//! `WS /api/workspaces/{id}/events` — the per-workspace event fan-out.

use axum::{
    extract::{
        Path as AxumPath, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};

use super::support::validate_websocket_origin;
use crate::{AppState, db, error::AppResult, events::WorkspaceEvent};

/* ------------------------------ workspace events -------------------------- */

/// `WS /api/workspaces/{id}/events`: one read-only stream of agent status,
/// approvals, deliveries, terminal exits and board changes.
pub async fn workspace_events(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    validate_websocket_origin(&headers)?;
    db::get_workspace(&state.pool, &workspace_id).await?;
    let receiver = state.events.subscribe(&workspace_id);
    Ok(ws.on_upgrade(move |socket| handle_workspace_events(receiver, socket)))
}

async fn handle_workspace_events(
    mut receiver: tokio::sync::broadcast::Receiver<WorkspaceEvent>,
    socket: WebSocket,
) {
    let (mut sender, mut incoming) = socket.split();
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Ok(event) => {
                    let Ok(payload) = serde_json::to_string(&event) else { continue };
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            // The stream is read-only; a client frame only matters as a close.
            message = incoming.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}
