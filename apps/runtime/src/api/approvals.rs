//! Hook-side control surfaces: node tokens, approval answers, message
//! deliveries and the control confirmation handshake.

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, collab, db,
    error::{AppError, AppResult},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeTokenResponse {
    node_id: String,
    /// The path the client reads, not the token: the token itself never travels
    /// over the API, only through the 0600 file.
    token_file: String,
}

/// Re-mints `<data>/node-tokens/<nodeId>` for a session's node. Needed when a
/// terminal outlived the data directory it was started against, which is
/// exactly when its reports would otherwise silently drop to `legacy`.
pub async fn refresh_node_token(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<NodeTokenResponse>> {
    let session = db::get_terminal_session(&state.pool, &session_id).await?;
    let node_id = session
        .owner_node_id
        .ok_or_else(|| AppError::BadRequest("This session has no owning node".into()))?;
    state.hooks.issue_node_token(&node_id)?;
    Ok(Json(NodeTokenResponse {
        token_file: state
            .hooks
            .node_token_dir()
            .join(&node_id)
            .to_string_lossy()
            .into_owned(),
        node_id,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerApprovalRequest {
    pub(super) decision: String,
}

/// Records the user's answer to a pending permission request, and gets it back
/// to the CLI that is waiting for it — plan §5.5.
///
/// Two routes out. When the hook client wrote `<data>/pending/<id>.json` and is
/// polling, an answer file is the deterministic path: the CLI receives the
/// decision through its own hook protocol. Otherwise the answer is typed into
/// the PTY the way a human would press the key, which depends on the prompt
/// still being on screen and is therefore reported as `route: "keys"`.
pub async fn answer_approval(
    State(state): State<AppState>,
    AxumPath(pending_id): AxumPath<String>,
    Json(request): Json<AnswerApprovalRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let (approval, route) =
        collab::approvals::answer(&state, &pending_id, &request.decision).await?;
    let mut body = serde_json::to_value(&approval).unwrap_or(serde_json::Value::Null);
    if let Some(object) = body.as_object_mut() {
        object.insert("route".into(), serde_json::json!(route));
    }
    Ok(Json(body))
}

#[derive(Deserialize)]
pub struct DeliveriesQuery {
    limit: Option<i64>,
}

/// `GET /api/workspaces/{id}/deliveries` — the 投递记录 panel (plan §5.7 step
/// 10). Rows never contain the message body, only how many characters it had,
/// so this is safe to render verbatim.
pub async fn list_deliveries(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<DeliveriesQuery>,
) -> AppResult<Json<Vec<crate::model::AgentDelivery>>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(
        db::list_deliveries(&state.pool, &workspace_id, query.limit.unwrap_or(200)).await?,
    ))
}

#[derive(Deserialize)]
pub struct ControlConfirmRequest {
    approve: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConfirmResponse {
    request_id: String,
    approve: bool,
    accepted: bool,
}

/// `POST /api/control/confirm/{requestId}` — the human half of `close`
/// (plan §5.8). `accepted: false` means the verb already gave up; the dialog
/// closes either way, which is why this is not an error.
pub async fn confirm_control(
    State(state): State<AppState>,
    AxumPath(request_id): AxumPath<String>,
    Json(request): Json<ControlConfirmRequest>,
) -> AppResult<Json<ControlConfirmResponse>> {
    let accepted = collab::control::answer_confirm(&state, &request_id, request.approve);
    Ok(Json(ControlConfirmResponse {
        request_id,
        approve: request.approve,
        accepted,
    }))
}
