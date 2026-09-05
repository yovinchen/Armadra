//! `/api/workspaces/{id}/language/**` — the Runtime ↔ Web surface (design
//! §2.9).
//!
//! The controller does not parse LSP. It authorises, it routes, and it moves
//! text frames; every decision about *what* a message may do is taken on the
//! execution host, which for a local workspace is this process and for a
//! remote one is the Worker.
//!
//! The session socket is its own WebSocket rather than the workspace event
//! stream: that stream is one-directional by design, and a session has to
//! send. Session *status* still goes on the event stream, so the status line
//! and the settings page follow a server without opening a socket.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{
        Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use super::{ServerState, discover, edits, lifecycle::OpenedSession, reason};
use crate::{
    AppState, db,
    error::{AppError, AppResult},
    model::Workspace,
};

/* ------------------------------- discovery -------------------------------- */

#[derive(Debug, Deserialize)]
pub struct ProbeQuery {
    /// `?refresh=1` ignores the 24 h cache and runs `--version` again.
    #[serde(default)]
    refresh: Option<String>,
}

/// `GET /api/workspaces/{id}/language-service`
///
/// Rows are listed whatever the answer is. A workspace with no execute grant
/// still gets one row per language, each `unsupported / execution_not_granted`
/// — the settings page has to be able to say *what* is missing, and an empty
/// panel says nothing.
pub async fn language_service(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<ProbeQuery>,
) -> AppResult<Json<super::LanguageServiceStatus>> {
    let workspace = readable(&state, &workspace_id).await?;
    let refresh = query
        .refresh
        .as_deref()
        .is_some_and(|value| value == "1" || value == "true");
    let allow_execute = workspace.permissions.execute;
    let mut servers = discover::discover(&state.settings, "local", allow_execute, refresh).await;
    // A server that is actually running says so, over whatever the probe
    // cached: the probe answers "could this start", the hub answers "is it".
    for hub in state.language.hubs_for(&workspace_id) {
        let live = hub.descriptor();
        if let Some(row) = servers
            .iter_mut()
            .find(|row| row.server_id == live.server_id)
        {
            row.state = live.state;
            row.reason = live.reason.clone();
            row.restart_count = live.restart_count;
            row.pid = live.pid;
            row.start_time_unix_ms = live.start_time_unix_ms;
            row.open_documents = live.open_documents;
            if !live.features.is_empty() {
                row.features = live.features;
            }
        }
    }
    let usable = servers
        .iter()
        .any(|server| server.state != ServerState::Unsupported);
    Ok(Json(super::LanguageServiceStatus {
        status: if usable { "available" } else { "unavailable" },
        reason: if usable {
            None
        } else if !allow_execute {
            Some(reason::EXECUTION_NOT_GRANTED.to_owned())
        } else {
            Some(reason::SERVER_NOT_FOUND.to_owned())
        },
        execution_host_id: "local".into(),
        servers,
    }))
}

/* -------------------------------- sessions -------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    language_id: String,
    client_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    client_capabilities: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionResponse {
    session_id: String,
    generation: u64,
    server_id: String,
    state: ServerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_capabilities: Option<Value>,
}

/// `POST /api/workspaces/{id}/language/sessions`
pub async fn open_session(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<OpenSessionRequest>,
) -> AppResult<Json<OpenSessionResponse>> {
    let workspace = readable(&state, &workspace_id).await?;
    crate::remote::refuse_remote(&workspace, "Language services on a remote execution host")?;
    let opened = state
        .language
        .open_session(
            &state.settings,
            &state.events,
            &workspace_id,
            std::path::Path::new(&workspace.root_path),
            &request.language_id,
            &request.client_id,
            workspace.permissions.write,
            workspace.permissions.execute,
        )
        .await?;
    let answer = OpenSessionResponse {
        session_id: opened.session_id.clone(),
        generation: opened.generation,
        server_id: opened.server_id.clone(),
        state: opened.state,
        reason: opened.reason.clone(),
        server_capabilities: (!opened.capabilities.is_null()).then(|| opened.capabilities.clone()),
    };
    // The socket has not been opened yet, so the receiver is parked until the
    // client connects. Parking it rather than dropping it means diagnostics
    // published between `POST` and the upgrade are not lost.
    park(&state, &workspace_id, opened);
    Ok(Json(answer))
}

/// `DELETE /api/workspaces/{id}/language/sessions/{sessionId}`
pub async fn close_session(
    State(state): State<AppState>,
    AxumPath((workspace_id, session_id)): AxumPath<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    readable(&state, &workspace_id).await?;
    let closed = state
        .language
        .close_session(&workspace_id, &session_id)
        .await;
    unpark(&state, &session_id);
    Ok(Json(serde_json::json!({ "closed": closed })))
}

/// `GET /api/workspaces/{id}/language/sessions/{sessionId}/stream` (WebSocket)
///
/// One text frame is one JSON-RPC message. The controller only forwards: it
/// does not read the payload, and it does not log it.
pub async fn session_stream(
    State(state): State<AppState>,
    AxumPath((workspace_id, session_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    crate::api::validate_websocket_origin(&headers)?;
    readable(&state, &workspace_id).await?;
    let hub = state
        .language
        .hubs_for(&workspace_id)
        .into_iter()
        .find(|hub| hub.lock().sessions.contains_key(&session_id))
        .ok_or_else(|| AppError::NotFound("No such language session".into()))?;
    let outbox = unpark(&state, &session_id)
        .ok_or_else(|| AppError::Conflict("This language session already has a socket".into()))?;
    Ok(ws.on_upgrade(move |socket| pump(hub, session_id, outbox, socket)))
}

async fn pump(
    hub: std::sync::Arc<super::mux::Hub>,
    session_id: String,
    mut outbox: mpsc::UnboundedReceiver<Vec<u8>>,
    socket: WebSocket,
) {
    let (mut sender, mut incoming) = socket.split();
    loop {
        tokio::select! {
            outgoing = outbox.recv() => match outgoing {
                Some(body) => {
                    let Ok(text) = String::from_utf8(body) else { continue };
                    if sender.send(Message::Text(text.into())).await.is_err() { break; }
                }
                None => break,
            },
            message = incoming.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    super::session::handle(&hub, &session_id, text.as_bytes());
                }
                // A language message is text. A binary frame is not one, and
                // guessing at an encoding is how a payload gets corrupted.
                Some(Ok(Message::Binary(_))) => continue,
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => break,
            }
        }
    }
}

/* ---------------------------------- edits --------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditRequest {
    edit: Value,
    #[serde(default)]
    expected_sha256: HashMap<String, String>,
}

/// `POST /api/workspaces/{id}/language/sessions/{sessionId}/edits`
pub async fn apply_edit(
    State(state): State<AppState>,
    AxumPath((workspace_id, session_id)): AxumPath<(String, String)>,
    Json(request): Json<ApplyEditRequest>,
) -> AppResult<Json<edits::ApplyResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    crate::remote::refuse_remote(&workspace, "Applying language edits on a remote host")?;
    let hub = state
        .language
        .hubs_for(&workspace_id)
        .into_iter()
        .find(|hub| hub.lock().sessions.contains_key(&session_id))
        .ok_or_else(|| AppError::NotFound("No such language session".into()))?;
    let files = edits::parse(&request.edit, &hub.rewriter)?;
    // A file with unsaved changes is not overwritten. The dialog lists them
    // and the user decides; nothing here silently discards a draft.
    let dirty = {
        let held = hub.lock();
        edits::dirty_files(&files, &held.documents, &hub.rewriter)
    };
    if !dirty.is_empty() {
        return Err(AppError::Conflict(format!(
            "Save these files before applying the edit: {}",
            dirty.join(", ")
        )));
    }
    let root = std::path::PathBuf::from(workspace.root_path);
    let events = state.events.clone();
    let workspace_id = workspace_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        edits::apply(
            &root,
            &workspace_id,
            &files,
            &request.expected_sha256,
            &events,
        )
    })
    .await??;
    Ok(Json(result))
}

/* ------------------------------ manual control ---------------------------- */

/// `POST /api/workspaces/{id}/language/servers/{serverId}/restart`
pub async fn restart_server(
    State(state): State<AppState>,
    AxumPath((workspace_id, server_id)): AxumPath<(String, String)>,
) -> AppResult<Json<super::ServerDescriptor>> {
    let workspace = readable(&state, &workspace_id).await?;
    if !workspace.permissions.execute {
        return Err(AppError::Forbidden(reason::EXECUTION_NOT_GRANTED.into()));
    }
    state.language.restart(&workspace_id, &server_id).await?;
    descriptor(&state, &workspace_id, &server_id)
}

/// `POST /api/workspaces/{id}/language/servers/{serverId}/stop`
pub async fn stop_server(
    State(state): State<AppState>,
    AxumPath((workspace_id, server_id)): AxumPath<(String, String)>,
) -> AppResult<Json<super::ServerDescriptor>> {
    readable(&state, &workspace_id).await?;
    state.language.stop(&workspace_id, &server_id).await?;
    descriptor(&state, &workspace_id, &server_id)
}

fn descriptor(
    state: &AppState,
    workspace_id: &str,
    server_id: &str,
) -> AppResult<Json<super::ServerDescriptor>> {
    state
        .language
        .hub(workspace_id, server_id)
        .map(|hub| Json(hub.descriptor()))
        .ok_or_else(|| AppError::NotFound("No such language server".into()))
}

/* --------------------------------- helpers -------------------------------- */

async fn readable(state: &AppState, workspace_id: &str) -> AppResult<Workspace> {
    let workspace = db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    Ok(workspace)
}

/// Sockets that have been opened but not yet connected.
///
/// `POST` creates a session and `GET …/stream` connects it; between the two,
/// the server may already be publishing diagnostics. Holding the receiver here
/// means those arrive when the socket opens instead of being dropped.
type Parked = std::sync::Mutex<HashMap<String, mpsc::UnboundedReceiver<Vec<u8>>>>;

fn parked() -> &'static Parked {
    static PARKED: std::sync::OnceLock<Parked> = std::sync::OnceLock::new();
    PARKED.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn park(state: &AppState, workspace_id: &str, opened: OpenedSession) {
    let session_id = opened.session_id.clone();
    if let Ok(mut parked) = parked().lock() {
        parked.insert(session_id.clone(), opened.outbox);
    }
    // A session nobody ever connects would hold a server open forever, so it
    // is given a minute to produce a socket and then closed like any other.
    let language = state.language.clone();
    let workspace_id = workspace_id.to_owned();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let abandoned = parked()
            .lock()
            .map(|parked| parked.contains_key(&session_id))
            .unwrap_or(false);
        if abandoned {
            unpark_id(&session_id);
            language.close_session(&workspace_id, &session_id).await;
        }
    });
}

fn unpark(_state: &AppState, session_id: &str) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
    unpark_id(session_id)
}

fn unpark_id(session_id: &str) -> Option<mpsc::UnboundedReceiver<Vec<u8>>> {
    parked().lock().ok()?.remove(session_id)
}
