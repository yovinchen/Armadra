use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, relative_to_root, resolve_in_root, resolve_writable_in_root},
};

const MAX_ENTRIES: usize = 500;
const MAX_TEXT_FILE_SIZE: u64 = 1_048_576;
/// `PUT /api/workspaces/{id}/file` ceiling. The editor node refuses to open
/// anything above the 1 MiB preview limit, so this is only a backstop.
pub const MAX_WRITE_FILE_SIZE: u64 = 2 * 1_048_576;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub path: String,
    pub size: u64,
}

/// `PUT /api/workspaces/{id}/file`.
///
/// The body is JSON, so `content` is already valid UTF-8 by construction — no
/// binary payload can reach this function. The write is atomic: the bytes go to
/// a sibling temp file that is fsync'd and then renamed over the target, so a
/// crash mid-write leaves the previous contents intact rather than a truncated
/// file.
///
/// `expected_size` is an optimistic-concurrency token: when present the file
/// must exist with exactly that many bytes, otherwise the write is refused with
/// a conflict and the caller re-reads.
pub fn write_text_file(
    root: &Path,
    requested: &str,
    content: &str,
    expected_size: Option<u64>,
) -> AppResult<FileWriteResult> {
    let root = canonical_directory(root)?;
    let bytes = content.as_bytes();
    if bytes.len() as u64 > MAX_WRITE_FILE_SIZE {
        return Err(AppError::BadRequest(
            "File is larger than the 2 MiB write limit".into(),
        ));
    }
    let path = resolve_writable_in_root(&root, requested)?;

    if let Some(expected) = expected_size {
        let current = fs::symlink_metadata(&path).ok().map(|meta| meta.len());
        if current != Some(expected) {
            return Err(AppError::Conflict(
                "The file changed on disk since it was read".into(),
            ));
        }
    }

    let directory = path
        .parent()
        .ok_or_else(|| AppError::BadRequest("Requested path is invalid".into()))?;
    let temporary = temporary_sibling(&path);
    let write = (|| -> std::io::Result<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // Keep the mode of the file we are replacing; `File::create` would
        // otherwise reset an executable script to 0644.
        if let Ok(existing) = fs::metadata(&path) {
            let _ = fs::set_permissions(&temporary, existing.permissions());
        }
        fs::rename(&temporary, &path)
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::Io(error));
    }
    // Best effort: on most filesystems the rename is only durable once the
    // directory entry is flushed too. A failure here does not invalidate the
    // write, so it is not reported.
    if let Ok(handle) = File::open(directory) {
        let _ = handle.sync_all();
    }

    Ok(FileWriteResult {
        path: relative_to_root(&root, &path)?,
        size: bytes.len() as u64,
    })
}

/// `dir/.name.<pid>.<nanos>.armadra-tmp` — same directory, so the rename stays on
/// one filesystem and therefore stays atomic.
fn temporary_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let directory = path.parent().map(Path::to_path_buf).unwrap_or_default();
    directory.join(format!(
        ".{name}.{}.{stamp}.armadra-tmp",
        std::process::id()
    ))
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

    #[test]
    fn writes_new_and_existing_files_inside_the_root() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();

        let created = write_text_file(root.path(), "src/new.txt", "一行\n", None).unwrap();
        assert_eq!(created.path, "src/new.txt");
        assert_eq!(created.size, "一行\n".len() as u64);
        assert_eq!(
            fs::read_to_string(root.path().join("src/new.txt")).unwrap(),
            "一行\n"
        );

        let updated = write_text_file(root.path(), "src/new.txt", "two\n", None).unwrap();
        assert_eq!(updated.size, 4);
        // No temp file is left behind.
        let leftovers = fs::read_dir(root.path().join("src"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".armadra-tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn refuses_writes_outside_the_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();

        assert!(matches!(
            write_text_file(root.path(), "../secret.txt", "hacked", None),
            Err(AppError::BadRequest(_))
        ));
        assert!(
            write_text_file(
                root.path(),
                outside.path().join("secret.txt").to_str().unwrap(),
                "hacked",
                None,
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "keep\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_symlink() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("leak.txt"),
        )
        .unwrap();

        assert!(matches!(
            write_text_file(root.path(), "leak.txt", "hacked", None),
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn compare_and_swap_rejects_a_stale_expected_size() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("note.txt"), "one\n").unwrap();

        assert!(matches!(
            write_text_file(root.path(), "note.txt", "two\n", Some(99)),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "one\n"
        );

        let saved = write_text_file(root.path(), "note.txt", "two\n", Some(4)).unwrap();
        assert_eq!(saved.size, 4);

        // A file that does not exist yet can never satisfy a CAS token.
        assert!(matches!(
            write_text_file(root.path(), "fresh.txt", "x", Some(0)),
            Err(AppError::Conflict(_))
        ));
    }

    #[test]
    fn refuses_payloads_above_the_write_limit() {
        let root = tempdir().unwrap();
        let oversized = "a".repeat(MAX_WRITE_FILE_SIZE as usize + 1);
        assert!(matches!(
            write_text_file(root.path(), "big.txt", &oversized, None),
            Err(AppError::BadRequest(_))
        ));
        assert!(!root.path().join("big.txt").exists());
    }
}
