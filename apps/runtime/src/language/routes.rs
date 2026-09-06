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

use super::{ServerState, discover, edits, reason};
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
    // The probe cache lives in the settings document, so it may only be written
    // while this Runtime still owns that domain. The probes themselves are
    // facts about this machine and run either way.
    let persist = crate::ownership::local_write_allowed(
        &state.pool,
        crate::ownership::OwnershipDomain::Settings,
    )
    .await;
    let servers = match crate::remote::resolve(&state, &workspace)? {
        crate::remote::Execution::Local => {
            let mut servers =
                discover::discover(&state.settings, "local", allow_execute, refresh, persist).await;
            // A server that is actually running says so, over whatever the
            // probe cached: the probe answers "could this start", the hub
            // answers "is it".
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
            servers
        }
        // The execution host probes its own machine. It answers without the
        // grant, because probing starts nothing; the gate is applied here,
        // over its answer, exactly as `discover` applies it locally.
        crate::remote::Execution::Remote(worker) => {
            let mut servers = match worker.language.current().await {
                // A live link knows which servers are actually running; the
                // serial connection is a different process and would report
                // none of them.
                Some(link) => link.capabilities(refresh).await?,
                None => crate::remote::language::descriptors(
                    worker
                        .language_capabilities(&workspace.id, &workspace.root_path, refresh)
                        .await?,
                ),
            };
            if !allow_execute {
                for row in &mut servers {
                    if row.state != ServerState::Unsupported {
                        row.state = ServerState::Unsupported;
                        row.reason = Some(reason::EXECUTION_NOT_GRANTED.to_owned());
                    }
                }
            }
            servers
        }
    };
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
        execution_host_id: execution_host_id(&workspace),
        servers,
    }))
}

/// What the client is told the servers run on. Empty means this machine, and
/// the interface has one word for that.
fn execution_host_id(workspace: &Workspace) -> String {
    if workspace.execution_host_id.is_empty() {
        "local".to_owned()
    } else {
        workspace.execution_host_id.clone()
    }
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
    let opened = match crate::remote::resolve(&state, &workspace)? {
        crate::remote::Execution::Local => {
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
            Opened {
                session_id: opened.session_id,
                server_id: opened.server_id,
                generation: opened.generation,
                state: opened.state,
                reason: opened.reason,
                capabilities: opened.capabilities,
                outbox: opened.outbox,
            }
        }
        // The second connection is opened here and nowhere else, so a host
        // that is only ever browsed never spends an `ssh` session on it.
        crate::remote::Execution::Remote(worker) => {
            let link = worker.language.ensure(&worker, &state.events).await?;
            let opened = link
                .open_session(
                    &workspace_id,
                    &workspace.id,
                    &workspace.root_path,
                    &request.language_id,
                    &request.client_id,
                    workspace.permissions.write,
                    workspace.permissions.execute,
                )
                .await?;
            Opened {
                session_id: opened.session_id,
                server_id: opened.server_id,
                generation: opened.generation,
                state: opened.state,
                reason: opened.reason,
                capabilities: opened.capabilities,
                outbox: opened.outbox,
            }
        }
    };
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
    park(&state, &workspace_id, opened.session_id, opened.outbox);
    Ok(Json(answer))
}

/// One opened session, whichever machine answered.
struct Opened {
    session_id: String,
    server_id: String,
    generation: u64,
    state: ServerState,
    reason: Option<String>,
    capabilities: Value,
    outbox: mpsc::UnboundedReceiver<Vec<u8>>,
}

/// `DELETE /api/workspaces/{id}/language/sessions/{sessionId}`
pub async fn close_session(
    State(state): State<AppState>,
    AxumPath((workspace_id, session_id)): AxumPath<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let workspace = readable(&state, &workspace_id).await?;
    let closed = match crate::remote::resolve(&state, &workspace)? {
        crate::remote::Execution::Local => {
            state
                .language
                .close_session(&workspace_id, &session_id)
                .await
        }
        crate::remote::Execution::Remote(worker) => match worker.language.current().await {
            Some(link) => {
                let closed = link.close_session(&session_id).await;
                // The last session on a host takes the `ssh` session with it:
                // `sshd` allows ten by default, and one held open for an editor
                // nobody has any more is one a terminal cannot have (design
                // §2.7).
                if !link.has_any_session() {
                    worker.language.release().await;
                }
                closed
            }
            None => false,
        },
    };
    unpark(&state, &session_id);
    Ok(Json(serde_json::json!({ "closed": closed })))
}

/// Where a session's messages go. The controller holds one of these per open
/// socket and knows nothing else about the machine behind it.
#[derive(Clone)]
enum Endpoint {
    Local(std::sync::Arc<super::mux::Hub>),
    Remote(std::sync::Arc<crate::remote::language::Link>),
}

impl Endpoint {
    /// One JSON-RPC message on its way to the server. A remote send waits for
    /// link credit, which is what turns a flood into back pressure on the tab
    /// rather than unbounded memory here.
    async fn send(&self, session_id: &str, body: &[u8]) -> bool {
        match self {
            Self::Local(hub) => {
                super::session::handle(hub, session_id, body);
                true
            }
            Self::Remote(link) => link.send(session_id, body.to_vec()).await.is_ok(),
        }
    }
}

/// The endpoint that holds `session_id`, or `None` when nothing does.
async fn endpoint(
    state: &AppState,
    workspace: &Workspace,
    session_id: &str,
) -> AppResult<Option<Endpoint>> {
    Ok(match crate::remote::resolve(state, workspace)? {
        crate::remote::Execution::Local => state
            .language
            .hubs_for(&workspace.id)
            .into_iter()
            .find(|hub| hub.lock().sessions.contains_key(session_id))
            .map(Endpoint::Local),
        crate::remote::Execution::Remote(worker) => worker
            .language
            .current()
            .await
            .filter(|link| link.has_session(session_id))
            .map(Endpoint::Remote),
    })
}

/// Ends a session whose socket is gone, on whichever host runs it. Errors are
/// swallowed on purpose: the socket has already closed and nobody is left to
/// tell, and a session that cannot be found was already ended by `DELETE`.
async fn end_session_after_socket(state: &AppState, workspace_id: &str, session_id: &str) {
    let Ok(workspace) = readable(state, workspace_id).await else {
        return;
    };
    match crate::remote::resolve(state, &workspace) {
        Ok(crate::remote::Execution::Local) => {
            state.language.close_session(workspace_id, session_id).await;
        }
        Ok(crate::remote::Execution::Remote(worker)) => {
            if let Some(link) = worker.language.current().await {
                link.close_session(session_id).await;
                if !link.has_any_session() {
                    worker.language.release().await;
                }
            }
        }
        Err(_) => {}
    }
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
    let workspace = readable(&state, &workspace_id).await?;
    let endpoint = endpoint(&state, &workspace, &session_id)
        .await?
        .ok_or_else(|| AppError::NotFound("No such language session".into()))?;
    let outbox = unpark(&state, &session_id)
        .ok_or_else(|| AppError::Conflict("This language session already has a socket".into()))?;
    // The socket *is* the session's lifetime. A tab that reloads, a browser
    // that crashes and an explicit `DELETE` all end the same way, and a
    // session nobody can reach still holds its documents open — the next
    // session for the same file would be told it is a follower and would sit
    // there with no diagnostics, waiting for a `didOpen` that already
    // happened (design §2.2 `documents`). A remote session ends the same way
    // through its link, so the execution host frees the server too.
    let closing_state = state.clone();
    let closing_workspace = workspace_id.clone();
    let closing_session = session_id.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        pump(endpoint, session_id, outbox, socket).await;
        end_session_after_socket(&closing_state, &closing_workspace, &closing_session).await;
    }))
}

async fn pump(
    endpoint: Endpoint,
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
                // The sender was dropped: the server is gone, or a remote link
                // died and marked this session disconnected. Closing the socket
                // is how the client learns to stop waiting.
                None => break,
            },
            message = incoming.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if !endpoint.send(&session_id, text.as_bytes()).await { break; }
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
    // A remote edit is applied where the files are. The versions travel with
    // it, so every file is still checked against what the caller read — on the
    // machine that writes it, which is the only place that check means
    // anything.
    if let crate::remote::Execution::Remote(worker) = crate::remote::resolve(&state, &workspace)? {
        let link = worker
            .language
            .current()
            .await
            .ok_or_else(|| AppError::NotFound("No such language session".into()))?;
        let result = link
            .apply_edit(
                &workspace.id,
                &workspace.root_path,
                &session_id,
                &request.edit,
                request.expected_sha256,
                workspace.permissions.write,
            )
            .await?;
        // The remote watcher would find these on its next pass; publishing them
        // now is what makes an open editor reload as promptly as it does for a
        // local edit.
        for file in &result.applied {
            state.events.publish(
                &workspace_id,
                crate::events::WorkspaceEvent::FileChanged {
                    workspace_id: workspace_id.clone(),
                    path: file.path.clone(),
                    kind: crate::events::FileChangeKind::Modified,
                    sha256: Some(file.sha256.clone()),
                    size: Some(file.size),
                    mtime: None,
                },
            );
        }
        return Ok(Json(result));
    }
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
    control(&state, &workspace, &server_id, super::Control::Restart).await
}

/// `POST /api/workspaces/{id}/language/servers/{serverId}/stop`
pub async fn stop_server(
    State(state): State<AppState>,
    AxumPath((workspace_id, server_id)): AxumPath<(String, String)>,
) -> AppResult<Json<super::ServerDescriptor>> {
    let workspace = readable(&state, &workspace_id).await?;
    control(&state, &workspace, &server_id, super::Control::Stop).await
}

/// Restart or stop, on whichever machine runs the server.
///
/// A remote server is reached over the language link, because that is the
/// connection its process belongs to. Without a link there is nothing running
/// to act on, and saying so is better than a button that silently succeeds.
async fn control(
    state: &AppState,
    workspace: &Workspace,
    server_id: &str,
    action: super::Control,
) -> AppResult<Json<super::ServerDescriptor>> {
    match crate::remote::resolve(state, workspace)? {
        crate::remote::Execution::Local => {
            match action {
                super::Control::Stop => state.language.stop(&workspace.id, server_id).await?,
                super::Control::Restart => {
                    state.language.restart(&workspace.id, server_id).await?
                }
            }
            descriptor(state, &workspace.id, server_id)
        }
        crate::remote::Execution::Remote(worker) => {
            let link = worker.language.current().await.ok_or_else(|| {
                AppError::NotFound("No language server is running on that host".into())
            })?;
            let server = link
                .control(
                    &workspace.id,
                    &workspace.id,
                    &workspace.root_path,
                    server_id,
                    action,
                    workspace.permissions.execute,
                )
                .await?;
            Ok(Json(server))
        }
    }
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

fn park(
    state: &AppState,
    workspace_id: &str,
    session_id: String,
    outbox: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    if let Ok(mut parked) = parked().lock() {
        parked.insert(session_id.clone(), outbox);
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
