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

/// Registering where a workspace's files are is a filesystem-domain write, and
/// creating the workspace row is a canvas-domain one (Go Host 业务所有权迁移
/// §1.1). Both are checked, and the filesystem is checked first so the refusal
/// names the domain that actually moved: filesystem may only be on the Host
/// while the canvas already is, so checking the canvas first would report the
/// canvas for every root registration.
///
/// Nothing about the files themselves is gated. Reading, writing, watching and
/// searching keep answering whoever owns this record — the switch moves the
/// decision, not the machine.
async fn require_root_registration(pool: &sqlx::SqlitePool) -> AppResult<()> {
    ownership::require_local_write(pool, ownership::OwnershipDomain::Filesystem).await?;
    ownership::require_local_write(pool, ownership::OwnershipDomain::Canvas).await
}

pub async fn create_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&request.name)?;
    // Before `createDirectory` touches the disk: a refused registration must
    // not leave a folder behind that nothing then references.
    require_root_registration(&state.pool).await?;
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
    require_root_registration(&state.pool).await?;
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
    // Before the remote Worker is started: registering a root on another
    // machine is the filesystem domain's decision, and a Runtime that no longer
    // makes it must not open an SSH connection to act on it.
    require_root_registration(&state.pool).await?;
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

/// `PATCH /api/workspaces/{id}/execution-host` — move a workspace to another
/// execution host (remote completion design §3.3).
///
/// A rebinding, never a file move: the new host's root has to look like the
/// same project, and nothing may still be bound to the old one. A refusal
/// comes back as a 409 whose body is the structured reason — both
/// fingerprints, or the list of blockers — because "conflict" alone is not
/// something a person can act on.
pub async fn switch_execution_host(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<crate::remote::switch::SwitchRequest>,
) -> AppResult<axum::response::Response> {
    use axum::response::IntoResponse;

    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    match crate::remote::switch::switch(&state, &workspace, request).await? {
        Ok(updated) => {
            // The whole client view of this workspace is now about a different
            // machine, so it refetches rather than patching what it has.
            state.events.publish(
                &workspace_id,
                crate::events::WorkspaceEvent::WorkspaceUpdated {
                    workspace_id: workspace_id.clone(),
                },
            );
            Ok(Json(updated).into_response())
        }
        Err(refusal) => Ok((axum::http::StatusCode::CONFLICT, Json(refusal)).into_response()),
    }
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
    // Before any uploaded byte is written: the import ends in a registered
    // root, and a Runtime that may not create one must not stage the files.
    require_root_registration(&state.pool).await?;
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
    // Read, write and execute for a workspace are the filesystem domain's
    // decision; the name and the colour are the canvas's. A patch that changes
    // permissions therefore needs both, and one that only renames needs one —
    // which is what keeps renaming a workspace working while its permissions
    // are being decided on the Host.
    if request.permissions.is_some() {
        ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Filesystem).await?;
    }
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
    // then delete, and removing the row removes the root registration with it.
    require_root_registration(&state.pool).await?;
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
