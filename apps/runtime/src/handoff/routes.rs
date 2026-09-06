//! HTTP surface for handoff preview and approval.
//!
//! Every handler delegates straight to the module functions, which already
//! carry the workspace permission gate, the identity and context-link checks
//! and the digest confirmation. Nothing here decides anything on its own, so a
//! route can never be a weaker door than the verb behind it.
//!
//! Accepting is the only user authorization in the flow: preparing a bundle
//! freezes material, it does not deliver it, and the runtime never accepts on
//! the user's behalf.
use super::{ConfirmRequest, HandoffView, PrepareRequest};
use crate::{AppState, error::AppResult};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    /// The node whose handoffs are listed; both directions are returned, so a
    /// target sees what was addressed to it. Absent lists the whole workspace,
    /// which is what the history panel reads.
    #[serde(default)]
    pub source_node_id: Option<String>,
}

/// The three verbs that change a handoff answer `ownership_moved` once the
/// agent domain has moved (business migration §2.7).
///
/// Reading does not. `list` and `get` keep answering from this database for the
/// same reason every other domain's reads do: the rows stay the rollback
/// baseline until migration 0012 retires them, and a client that could not read
/// them during a switch would show an empty history rather than a frozen one.
async fn host_owns_handoffs(state: &AppState) -> AppResult<()> {
    crate::ownership::require_local_write(&state.pool, crate::ownership::OwnershipDomain::Agent)
        .await
}

pub async fn prepare(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<PrepareRequest>,
) -> AppResult<Json<HandoffView>> {
    host_owns_handoffs(&state).await?;
    super::prepare(&state, &workspace_id, request)
        .await
        .map(Json)
}

pub async fn list(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Vec<HandoffView>>> {
    match query.source_node_id.as_deref() {
        Some(node_id) => super::list(&state, &workspace_id, node_id).await.map(Json),
        None => super::list_workspace(&state, &workspace_id).await.map(Json),
    }
}

pub async fn get(
    State(state): State<AppState>,
    Path((workspace_id, handoff_id)): Path<(String, String)>,
) -> AppResult<Json<HandoffView>> {
    super::get(&state, &workspace_id, &handoff_id)
        .await
        .map(Json)
}

pub async fn accept(
    State(state): State<AppState>,
    Path((workspace_id, handoff_id)): Path<(String, String)>,
    Json(request): Json<ConfirmRequest>,
) -> AppResult<Json<HandoffView>> {
    host_owns_handoffs(&state).await?;
    super::accept(&state, &workspace_id, &handoff_id, request)
        .await
        .map(Json)
}

pub async fn cancel(
    State(state): State<AppState>,
    Path((workspace_id, handoff_id)): Path<(String, String)>,
    Json(request): Json<ConfirmRequest>,
) -> AppResult<Json<HandoffView>> {
    host_owns_handoffs(&state).await?;
    super::cancel(&state, &workspace_id, &handoff_id, request)
        .await
        .map(Json)
}
