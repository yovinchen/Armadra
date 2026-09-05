//! File management for the editor and the file tree (E01/M4).
//!
//! Create, rename/move and delete, all inside one workspace and all behind the
//! workspace's write permission (checked by the caller in `api`).
//!
//! Deleting never removes bytes. The entry is **moved** into
//! `<workspace>/.armadra/trash/<id>/` next to a small `entry.json` describing
//! where it came from, and [`restore_trash`] puts it back. A permanent delete
//! is deliberately not offered: a canvas node must not be able to destroy work
//! that nothing else in the product can recover.
//!
//! Path rules, in one place because every operation shares them:
//!
//! * The path is workspace-relative, normalized, and free of `..` — the same
//!   [`workspace_relative_path`] the writer uses.
//! * The **parent** is canonicalized through [`resolve_in_root`], so a
//!   symlinked directory above the target cannot lead outside the workspace.
//! * The target itself is examined with `symlink_metadata`: a symbolic link is
//!   refused outright rather than operated on, because renaming or trashing
//!   through a link would move whatever it points at.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, relative_to_root, resolve_in_root, workspace_relative_path},
};

/// Where deleted entries wait to be restored.
pub const TRASH_DIRECTORY: &str = ".armadra/trash";
/// A single trashed entry may not be restored over something newer.
const MANIFEST: &str = "entry.json";
/// The moved file or folder keeps its own name under this sub-directory, so a
/// restore is a plain rename and the manifest can never collide with it.
const PAYLOAD: &str = "payload";
/// How many trashed entries `list_trash` reports. Enough for an undo panel,
/// bounded so a long-running workspace cannot produce an unbounded response.
const MAX_TRASH_ENTRIES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryResult {
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    /// Where it was when it was deleted, relative to the workspace root.
    pub original_path: String,
    pub name: String,
    pub kind: EntryKind,
    /// RFC 3339.
    pub deleted_at: String,
}

/* --------------------------------- resolving ------------------------------ */

/// Split a workspace-relative path into (normalized relative, absolute) with
/// the parent canonicalized. The target does **not** have to exist.
///
/// The relative half is recomputed from the canonical parent, so a symlinked
/// directory on the way down is reported at the place the bytes actually live
/// rather than at the path that was typed.
fn resolve_target(root: &Path, requested: &str) -> AppResult<(String, PathBuf)> {
    let relative = workspace_relative_path(requested)?;
    let (parent, name) = match relative.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => (".", relative.as_str()),
    };
    if name.is_empty() || name == "." || name == ".." {
        return Err(AppError::BadRequest("Requested path is invalid".into()));
    }
    let directory = resolve_in_root(root, parent)?;
    if !directory.is_dir() {
        return Err(AppError::BadRequest(
            "The parent directory does not exist".into(),
        ));
    }
    let path = directory.join(name);
    Ok((relative_to_root(root, &path)?, path))
}

/// As [`resolve_target`], but the entry must already exist as a regular file or
/// a directory. Symbolic links are refused.
fn resolve_existing(root: &Path, requested: &str) -> AppResult<(String, PathBuf, EntryKind)> {
    let (relative, path) = resolve_target(root, requested)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::Forbidden(
            "Symbolic links cannot be renamed or deleted from here".into(),
        ));
    }
    let kind = if metadata.is_dir() {
        EntryKind::Directory
    } else if metadata.is_file() {
        EntryKind::File
    } else {
        return Err(AppError::BadRequest(
            "Only regular files and folders can be managed".into(),
        ));
    };
    Ok((relative, path, kind))
}

/// A single path segment that may be created. Mirrors
/// `security::valid_directory_name` but also refuses the names our own
/// bookkeeping uses.
fn valid_entry_name(name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.chars().count() > 200
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.ends_with(".armadra-tmp")
        || name.chars().any(char::is_control)
    {
        return Err(AppError::BadRequest("That name is not allowed".into()));
    }
    Ok(())
}

/// The `.armadra` folder is ours. Refusing to create, rename or delete inside
/// it keeps the trash, the imports and the assets from being edited through
/// the same surface that produced them.
fn refuse_reserved(relative: &str) -> AppResult<()> {
    if relative == ".armadra" || relative.starts_with(".armadra/") {
        return Err(AppError::Forbidden(
            "The .armadra folder is managed by Armadra".into(),
        ));
    }
    Ok(())
}

/* --------------------------------- operations ----------------------------- */

/// 新建文件 / 新建文件夹. An existing name is a 409, never an overwrite.
pub fn create_entry(root: &Path, requested: &str, kind: EntryKind) -> AppResult<EntryResult> {
    let root = canonical_directory(root)?;
    let (relative, path) = resolve_target(&root, requested)?;
    refuse_reserved(&relative)?;
    valid_entry_name(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
    )?;
    if path.symlink_metadata().is_ok() {
        return Err(AppError::Conflict(
            "A file or folder with that name already exists".into(),
        ));
    }
    match kind {
        EntryKind::Directory => fs::create_dir(&path)?,
        EntryKind::File => {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            options.open(&path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::Conflict("A file with that name already exists".into())
                } else {
                    error.into()
                }
            })?;
        }
    }
    Ok(EntryResult {
        path: relative,
        kind,
    })
}

/// 重命名 / 移动. Both are the same operation; only the destination differs.
///
/// The destination must be free — a rename never overwrites — and a directory
/// may not be moved inside itself.
pub fn rename_entry(root: &Path, from: &str, to: &str) -> AppResult<EntryResult> {
    let root = canonical_directory(root)?;
    let (source_relative, source, kind) = resolve_existing(&root, from)?;
    let (target_relative, target) = resolve_target(&root, to)?;
    refuse_reserved(&source_relative)?;
    refuse_reserved(&target_relative)?;
    valid_entry_name(
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
    )?;
    // Renaming a path onto itself is a no-op, not a conflict: the editor may
    // submit the unchanged name when a rename dialog is confirmed untouched.
    if source_relative == target_relative {
        return Ok(EntryResult {
            path: target_relative,
            kind,
        });
    }
    if target_relative.starts_with(&format!("{source_relative}/")) {
        return Err(AppError::BadRequest(
            "A folder cannot be moved inside itself".into(),
        ));
    }
    if target.symlink_metadata().is_ok() {
        return Err(AppError::Conflict(
            "A file or folder with that name already exists".into(),
        ));
    }
    fs::rename(&source, &target)?;
    Ok(EntryResult {
        path: target_relative,
        kind,
    })
}

fn trash_root(root: &Path) -> PathBuf {
    root.join(TRASH_DIRECTORY)
}

/// 删除到回收站. The entry is moved, never unlinked, and the manifest records
/// where it came from so [`restore_trash`] can put it back.
pub fn trash_entry(root: &Path, requested: &str) -> AppResult<TrashEntry> {
    let root = canonical_directory(root)?;
    let (relative, path, kind) = resolve_existing(&root, requested)?;
    refuse_reserved(&relative)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::BadRequest("Requested path is invalid".into()))?
        .to_owned();
    let id = uuid::Uuid::new_v4().to_string();
    let slot = trash_root(&root).join(&id);
    fs::create_dir_all(slot.join(PAYLOAD))?;
    let entry = TrashEntry {
        id,
        original_path: relative,
        name: name.clone(),
        kind,
        deleted_at: chrono::Utc::now().to_rfc3339(),
    };
    // Move first: a manifest describing something still in place would be a
    // lie if the rename then failed.
    fs::rename(&path, slot.join(PAYLOAD).join(&name)).inspect_err(|_| {
        let _ = fs::remove_dir_all(&slot);
    })?;
    fs::write(
        slot.join(MANIFEST),
        serde_json::to_vec_pretty(&entry)
            .map_err(|_| AppError::Internal("Cannot record the deleted entry".into()))?,
    )?;
    Ok(entry)
}

/// What is currently recoverable, newest first.
pub fn list_trash(root: &Path) -> AppResult<Vec<TrashEntry>> {
    let root = canonical_directory(root)?;
    let directory = trash_root(&root);
    let Ok(reader) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let mut entries: Vec<TrashEntry> = reader
        .filter_map(Result::ok)
        .filter_map(|slot| fs::read(slot.path().join(MANIFEST)).ok())
        .filter_map(|bytes| serde_json::from_slice::<TrashEntry>(&bytes).ok())
        .collect();
    entries.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    entries.truncate(MAX_TRASH_ENTRIES);
    Ok(entries)
}

/// Put a trashed entry back where it came from.
///
/// The original location must be free again and its parent must still exist;
/// a restore never overwrites and never recreates a directory tree that the
/// user has since removed.
pub fn restore_trash(root: &Path, id: &str) -> AppResult<EntryResult> {
    let root = canonical_directory(root)?;
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(AppError::BadRequest("Unknown deleted entry".into()));
    }
    let slot = trash_root(&root).join(id);
    let entry: TrashEntry = fs::read(slot.join(MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| AppError::NotFound("Unknown deleted entry".into()))?;
    let (relative, target) = resolve_target(&root, &entry.original_path)?;
    refuse_reserved(&relative)?;
    if target.symlink_metadata().is_ok() {
        return Err(AppError::Conflict(
            "Something else already occupies the original location".into(),
        ));
    }
    fs::rename(slot.join(PAYLOAD).join(&entry.name), &target)?;
    let _ = fs::remove_dir_all(&slot);
    Ok(EntryResult {
        path: relative,
        kind: entry.kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_files_and_folders_but_never_overwrites() {
        let root = tempdir().unwrap();
        let file = create_entry(root.path(), "notes.txt", EntryKind::File).unwrap();
        assert_eq!(file.path, "notes.txt");
        assert!(root.path().join("notes.txt").is_file());

        let folder = create_entry(root.path(), "src", EntryKind::Directory).unwrap();
        assert_eq!(folder.kind, EntryKind::Directory);
        assert!(root.path().join("src").is_dir());

        fs::write(root.path().join("notes.txt"), "keep").unwrap();
        assert!(matches!(
            create_entry(root.path(), "notes.txt", EntryKind::File),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn refuses_escapes_reserved_folders_and_missing_parents() {
        let root = tempdir().unwrap();
        for bad in ["../outside.txt", "/etc/hosts", "a/../../escape"] {
            assert!(
                matches!(
                    create_entry(root.path(), bad, EntryKind::File),
                    Err(AppError::BadRequest(_))
                ),
                "{bad} must be refused"
            );
        }
        assert!(matches!(
            create_entry(root.path(), "missing/child.txt", EntryKind::File),
            Err(AppError::NotFound(_))
        ));
        fs::create_dir_all(root.path().join(".armadra")).unwrap();
        assert!(matches!(
            create_entry(root.path(), ".armadra/sneak.txt", EntryKind::File),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn renames_and_moves_without_clobbering() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("a.txt"), "one").unwrap();
        fs::write(root.path().join("b.txt"), "two").unwrap();

        let moved = rename_entry(root.path(), "a.txt", "src/a.txt").unwrap();
        assert_eq!(moved.path, "src/a.txt");
        assert_eq!(
            fs::read_to_string(root.path().join("src/a.txt")).unwrap(),
            "one"
        );
        assert!(!root.path().join("a.txt").exists());

        assert!(matches!(
            rename_entry(root.path(), "src/a.txt", "b.txt"),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "two"
        );

        assert!(matches!(
            rename_entry(root.path(), "src", "src/inner"),
            Err(AppError::BadRequest(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_rename_or_trash_through_a_symlink() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("leak.txt"),
        )
        .unwrap();

        assert!(matches!(
            rename_entry(root.path(), "leak.txt", "moved.txt"),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            trash_entry(root.path(), "leak.txt"),
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn trashing_moves_the_bytes_and_restores_them() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/note.txt"), "content").unwrap();

        let entry = trash_entry(root.path(), "src/note.txt").unwrap();
        assert_eq!(entry.original_path, "src/note.txt");
        assert_eq!(entry.kind, EntryKind::File);
        assert!(!root.path().join("src/note.txt").exists());
        // The bytes are still there, under the trash slot.
        assert_eq!(
            fs::read_to_string(
                root.path()
                    .join(TRASH_DIRECTORY)
                    .join(&entry.id)
                    .join(PAYLOAD)
                    .join("note.txt"),
            )
            .unwrap(),
            "content"
        );

        let listed = list_trash(root.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, entry.id);

        let restored = restore_trash(root.path(), &entry.id).unwrap();
        assert_eq!(restored.path, "src/note.txt");
        assert_eq!(
            fs::read_to_string(root.path().join("src/note.txt")).unwrap(),
            "content"
        );
        assert!(list_trash(root.path()).unwrap().is_empty());
    }

    #[test]
    fn trashes_folders_and_refuses_to_restore_over_a_new_file() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("old/deep")).unwrap();
        fs::write(root.path().join("old/deep/x.txt"), "x").unwrap();

        let entry = trash_entry(root.path(), "old").unwrap();
        assert_eq!(entry.kind, EntryKind::Directory);
        assert!(!root.path().join("old").exists());

        fs::create_dir(root.path().join("old")).unwrap();
        assert!(matches!(
            restore_trash(root.path(), &entry.id),
            Err(AppError::Conflict(_))
        ));
        // Nothing was lost by the refused restore.
        assert!(
            root.path()
                .join(TRASH_DIRECTORY)
                .join(&entry.id)
                .join(PAYLOAD)
                .join("old/deep/x.txt")
                .is_file()
        );
    }

    #[test]
    fn unknown_trash_ids_are_refused_without_touching_the_filesystem() {
        let root = tempdir().unwrap();
        assert!(matches!(
            restore_trash(root.path(), "../../etc"),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            restore_trash(root.path(), "0198f000-0000-7000-8000-000000000000"),
            Err(AppError::NotFound(_))
        ));
    }
}
