//! HTTP surface for T02.
//!
//! Sampling routes are workspace-scoped (the panel shows one workspace's
//! sessions); power routes are not, because a lease belongs to the machine and
//! survives switching canvases.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};

use crate::{AppState, db, error::AppResult};

use super::{
    ResourceSnapshot, SubscribeRequest, Subscription,
    orphans::{self, AdoptedSession},
    power::{LeaseRequest, PowerLease, PowerState, RenewRequest},
};

/// `GET /api/workspaces/{id}/resources` — one sample, right now.
///
/// The sampler is primed (two refreshes around the platform's minimum CPU
/// window) so this answer carries real CPU numbers rather than a first-refresh
/// zero, which is what a panel needs for its first paint.
pub async fn snapshot(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> AppResult<Json<ResourceSnapshot>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    let snapshot = state
        .resources
        .snapshot(&state, &workspace_id, true)
        .await?;
    Ok(Json(snapshot))
}

/// `POST /api/workspaces/{id}/resources/subscription` — start or renew the
/// sampling loop for this workspace. Sampling stops on its own once the last
/// subscription lapses, so a client that goes away costs nothing.
pub async fn subscribe(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    body: Option<Json<SubscribeRequest>>,
) -> AppResult<Json<Subscription>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    let request = body.map(|Json(request)| request).unwrap_or_default();
    Ok(Json(state.resources.subscribe(
        &state,
        &workspace_id,
        &request,
    )))
}

/// `DELETE /api/workspaces/{id}/resources/subscription/{subscriptionId}`.
pub async fn unsubscribe(
    State(state): State<AppState>,
    Path((_workspace_id, subscription_id)): Path<(String, String)>,
) -> StatusCode {
    state.resources.unsubscribe(&subscription_id);
    StatusCode::NO_CONTENT
}

/// `POST /api/workspaces/{id}/resources/orphans/{sessionId}/adopt` — rebind a
/// session whose node was deleted, and answer with the node id the canvas must
/// create so the binding is exactly the one the session had.
pub async fn adopt(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
) -> AppResult<Json<AdoptedSession>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(
        orphans::adopt(&state.pool, &workspace_id, &session_id).await?,
    ))
}

/// `POST /api/workspaces/{id}/resources/orphans/{orphanId}/terminate`.
///
/// Destructive, and the canvas confirms before calling it. Only sessions this
/// runtime manages (or persistent sessions it created) can be named here — an
/// arbitrary pid is not addressable through this route at all.
pub async fn terminate_orphan(
    State(state): State<AppState>,
    Path((workspace_id, orphan_id)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    orphans::terminate(&state.pool, &state.terminals, &workspace_id, &orphan_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ---------------------------------- power --------------------------------- */

/// `GET /api/power` — policy, mechanism and every lease currently held.
pub async fn power(State(state): State<AppState>) -> Json<PowerState> {
    Json(state.resources.power().state())
}

/// `POST /api/power/leases` — ask to keep this machine awake.
///
/// Always answers with a lease when the request is well formed. Whether it
/// holds anything is `active` / `blockedBy` on the lease itself: a claim the
/// policy forbids is recorded and shown rather than silently dropped.
pub async fn acquire_lease(
    State(state): State<AppState>,
    Json(request): Json<LeaseRequest>,
) -> AppResult<Json<PowerLease>> {
    Ok(Json(state.resources.power().acquire(request)?))
}

/// `POST /api/power/leases/{id}/renew`.
pub async fn renew_lease(
    State(state): State<AppState>,
    Path(lease_id): Path<String>,
    body: Option<Json<RenewRequest>>,
) -> AppResult<Json<PowerLease>> {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    Ok(Json(state.resources.power().renew(&lease_id, request)?))
}

/// `DELETE /api/power/leases/{id}` — release now, not at the next tick.
pub async fn release_lease(
    State(state): State<AppState>,
    Path(lease_id): Path<String>,
) -> AppResult<Json<PowerState>> {
    Ok(Json(state.resources.power().release(&lease_id)?))
}
