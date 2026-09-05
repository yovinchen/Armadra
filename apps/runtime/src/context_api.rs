use crate::{
    AppState,
    context_usage::{self, ContextQuery, ContextUsage},
    error::AppResult,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};

pub async fn snapshot(
    State(state): State<AppState>,
    Path((workspace_id, node_id)): Path<(String, String)>,
    Query(query): Query<ContextQuery>,
) -> AppResult<Json<ContextUsage>> {
    context_usage::get_snapshot(&state, &workspace_id, &node_id, &query)
        .await
        .map(Json)
}
