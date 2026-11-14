//! Files the agent writes as root. Its own folders must
//! be ones only it can change, and nothing here follows a symlink, so a path someone else
//! planted can't redirect a write or a copy.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rustix::fs::OFlags;

/// The largest state file read back (ssh.json, update.json).
const SMALL: u64 = 64 * 1024;

fn no_follow() -> i32 {
    // The flag's bits fit in an i32 on every target; it's how `custom_flags` takes them.
    i32::try_from(OFlags::NOFOLLOW.bits()).unwrap_or(0)
}

/// Opening a FIFO planted in place of a file would otherwise wait for a writer forever.
fn no_block() -> i32 {
    i32::try_from(OFlags::NONBLOCK.bits()).unwrap_or(0)
}

/// Who the agent runs as: root in production, whoever runs the tests otherwise.
fn me() -> u32 {
    rustix::process::geteuid().as_raw()
}

fn not_ours(dir: &Path) -> io::Error {
    let who = if me() == 0 { "root" } else { "the agent" };
    io::Error::other(format!("{} isn't a folder owned by {who}", dir.display()))
}

/// Makes `dir` if it's missing and checks it's a real folder owned by the agent's user, then
/// sets its mode. A symlink, or a folder someone else owns, is refused rather than used.
///
/// # Errors
/// If it can't be made, or isn't the agent's.
pub fn own_dir(dir: &Path, mode: u32) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(mode).create(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != me() {
        return Err(not_ours(dir));
    }
    if meta.mode() & 0o7777 != mode {
        fs::set_permissions(dir, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

fn temp_beside(path: &Path) -> PathBuf {
    let mut bytes = [0u8; 6];
    rustix::rand::getrandom(&mut bytes, rustix::rand::GetRandomFlags::empty()).unwrap_or(0);
    let n = bytes.iter().fold(0u64, |a, b| a << 8 | u64::from(*b));
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".tmp-{n:012x}"));
    path.with_file_name(name)
}

fn create_new(path: &Path, mode: u32) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(no_follow())
        .open(path)
}

/// Writes a whole file through a new temporary file renamed over it.
///
/// # Errors
/// If the file can't be written.
pub fn write_atomic(path: &Path, text: &str, mode: u32) -> io::Result<()> {
    let tmp = temp_beside(path);
    let written = create_new(&tmp, mode).and_then(|mut f| {
        f.write_all(text.as_bytes())?;
        f.sync_all()
    });
    let renamed = written.and_then(|()| fs::rename(&tmp, path));
    if renamed.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    renamed
}

fn open_regular(path: &Path) -> io::Result<(File, fs::Metadata)> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(no_follow() | no_block())
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other(format!(
            "{} isn't a regular file",
            path.display()
        )));
    }
    Ok((file, meta))
}

/// A small regular file's text, or `None` if it's missing, too big, or not a regular file.
#[must_use]
pub fn read_small(path: &Path) -> Option<String> {
    let (file, meta) = open_regular(path).ok()?;
    if meta.len() > SMALL {
        return None;
    }
    let mut text = String::new();
    file.take(SMALL).read_to_string(&mut text).ok()?;
    Some(text)
}

/// Who owns a file, and its mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Owner {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
}

/// Copies a regular file without following a symlink at either end. Whatever is at `dest` is
/// removed and the copy made anew there, so it's never written through. The copy is given
/// `owner`, or keeps the source's, and the source's modified time. Returns the source's owner.
///
/// # Errors
/// `NotFound` if `src` is missing; any other failure to read or write.
pub fn copy_file(src: &Path, dest: &Path, owner: Option<Owner>) -> io::Result<Owner> {
    let (mut from, meta) = open_regular(src)?;
    match fs::remove_file(dest) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut to = create_new(dest, 0o600)?;
    io::copy(&mut from, &mut to)?;
    let was = Owner {
        uid: meta.uid(),
        gid: meta.gid(),
        mode: meta.mode(),
    };
    let o = owner.unwrap_or(was);
    if me() == 0 {
        std::os::unix::fs::fchown(&to, Some(o.uid), Some(o.gid))?;
    }
    to.set_permissions(fs::Permissions::from_mode(o.mode & 0o7777))?;
    to.set_modified(meta.modified().unwrap_or_else(|_| SystemTime::now()))?;
    to.sync_all()?;
    Ok(was)
}

/// Sets a file's mode through a handle opened without following a link.
///
/// # Errors
/// If it can't be opened or changed.
pub fn chmod_no_follow(path: &Path, mode: u32) -> io::Result<()> {
    let (file, _) = open_regular(path)?;
    file.set_permissions(fs::Permissions::from_mode(mode))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::handlers::testing::TempRoot;

    #[test]
    fn copies_without_following_links_at_either_end() {
        let root = TempRoot::new("safe-fs-copy");
        let base = Path::new(&root.paths.state);
        fs::create_dir_all(base).unwrap();
        let (src, dest, target) = (base.join("src"), base.join("dest"), base.join("target"));
        fs::write(&src, "data").unwrap();
        fs::write(&target, "untouched").unwrap();
        symlink(&target, &dest).unwrap();
        copy_file(&src, &dest, None).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "data");
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");
        let link = base.join("link");
        symlink(&target, &link).unwrap();
        assert!(copy_file(&link, &base.join("other"), None).is_err());
        assert!(!base.join("other").exists());
    }

    #[test]
    fn writes_through_a_new_file_and_reads_only_regular_ones() {
        let root = TempRoot::new("safe-fs-write");
        let base = Path::new(&root.paths.state);
        fs::create_dir_all(base).unwrap();
        let (file, target) = (base.join("state.json"), base.join("target"));
        fs::write(&target, "untouched").unwrap();
        symlink(&target, &file).unwrap();
        assert_eq!(read_small(&file), None);
        write_atomic(&file, "{}", 0o600).unwrap();
        assert_eq!(read_small(&file).as_deref(), Some("{}"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
    }

    #[test]
    fn refuses_a_folder_that_is_a_link() {
        let root = TempRoot::new("safe-fs-dir");
        let base = Path::new(&root.paths.state);
        fs::create_dir_all(base.join("elsewhere")).unwrap();
        symlink(base.join("elsewhere"), base.join("dir")).unwrap();
        assert!(own_dir(&base.join("dir"), 0o700).is_err());
        own_dir(&base.join("real"), 0o700).unwrap();
        assert_eq!(
            fs::metadata(base.join("real")).unwrap().mode() & 0o7777,
            0o700
        );
    }
}
