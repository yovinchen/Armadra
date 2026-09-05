use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, relative_to_root, resolve_in_root},
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

/// UTF-8 byte order mark. Stripped from `content` and reported separately, so
/// the editor never shows it as a stray character and a save can put it back.
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub mime_type: String,
    pub content: String,
    pub size: u64,
    /// The content version for the next save. Absent when the file is not
    /// valid UTF-8: what the editor shows is a lossy reading, and writing it
    /// back would silently rewrite bytes it never saw (E01/M4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// `utf-8` or `unknown`; `unknown` means read-only.
    pub encoding: &'static str,
    /// The file starts with a UTF-8 BOM. Stripped from `content`; a save that
    /// passes `bom: true` writes it again.
    pub bom: bool,
    /// `lf`, `crlf`, `mixed`, or `none` for a file without a line break.
    pub eol: &'static str,
    /// The file cannot be written where it is, whatever the workspace allows.
    pub readonly: bool,
}

/// Which line ending the file uses. `mixed` is reported rather than guessed:
/// the editor says so instead of quietly normalizing a file on the next save.
fn detect_eol(bytes: &[u8]) -> &'static str {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        if index > 0 && bytes[index - 1] == b'\r' {
            crlf += 1;
        } else {
            lf += 1;
        }
    }
    match (crlf, lf) {
        (0, 0) => "none",
        (0, _) => "lf",
        (_, 0) => "crlf",
        _ => "mixed",
    }
}

pub fn list_directory(root: &Path, requested: &str) -> AppResult<FileList> {
    let root = canonical_directory(root)?;
    let directory = resolve_in_root(&root, requested)?;
    if !directory.is_dir() {
        return Err(AppError::BadRequest(
            "Requested path is not a directory".into(),
        ));
    }
    let paths = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    let mut entries: Vec<FileEntry> = paths
        .into_iter()
        .filter(|entry| !IGNORED_NAMES.contains(&entry.file_name().to_string_lossy().as_ref()))
        .filter_map(|entry| {
            let path = entry.path();
            // Resolve scope before exposing target metadata. A symlink inside
            // the workspace must not disclose the type or size of outside files.
            let target = resolve_in_root(&root, path.to_str()?).ok()?;
            let metadata = fs::metadata(&target).ok()?;
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
    entries.sort_by(|left, right| {
        (left.kind != "directory", &left.name).cmp(&(right.kind != "directory", &right.name))
    });
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
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
    let mut bytes = Vec::new();
    File::open(&path)?
        .take(MAX_TEXT_FILE_SIZE + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_TEXT_FILE_SIZE {
        return Err(AppError::BadRequest(
            "File exceeds the preview limit".into(),
        ));
    }
    let size = bytes.len() as u64;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return Err(AppError::BadRequest(
            "Binary files cannot be previewed as text".into(),
        ));
    }
    let eol = detect_eol(&bytes);
    let bom = bytes.starts_with(&UTF8_BOM);
    let body = if bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        &bytes[..]
    };
    // A file that is not valid UTF-8 is still worth showing. It comes back as
    // a lossy reading with no content version, which is exactly what the
    // editor already treats as read-only (E01/M4).
    let (content, encoding) = match std::str::from_utf8(body) {
        Ok(text) => (text.to_owned(), "utf-8"),
        Err(_) => (String::from_utf8_lossy(body).into_owned(), "unknown"),
    };
    Ok(FileContent {
        path: relative_to_root(&root, &path)?,
        mime_type: mime_guess::from_path(&path)
            .first_or_text_plain()
            .essence_str()
            .to_owned(),
        content,
        size,
        sha256: (encoding == "utf-8").then_some(sha256),
        encoding,
        bom,
        eol,
        readonly: metadata.permissions().readonly(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

// Application writers share a gate; external editors are still checked just
// before publication. Filesystems do not provide a cross-process content CAS.
static FILE_WRITERS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn file_gate(path: &Path) -> AppResult<Arc<Mutex<()>>> {
    let mut gates = FILE_WRITERS
        .lock()
        .map_err(|_| AppError::Internal("File gate unavailable".into()))?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    Ok(gates
        .entry(path.to_owned())
        .or_default()
        .upgrade()
        .unwrap_or_else(|| {
            let gate = Arc::new(Mutex::new(()));
            gates.insert(path.to_owned(), Arc::downgrade(&gate));
            gate
        }))
}
fn writable_path(root: &Path, requested: &str) -> AppResult<PathBuf> {
    let relative = Path::new(requested);
    if requested.is_empty()
        || requested.len() > 32768
        || relative.is_absolute()
        || !relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err(AppError::BadRequest(
            "A literal workspace-relative file path is required".into(),
        ));
    }
    let name = relative
        .file_name()
        .ok_or_else(|| AppError::BadRequest("File name is missing".into()))?;
    let parent = relative
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = resolve_in_root(
        root,
        parent
            .to_str()
            .ok_or_else(|| AppError::BadRequest("Path must be Unicode".into()))?,
    )?;
    if !parent.is_dir() {
        return Err(AppError::BadRequest(
            "File parent is not a directory".into(),
        ));
    }
    Ok(parent.join(name))
}
fn current_version(path: &Path) -> AppResult<Option<(String, std::fs::Permissions)>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(AppError::Forbidden(
            "Writing through a symbolic link is not allowed".into(),
        ));
    }
    if !metadata.is_file() {
        return Err(AppError::BadRequest(
            "Only regular files can be replaced".into(),
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::BadRequest(
            "Only regular files can be replaced".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_WRITE_FILE_SIZE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_WRITE_FILE_SIZE {
        return Err(AppError::BadRequest(
            "Existing file exceeds the write limit".into(),
        ));
    }
    Ok(Some((
        format!("{:x}", Sha256::digest(&bytes)),
        metadata.permissions(),
    )))
}
fn verify_version(path: &Path, expected: Option<&str>) -> AppResult<Option<std::fs::Permissions>> {
    let current = current_version(path)?;
    if current.as_ref().map(|(hash, _)| hash.as_str()) != expected {
        return Err(AppError::Conflict(
            "File content changed; reload or compare the disk version before saving".into(),
        ));
    }
    Ok(current.map(|(_, permissions)| permissions))
}

/// A missing version means create-only. Existing files require the SHA-256
/// returned by read_text_file; size alone cannot detect same-length edits.
/// A sibling temporary file is exclusive, fsynced and published atomically.
/// The last verification detects observed external writes, not an OS-wide lock.
///
/// `bom` re-emits the byte order mark `read_text_file` stripped, so a file that
/// arrived with one keeps it. Line endings are not rewritten: the editor holds
/// whatever the file contained and hands it back unchanged (E01/M4).
pub fn write_text_file(
    root: &Path,
    requested: &str,
    content: &str,
    expected_sha256: Option<&str>,
    bom: bool,
) -> AppResult<FileWriteResult> {
    let root = canonical_directory(root)?;
    let payload;
    let bytes: &[u8] = if bom {
        payload = [&UTF8_BOM[..], content.as_bytes()].concat();
        &payload
    } else {
        content.as_bytes()
    };
    if bytes.len() as u64 > MAX_WRITE_FILE_SIZE {
        return Err(AppError::BadRequest(
            "File is larger than the 2 MiB write limit".into(),
        ));
    }
    if expected_sha256
        .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(AppError::BadRequest(
            "A valid content version is required".into(),
        ));
    }
    let expected = expected_sha256.map(str::to_ascii_lowercase);
    let path = writable_path(&root, requested)?;
    let gate = file_gate(&path)?;
    let _guard = gate
        .lock()
        .map_err(|_| AppError::Internal("File writer unavailable".into()))?;
    let permissions = verify_version(&path, expected.as_deref())?;
    if permissions.as_ref().is_some_and(|value| value.readonly()) {
        return Err(AppError::Forbidden("File is read-only".into()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::BadRequest("File parent is missing".into()))?;
    let temporary = parent.join(format!(".{}.armadra-tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| -> AppResult<FileWriteResult> {
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&temporary, permissions)?;
        }
        if writable_path(&root, requested)? != path {
            return Err(AppError::Conflict("File parent changed during save".into()));
        }
        verify_version(&path, expected.as_deref())?;
        // Claim the hash *before* it is on disk: the filesystem event of our
        // own save must never race ahead of the record that identifies it
        // (E01/M4). A write that fails after this only leaves a hash nothing
        // matches, which the next real change still differs from.
        crate::file_watch::note_write(&path, &format!("{:x}", Sha256::digest(bytes)));
        if expected.is_none() {
            fs::hard_link(&temporary, &path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::Conflict("File was created by another writer".into())
                } else {
                    error.into()
                }
            })?;
        } else {
            fs::rename(&temporary, &path)?;
        }
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(FileWriteResult {
            path: relative_to_root(&root, &path)?,
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        })
    })();
    drop(file);
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// The content version a previous write published, as the next write's CAS
    /// token. A write always has one; only a read of a non-UTF-8 file does not.
    fn version(result: &FileWriteResult) -> Option<&str> {
        Some(result.sha256.as_str())
    }

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

        let created = write_text_file(root.path(), "src/new.txt", "一行\n", None, false).unwrap();
        assert_eq!(created.path, "src/new.txt");
        assert_eq!(created.size, "一行\n".len() as u64);
        assert_eq!(
            fs::read_to_string(root.path().join("src/new.txt")).unwrap(),
            "一行\n"
        );

        let updated = write_text_file(
            root.path(),
            "src/new.txt",
            "two\n",
            version(&created),
            false,
        )
        .unwrap();
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
            write_text_file(root.path(), "../secret.txt", "hacked", None, false),
            Err(AppError::BadRequest(_))
        ));
        assert!(
            write_text_file(
                root.path(),
                outside.path().join("secret.txt").to_str().unwrap(),
                "hacked",
                None,
                false,
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
            write_text_file(root.path(), "leak.txt", "hacked", None, false),
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn content_version_rejects_stale_and_missing_files() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("note.txt"), "one\n").unwrap();

        assert!(matches!(
            write_text_file(
                root.path(),
                "note.txt",
                "two\n",
                Some(&"0".repeat(64)),
                false
            ),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "one\n"
        );

        let saved = write_text_file(
            root.path(),
            "note.txt",
            "two\n",
            read_text_file(root.path(), "note.txt")
                .unwrap()
                .sha256
                .as_deref(),
            false,
        )
        .unwrap();
        assert_eq!(saved.size, 4);

        // A file that does not exist yet can never satisfy a CAS token.
        assert!(matches!(
            write_text_file(root.path(), "fresh.txt", "x", Some(&"0".repeat(64)), false),
            Err(AppError::Conflict(_))
        ));
    }

    #[test]
    fn detects_same_length_external_changes_and_requires_a_version() {
        let root = tempdir().unwrap();
        let file = root.path().join("note.txt");
        fs::write(&file, "old").unwrap();
        let original = read_text_file(root.path(), "note.txt").unwrap();
        fs::write(&file, "new").unwrap();
        assert!(matches!(
            write_text_file(
                root.path(),
                "note.txt",
                "mine",
                original.sha256.as_deref(),
                false
            ),
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            write_text_file(root.path(), "note.txt", "mine", None, false),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(fs::read_to_string(file).unwrap(), "new");
    }

    #[test]
    fn simultaneous_writers_cannot_both_replace_the_same_version() {
        let root = tempdir().unwrap();
        let first = write_text_file(root.path(), "note.txt", "start", None, false).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = ["first", "other"]
            .into_iter()
            .map(|text| {
                let root = root.path().to_owned();
                let barrier = barrier.clone();
                let hash = first.sha256.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    write_text_file(&root, "note.txt", text, Some(&hash), false)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(AppError::Conflict(_))))
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn literal_whitespace_names_remain_distinct_and_readonly_files_are_preserved() {
        let root = tempdir().unwrap();
        write_text_file(root.path(), "note", "plain", None, false).unwrap();
        let spaced = write_text_file(root.path(), " note ", "space", None, false).unwrap();
        assert_eq!(
            read_text_file(root.path(), " note ").unwrap().sha256,
            Some(spaced.sha256.clone())
        );
        assert_eq!(
            fs::read_to_string(root.path().join("note")).unwrap(),
            "plain"
        );
        let path = root.path().join(" note ");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(matches!(
            write_text_file(root.path(), " note ", "later", version(&spaced), false),
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "space");
    }

    #[test]
    fn reports_line_endings_bom_and_encoding() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("unix.txt"), "a\nb\n").unwrap();
        fs::write(root.path().join("dos.txt"), "a\r\nb\r\n").unwrap();
        fs::write(root.path().join("mixed.txt"), "a\r\nb\n").unwrap();
        fs::write(root.path().join("one.txt"), "no break").unwrap();
        fs::write(
            root.path().join("bom.txt"),
            [&UTF8_BOM[..], b"hello\n"].concat(),
        )
        .unwrap();
        // 0xFF is not valid UTF-8 anywhere and is not a NUL, so this reaches
        // the encoding check rather than the binary one.
        fs::write(root.path().join("latin.txt"), [b'a', 0xFF, b'\n']).unwrap();

        assert_eq!(read_text_file(root.path(), "unix.txt").unwrap().eol, "lf");
        assert_eq!(read_text_file(root.path(), "dos.txt").unwrap().eol, "crlf");
        assert_eq!(
            read_text_file(root.path(), "mixed.txt").unwrap().eol,
            "mixed"
        );
        assert_eq!(read_text_file(root.path(), "one.txt").unwrap().eol, "none");

        let bom = read_text_file(root.path(), "bom.txt").unwrap();
        assert!(bom.bom);
        assert_eq!(bom.content, "hello\n");
        assert_eq!(bom.encoding, "utf-8");
        assert!(bom.sha256.is_some());

        // Not UTF-8: shown, but with no content version, which is what makes
        // the editor read-only.
        let latin = read_text_file(root.path(), "latin.txt").unwrap();
        assert_eq!(latin.encoding, "unknown");
        assert!(latin.sha256.is_none());
    }

    #[test]
    fn a_bom_survives_a_round_trip() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("bom.txt"),
            [&UTF8_BOM[..], b"one\n"].concat(),
        )
        .unwrap();
        let read = read_text_file(root.path(), "bom.txt").unwrap();
        write_text_file(
            root.path(),
            "bom.txt",
            "two\n",
            read.sha256.as_deref(),
            read.bom,
        )
        .unwrap();
        assert_eq!(
            fs::read(root.path().join("bom.txt")).unwrap(),
            [&UTF8_BOM[..], b"two\n"].concat()
        );
        assert!(read_text_file(root.path(), "bom.txt").unwrap().bom);
    }

    #[test]
    fn refuses_payloads_above_the_write_limit() {
        let root = tempdir().unwrap();
        let oversized = "a".repeat(MAX_WRITE_FILE_SIZE as usize + 1);
        assert!(matches!(
            write_text_file(root.path(), "big.txt", &oversized, None, false),
            Err(AppError::BadRequest(_))
        ));
        assert!(!root.path().join("big.txt").exists());
    }
}
