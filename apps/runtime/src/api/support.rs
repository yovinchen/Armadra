//! Shared extractors for the HTTP layer: workspace permission lookups,
//! WebSocket origin checks and query-map helpers used across the API modules.

use std::collections::HashMap;

use axum::http::HeaderMap;

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    model::Workspace,
};

/// Read access is the gate for every listing and search surface.
pub(super) async fn readable_workspace(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<Workspace> {
    let workspace = db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    Ok(workspace)
}

/// Write access is the gate for creating, renaming and deleting.
pub(super) async fn writable_workspace(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<Workspace> {
    let workspace = db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    Ok(workspace)
}

pub(super) fn validate_websocket_origin(headers: &HeaderMap) -> AppResult<()> {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Forbidden("WebSocket Origin is required".into()))?;
    if loopback_origin(origin) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "WebSocket Origin is not allowed".into(),
        ))
    }
}

/// The origins a loopback Runtime accepts.
///
/// The portless forms matter for the Unix socket and named pipe transports: a
/// caller that reached the Runtime over one of those has no port to name, and
/// the Go Host rewrites the device's own browser Origin to exactly this before
/// forwarding (host protocol design §5). It is still a loopback literal — this
/// never widens the check to a hostname the network could resolve.
pub fn loopback_origin(origin: &str) -> bool {
    origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:")
        || origin == "http://127.0.0.1"
        || origin == "http://localhost"
        || origin == "tauri://localhost"
        || origin == "https://tauri.localhost"
}

pub(super) fn default_path() -> String {
    ".".into()
}

pub fn parse_query_map(query: &HashMap<String, String>, key: &str) -> String {
    query.get(key).cloned().unwrap_or_else(default_path)
}
