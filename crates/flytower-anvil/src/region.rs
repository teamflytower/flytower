//! Region files (`r.<x>.<z>.mca`): 32×32 chunks, each compressed on its own.
//!
//! The file starts with two 4 KiB tables: where each chunk lives, then when each chunk was
//! last saved. The second table is what makes incremental passes cheap: if neither table
//! changed, no chunk in the region did.
//!
//! [`Region::compact`] writes a region back with some chunks left out. Kept chunks are copied
//! byte for byte, never decoded, so nothing about them can change.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::{GzDecoder, ZlibDecoder};

/// Both header tables.
pub const HEADER: usize = 8192;
/// Region files are laid out in sectors of this many bytes.
pub const SECTOR: usize = 4096;

/// Biggest chunk we'll inflate. Vanilla chunks are a few hundred KiB at most; this stops a
/// zip bomb filling memory.
const MAX_CHUNK: u64 = 64 << 20;

/// Why a chunk couldn't be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// The region coordinates in a file name like `r.-1.3.mca`.
#[must_use]
pub fn coords(name: &str) -> Option<(i32, i32)> {
    let rest = name.strip_prefix("r.")?.strip_suffix(".mca")?;
    let (x, z) = rest.split_once('.')?;
    Some((x.parse().ok()?, z.parse().ok()?))
}

/// The world position of chunk `i` (`x + z * 32`) of region `rx`, `rz`.
#[must_use]
pub fn chunk_xz(rx: i32, rz: i32, i: usize) -> (i32, i32) {
    let (x, z) = (i % 32, (i / 32) % 32);
    // Both are below 32, so the casts can't lose anything.
    (
        rx * 32 + i32::try_from(x).unwrap_or(0),
        rz * 32 + i32::try_from(z).unwrap_or(0),
    )
}

/// The file an oversized chunk's data lives in, beside its region.
#[must_use]
pub fn mcc_name(cx: i32, cz: i32) -> String {
    format!("c.{cx}.{cz}.mcc")
}

/// Where chunk `i` sits in a region file, from the first header table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// The sector its data starts at, counting the two header sectors.
    pub sector: usize,
    /// How many sectors it takes up.
    pub sectors: usize,
    /// When it was last saved, in seconds since 1970, from the second table.
    pub saved: u32,
}

/// Reads just the header tables, padded with zeros if the file is shorter (new and empty
/// region files are). Enough to tell whether anything changed.
///
/// # Errors
///
/// When the file can't be read.
pub fn header(path: &Path) -> io::Result<[u8; HEADER]> {
    let mut out = [0; HEADER];
    let mut file = File::open(path)?;
    let mut filled = 0;
    while filled < HEADER {
        match file.read(&mut out[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(out)
}

/// A whole region file in memory.
pub struct Region {
    data: Vec<u8>,
    dir: PathBuf,
    x: i32,
    z: i32,
}

impl Region {
    /// Reads a region file.
    ///
    /// # Errors
    ///
    /// When the file can't be read.
    pub fn open(path: &Path, x: i32, z: i32) -> io::Result<Self> {
        let data = std::fs::read(path)?;
        let dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        Ok(Self { data, dir, x, z })
    }

    /// A region made from bytes, for tests and tools.
    #[must_use]
    pub const fn from_bytes(data: Vec<u8>, dir: PathBuf, x: i32, z: i32) -> Self {
        Self { data, dir, x, z }
    }

    /// The region's x and z.
    #[must_use]
    pub const fn xz(&self) -> (i32, i32) {
        (self.x, self.z)
    }

    /// How big the file is.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.data.len()
    }

    /// Whether the file is empty (even of headers).
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Where chunk `i` is, or `None` when it was never generated.
    #[must_use]
    pub fn entry(&self, i: usize) -> Option<Entry> {
        let loc = self.data.get(i * 4..i * 4 + 4)?;
        let sector = usize::from(loc[0]) << 16 | usize::from(loc[1]) << 8 | usize::from(loc[2]);
        if sector == 0 && loc[3] == 0 {
            return None;
        }
        let saved = self
            .data
            .get(SECTOR + i * 4..SECTOR + i * 4 + 4)
            .map_or(0, |t| u32::from_be_bytes([t[0], t[1], t[2], t[3]]));
        Some(Entry {
            sector,
            sectors: loc[3].into(),
            saved,
        })
    }

    /// The raw sectors chunk `i` takes up, exactly as stored: what [`Self::compact`] copies.
    ///
    /// # Errors
    ///
    /// When the entry points into the headers or past the end of the file.
    pub fn sectors(&self, i: usize) -> Result<Option<&[u8]>, Error> {
        let Some(e) = self.entry(i) else {
            return Ok(None);
        };
        if e.sector < 2 || e.sectors == 0 {
            return Err(Error("chunk points into the header".into()));
        }
        let (start, end) = (e.sector * SECTOR, (e.sector + e.sectors) * SECTOR);
        // The last sector of a file is sometimes cut short; Minecraft pads it on its next write.
        let end = if end > self.data.len() && end - self.data.len() < SECTOR {
            self.data.len()
        } else {
            end
        };
        self.data
            .get(start..end)
            .filter(|b| b.len() >= 5)
            .map(Some)
            .ok_or_else(|| Error("chunk points past the end of the file".into()))
    }

    /// Whether chunk `i`'s data is too big for the region and lives in its own `.mcc` file.
    #[must_use]
    pub fn external(&self, i: usize) -> bool {
        matches!(self.sectors(i), Ok(Some(b)) if b[4] & 0x80 != 0)
    }

    /// The region rewritten with only the chunks `keep` says yes to, packed one after
    /// another. Kept chunks' bytes and save times are copied unchanged. `None` when no chunks
    /// are left, so the file can be deleted rather than kept as empty headers.
    ///
    /// # Errors
    ///
    /// When a kept chunk's entry is broken: we won't guess at what to copy.
    pub fn compact(&self, keep: impl Fn(usize) -> bool) -> Result<Option<Vec<u8>>, Error> {
        let mut out = vec![0; HEADER];
        let mut any = false;
        for i in 0..1024 {
            if !keep(i) {
                continue;
            }
            let Some(entry) = self.entry(i) else {
                continue;
            };
            let bytes = self
                .sectors(i)?
                .ok_or_else(|| Error("chunk vanished".into()))?;
            let sector = out.len() / SECTOR;
            let count = bytes.len().div_ceil(SECTOR);
            let (Ok(at), Ok(count_byte)) = (u32::try_from(sector), u8::try_from(count)) else {
                return Err(Error("region is too big to rewrite".into()));
            };
            out[i * 4..i * 4 + 3].copy_from_slice(&at.to_be_bytes()[1..]);
            out[i * 4 + 3] = count_byte;
            out[SECTOR + i * 4..SECTOR + i * 4 + 4].copy_from_slice(&entry.saved.to_be_bytes());
            out.extend_from_slice(bytes);
            out.resize(out.len().div_ceil(SECTOR) * SECTOR, 0);
            any = true;
        }
        Ok(any.then_some(out))
    }

    /// The uncompressed NBT of chunk `i` (`x + z * 32` within the region), or `None` when
    /// the chunk was never generated.
    ///
    /// # Errors
    ///
    /// When the chunk's entry points nowhere sensible or its data won't decompress.
    pub fn chunk(&self, i: usize) -> Result<Option<Vec<u8>>, Error> {
        let Some(entry) = self.data.get(i * 4..i * 4 + 4) else {
            return Ok(None);
        };
        let sector =
            usize::from(entry[0]) << 16 | usize::from(entry[1]) << 8 | usize::from(entry[2]);
        if sector == 0 && entry[3] == 0 {
            return Ok(None);
        }
        let start = sector * SECTOR;
        let Some(head) = self.data.get(start..start + 5) else {
            return Err(Error("chunk points past the end of the file".into()));
        };
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let kind = head[4];
        if kind & 0x80 != 0 {
            // Too big for the region file: the data is in its own `.mcc` file.
            let cx = self.x * 32 + i32::try_from(i % 32).unwrap_or(0);
            let cz = self.z * 32 + i32::try_from(i / 32).unwrap_or(0);
            let path = self.dir.join(format!("c.{cx}.{cz}.mcc"));
            let data =
                std::fs::read(&path).map_err(|e| Error(format!("{}: {e}", path.display())))?;
            return decompress(kind & 0x7f, &data).map(Some);
        }
        let Some(body) = len
            .checked_sub(1)
            .and_then(|n| self.data.get(start + 5..start + 5 + n))
        else {
            return Err(Error("chunk length runs past the end of the file".into()));
        };
        decompress(kind, body).map(Some)
    }
}

/// Replaces a file in one step: writes the new bytes beside it, syncs them to disk, then
/// renames them over it, so a crash leaves either the old file or the new one, never half
/// of either. The new file keeps the old one's permissions.
///
/// # Errors
///
/// When writing, syncing or renaming fails. The old file is then untouched.
pub fn replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = temp_path(path);
    let written = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        if let Ok(meta) = fs::metadata(path) {
            file.set_permissions(meta.permissions())?;
        }
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    sync_dir(path)
}

/// Deletes a file and makes the deletion stick. A file that's already gone is fine.
///
/// # Errors
///
/// When the file is there but can't be deleted.
pub fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => sync_dir(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// The name [`replace`] writes to first. It starts with a dot, so nothing (Minecraft, the
/// map) mistakes it for a region.
#[must_use]
pub fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(Default::default, |n| n.to_string_lossy());
    path.with_file_name(format!(".{name}.flytower-tmp"))
}

/// Whether a file name is one [`replace`] left behind when it was stopped part-way.
#[must_use]
pub fn is_temp(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".flytower-tmp")
}

fn sync_dir(path: &Path) -> io::Result<()> {
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => File::open(dir)?.sync_all(),
        _ => Ok(()),
    }
}

/// Undoes one of the region file compression types.
///
/// # Errors
///
/// When the type is unknown or the data is corrupt.
pub fn decompress(kind: u8, data: &[u8]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    let read = match kind {
        1 => GzDecoder::new(data).take(MAX_CHUNK).read_to_end(&mut out),
        2 => ZlibDecoder::new(data).take(MAX_CHUNK).read_to_end(&mut out),
        3 => return Ok(data.to_vec()),
        4 => return lz4_blocks(data),
        127 => return Err(Error("chunk uses a custom compression".into())),
        _ => return Err(Error(format!("unknown chunk compression {kind}"))),
    };
    read.map_err(|e| Error(format!("chunk won't decompress: {e}")))?;
    Ok(out)
}

/// Minecraft's LZ4 option (type 4) writes lz4-java's block stream: a run of blocks, each
/// with a 21-byte header, ending with an empty one.
fn lz4_blocks(mut data: &[u8]) -> Result<Vec<u8>, Error> {
    const MAGIC: &[u8] = b"LZ4Block";
    let bad = |why: &str| Error(format!("chunk won't decompress: {why}"));
    let mut out = Vec::new();
    while !data.is_empty() {
        if data.len() < 21 || &data[..8] != MAGIC {
            return Err(bad("not an LZ4 block"));
        }
        let method = data[8] & 0xf0;
        let le = |at: usize| {
            u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as usize
        };
        let (packed, unpacked) = (le(9), le(13));
        let Some(body) = data.get(21..21 + packed) else {
            return Err(bad("LZ4 block runs past the end"));
        };
        if unpacked == 0 {
            break;
        }
        if (out.len() + unpacked) as u64 > MAX_CHUNK {
            return Err(bad("too big"));
        }
        match method {
            0x10 if packed == unpacked => out.extend_from_slice(body),
            0x20 => {
                let at = out.len();
                out.resize(at + unpacked, 0);
                let n = lz4_flex::block::decompress_into(body, &mut out[at..])
                    .map_err(|e| bad(&e.to_string()))?;
                if n != unpacked {
                    return Err(bad("LZ4 block is the wrong size"));
                }
            }
            _ => return Err(bad("unknown LZ4 block type")),
        }
        data = &data[21 + packed..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_file_names() {
        assert_eq!(coords("r.0.0.mca"), Some((0, 0)));
        assert_eq!(coords("r.-12.7.mca"), Some((-12, 7)));
        assert_eq!(coords("r.1.mca"), None);
        assert_eq!(coords("r.a.b.mca"), None);
        assert_eq!(coords("c.0.0.mcc"), None);
    }

    #[test]
    fn empty_entries_are_missing_chunks() {
        let region = Region::from_bytes(vec![0; HEADER], PathBuf::new(), 0, 0);
        assert_eq!(region.chunk(0), Ok(None));
        assert_eq!(region.chunk(1023), Ok(None));
    }

    #[test]
    fn bad_entries_are_errors_not_panics() {
        let mut data = vec![0; HEADER];
        data[..4].copy_from_slice(&[0xff, 0xff, 0xff, 1]);
        data[4..8].copy_from_slice(&[0, 0, 2, 1]);
        let region = Region::from_bytes(data, PathBuf::new(), 0, 0);
        assert!(region.chunk(0).is_err());
        assert!(region.chunk(1).is_err());
    }

    /// A region with the given chunks: (index, sectors, first byte of data, save time).
    fn built(chunks: &[(usize, usize, u8, u32)]) -> Vec<u8> {
        let mut data = vec![0; HEADER];
        for &(i, n, fill, saved) in chunks {
            let at = data.len() / SECTOR;
            data[i * 4..i * 4 + 3].copy_from_slice(&u32::try_from(at).unwrap().to_be_bytes()[1..]);
            data[i * 4 + 3] = u8::try_from(n).unwrap();
            data[SECTOR + i * 4..SECTOR + i * 4 + 4].copy_from_slice(&saved.to_be_bytes());
            let mut body = vec![fill; n * SECTOR];
            body[..5].copy_from_slice(&[0, 0, 0, 2, 2]);
            data.extend(body);
        }
        data
    }

    #[test]
    fn compaction_copies_kept_chunks_exactly() {
        let data = built(&[(0, 1, 7, 100), (5, 3, 8, 200), (1023, 2, 9, 300)]);
        let region = Region::from_bytes(data, PathBuf::new(), 0, 0);
        let out = region.compact(|i| i != 5).unwrap().unwrap();
        assert_eq!(out.len(), HEADER + 3 * SECTOR);
        let new = Region::from_bytes(out, PathBuf::new(), 0, 0);
        assert_eq!(new.entry(5), None);
        for i in [0, 1023] {
            assert_eq!(new.sectors(i).unwrap(), region.sectors(i).unwrap());
            assert_eq!(new.entry(i).unwrap().saved, region.entry(i).unwrap().saved);
        }
        assert_eq!(new.entry(1023).unwrap().sector, 3);
        assert_eq!(region.compact(|_| false).unwrap(), None);
        // Keeping everything packs, but changes no chunk.
        let all = Region::from_bytes(
            region.compact(|_| true).unwrap().unwrap(),
            PathBuf::new(),
            0,
            0,
        );
        for i in [0, 5, 1023] {
            assert_eq!(all.sectors(i).unwrap(), region.sectors(i).unwrap());
        }
    }

    #[test]
    fn compaction_refuses_broken_kept_chunks() {
        let mut data = built(&[(0, 1, 7, 100)]);
        data[4..8].copy_from_slice(&[0, 0, 9, 1]);
        let region = Region::from_bytes(data, PathBuf::new(), 0, 0);
        assert!(region.compact(|_| true).is_err());
        // Dropping the broken one is fine.
        assert!(region.compact(|i| i == 0).unwrap().is_some());
        assert!(region.sectors(1).is_err());
    }

    #[test]
    fn spots_external_chunks() {
        let mut data = built(&[(0, 1, 7, 1), (1, 1, 7, 1)]);
        data[2 * SECTOR + 4] = 0x82;
        let region = Region::from_bytes(data, PathBuf::new(), 0, 0);
        assert!(region.external(0));
        assert!(!region.external(1));
        assert!(!region.external(2));
        assert_eq!(chunk_xz(-1, 2, 33), (-31, 65));
        assert_eq!(mcc_name(-31, 65), "c.-31.65.mcc");
    }

    #[test]
    fn replaces_files_whole() {
        let dir =
            std::env::temp_dir().join(format!("flytower-anvil-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("r.0.0.mca");
        fs::write(&path, b"old").unwrap();
        replace(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!temp_path(&path).exists());
        assert!(is_temp(
            &temp_path(&path).file_name().unwrap().to_string_lossy()
        ));
        assert_eq!(
            coords(&temp_path(&path).file_name().unwrap().to_string_lossy()),
            None
        );
        remove(&path).unwrap();
        remove(&path).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_compression_is_an_error() {
        assert!(decompress(9, b"x").is_err());
        assert!(decompress(127, b"x").is_err());
        assert!(decompress(4, b"LZ4Blocc").is_err());
    }
}
