//! `/api/workspaces/{id}/index` and `/search` — the file index and the
//! workspace search surfaces.

use std::path::Path;

use armadra_protocol::v1::WorkerServiceOperation;
use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::Deserialize;

use super::support::readable_workspace;
use crate::{
    AppState,
    error::AppResult,
    file_search,
    remote::{self, JsonAnswer},
};

/* ---------------------------- search and file work ------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexQuery {
    #[serde(default)]
    query: String,
    limit: Option<usize>,
}

/// `GET /api/workspaces/{id}/file-index?query=&limit=` — 快速打开 (E01/M4).
///
/// A fuzzy filename match over the workspace with build folders skipped. The
/// answer is capped and says when it was cut short; it is never the whole tree.
pub async fn file_index(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<FileIndexQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = readable_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::SearchIndex,
            &remote::service::IndexPayload {
                query: query.query,
                limit: query.limit,
            },
        )
        .await;
    }
    let index = tokio::task::spawn_blocking(move || {
        file_search::index_files(Path::new(&workspace.root_path), &query.query, query.limit)
    })
    .await??;
    JsonAnswer::local(&index)
}

/// `POST /api/workspaces/{id}/file-search` — 项目搜索 (E01/M4).
///
/// A POST because the request carries a pattern and two glob lists; nothing is
/// mutated. Paging is by `offset`/`nextOffset` over matching files.
pub async fn search_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<file_search::SearchRequest>,
) -> AppResult<JsonAnswer> {
    let workspace = readable_workspace(&state, &workspace_id).await?;
    if let Some(worker) = remote::resolve(&state, &workspace)?.remote() {
        return remote::proxy(
            worker,
            &workspace,
            WorkerServiceOperation::SearchContent,
            &request,
        )
        .await;
    }
    let result = tokio::task::spawn_blocking(move || {
        file_search::search_content(Path::new(&workspace.root_path), &request)
    })
    .await??;
    JsonAnswer::local(&result)
}
