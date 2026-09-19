//! `/api/workspaces/{id}/assets` — the whiteboard asset store: upload,
//! import from a path, and read-back.

use std::path::Path;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::HeaderMap,
    response::Response,
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, collab, db,
    error::{AppError, AppResult},
    remote,
    security::{canonical_directory, resolve_import_source},
};

/* --------------------------------- assets --------------------------------- */

/// What may be stored as a whiteboard asset, and the extension each type gets.
/// A whitelist rather than `mime_guess`: the extension ends up in a file name
/// and the type is echoed back as a `Content-Type`, so both have to come from
/// a table this file controls.
const ASSET_TYPES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/svg+xml", "svg"),
    ("image/avif", "avif"),
    ("image/bmp", "bmp"),
];

/// Same ceiling as the whiteboard snapshot (old canvas contract §6.2): an image
/// that
/// does not fit is one the user should not be pasting onto a board.
pub const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;

fn asset_extension(mime: &str) -> Option<&'static str> {
    let mime = mime.split(';').next()?.trim().to_ascii_lowercase();
    ASSET_TYPES
        .iter()
        .find(|(candidate, _)| *candidate == mime)
        .map(|(_, extension)| *extension)
}

/// The stored extension for a file on disk, or `None` when it is not one of
/// the eight image types. Folded onto the table's spelling — `jpeg` is stored
/// as `jpg`, exactly as `image/jpeg` is.
fn asset_extension_of_file(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let extension = if extension == "jpeg" {
        "jpg"
    } else {
        &extension
    };
    ASSET_TYPES
        .iter()
        .find(|(_, candidate)| *candidate == extension)
        .map(|(_, candidate)| *candidate)
}

fn asset_mime(extension: &str) -> Option<&'static str> {
    ASSET_TYPES
        .iter()
        .find(|(_, candidate)| *candidate == extension)
        .map(|(mime, _)| *mime)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAssetRequest {
    data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAssetResponse {
    /// `<sha256[..16]>.<ext>`; also the last path segment of `url`.
    id: String,
    /// Workspace-relative path, which is what an agent is handed.
    path: String,
    /// Runtime-relative URL. The client prefixes its own runtime origin — the
    /// runtime does not know which port it was actually bound to.
    url: String,
    mime_type: String,
    bytes: usize,
}

/// `POST /api/workspaces/{id}/assets` — old canvas contract §6.2.
///
/// Backs every picture that lands on a board. Two body shapes are accepted
/// because the client has two kinds of source: a `File`/`Blob` is posted raw
/// with its own `Content-Type`, while an already-decoded `data:` URL (paste,
/// drag from another page) is posted as `{"dataUrl": "…"}` with
/// `Content-Type: application/json`.
///
/// The stored name is the content hash, so re-uploading the same picture is a
/// no-op and two boards that paste the same screenshot share one file.
pub async fn upload_asset(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Json<UploadAssetResponse>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let (extension, bytes) = if content_type.starts_with("application/json") {
        let request: UploadAssetRequest = serde_json::from_slice(&body)
            .map_err(|_| AppError::BadRequest("Asset body is not a JSON data URL".into()))?;
        decode_asset_data_url(&request.data_url)?
    } else {
        let extension = asset_extension(content_type).ok_or_else(|| {
            AppError::BadRequest("Asset type is not an accepted image type".into())
        })?;
        (extension, body.to_vec())
    };
    // The store lives with the workspace. On a remote one the bytes are
    // streamed to the execution host and the dedupe is the same content
    // address, asked for over the wire instead of read off this disk.
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote_store(worker, &workspace, extension, &bytes)
            .await
            .map(Json);
    }
    let root = canonical_directory(&workspace.root_path)?;
    store_asset(&root, &workspace.id, extension, &bytes).map(Json)
}

/// The remote half of [`store_asset`].
///
/// Content addressing is what makes this safe to do in two steps: the name is
/// derived from the bytes, so asking whether it already exists and then
/// uploading it cannot race into a different file — the worst case is two
/// uploads of identical content, and the second one is refused as "already
/// there", which is the answer either way.
async fn remote_store(
    worker: &crate::remote::client::RemoteWorker,
    workspace: &crate::model::Workspace,
    extension: &str,
    bytes: &[u8],
) -> AppResult<UploadAssetResponse> {
    use sha2::{Digest, Sha256};

    if bytes.is_empty() {
        return Err(AppError::BadRequest("Asset is empty".into()));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AppError::BadRequest("Asset is too large".into()));
    }
    let id = format!("{}.{extension}", hex16(&Sha256::digest(bytes)));
    let path = format!("{ASSETS_DIRECTORY}/{id}");
    let known = remote::read::<_, crate::imports::FileInfo>(
        worker,
        workspace,
        armadra_protocol::v1::WorkerServiceOperation::FileInfo,
        &remote::service::PathPayload { path: path.clone() },
    )
    .await
    .is_ok();
    if !known {
        remote::upload::upload(
            worker,
            &workspace.id,
            &workspace.root_path,
            &path,
            bytes,
            // Create-only. A name that appeared between the check and the
            // upload holds the same bytes, so a conflict here is success.
            None,
        )
        .await
        .or_else(|error| match error {
            AppError::Conflict(_) => Ok(crate::remote::upload::Uploaded {
                path: path.clone(),
                sha256: String::new(),
                bytes: bytes.len(),
            }),
            other => Err(other),
        })?;
    }
    Ok(UploadAssetResponse {
        url: format!("/api/workspaces/{}/assets/{id}", workspace.id),
        mime_type: asset_mime(extension)
            .unwrap_or("application/octet-stream")
            .to_owned(),
        path,
        id,
        bytes: bytes.len(),
    })
}

/// Copy already-validated bytes into `<workspace>/.armadra/assets/` under their
/// content hash and describe where they landed.
///
/// Shared by the upload and the import route so the two dedupe against the same
/// file names and answer with the same shape; only how the bytes were obtained
/// differs.
fn store_asset(
    root: &Path,
    workspace_id: &str,
    extension: &str,
    bytes: &[u8],
) -> AppResult<UploadAssetResponse> {
    use sha2::{Digest, Sha256};

    if bytes.is_empty() {
        return Err(AppError::BadRequest("Asset is empty".into()));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AppError::BadRequest("Asset is too large".into()));
    }

    let id = format!("{}.{extension}", hex16(&Sha256::digest(bytes)));
    let path = root.join(ASSETS_DIRECTORY).join(&id);
    // Content-addressed: an identical upload is already on disk and rewriting
    // it would only risk tearing a file another tab is reading.
    if !path.is_file() {
        collab::context_link::write_export(&path, bytes)?;
    }
    Ok(UploadAssetResponse {
        url: format!("/api/workspaces/{workspace_id}/assets/{id}"),
        mime_type: asset_mime(extension)
            .unwrap_or("application/octet-stream")
            .to_owned(),
        path: format!("{ASSETS_DIRECTORY}/{id}"),
        id,
        bytes: bytes.len(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetRequest {
    path: String,
}

/// `POST /api/workspaces/{id}/assets/import` — old canvas contract §8, Phase 3.
///
/// The desktop shell only ever learns a real *path* for an OS drag: the webview
/// hands the shell the drop and keeps the bytes to itself, and the shell has no
/// filesystem plugin. So the runtime does the reading, and the picture ends up
/// in the same content-addressed store as an upload — identical response, same
/// dedupe, same `.armadra/assets/` file.
///
/// The type comes from the extension, because a file on disk carries no MIME.
pub async fn import_asset(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<ImportAssetRequest>,
) -> AppResult<remote::JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    // The path named here is a path on the machine the workspace executes on,
    // so the read, the type check and the dedupe all happen there.
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            armadra_protocol::v1::WorkerServiceOperation::AssetImport,
            &remote::service::assets::ImportAssetPayload {
                path: request.path,
                workspace_id: workspace.id.clone(),
            },
        )
        .await;
    }
    let root = canonical_directory(&workspace.root_path)?;
    let stored =
        tokio::task::spawn_blocking(move || import_asset_at(&root, &workspace.id, &request.path))
            .await??;
    remote::JsonAnswer::local(&stored)
}

/// Copy one already-on-disk image into `<root>/.armadra/assets/`.
///
/// Split out of the route because the execution host runs exactly this when a
/// remote workspace imports by path: same type table, same size ceiling, same
/// content-addressed name, so the answer is indistinguishable from a local
/// import except for which disk the bytes came off.
pub fn import_asset_at(
    root: &Path,
    workspace_id: &str,
    requested: &str,
) -> AppResult<UploadAssetResponse> {
    let source = resolve_import_source(root, requested)?;
    let extension = asset_extension_of_file(&source)
        .ok_or_else(|| AppError::BadRequest("Asset type is not an accepted image type".into()))?;

    // Ask the metadata first: a 4 GiB video should be refused, not read into
    // memory and then refused.
    let metadata = std::fs::metadata(&source)
        .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?;
    if metadata.len() > MAX_ASSET_BYTES as u64 {
        return Err(AppError::BadRequest("Asset is too large".into()));
    }
    let bytes = std::fs::read(&source)
        .map_err(|error| AppError::BadRequest(format!("Asset could not be read: {error}")))?;

    store_asset(root, workspace_id, extension, &bytes)
}

/// `GET /api/workspaces/{id}/assets/{assetId}` — serves an uploaded asset back.
///
/// The name is a content hash, so the bytes behind a given URL never change and
/// the response may be cached forever. The id is matched against the shape the
/// uploader mints rather than being resolved as a path, which is what keeps a
/// crafted id from reading somewhere else in the workspace.
pub async fn get_asset(
    State(state): State<AppState>,
    AxumPath((workspace_id, asset_id)): AxumPath<(String, String)>,
) -> AppResult<Response> {
    use axum::http::header;

    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    let (hash, extension) = asset_id
        .rsplit_once('.')
        .ok_or_else(|| AppError::BadRequest("Asset id is invalid".into()))?;
    let mime = asset_mime(extension).filter(|_| {
        hash.len() == 16 && hash.chars().all(|character| character.is_ascii_hexdigit())
    });
    let Some(mime) = mime else {
        return Err(AppError::BadRequest("Asset id is invalid".into()));
    };
    let relative = format!("{ASSETS_DIRECTORY}/{asset_id}");
    let bytes = match remote::resolve(&state, &workspace)?.remote() {
        // A board does not care which machine its pictures are on, so the
        // read follows the workspace rather than the controller's disk.
        Some(worker) => {
            remote::download::fetch(worker, &workspace, &relative)
                .await
                .map_err(|_| AppError::NotFound("Asset was not found".into()))?
                .bytes
        }
        None => {
            let root = canonical_directory(&workspace.root_path)?;
            std::fs::read(root.join(&relative))
                .map_err(|_| AppError::NotFound("Asset was not found".into()))?
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        // An SVG is served as an image and must never be sniffed into a
        // document; the header costs nothing on the other seven types.
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(bytes))
        .map_err(|error| AppError::Internal(error.to_string()))
}

/// Where uploaded assets live, relative to the workspace root.
pub const ASSETS_DIRECTORY: &str = ".armadra/assets";

fn hex16(digest: &[u8]) -> String {
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_asset_data_url(source: &str) -> AppResult<(&'static str, Vec<u8>)> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let rest = source
        .strip_prefix("data:")
        .ok_or_else(|| AppError::BadRequest("Asset is not a data URL".into()))?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| AppError::BadRequest("Asset is not a data URL".into()))?;
    let meta = meta
        .strip_suffix(";base64")
        .ok_or_else(|| AppError::BadRequest("Only base64 data URLs are accepted".into()))?;
    let extension = asset_extension(meta)
        .ok_or_else(|| AppError::BadRequest("Asset type is not an accepted image type".into()))?;
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| AppError::BadRequest("Asset is not valid base64".into()))?;
    Ok((extension, bytes))
}
