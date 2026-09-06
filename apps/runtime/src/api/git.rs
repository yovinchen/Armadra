//! `/api/workspaces/{id}/git` — the proxied Git subset: status, diff, init,
//! staging, revert, resolve and commit.

use std::path::Path;

use armadra_protocol::v1::WorkerServiceOperation;
use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::Deserialize;

use super::support::default_path;
use crate::{
    AppState, db,
    error::{AppError, AppResult},
    git,
    model::Workspace,
    ownership,
    remote::{self, JsonAnswer},
};

/* ------------------------------------ git --------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffQuery {
    #[serde(default = "default_path")]
    path: String,
    #[serde(default)]
    scope: git::DiffScope,
    /// Comma-separated workspace-relative paths. Absent = the whole `path`
    /// directory.
    paths: Option<String>,
    /// Display option: hide whitespace-only differences from the patch and its
    /// line counts. The file list is unaffected.
    #[serde(default)]
    ignore_whitespace: bool,
}

pub async fn git_diff(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitDiffQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git reads".into(),
        ));
    }
    let paths: Vec<String> = query
        .paths
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitDiff,
            &remote::service::DiffPayload {
                path: query.path,
                scope: query.scope,
                paths,
                ignore_whitespace: query.ignore_whitespace,
            },
        )
        .await;
    }
    JsonAnswer::local(&git::read_diff_with_execution(
        Path::new(&workspace.root_path),
        &query.path,
        &git::DiffRequest {
            scope: query.scope,
            paths,
            ignore_whitespace: query.ignore_whitespace,
        },
        workspace.permissions.execute,
    )?)
}

/// Which repository under the workspace a legacy Git request addresses.
/// Absent means the workspace root, so every existing caller keeps working
/// while a multi-repository workspace names the checkout it means (§4.1).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitRepositoryPathQuery {
    #[serde(default = "default_path")]
    path: String,
}

pub async fn git_status(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitRepositoryPathQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git reads".into(),
        ));
    }
    git::access::require_execution(workspace.permissions.execute, "Git worktree status")?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitStatus,
            &remote::service::PathPayload { path: query.path },
        )
        .await;
    }
    JsonAnswer::local(&git::read_status_at(
        Path::new(&workspace.root_path),
        &query.path,
    )?)
}

/// `POST /api/workspaces/{id}/git/init`.
///
/// Deliberately explicit: the drawer only offers it once a read has reported
/// `repository: false`, and the service refuses a workspace that already
/// belongs to any repository rather than nesting a second one inside it.
pub async fn git_init(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<JsonAnswer> {
    // Creating a repository is a git write, and it is the one write that does
    // not go through `git_write_workspace`: there is no repository to take a
    // queue key from yet, so its permission check is inline and so is its
    // ownership guard.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Git).await?;
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read || !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git writes".into(),
        ));
    }
    git::access::require_execution(
        workspace.permissions.execute,
        "Git repository initialization",
    )?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitInit,
            &serde_json::Map::new(),
        )
        .await;
    }
    let result =
        tokio::task::spawn_blocking(move || git::init_repository(Path::new(&workspace.root_path)))
            .await??;
    JsonAnswer::local(&result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsRequest {
    paths: Vec<String>,
    /// The repository the paths belong to; the workspace root by default.
    #[serde(default = "default_path")]
    path: String,
}

pub async fn git_stage(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = git_write_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitStage,
            &remote::service::PathsPayload {
                path: request.path,
                paths: request.paths,
            },
        )
        .await;
    }
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), &request.path)
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::stage_paths(
            Path::new(&workspace.root_path),
            &request.path,
            &request.paths,
        )
    })
    .await??;
    JsonAnswer::local(&result)
}

/// The permission gate every Git write shares: read, write and the execution
/// grant, in that order. The remote path checks it here *and* again on the
/// execution host, which is where the repository actually is.
/// Every index, worktree and commit write goes through here, which is why the
/// ownership guard lives here too (business migration §2.8): one gate rather
/// than seven, so a route added later cannot forget it.
///
/// Reads are deliberately not gated. A Runtime that handed the git domain over
/// still answers `status`, `diff` and `history`, because the panel has to keep
/// showing the repository it no longer writes -- the switch moves who decides,
/// not what a person can look at.
async fn git_write_workspace(state: &AppState, workspace_id: &str) -> AppResult<Workspace> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Git).await?;
    let workspace = db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.read || !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git writes".into(),
        ));
    }
    git::access::require_execution(
        workspace.permissions.execute,
        "Git index, worktree, and commit writes",
    )?;
    Ok(workspace)
}

pub async fn git_unstage(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = git_write_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitUnstage,
            &remote::service::PathsPayload {
                path: request.path,
                paths: request.paths,
            },
        )
        .await;
    }
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), &request.path)
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::unstage_paths(
            Path::new(&workspace.root_path),
            &request.path,
            &request.paths,
        )
    })
    .await??;
    JsonAnswer::local(&result)
}

/// `POST /api/workspaces/{id}/git/resolve`: stage a conflicted path only
/// after its file no longer contains conflict markers (plan §4.3).
pub async fn git_resolve(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = git_write_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitResolve,
            &remote::service::PathsPayload {
                path: request.path,
                paths: request.paths,
            },
        )
        .await;
    }
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), &request.path)
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::mark_resolved(
            Path::new(&workspace.root_path),
            &request.path,
            &request.paths,
        )
    })
    .await??;
    JsonAnswer::local(&result)
}

/// `POST /api/workspaces/{id}/git/revert`: restoring from the index and
/// restoring from HEAD lose different work, so the source is explicit.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertRequest {
    paths: Vec<String>,
    #[serde(default)]
    source: git::RestoreSource,
    /// The repository the paths belong to; the workspace root by default.
    #[serde(default = "default_path")]
    path: String,
}

pub async fn git_revert(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<RevertRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = git_write_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitRevert,
            &remote::service::RevertPayload {
                path: request.path,
                paths: request.paths,
                source: request.source,
            },
        )
        .await;
    }
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), &request.path)
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::revert_paths(
            Path::new(&workspace.root_path),
            &request.path,
            &request.paths,
            request.source,
        )
    })
    .await??;
    JsonAnswer::local(&result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    message: String,
    paths: Option<Vec<String>>,
    /// The repository the commit lands in. There is deliberately no
    /// cross-repository commit: one request, one repository (§4.1).
    #[serde(default = "default_path")]
    path: String,
    /// Present only for an explicit amend; the composer sends the OID it showed.
    amend: Option<AmendBody>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmendBody {
    expected_head: String,
    #[serde(default)]
    allow_published: bool,
}

/// `GET /api/workspaces/{id}/git/head-commit`: what an amend would rewrite.
pub async fn git_head_commit(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitRepositoryPathQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git reads".into(),
        ));
    }
    git::access::require_execution(workspace.permissions.execute, "Git commit inspection")?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitHeadCommit,
            &remote::service::PathPayload { path: query.path },
        )
        .await;
    }
    let result = tokio::task::spawn_blocking(move || {
        git::head_commit(Path::new(&workspace.root_path), &query.path)
    })
    .await??;
    JsonAnswer::local(&result)
}

pub async fn git_commit(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<CommitRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = git_write_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::GitCommit,
            &remote::service::CommitPayload {
                path: request.path,
                message: request.message,
                paths: request.paths,
                amend: request.amend.map(|amend| remote::service::AmendPayload {
                    expected_head: amend.expected_head,
                    allow_published: amend.allow_published,
                }),
            },
        )
        .await;
    }
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), &request.path)
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let amend = request.amend.map(|amend| git::AmendRequest {
            expected_head: amend.expected_head,
            allow_published: amend.allow_published,
        });
        git::commit(
            Path::new(&workspace.root_path),
            &request.path,
            &request.message,
            request.paths.as_deref(),
            amend.as_ref(),
        )
    })
    .await??;
    JsonAnswer::local(&result)
}
