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

/// Deserializable as well as serializable: this is one of the version-locked
/// service payloads, so the controller has to be able to read back what an
/// execution host produced (remote completion design §3.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// The published directory is still disposable until its database transaction
/// succeeds. Dropping a cancelled registration also removes the owned copy.
pub struct ImportedWorkspace {
    pub path: PathBuf,
    registered: bool,
}
impl ImportedWorkspace {
    pub fn keep(&mut self) {
        self.registered = true;
    }
}
impl Drop for ImportedWorkspace {
    fn drop(&mut self) {
        if !self.registered {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

impl ImportBatch {
    pub fn new(root: &Path) -> AppResult<Self> {
        let root = canonical_directory(root)?;
        ensure_directory(&root.join(".armadra"))?;
        ensure_directory(&root.join(DIRECTORY))?;
        Self::under(&root.join(DIRECTORY), DIRECTORY)
    }

    /// A browser folder becomes an independent workspace rooted in a managed
    /// UUID directory. It never claims to be the browser's original folder.
    pub fn workspace(parent: &Path) -> AppResult<Self> {
        ensure_directory(parent)?;
        Self::under(parent, "")
    }

    fn under(parent: &Path, prefix: &str) -> AppResult<Self> {
        let parent = canonical_directory(parent)?;
        let id = uuid::Uuid::new_v4().to_string();
        let staging = parent.join(format!(".pending-{id}"));
        fs::create_dir(&staging)?;
        Ok(Self {
            staging,
            destination: parent.join(&id),
            relative: if prefix.is_empty() {
                id
            } else {
                format!("{prefix}/{id}")
            },
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
        let destination = self.available_copy_name(name)?;
        self.write(&destination, &bytes)
    }

    /// Desktop drops can include equally named files from different source
    /// directories. Allocate in input order and keep the extension intact;
    /// files, directories and symlinks all reserve their existing names.
    /// `write` still uses create_new, so a late collision cannot overwrite data.
    fn available_copy_name(&self, name: &str) -> AppResult<String> {
        relative_path(name)?;
        let path = Path::new(name);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(name);
        let extension = path.extension().and_then(|value| value.to_str());
        let mut candidate = name.to_owned();
        let mut ordinal = 2;
        loop {
            match fs::symlink_metadata(self.staging.join(&candidate)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
                Err(error) => return Err(error.into()),
                Ok(_) => {}
            }
            candidate = match extension {
                Some(extension) => format!("{stem}-{ordinal}.{extension}"),
                None => format!("{stem}-{ordinal}"),
            };
            ordinal += 1;
        }
    }

    pub fn commit(mut self, root: &Path) -> AppResult<ImportResult> {
        self.finish()?;
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

    pub fn commit_workspace(mut self) -> AppResult<ImportedWorkspace> {
        self.finish()?;
        Ok(ImportedWorkspace {
            path: self.destination.clone(),
            registered: false,
        })
    }

    fn finish(&mut self) -> AppResult<()> {
        // UUID destination is never reused; a conflicting entry is an error.
        if self.destination.exists() {
            return Err(AppError::Conflict(
                "Import destination already exists".into(),
            ));
        }
        fs::rename(&self.staging, &self.destination)?;
        self.committed = true;
        Ok(())
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
        // A Windows prefix is not a filesystem entry of its own: statting the
        // bare `C:` fails with "Incorrect function" and would turn every
        // absolute path on that platform into an import error. Neither a drive
        // nor a root can be a symlink, so only what hangs below them is checked.
        if matches!(
            component,
            std::path::Component::Prefix(_) | std::path::Component::RootDir
        ) {
            continue;
        }
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(AppError::Forbidden(
                "Symbolic links cannot be imported".into(),
            ));
        }
    }
    Ok(())
}

pub fn directory_source(path: &str) -> AppResult<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppError::BadRequest(
            "Folder source must be an absolute path without traversal".into(),
        ));
    }
    reject_symlink_components(path)?;
    canonical_directory(path)
}

pub async fn read_manifest(
    multipart: &mut axum::extract::Multipart,
    allow_empty_root: bool,
) -> AppResult<ImportManifest> {
    let mut field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest("Invalid file upload".into()))?
        .ok_or_else(|| AppError::BadRequest("Import manifest is missing".into()))?;
    if field.name() != Some("manifest") {
        return Err(AppError::BadRequest(
            "Import manifest must come first".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| AppError::BadRequest("Invalid import manifest".into()))?
    {
        if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
            return Err(AppError::BadRequest("Import manifest is too large".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    let manifest: ImportManifest = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::BadRequest("Invalid import manifest".into()))?;
    if !(allow_empty_root && manifest.paths.is_empty() && manifest.directories.is_empty()) {
        validate_manifest(&manifest)?;
    }
    Ok(manifest)
}

pub async fn receive_files(
    multipart: &mut axum::extract::Multipart,
    batch: &mut ImportBatch,
    manifest: &ImportManifest,
) -> AppResult<()> {
    for directory in &manifest.directories {
        batch.directory(directory)?;
    }
    let mut received = HashSet::new();
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest("Incomplete file upload".into()))?
    {
        let index: usize = field
            .name()
            .and_then(|name| name.parse().ok())
            .filter(|index| *index < manifest.paths.len())
            .ok_or_else(|| AppError::BadRequest("Unexpected imported file".into()))?;
        if !received.insert(index) {
            return Err(AppError::BadRequest("Duplicate imported file".into()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| AppError::BadRequest("Incomplete file upload".into()))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_FILE_BYTES {
                return Err(AppError::BadRequest(
                    "A file exceeds the 16 MiB import limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        batch.write(&manifest.paths[index], &bytes)?;
    }
    if received.len() != manifest.paths.len() {
        return Err(AppError::BadRequest(
            "Some imported files are missing".into(),
        ));
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
    }
    .to_owned();
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
    fn empty_workspace_copies_commit_and_unregistered_copies_are_removed() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("managed");
        let batch = ImportBatch::workspace(&parent).unwrap();
        let imported = batch.commit_workspace().unwrap();
        let path = imported.path.clone();
        assert!(path.is_dir());
        drop(imported);
        assert!(!path.exists());

        let batch = ImportBatch::workspace(&parent).unwrap();
        batch.directory("empty/nested").unwrap();
        let mut imported = batch.commit_workspace().unwrap();
        assert!(imported.path.join("empty/nested").is_dir());
        let path = imported.path.clone();
        imported.keep();
        drop(imported);
        assert!(path.is_dir());
    }

    #[test]
    fn directory_sources_reject_files_and_traversal() {
        let root = tempfile::tempdir().unwrap();
        let root = crate::paths::canonicalize(root.path()).unwrap();
        fs::write(root.join("file.txt"), "x").unwrap();
        assert!(directory_source(root.to_str().unwrap()).is_ok());
        assert!(directory_source(root.join("file.txt").to_str().unwrap()).is_err());
        assert!(directory_source(root.join("../").to_str().unwrap()).is_err());
        assert!(directory_source("relative").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, root.join("linked-folder")).unwrap();
            assert!(directory_source(root.join("linked-folder").to_str().unwrap()).is_err());
        }
    }
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
    fn desktop_copies_with_the_same_basename_preserve_every_file() {
        let root = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let sources = crate::paths::canonicalize(sources.path()).unwrap();
        fs::create_dir(sources.join("a")).unwrap();
        fs::create_dir(sources.join("b")).unwrap();
        let originals: [&[u8]; 2] = [b"first\0payload", b"second\0payload"];
        for (directory, bytes) in ["a", "b"].into_iter().zip(originals) {
            fs::write(sources.join(directory).join("report.txt"), bytes).unwrap();
        }
        fs::write(root.path().join("report.txt"), b"existing workspace file").unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        for directory in ["a", "b"] {
            batch
                .copy(
                    root.path(),
                    sources.join(directory).join("report.txt").to_str().unwrap(),
                )
                .unwrap();
        }
        let result = batch.commit(root.path()).unwrap();
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            ["report.txt", "report-2.txt"]
        );
        for (file, bytes) in result.files.iter().zip(originals) {
            assert_eq!(fs::read(root.path().join(&file.path)).unwrap(), bytes);
        }
        assert_eq!(
            fs::read(root.path().join("report.txt")).unwrap(),
            b"existing workspace file"
        );
        assert_eq!(
            fs::read(sources.join("a/report.txt")).unwrap(),
            originals[0]
        );
        assert_eq!(
            fs::read(sources.join("b/report.txt")).unwrap(),
            originals[1]
        );
    }

    #[test]
    fn desktop_copy_suffixes_skip_directories_and_existing_suffixes() {
        let root = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let source = crate::paths::canonicalize(sources.path())
            .unwrap()
            .join("report.txt");
        fs::write(&source, b"new copy").unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        batch
            .write("report.txt/nested.txt", b"nested structure")
            .unwrap();
        batch.directory("report-2.txt").unwrap();
        batch.write("report-3.txt", b"existing suffix").unwrap();
        batch.copy(root.path(), source.to_str().unwrap()).unwrap();
        let result = batch.commit(root.path()).unwrap();
        let destination = root.path().join(&result.path);
        assert!(destination.join("report.txt").is_dir());
        assert!(destination.join("report-2.txt").is_dir());
        assert_eq!(
            fs::read(destination.join("report.txt/nested.txt")).unwrap(),
            b"nested structure"
        );
        assert_eq!(
            fs::read(destination.join("report-3.txt")).unwrap(),
            b"existing suffix"
        );
        assert_eq!(
            fs::read(destination.join("report-4.txt")).unwrap(),
            b"new copy"
        );
    }

    #[test]
    fn desktop_copy_suffixes_keep_dotfiles_and_extensionless_names() {
        let root = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let sources = crate::paths::canonicalize(sources.path()).unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        for name in [".env", "Makefile"] {
            let source = sources.join(name);
            fs::write(&source, b"preserved").unwrap();
            batch.copy(root.path(), source.to_str().unwrap()).unwrap();
            batch.copy(root.path(), source.to_str().unwrap()).unwrap();
        }
        let result = batch.commit(root.path()).unwrap();
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            [".env", ".env-2", "Makefile", "Makefile-2"]
        );
    }

    #[test]
    fn failed_batches_still_roll_back_after_renaming_copies() {
        let root = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let source = crate::paths::canonicalize(sources.path())
            .unwrap()
            .join("report.txt");
        fs::write(&source, b"source unchanged").unwrap();
        let mut batch = ImportBatch::new(root.path()).unwrap();
        batch.copy(root.path(), source.to_str().unwrap()).unwrap();
        batch.copy(root.path(), source.to_str().unwrap()).unwrap();
        // Manifest writes remain strict; suffix allocation applies only to copies.
        assert!(batch.write("report-2.txt", b"overwrite").is_err());
        drop(batch);
        assert_eq!(
            fs::read_dir(root.path().join(DIRECTORY)).unwrap().count(),
            0
        );
        assert_eq!(fs::read(source).unwrap(), b"source unchanged");
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
