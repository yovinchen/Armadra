//! Local filesystem primitives for the package: hashing, owner-only creation
//! of directories and files, and directory durability.

use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::Path,
};

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::invalid;

pub(super) fn hash_file(path: &Path) -> AppResult<(u64, Vec<u8>)> {
    hash_reader(&mut File::open(path)?, u64::MAX)
}

pub(super) fn hash_reader(file: &mut File, limit: u64) -> AppResult<(u64, Vec<u8>)> {
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| invalid("file too large"))?;
        if bytes > limit {
            return Err(invalid("file exceeds byte limit"));
        }
        hash.update(&buffer[..read]);
    }
    Ok((bytes, hash.finalize().to_vec()))
}

pub(super) fn private_directory(path: &Path) -> AppResult<()> {
    // The only mutation is the Unix-only `mode` below.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Conflict("Migration export destination already exists".into())
        } else {
            error.into()
        }
    })?;
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        sync_directory(parent)?;
    }
    Ok(())
}

pub(super) fn private_ancestors(path: &Path) -> AppResult<()> {
    if path.exists() {
        if fs::symlink_metadata(path)?.file_type().is_symlink() || !path.is_dir() {
            return Err(invalid("unsafe package directory"));
        }
        return Ok(());
    }
    private_ancestors(
        path.parent()
            .ok_or_else(|| invalid("missing package ancestor"))?,
    )?;
    private_directory(path)
}

pub(super) fn private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub(super) fn sync_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
