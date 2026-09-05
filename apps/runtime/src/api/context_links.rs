//! `PUT /api/nodes/{id}/context-links` — the canvas link document a node
//! reads its collaborators from.

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::Deserialize;

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    model::{ContextLink, ContextLinkDocument},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLinksRequest {
    #[serde(default)]
    links: Vec<ContextLink>,
}

/// The canvas pushes each node's link document whenever an edge changes; the
/// context-link verbs in Phase 3 authorize against exactly this list.
pub async fn put_context_links(
    State(state): State<AppState>,
    AxumPath((workspace_id, node_id)): AxumPath<(String, String)>,
    Json(request): Json<ContextLinksRequest>,
) -> AppResult<Json<ContextLinkDocument>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    if uuid::Uuid::parse_str(&node_id).is_err() {
        return Err(AppError::BadRequest("Node id is invalid".into()));
    }
    Ok(Json(
        db::put_context_links(&state.pool, &workspace_id, &node_id, &request.links).await?,
    ))
}
