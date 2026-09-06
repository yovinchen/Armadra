//! File management on the execution host (design §3.1).
//!
//! Creating, renaming, moving, deleting and restoring all resolve inside the
//! frozen root on the machine that owns the files. Deleting still means moving
//! under that host's own `.armadra/trash/<id>/`: nothing here unlinks, and the
//! trash a remote workspace restores from is the remote one.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{error::AppResult, file_ops, imports, remote::service::blocking};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEntryPayload {
    pub path: String,
    pub kind: file_ops::EntryKind,
}

/// A rename and a move are the same filesystem operation and the same
/// boundary check; they differ only in whether the parent directory changed,
/// which is what the two operation numbers record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryPayload {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEntryPayload {
    pub id: String,
}

/// Nothing but the root: the trash listing takes no arguments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrashListPayload {}

pub async fn info(root: PathBuf, path: String) -> AppResult<Vec<u8>> {
    blocking(move || imports::file_info(&root, &path)).await
}

pub async fn create(root: PathBuf, payload: CreateEntryPayload) -> AppResult<Vec<u8>> {
    blocking(move || file_ops::create_entry(&root, &payload.path, payload.kind)).await
}

pub async fn rename(root: PathBuf, payload: RenameEntryPayload) -> AppResult<Vec<u8>> {
    blocking(move || file_ops::rename_entry(&root, &payload.from, &payload.to)).await
}

pub async fn trash(root: PathBuf, path: String) -> AppResult<Vec<u8>> {
    blocking(move || file_ops::trash_entry(&root, &path)).await
}

pub async fn list_trash(root: PathBuf) -> AppResult<Vec<u8>> {
    blocking(move || file_ops::list_trash(&root)).await
}

pub async fn restore(root: PathBuf, payload: RestoreEntryPayload) -> AppResult<Vec<u8>> {
    blocking(move || file_ops::restore_trash(&root, &payload.id)).await
}
