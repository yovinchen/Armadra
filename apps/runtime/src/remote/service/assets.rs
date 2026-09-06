//! Whiteboard assets on the execution host (design §3.2).
//!
//! An import names a path, and that path is on the execution host — the
//! desktop shell only ever learns a real path for an OS drag, and on a remote
//! workspace the drag came from the machine the files are on. So the read, the
//! type check, the size ceiling and the content-addressed dedupe all happen
//! there, and the answer is the same `UploadAssetResponse` a local import
//! produces.
//!
//! Bytes that came from a browser take the other road: they are already in the
//! controller's memory, so they travel as `WorkerUploadRequest` chunks and the
//! controller does the dedupe by asking whether the content-addressed name
//! already exists.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{error::AppResult, remote::service::blocking};

/// The workspace id travels with the request because the answer contains the
/// asset's URL, and that URL is a controller route. The Worker has no
/// workspace table to look it up in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetPayload {
    pub path: String,
    pub workspace_id: String,
}

pub async fn import(root: PathBuf, payload: ImportAssetPayload) -> AppResult<Vec<u8>> {
    blocking(move || {
        crate::api::assets::import_asset_at(&root, &payload.workspace_id, &payload.path)
    })
    .await
}
