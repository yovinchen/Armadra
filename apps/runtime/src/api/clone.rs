//! `/api/git/clone` — starting, polling and cancelling a repository clone.

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::{Deserialize, Serialize};

use super::workspaces::valid_workspace_name;
use crate::{
    AppState, db,
    error::{AppError, AppResult},
    git,
    model::Workspace,
    security::canonical_directory,
};

/* -------------------------------- git clone ------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    url: String,
    parent: String,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStartedResponse {
    job_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStatusResponse {
    state: git::CloneState,
    lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Only set once the clone finished and the folder was registered.
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<Workspace>,
}

/// Start `git clone --progress` in the background (plan §20). There is no
/// workspace to publish events into yet, so the dialog polls
/// `GET /api/git/clone/{job_id}` instead.
pub async fn git_clone(
    State(state): State<AppState>,
    Json(request): Json<CloneRequest>,
) -> AppResult<Json<CloneStartedResponse>> {
    // Starting a clone is a git write: it makes the machine fetch a repository
    // and lands a directory on disk (business migration §2.8).
    crate::ownership::require_local_write(&state.pool, crate::ownership::OwnershipDomain::Git)
        .await?;
    // A new project has no grant yet. If its destination is inside existing
    // workspaces, preserve every ancestor's restrictions instead of bypassing
    // them through this global creation endpoint.
    let parent = canonical_directory(&request.parent)?;
    for summary in db::list_workspaces(&state.pool).await? {
        let workspace = summary.workspace;
        if let Ok(root) = canonical_directory(&workspace.root_path)
            && parent.starts_with(&root)
        {
            if !workspace.permissions.read || !workspace.permissions.write {
                return Err(AppError::Forbidden(
                    "An ancestor workspace does not allow cloning into this destination".into(),
                ));
            }
            git::access::require_execution(
                workspace.permissions.execute,
                "Cloning into an existing workspace",
            )?;
        }
    }
    let parent = parent
        .to_str()
        .ok_or_else(|| AppError::BadRequest("Clone destination must be a UTF-8 path".into()))?;
    let started = git::start_clone(&request.url, parent, request.name.as_deref())?;
    Ok(Json(CloneStartedResponse {
        job_id: started.job_id,
    }))
}

pub async fn git_clone_status(
    State(state): State<AppState>,
    AxumPath(job_id): AxumPath<String>,
) -> AppResult<Json<CloneStatusResponse>> {
    let status = git::clone_status(&job_id)?;
    // `db::create_workspace` is idempotent on the root path, so two polls
    // landing at the same time cannot produce two workspaces.
    let workspace = if status.state == git::CloneState::Done {
        let root = canonical_directory(&status.target)?;
        Some(
            db::create_workspace(
                &state.pool,
                valid_workspace_name(&status.name)?,
                &root.to_string_lossy(),
                None,
                None,
            )
            .await?,
        )
    } else {
        None
    };
    Ok(Json(CloneStatusResponse {
        state: status.state,
        lines: status.lines,
        error: status.error,
        workspace,
    }))
}

pub async fn cancel_git_clone(
    AxumPath(job_id): AxumPath<String>,
) -> AppResult<axum::http::StatusCode> {
    git::cancel_clone(&job_id)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
