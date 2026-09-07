//! The Git window's two workspace-level reads (Git 工具窗口设计 §3.1).
//!
//! Every other route in this module is about *one* checkout and takes a `path`.
//! These two are about the workspace: the log merges every discovered
//! repository's commits into one graph, and the branch tree lists every
//! repository's refs in one answer. Which repositories there are is part of
//! what they return, so there is nothing for a caller to name first — and
//! nothing for it to name *instead*, which is why the discovery scan is the
//! only source of the list.
//!
//! The log is a POST because its filters are a record — a ref selection, an
//! author list, a date range, a pathspec list, a search with two switches and a
//! page cursor — and putting that in a query string is where escaping goes
//! wrong. Nothing about it writes.

use armadra_protocol::v1::WorkerServiceOperation;
use axum::{
    Json,
    extract::{Path as AxumPath, State},
};

use super::{REPOSITORIES, proxied, workspace};
use crate::{
    AppState,
    error::AppResult,
    git_repository::LogRequest,
    remote::{JsonAnswer, service},
};
use std::path::Path;

/// `POST /api/workspaces/{id}/git/log` — one page of the merged commit graph.
pub async fn log(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<LogRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitLog,
        &service::git::LogPayload {
            request: request.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            // The discovery cache is keyed by workspace id here, the way every
            // other controller-side scan of this workspace is, so the log and
            // the repository list cannot disagree about what was found.
            .log(Path::new(&workspace.root_path), &id, request)
            .await?,
    )
}

/// `GET /api/workspaces/{id}/git/refs` — every repository's branch tree.
pub async fn refs(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitRefs,
        &service::git::RootPayload {},
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .refs_snapshot(Path::new(&workspace.root_path), &id)
            .await?,
    )
}
