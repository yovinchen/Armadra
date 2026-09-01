//! Two file primitives the skills installer needs, kept here rather than
//! reached for across module boundaries: `hook::install` owns its own copies
//! and is being edited by another part of Phase 2/3.

use std::{fs, io, path::Path};

use crate::error::AppResult;

/// A missing file reads as empty; anything else propagates, because silently
/// treating an unreadable file as empty would overwrite it.
pub fn read_to_string_or_empty(path: &Path) -> AppResult<String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

/// tmp + rename, so a CLI reading the file concurrently never sees half of it.
pub fn write_atomically(path: &Path, contents: &[u8]) -> AppResult<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{}.aicc-tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file")
    ));
    fs::write(&temporary, contents)?;
    fs::rename(&temporary, path)?;
    Ok(())
}
