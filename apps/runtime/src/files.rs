use std::{fs, path::Path};

use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, relative_to_root, resolve_in_root},
};

const MAX_ENTRIES: usize = 500;
const MAX_TEXT_FILE_SIZE: u64 = 1_048_576;
const IGNORED_NAMES: &[&str] = &[".git", "node_modules", "target", "dist", "coverage"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub readonly: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub mime_type: String,
    pub content: String,
    pub size: u64,
}

pub fn list_directory(root: &Path, requested: &str) -> AppResult<FileList> {
    let root = canonical_directory(root)?;
    let directory = resolve_in_root(&root, requested)?;
    if !directory.is_dir() {
        return Err(AppError::BadRequest(
            "Requested path is not a directory".into(),
        ));
    }
    let mut paths = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    paths.sort_by_key(|entry| (!entry.path().is_dir(), entry.file_name()));
    let truncated = paths.len() > MAX_ENTRIES;
    let entries = paths
        .into_iter()
        .filter(|entry| !IGNORED_NAMES.contains(&entry.file_name().to_string_lossy().as_ref()))
        .take(MAX_ENTRIES)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::metadata(&path).ok()?;
            if !metadata.is_file() && !metadata.is_dir() {
                return None;
            }
            Some(FileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: relative_to_root(&root, &path).ok()?,
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                },
                size: metadata.len(),
                readonly: metadata.permissions().readonly(),
            })
        })
        .collect();
    Ok(FileList {
        path: relative_to_root(&root, &directory)?,
        entries,
        truncated,
    })
}

pub fn read_text_file(root: &Path, requested: &str) -> AppResult<FileContent> {
    let root = canonical_directory(root)?;
    let path = resolve_in_root(&root, requested)?;
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(AppError::BadRequest("Requested path is not a file".into()));
    }
    if metadata.len() > MAX_TEXT_FILE_SIZE {
        return Err(AppError::BadRequest(
            "File is larger than the 1 MiB preview limit".into(),
        ));
    }
    let bytes = fs::read(&path)?;
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return Err(AppError::BadRequest(
            "Binary files cannot be previewed as text".into(),
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| AppError::BadRequest("File is not valid UTF-8 text".into()))?;
    Ok(FileContent {
        path: relative_to_root(&root, &path)?,
        mime_type: mime_guess::from_path(&path)
            .first_or_text_plain()
            .essence_str()
            .to_owned(),
        content,
        size: metadata.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn lists_directories_before_files_and_ignores_build_folders() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("README.md"), "hello").unwrap();
        let list = list_directory(root.path(), ".").unwrap();
        assert_eq!(list.entries[0].name, "src");
        assert!(
            list.entries
                .iter()
                .all(|entry| entry.name != "node_modules")
        );
    }

    #[test]
    fn rejects_binary_previews() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("binary"), [1, 0, 2]).unwrap();
        assert!(matches!(
            read_text_file(root.path(), "binary"),
            Err(AppError::BadRequest(_))
        ));
    }
}
