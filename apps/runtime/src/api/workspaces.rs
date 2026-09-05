//! `/api/workspaces` — creating, importing, listing, patching and opening
//! workspaces, plus the remote execution-host probe.

use std::path::Path;

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    db::{self, WorkspacePatch},
    error::{AppError, AppResult},
    file_watch, imports,
    model::{Workspace, WorkspacePermissions, WorkspaceSummary},
    ownership, paths,
    security::{canonical_directory, prepare_new_directory},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    name: String,
    root_path: String,
    color: Option<String>,
    permissions: Option<WorkspacePermissions>,
    /// 新建文件夹 (plan §20): `root_path` does not exist yet and we create it.
    /// The parent must exist, the leaf must not, and neither may sit in a
    /// protected system location.
    #[serde(default)]
    create_directory: bool,
}

pub(super) fn valid_workspace_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::BadRequest("Workspace name is invalid".into()));
    }
    Ok(name)
}

pub async fn create_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&request.name)?;
    // Before `createDirectory` touches the disk: a refused canvas write must
    // not leave a folder behind that nothing then references.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    if request.create_directory {
        create_root_directory(&request.root_path)?;
    }
    let root = canonical_directory(&request.root_path)?;
    Ok(Json(
        db::create_workspace(
            &state.pool,
            name,
            &root.to_string_lossy(),
            request.color.as_deref(),
            request.permissions.as_ref(),
        )
        .await?,
    ))
}

pub async fn open_directory_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&request.name)?;
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    let root = imports::directory_source(&request.root_path)?;
    Ok(Json(
        db::create_workspace(
            &state.pool,
            name,
            &root.to_string_lossy(),
            request.color.as_deref(),
            request.permissions.as_ref(),
        )
        .await?,
    ))
}

/* ---------------------------- remote execution ---------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRemoteWorkspaceRequest {
    name: String,
    /// A `settings.ssh.hosts[].id` with a `worker` configuration.
    execution_host_id: String,
    /// An absolute path **on that host**. Nothing about it is resolved here.
    root_path: String,
    permissions: Option<WorkspacePermissions>,
}

/// `POST /api/workspaces/remote` — open a project that lives on an SSH
/// execution host (H02).
///
/// The path is proven by the execution host, not by this machine: the Worker
/// is started, the root is registered — which canonicalizes and freezes it —
/// and only then is the workspace stored, with the canonical remote path. An
/// unreachable host, a missing Worker binary or a version mismatch fails here
/// instead of producing a workspace that silently reads local files.
pub async fn open_remote_workspace(
    State(state): State<AppState>,
    Json(request): Json<OpenRemoteWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&request.name)?;
    if !request.root_path.starts_with('/') || request.root_path.len() > 4_096 {
        return Err(AppError::BadRequest(
            "A remote workspace root must be an absolute path on the execution host".into(),
        ));
    }
    let host = state.settings.ssh_host(&request.execution_host_id);
    let worker = state.remote.get(host, &request.execution_host_id)?;
    // A probe id, not the workspace id: the workspace does not exist yet, and
    // the registration is what proves the directory does.
    let canonical = worker
        .register_root(
            &format!("probe-{}", uuid::Uuid::new_v4().simple()),
            &request.root_path,
        )
        .await?;
    Ok(Json(
        db::create_remote_workspace(
            &state.pool,
            name,
            &request.execution_host_id,
            &canonical,
            request.permissions.as_ref(),
        )
        .await?,
    ))
}

/// What a remote Worker reports about itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkerProbe {
    pub platform: String,
    pub architecture: String,
    pub runtime_version: String,
    pub capabilities: Vec<String>,
}

/// `POST /api/ssh/hosts/{host_id}/worker/test` — start the configured remote
/// Worker and read its handshake.
///
/// Separate from the terminal reachability probe: `ssh` may work perfectly
/// while the Worker binary is missing or the wrong version, and the settings
/// page has to be able to say which.
pub async fn test_remote_worker(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
) -> AppResult<Json<RemoteWorkerProbe>> {
    let host = state.settings.ssh_host(&host_id);
    let worker = state.remote.get(host, &host_id)?;
    let hello = worker.probe().await?;
    Ok(Json(RemoteWorkerProbe {
        platform: hello.platform,
        architecture: hello.architecture,
        runtime_version: hello.runtime_version,
        capabilities: hello.capabilities,
    }))
}

#[derive(Deserialize)]
pub struct WorkspaceImportQuery {
    name: String,
}

pub async fn import_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceImportQuery>,
    mut multipart: axum::extract::Multipart,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&query.name)?;
    // Before any uploaded byte is written: the import ends in a workspace row,
    // and a Runtime that may not create one must not stage the files for it.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    let manifest = imports::read_manifest(&mut multipart, true).await?;
    let mut batch =
        imports::ImportBatch::workspace(&paths::data_dir().join("imported-workspaces"))?;
    imports::receive_files(&mut multipart, &mut batch, &manifest).await?;
    Ok(Json(
        register_imported_workspace(&state.pool, batch, name).await?,
    ))
}

pub(super) async fn register_imported_workspace(
    pool: &sqlx::SqlitePool,
    batch: imports::ImportBatch,
    name: &str,
) -> AppResult<Workspace> {
    let mut imported = batch.commit_workspace()?;
    let workspace =
        db::create_workspace(pool, name, &imported.path.to_string_lossy(), None, None).await?;
    imported.keep();
    Ok(workspace)
}

/// `mkdir` one level for `createDirectory: true`. Splitting the requested path
/// into parent + leaf keeps the whole check in `security`: the parent is
/// canonicalized and screened, and an existing leaf is a 409 rather than a
/// silent reuse.
fn create_root_directory(root_path: &str) -> AppResult<()> {
    let requested = Path::new(root_path.trim_end_matches(['/', '\\']));
    let parent = requested
        .parent()
        .and_then(|parent| parent.to_str())
        .filter(|parent| !parent.is_empty())
        .ok_or_else(|| AppError::BadRequest("The parent directory is missing".into()))?;
    let name = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::BadRequest("Folder name is invalid".into()))?;
    let target = prepare_new_directory(parent, name)?;
    std::fs::create_dir(&target)?;
    Ok(())
}

pub async fn list_workspaces(
    State(state): State<AppState>,
) -> AppResult<Json<Vec<WorkspaceSummary>>> {
    Ok(Json(db::list_workspaces(&state.pool).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceRequest {
    name: Option<String>,
    color: Option<String>,
    permissions: Option<WorkspacePermissions>,
}

pub async fn update_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<UpdateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    let workspace = db::update_workspace(
        &state.pool,
        &workspace_id,
        WorkspacePatch {
            name: request.name,
            color: request.color,
            permissions: request.permissions,
        },
    )
    .await?;
    // Losing read access releases the editor's filesystem watchers with it
    // (E01/M4); nothing keeps pushing paths the canvas may not look at.
    if !workspace.permissions.read {
        file_watch::release_workspace(&workspace_id);
    }
    Ok(Json(workspace))
}

/// `DELETE /api/workspaces/{id}` — 从列表移除 (plan §20).
///
/// Removes the entry, never the project: every terminal session of the
/// workspace is terminated and destroyed first (they would otherwise outlive
/// the rows that name them), then the workspace row goes, taking its boards,
/// nodes, edges, sessions, agent status, approvals, context links and
/// deliveries with it through the schema's cascades. Nothing under
/// `rootPath` is read, moved or deleted.
pub async fn delete_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<axum::http::StatusCode> {
    // Before the 404 probe and long before any teardown: a Runtime that no
    // longer owns the canvas must not destroy sessions for a row it cannot
    // then delete.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    // 404 before anything is torn down, so an unknown id is a no-op.
    db::get_workspace(&state.pool, &workspace_id).await?;
    state.terminals.destroy_workspace(&workspace_id).await;
    file_watch::release_workspace(&workspace_id);
    db::delete_workspace(&state.pool, &workspace_id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn open_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Workspace>> {
    // Opening only stamps `last_opened_at`, but that is still a canvas-domain
    // write: two processes updating it would make the Host's exported row and
    // the Runtime's row disagree over which workspace was opened last.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    Ok(Json(
        db::touch_workspace_opened(&state.pool, &workspace_id).await?,
    ))
}
