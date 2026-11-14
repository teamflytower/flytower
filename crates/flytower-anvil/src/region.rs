//! Region files (`r.<x>.<z>.mca`): 32×32 chunks, each compressed on its own.
//!
//! The file starts with two 4 KiB tables: where each chunk lives, then when each chunk was
//! last saved. The second table is what makes incremental passes cheap: if neither table
//! changed, no chunk in the region did.

use std::fmt;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use flate2::read::{GzDecoder, ZlibDecoder};

/// Both header tables.
pub const HEADER: usize = 8192;
const SECTOR: usize = 4096;

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

    #[test]
    fn unknown_compression_is_an_error() {
        assert!(decompress(9, b"x").is_err());
        assert!(decompress(127, b"x").is_err());
        assert!(decompress(4, b"LZ4Blocc").is_err());
    }
}
