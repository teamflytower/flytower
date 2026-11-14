//! File helpers for the handlers: making folders, writing and copying files, as root.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;

use crate::envelope::{AgentError, ErrorCode};

pub fn io_error(what: &str, path: &Path, e: &io::Error) -> AgentError {
    AgentError::new(ErrorCode::Failed, format!("{what} {}: {e}", path.display()))
}

/// Like `writeFile(path, text, { mode })`: the mode applies only when the file is created.
pub fn write(path: &Path, text: &str, mode: u32) -> Result<(), AgentError> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| io_error("can't write", path, &e))
}

/// Like `mkdir(path, { recursive: true, mode })`.
pub fn mkdir(path: &Path, mode: u32) -> Result<(), AgentError> {
    DirBuilder::new()
        .recursive(true)
        .mode(mode)
        .create(path)
        .map_err(|e| io_error("can't create", path, &e))
}

/// Like `rm(path, { recursive: true, force: true })`.
pub fn remove(path: &Path) -> Result<(), AgentError> {
    let result = match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    };
    result.map_err(|e| io_error("can't remove", path, &e))
}

/// `None` when the file doesn't exist or can't be read.
pub fn read(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}
