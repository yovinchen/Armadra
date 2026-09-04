//! File imports are copies, never a grant to read beyond the workspace later.
//! Each batch has an exclusive staging directory and commits as one rename.
use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, resolve_in_root},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FILES: usize = 256;
const DIRECTORY: &str = ".armadra/imports";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub preview: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub path: String,
    pub files: Vec<FileInfo>,
}

#[derive(Deserialize)]
pub struct ImportManifest {
    pub paths: Vec<String>,
    #[serde(default)]
    pub directories: Vec<String>,
}

/// Validate both separator styles on every host. Never normalize a traversal
/// into a new path after validation, and never accept a browser fake path.
pub fn relative_path(value: &str) -> AppResult<String> {
    if value.is_empty()
        || value.len() > 4000
        || value.contains(['\\', '\0', ':'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(AppError::BadRequest(
            "Import paths must be plain relative paths".into(),
        ));
    }
    Ok(value.to_owned())
}

pub fn validate_manifest(manifest: &ImportManifest) -> AppResult<()> {
    if manifest.paths.len() > MAX_FILES
        || manifest.directories.len() > MAX_FILES
        || (manifest.paths.is_empty() && manifest.directories.is_empty())
    {
        return Err(AppError::BadRequest(
            "An import must contain 1–256 files or directories".into(),
        ));
    }
    let mut seen = HashSet::new();
    for path in manifest.paths.iter().chain(&manifest.directories) {
        relative_path(path)?;
        if !seen.insert(path) {
            return Err(AppError::BadRequest("Duplicate import path".into()));
        }
    }
    Ok(())
}

/// The managed directory may already exist, but none of its components may
/// be symlinks. A user-created .armadra symlink cannot redirect file writes.
fn ensure_directory(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(AppError::Forbidden(
            "Import destination is not a regular directory".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

pub struct ImportBatch {
    staging: PathBuf,
    destination: PathBuf,
    relative: String,
    bytes: usize,
    paths: Vec<String>,
    committed: bool,
}

impl ImportBatch {
    pub fn new(root: &Path) -> AppResult<Self> {
        let root = canonical_directory(root)?;
        ensure_directory(&root.join(".armadra"))?;
        ensure_directory(&root.join(DIRECTORY))?;
        let id = uuid::Uuid::new_v4().to_string();
        let staging = root.join(DIRECTORY).join(format!(".pending-{id}"));
        fs::create_dir(&staging)?;
        Ok(Self {
            staging,
            destination: root.join(DIRECTORY).join(&id),
            relative: format!("{DIRECTORY}/{id}"),
            bytes: 0,
            paths: Vec::new(),
            committed: false,
        })
    }

    pub fn directory(&self, path: &str) -> AppResult<()> {
        let path = relative_path(path)?;
        let mut current = self.staging.clone();
        for component in path.split('/') {
            current.push(component);
            ensure_directory(&current)?;
        }
        Ok(())
    }

    pub fn write(&mut self, path: &str, bytes: &[u8]) -> AppResult<()> {
        let path = relative_path(path)?;
        if self.paths.len() >= MAX_FILES
            || bytes.len() > MAX_FILE_BYTES
            || self.bytes.saturating_add(bytes.len()) > MAX_BATCH_BYTES
        {
            return Err(AppError::BadRequest(
                "Import exceeds the file count or size limit".into(),
            ));
        }
        if let Some((parent, _)) = path.rsplit_once('/') {
            self.directory(parent)?;
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.staging.join(&path))
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::Conflict("An imported file already exists".into())
                } else {
                    error.into()
                }
            })?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.bytes += bytes.len();
        self.paths.push(path);
        Ok(())
    }

    pub fn copy(&mut self, root: &Path, requested: &str) -> AppResult<()> {
        let requested_path = Path::new(requested);
        let source = if requested_path.is_absolute() {
            requested_path.to_path_buf()
        } else {
            root.join(relative_path(requested)?)
        };
        reject_symlink_components(&source)?;
        let source = crate::security::resolve_import_source(
            root,
            source
                .to_str()
                .ok_or_else(|| AppError::BadRequest("Invalid source path".into()))?,
        )?;
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::BadRequest("Invalid file name".into()))?;
        let mut bytes = Vec::new();
        fs::File::open(&source)?
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        self.write(name, &bytes)
    }

    pub fn commit(mut self, root: &Path) -> AppResult<ImportResult> {
        // UUID destination is never reused; a conflicting entry is an error.
        if self.destination.exists() {
            return Err(AppError::Conflict(
                "Import destination already exists".into(),
            ));
        }
        fs::rename(&self.staging, &self.destination)?;
        self.committed = true;
        let files = self
            .paths
            .iter()
            .map(|path| file_info(root, &format!("{}/{path}", self.relative)))
            .collect::<AppResult<_>>()?;
        Ok(ImportResult {
            path: self.relative.clone(),
            files,
        })
    }
}

impl Drop for ImportBatch {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.staging);
        }
    }
}

fn reject_symlink_components(path: &Path) -> AppResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(AppError::Forbidden(
                "Symbolic links cannot be imported".into(),
            ));
        }
    }
    Ok(())
}

pub fn file_info(root: &Path, requested: &str) -> AppResult<FileInfo> {
    let root = canonical_directory(root)?;
    let path = resolve_in_root(&root, requested)?;
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(AppError::BadRequest("Requested path is not a file".into()));
    }
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_owned();
    let preview = if mime.starts_with("image/") {
        "image"
    } else if metadata.len() <= 1024 * 1024 && is_text(&path)? {
        "text"
    } else {
        "download"
    };
    Ok(FileInfo {
        path: crate::security::relative_to_root(&root, &path)?,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        size: metadata.len(),
        mime_type: mime,
        preview,
    })
}

fn is_text(path: &Path) -> AppResult<bool> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes.len() <= 1024 * 1024
        && !bytes.contains(&0)
        && std::str::from_utf8(&bytes).is_ok()
        && !bytes.starts_with(b"%PDF-")
        && !bytes.starts_with(b"PK\x03\x04"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_nested_empty_and_binary_files_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        batch.write("src/a.txt", b"hello").unwrap();
        batch.write("empty.txt", b"").unwrap();
        batch.write("report.pdf", b"%PDF-1.7\n").unwrap();
        assert!(batch.write("src/a.txt", b"changed").is_err());
        let result = batch.commit(root.path()).unwrap();
        assert_eq!(result.files[0].preview, "text");
        assert_eq!(result.files[1].size, 0);
        assert_eq!(result.files[2].preview, "download");
        assert_eq!(
            fs::read(root.path().join(&result.files[0].path)).unwrap(),
            b"hello"
        );
    }
    #[test]
    fn rejects_traversal_and_cleans_failed_batches() {
        for path in [
            "../a",
            "/tmp/a",
            "a/../b",
            "a\\..\\b",
            "C:\\fakepath\\a",
            "a//b",
            ".",
            "",
        ] {
            assert!(relative_path(path).is_err(), "{path}");
        }
        let root = tempfile::tempdir().unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        batch.write("a", b"small").unwrap();
        assert!(batch.write("large", &vec![0; MAX_FILE_BYTES + 1]).is_err());
        drop(batch);
        assert_eq!(
            fs::read_dir(root.path().join(DIRECTORY)).unwrap().count(),
            0
        );
    }
    #[cfg(unix)]
    #[test]
    fn refuses_source_and_destination_symlinks_and_outside_reads() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("a.txt"), root.path().join("link")).unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        assert!(batch.copy(root.path(), "link").is_err());
        assert!(file_info(root.path(), outside.path().join("a.txt").to_str().unwrap()).is_err());
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), other.path().join(".armadra")).unwrap();
        assert!(ImportBatch::new(other.path()).is_err());
    }
}
