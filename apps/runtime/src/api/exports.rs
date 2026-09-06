//! `POST /api/workspaces/{id}/export/png` — writing a board export to the
//! workspace's export directory.

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, collab, db,
    error::{AppError, AppResult},
    security::canonical_directory,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPngRequest {
    data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPngResponse {
    /// Absolute path, which is what an agent is told to open.
    path: String,
    /// The same file relative to the workspace root, which is what a
    /// `ContextLink.content.pngPath` carries
    /// (docs/design/canvas-react-flow.md §2.5).
    relative_path: String,
    bytes: usize,
}

/// Only a base64 PNG is accepted, and only up to this many characters of it.
/// A 480×360 whiteboard is a few tens of kilobytes; the cap is there so a
/// runaway client cannot fill the workspace.
const MAX_EXPORT_PNG_BYTES: usize = 8 * 1024 * 1024;
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";

/// `POST /api/workspaces/{id}/exports/{exportId}/png` —
/// docs/design/canvas-react-flow.md §2.5.
///
/// Whatever is on the whiteboard — ink, a geo shape, a whole frame — only
/// exists as vectors inside the browser's whiteboard document, so the one party
/// that can rasterise it is the client. It uploads the PNG as a data URL and
/// the runtime drops the bytes at
/// `<workspace>/.armadra/exports/<exportId>.png`, which is the path a linked
/// agent is handed.
///
/// The export id is *not* required to be a node: the thing being exported is
/// usually a plain whiteboard item, which has no row anywhere. It only has to
/// be a uuid, which is what keeps the file name from being a path.
pub async fn export_png(
    State(state): State<AppState>,
    AxumPath((workspace_id, export_id)): AxumPath<(String, String)>,
    Json(request): Json<ExportPngRequest>,
) -> AppResult<Json<ExportPngResponse>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    write_png_export(&workspace.root_path, &export_id, &request.data_url)
}

fn write_png_export(
    root_path: &str,
    export_id: &str,
    data_url: &str,
) -> AppResult<Json<ExportPngResponse>> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    // The id becomes a file name, so it has to be an id and nothing else.
    if uuid::Uuid::parse_str(export_id).is_err() {
        return Err(AppError::BadRequest("Export id is invalid".into()));
    }
    if data_url.len() > MAX_EXPORT_PNG_BYTES {
        return Err(AppError::BadRequest("Exported image is too large".into()));
    }
    let payload = data_url
        .strip_prefix(PNG_DATA_URL_PREFIX)
        .ok_or_else(|| AppError::BadRequest("Only base64 PNG data URLs are accepted".into()))?;
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| AppError::BadRequest("Exported image is not valid base64".into()))?;

    let root = canonical_directory(root_path)?;
    let path = collab::context_link::export_path(&root, export_id);
    collab::context_link::write_export(&path, &bytes)?;
    Ok(Json(ExportPngResponse {
        relative_path: format!(
            "{}/{export_id}.png",
            collab::context_link::EXPORTS_DIRECTORY
        ),
        path: path.to_string_lossy().into_owned(),
        bytes: bytes.len(),
    }))
}
