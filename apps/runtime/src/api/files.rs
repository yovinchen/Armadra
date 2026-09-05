//! `/api/workspaces/{id}/files` — browsing, reading, writing, uploading and
//! trashing workspace files, plus the file-watch subscriptions.

use std::path::Path;

use armadra_protocol::v1::WorkerServiceOperation;
use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
    response::Response,
};
use serde::{Deserialize, Serialize};

use super::support::{default_path, readable_workspace, writable_workspace};
use crate::{
    AppState, db,
    error::{AppError, AppResult},
    file_ops, file_watch, files, imports,
    remote::{self, JsonAnswer},
    security::resolve_in_root,
};

#[derive(Deserialize)]
pub struct RequestedPath {
    #[serde(default = "default_path")]
    path: String,
}

pub async fn list_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    // `WorkerDirectory` and `files::FileList` are the same shape, so a remote
    // listing needs no second contract: the typed Worker message is mapped
    // straight back into the answer the canvas already reads.
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        let directory = worker
            .list_directory(&workspace.id, &workspace.root_path, &query.path)
            .await?;
        return JsonAnswer::local(&files::FileList {
            path: directory.path,
            entries: directory
                .entries
                .into_iter()
                .map(|entry| files::FileEntry {
                    name: entry.name,
                    path: entry.path,
                    kind: if entry.kind == "directory" {
                        "directory"
                    } else {
                        "file"
                    },
                    size: entry.size,
                    readonly: entry.readonly,
                })
                .collect(),
            truncated: directory.truncated,
        });
    }
    JsonAnswer::local(&files::list_directory(
        Path::new(&workspace.root_path),
        &query.path,
    )?)
}

pub async fn read_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::FileRead,
            &remote::service::PathPayload { path: query.path },
        )
        .await;
    }
    JsonAnswer::local(&files::read_text_file(
        Path::new(&workspace.root_path),
        &query.path,
    )?)
}

pub async fn file_info(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<imports::FileInfo>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Reading local file metadata")?;
    Ok(Json(imports::file_info(
        Path::new(&workspace.root_path),
        &query.path,
    )?))
}

/// Raw downloads retain the same canonical workspace boundary as text reads.
/// Always an attachment: uploaded HTML/SVG cannot execute in the Runtime origin.
pub async fn download_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Response> {
    use std::io::Read;
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Downloading a file")?;
    let root = Path::new(&workspace.root_path);
    let path = resolve_in_root(root, &query.path)?;
    if !path.is_file() {
        return Err(AppError::BadRequest("Requested path is not a file".into()));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)?
        .take(imports::MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > imports::MAX_FILE_BYTES {
        return Err(AppError::BadRequest(
            "File exceeds the 16 MiB download limit".into(),
        ));
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let encoded: String = name
        .as_bytes()
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    Response::builder()
        .header("Content-Type", "application/octet-stream")
        .header(
            "Content-Disposition",
            format!("attachment; filename*=UTF-8''{encoded}"),
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(axum::body::Body::from(bytes))
        .map_err(|_| AppError::Internal("Cannot create download response".into()))
}

/// The first multipart field is a JSON manifest; subsequent field names are
/// their zero-based indices in manifest.paths. Filenames are never trusted.
pub async fn upload_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    mut multipart: axum::extract::Multipart,
) -> AppResult<Json<imports::ImportResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    remote::refuse_remote(&workspace, "Uploading files")?;
    let manifest = imports::read_manifest(&mut multipart, false).await?;
    let root = Path::new(&workspace.root_path);
    let mut batch = imports::ImportBatch::new(root)?;
    imports::receive_files(&mut multipart, &mut batch, &manifest).await?;
    Ok(Json(batch.commit(root)?))
}

#[derive(Deserialize)]
pub struct ImportLocalFilesRequest {
    paths: Vec<String>,
}

pub async fn import_local_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<ImportLocalFilesRequest>,
) -> AppResult<Json<imports::ImportResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    remote::refuse_remote(&workspace, "Importing local files")?;
    if request.paths.is_empty() || request.paths.len() > imports::MAX_FILES {
        return Err(AppError::BadRequest("Import requires 1–256 files".into()));
    }
    let root = Path::new(&workspace.root_path);
    let mut batch = imports::ImportBatch::new(root)?;
    for path in request.paths {
        batch.copy(root, &path)?;
    }
    Ok(Json(batch.commit(root)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    path: String,
    content: String,
    /// Legacy field retained to reject old size-only overwrites explicitly.
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
    /// Re-emit the UTF-8 BOM `read_file` stripped, so a file that had one
    /// keeps it (E01/M4). Absent means no BOM, which is what a new file wants.
    #[serde(default)]
    bom: bool,
}

/// `PUT /api/workspaces/{id}/file` — the editor node's save (plan §3.4).
pub async fn write_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<WriteFileRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    if request.expected_size.is_some() && request.expected_sha256.is_none() {
        return Err(AppError::BadRequest(
            "Reload the file to obtain its content version before saving".into(),
        ));
    }
    // The same content version travels to the execution host, so a remote save
    // is protected by the file the editor actually read — not by a re-read on
    // the way there, which would defeat the check (E01/H02).
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        let written = worker
            .write_file(
                &workspace.id,
                &workspace.root_path,
                &request.path,
                request.content,
                request.expected_sha256,
                request.bom,
            )
            .await?;
        return JsonAnswer::local(&files::FileWriteResult {
            path: written.path,
            size: written.size,
            sha256: written.sha256,
        });
    }
    let result = tokio::task::spawn_blocking(move || {
        files::write_text_file(
            Path::new(&workspace.root_path),
            &request.path,
            &request.content,
            request.expected_sha256.as_deref(),
            request.bom,
        )
    })
    .await??;
    JsonAnswer::local(&result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEntryRequest {
    path: String,
    kind: file_ops::EntryKind,
}

/// `POST /api/workspaces/{id}/file-entries` — 新建文件 / 新建文件夹.
pub async fn create_file_entry(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<CreateEntryRequest>,
) -> AppResult<Json<file_ops::EntryResult>> {
    let workspace = writable_workspace(&state, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Creating, renaming and deleting files")?;
    tokio::task::spawn_blocking(move || {
        file_ops::create_entry(Path::new(&workspace.root_path), &request.path, request.kind)
            .map(Json)
    })
    .await?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryRequest {
    from: String,
    to: String,
}

/// `POST /api/workspaces/{id}/file-entries/rename` — 重命名 / 移动.
pub async fn rename_file_entry(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<RenameEntryRequest>,
) -> AppResult<Json<file_ops::EntryResult>> {
    let workspace = writable_workspace(&state, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Creating, renaming and deleting files")?;
    tokio::task::spawn_blocking(move || {
        file_ops::rename_entry(Path::new(&workspace.root_path), &request.from, &request.to)
            .map(Json)
    })
    .await?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryRequest {
    path: String,
}

/// `POST /api/workspaces/{id}/file-entries/trash` — 删除到回收站.
/// The bytes are moved under `.armadra/trash/`, never unlinked.
pub async fn trash_file_entry(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<TrashEntryRequest>,
) -> AppResult<Json<file_ops::TrashEntry>> {
    let workspace = writable_workspace(&state, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Creating, renaming and deleting files")?;
    tokio::task::spawn_blocking(move || {
        file_ops::trash_entry(Path::new(&workspace.root_path), &request.path).map(Json)
    })
    .await?
}

/// `GET /api/workspaces/{id}/file-entries/trash` — what can still be restored.
pub async fn list_trash(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Vec<file_ops::TrashEntry>>> {
    let workspace = readable_workspace(&state, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Creating, renaming and deleting files")?;
    tokio::task::spawn_blocking(move || {
        file_ops::list_trash(Path::new(&workspace.root_path)).map(Json)
    })
    .await?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEntryRequest {
    id: String,
}

/// `POST /api/workspaces/{id}/file-entries/restore` — undo one deletion.
pub async fn restore_file_entry(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<RestoreEntryRequest>,
) -> AppResult<Json<file_ops::EntryResult>> {
    let workspace = writable_workspace(&state, &workspace_id).await?;
    remote::refuse_remote(&workspace, "Creating, renaming and deleting files")?;
    tokio::task::spawn_blocking(move || {
        file_ops::restore_trash(Path::new(&workspace.root_path), &request.id).map(Json)
    })
    .await?
}

/* ------------------------------ language service -------------------------- */

/// What the editor may rely on for this workspace's language tooling.
///
/// There is no LSP in Armadra yet, so the honest answer is the only one: the
/// probe reports `unavailable` with a reason, and the editor shows no
/// completion affordances rather than an empty list pretending to be one
/// (design §2, §4).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServiceStatus {
    status: &'static str,
    reason: &'static str,
}

/// `GET /api/workspaces/{id}/language-service` — capability probe (E01/M4).
pub async fn language_service(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<LanguageServiceStatus>> {
    readable_workspace(&state, &workspace_id).await?;
    Ok(Json(LanguageServiceStatus {
        status: "unavailable",
        reason: "not_implemented",
    }))
}

/* ------------------------------ file watching ----------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFileRequest {
    path: String,
    /// The editor node showing the file. Two nodes on the same path each keep
    /// their own registration, so closing one does not blind the other.
    node_id: String,
}

/// `POST /api/workspaces/{id}/file-watch` — an editor node declares a file
/// open (E01/M4). The answer carries the version on disk right now, and says
/// whether changes will be pushed or the client has to ask.
pub async fn watch_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<WatchFileRequest>,
) -> AppResult<Json<file_watch::WatchRegistration>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        // A workspace that lost read access must not keep an OS watcher alive
        // on a folder the canvas may no longer look at.
        file_watch::release_workspace(&workspace_id);
        remote::watch::release_workspace(&workspace_id);
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    let events = state.events.clone();
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return Ok(Json(
            remote::watch::register(
                worker.clone(),
                events,
                &workspace.id,
                &workspace.root_path,
                &request.path,
                &request.node_id,
            )
            .await?,
        ));
    }
    tokio::task::spawn_blocking(move || {
        file_watch::register(
            &workspace_id,
            Path::new(&workspace.root_path),
            &request.path,
            &request.node_id,
            &events,
        )
        .map(Json)
    })
    .await?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchFileQuery {
    path: String,
    node_id: String,
}

/// `DELETE /api/workspaces/{id}/file-watch?path=&nodeId=` — the editor closed
/// the file. Unknown registrations are a no-op, so a late close after a
/// workspace switch is not an error.
pub async fn unwatch_file(
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<UnwatchFileQuery>,
) -> AppResult<axum::http::StatusCode> {
    // Which registry holds the file depends on where the workspace executes,
    // and a workspace can be re-pointed; dropping the viewer from both is
    // cheap and leaves no poller running for a node that closed.
    file_watch::unregister(&workspace_id, &query.path, &query.node_id)?;
    remote::watch::unregister(&workspace_id, &query.path, &query.node_id)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// `GET /api/workspaces/{id}/file-version?path=` — the current SHA-256, size
/// and mtime of one file. This is the fallback the editor polls on demand when
/// registration answered `unsupported`; a missing file is `exists: false`,
/// not a 404.
pub async fn file_version(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<file_watch::FileVersion>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return Ok(Json(
            remote::watch::version(worker, &workspace.id, &workspace.root_path, &query.path)
                .await?,
        ));
    }
    tokio::task::spawn_blocking(move || {
        file_watch::file_version(Path::new(&workspace.root_path), &query.path).map(Json)
    })
    .await?
}
