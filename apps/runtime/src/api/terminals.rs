//! `/api/terminals` and the terminal WebSocket — creating sessions, the
//! attach socket, and the capture / paste / scroll / terminate operations.

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
use serde::Deserialize;

use super::support::validate_websocket_origin;
use crate::{
    AppState, db,
    error::{AppError, AppResult},
    model::{SessionSummary, TerminalSession},
    ownership,
    security::resolve_in_root,
    terminal::{
        BackendInfo, CaptureResponse, ClientMessage, DEFAULT_COLS, DEFAULT_ROWS, SpawnRequest,
        TerminateMode, Utf8Decoder, agent_environment,
    },
};

/* --------------------------------- terminals ----------------------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalAgent {
    pub id: String,
    #[allow(dead_code)]
    pub account_id: Option<String>,
    pub permission_mode: Option<String>,
    #[allow(dead_code)]
    pub model: Option<String>,
    #[allow(dead_code)]
    pub session_id: Option<String>,
}

/// `ssh: { hostId }` — the session runs `ssh …` instead of a shell (plan §21).
/// Only the id travels: everything else comes from `settings.ssh.hosts[]`, so a
/// client can never dictate the command line.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalSsh {
    pub host_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalRequest {
    workspace_id: String,
    cwd: String,
    shell: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    /// Terminal node that owns this session. Hook reports are attributed to it.
    node_id: Option<String>,
    agent: Option<CreateTerminalAgent>,
    ssh: Option<CreateTerminalSsh>,
}

/// The environment an agent PTY starts with.
///
/// A custom agent runs somebody else's program but reports through its base
/// agent's hooks, so everything provider-shaped — the approval wait, the hook
/// adapter — follows the base, while `ARMADRA_AGENT_ID` stays the custom id: that
/// is what the canvas node, the session row and the status badge are keyed by
/// (plan §24.1). Its own `env` is applied last and cannot shadow an `ARMADRA_*`
/// name, because those keys are refused when the entry is stored.
pub(crate) fn agent_session_environment(
    state: &AppState,
    node_id: &str,
    agent_id: &str,
) -> Vec<(String, String)> {
    let mut env = agent_environment(node_id, agent_id);
    // Arms hook-reply approvals (ARMADRA_PERM_WAIT_SECS) when enabled in settings.
    env.extend(
        state
            .hooks
            .extra_env(&state.settings.base_agent(agent_id), &state.settings),
    );
    if let Some(custom) = state.settings.custom_agent(agent_id) {
        env.extend(crate::settings::custom_agent_env(&custom));
    }
    env
}

/// `POST /api/terminals` — create and start in one step.
///
/// The gate is the session domain's (business migration §2.6). Once the Host
/// owns it, *whether* a terminal should exist is the Host's decision and this
/// route answers `ownership_moved`; the Host then calls back through the
/// private session door, which starts the same process by the same code. What
/// is deliberately not gated is attaching: the WebSocket, the capture, the
/// paste and the scroll are execution, they stay here, and gating them would
/// break every open terminal the moment the record moved.
pub async fn create_terminal(
    State(state): State<AppState>,
    Json(request): Json<CreateTerminalRequest>,
) -> AppResult<Json<TerminalSession>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Session).await?;
    let workspace = db::get_workspace(&state.pool, &request.workspace_id).await?;
    let cwd = resolve_in_root(&workspace.root_path, &request.cwd)?;

    if let Some(node_id) = request.node_id.as_deref()
        && uuid::Uuid::parse_str(node_id).is_err()
    {
        return Err(AppError::BadRequest("Terminal node id is invalid".into()));
    }
    let mut env = Vec::new();
    if let Some(agent) = request.agent.as_ref() {
        if !db::valid_agent_id(&agent.id) {
            return Err(AppError::BadRequest("Unknown agent id".into()));
        }
        if let Some(mode) = agent.permission_mode.as_deref()
            && !db::PERMISSION_MODES.contains(&mode)
        {
            return Err(AppError::BadRequest("Unknown permission mode".into()));
        }
        let Some(node_id) = request.node_id.as_deref() else {
            // Without a node there is nothing to attribute hook reports to, and
            // the hook client would refuse to report anyway.
            return Err(AppError::BadRequest(
                "An agent terminal requires the owning nodeId".into(),
            ));
        };
        // The hook client looks the token up by node name; without it the
        // report would still arrive, only flagged `legacy`.
        if let Err(error) = state.hooks.issue_node_token(node_id) {
            tracing::warn!(%error, node = %node_id, "hook reports for this node will be unverified");
        }
        env = agent_session_environment(&state, node_id, &agent.id);
    }

    // An SSH terminal is a normal session whose command is `ssh …` (plan §21).
    // The argv is built from the stored host, never from the request, and an
    // unknown id is refused rather than silently falling back to a local shell.
    let (command, args) = match request.ssh.as_ref() {
        Some(ssh) => {
            let host = state
                .settings
                .ssh_host(&ssh.host_id)
                .ok_or_else(|| AppError::BadRequest("Unknown SSH host".into()))?;
            let mut argv = crate::terminal::ssh::ssh_argv(&host);
            let program = argv.remove(0);
            (Some(program), argv)
        }
        None => (request.command, request.args),
    };

    let session = state
        .terminals
        .spawn(SpawnRequest {
            workspace_id: request.workspace_id,
            cwd: cwd.to_string_lossy().into_owned(),
            shell: request.shell,
            command,
            args,
            kind: "terminal".into(),
            owner_node_id: request.node_id,
            agent_id: request.agent.map(|agent| agent.id),
            env,
        })
        .await?;
    Ok(Json(session))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Vec<SessionSummary>>> {
    let mut sessions = db::list_sessions(&state.pool, &workspace_id).await?;
    for session in &mut sessions {
        session.alive = state.terminals.is_alive(&session.session_id).await;
    }
    Ok(Json(sessions))
}

/// `?writer=` names the client's own input stream so a reconnect can be told
/// what it already applied. It is a label, not a credential: the socket is
/// already authorized, and the only thing this id decides is whether *this*
/// client resends *its own* unacknowledged keystrokes.
#[derive(Debug, Default, Deserialize)]
pub struct TerminalSocketQuery {
    #[serde(default)]
    writer: Option<String>,
}

pub async fn terminal_socket(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<TerminalSocketQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    validate_websocket_origin(&headers)?;
    // Reject an unknown session with a 404 rather than a socket that closes
    // immediately, and keep the owner / workspace check on the REST path.
    db::get_terminal_session(&state.pool, &session_id).await?;
    let writer = match query.writer {
        Some(value) if value.len() <= 64 && value.chars().all(|c| c.is_ascii_graphic()) => value,
        Some(_) => {
            return Err(AppError::BadRequest("Terminal writer id is invalid".into()));
        }
        None => String::new(),
    };
    Ok(ws.on_upgrade(move |socket| handle_terminal_socket(state, session_id, writer, socket)))
}

/// Plan §15.5. Connecting is attaching and closing is detaching: the process is
/// never touched by the lifetime of a socket. Several sockets may attach to the
/// same session at once.
async fn handle_terminal_socket(
    state: AppState,
    session_id: String,
    writer: String,
    socket: WebSocket,
) {
    let Ok(attach) = state
        .terminals
        .attach(&session_id, DEFAULT_COLS, DEFAULT_ROWS)
        .await
    else {
        return;
    };
    let crate::terminal::AttachSession {
        generation,
        backend,
        rows,
        cols,
        alive,
        snapshot,
        mut output,
        mut status,
        current_status,
        detach,
        ..
    } = attach;
    // Dropped when this function returns, which detaches the client.
    let _detach = detach;

    let (mut sender, mut receiver) = socket.split();
    let mut hello = serde_json::json!({
        "type": "hello",
        "sessionId": session_id,
        "generation": generation,
        "backend": backend.as_str(),
        "rows": rows,
        "cols": cols,
        "alive": alive,
    });
    // A reconnecting client is told what its own writer already reached, so it
    // resends only what never landed instead of replaying keystrokes.
    if !writer.is_empty() {
        let acknowledged = state
            .terminals
            .acknowledged_input(&session_id, &writer)
            .await;
        hello["acknowledgedInput"] = serde_json::json!(acknowledged);
    }
    let hello = hello.to_string();
    if sender.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    // Only the direct backend replays: a tmux client redraws the real screen.
    if let Some(data) = snapshot.filter(|data| !data.is_empty()) {
        let payload = serde_json::json!({ "type": "snapshot", "data": data }).to_string();
        if sender.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }
    if let Some(event) = current_status {
        let payload = serde_json::json!({
            "type": "status", "status": event.status, "exitCode": event.exit_code
        })
        .to_string();
        if sender.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }

    let mut decoder = Utf8Decoder::default();
    loop {
        tokio::select! {
            chunk = output.recv() => match chunk {
                Ok(chunk) => {
                    let data = decoder.push(&chunk);
                    if data.is_empty() { continue; }
                    let payload = serde_json::json!({ "type": "output", "data": data }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    let payload = serde_json::json!({
                        "type": "warning",
                        "message": format!("Terminal output skipped {count} buffered chunks")
                    }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                // The stream ended: either the session is over, or it was
                // recycled underneath us, in which case the client is told to
                // clear and reconnect rather than left with a frozen screen.
                Err(_) => {
                    announce_stale(&state, &session_id, generation, &mut sender).await;
                    break;
                }
                // (a `stale` frame is followed by the close handshake below)
            },
            event = status.recv() => match event {
                Ok(event) => {
                    let payload = serde_json::json!({
                        "type": "status", "status": event.status, "exitCode": event.exit_code
                    }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {}
            },
            message = receiver.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else { continue };
                    let mut applied: Option<u64> = None;
                    let result = match message {
                        ClientMessage::Input { data, input_id } => {
                            let outcome = state.terminals.write(&session_id, generation, &data).await;
                            // The mark moves only after the bytes reached the
                            // pty: an acknowledged input is one this session
                            // will never accept again from the same writer.
                            if outcome.is_ok() && let Some(id) = input_id.filter(|id| *id > 0) {
                                state.terminals.note_input_applied(&session_id, &writer, id).await;
                                applied = Some(id);
                            }
                            outcome
                        }
                        ClientMessage::Resize { cols, rows } => {
                            state.terminals.resize(&session_id, generation, cols, rows).await
                        }
                        ClientMessage::Terminate { mode } => {
                            state.terminals.terminate(&session_id, mode.unwrap_or_default()).await
                        }
                    };
                    // A write against an old generation is not a protocol
                    // error: the client is simply behind a recycle, and is told
                    // so instead of having its socket dropped.
                    match result {
                        Ok(()) => {
                            if let Some(id) = applied {
                                let payload = serde_json::json!({ "type": "ack", "inputId": id }).to_string();
                                if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                            }
                        }
                        Err(AppError::Conflict(_)) => {
                            if announce_stale(&state, &session_id, generation, &mut sender).await {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    // A bare drop would let the peer see an RST and lose whatever is still in
    // flight — a `stale` frame in particular. The handshake makes the last
    // frames readable before the stream ends.
    let _ = sender.send(Message::Close(None)).await;
    state.terminals.detached(&session_id).await;
}

/// Sends `stale` when the session has moved on to a newer generation (plan
/// §15.5). Returns whether this socket is now obsolete.
async fn announce_stale(
    state: &AppState,
    session_id: &str,
    generation: u64,
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) -> bool {
    let Some(current) = state.terminals.generation(session_id).await else {
        return true;
    };
    if current == generation {
        return false;
    }
    let payload = serde_json::json!({ "type": "stale", "generation": current }).to_string();
    let _ = sender.send(Message::Text(payload.into())).await;
    true
}

/* --------------------------------- terminals ------------------------------ */

pub async fn get_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<TerminalSession>> {
    Ok(Json(state.terminals.session(&session_id).await?))
}

/// `GET /api/terminals/backend` — which backend is actually in effect, and why
/// (plan §15.1). The settings page shows this next to its one dropdown.
pub async fn terminal_backend(State(state): State<AppState>) -> Json<BackendInfo> {
    Json(state.terminals.backend_info())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureQuery {
    lines: Option<u32>,
    /// `true` keeps the SGR sequences, for a snapshot rather than for reading.
    escapes: Option<bool>,
}

/// `GET /api/terminals/{id}/capture?lines=&escapes=` — the pane as text.
pub async fn capture_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<CaptureQuery>,
) -> AppResult<Json<CaptureResponse>> {
    db::get_terminal_session(&state.pool, &session_id).await?;
    let lines = query.lines.unwrap_or(200).min(10_000);
    Ok(Json(
        state
            .terminals
            .capture(&session_id, lines, query.escapes.unwrap_or(false))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteRequest {
    text: String,
    #[serde(default)]
    enter: bool,
}

/// `POST /api/terminals/{id}/paste` — bracketed paste, optional Enter.
pub async fn paste_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<PasteRequest>,
) -> AppResult<Json<TerminalSession>> {
    if request.text.chars().count() > 200_000 {
        return Err(AppError::BadRequest("Pasted text is too large".into()));
    }
    state
        .terminals
        .paste(&session_id, &request.text, request.enter)
        .await?;
    Ok(Json(state.terminals.session(&session_id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollRequest {
    /// Positive scrolls towards older output, negative back towards the live
    /// screen. Whole lines — the browser does the wheel-delta arithmetic.
    lines: i32,
}

/// `POST /api/terminals/{id}/scroll` — the wheel bridge of plan §18.5.
///
/// The tmux client is deliberately not in mouse mode, so a wheel event never
/// reaches tmux on its own; the web side turns it into whole lines and posts
/// them here.
pub async fn scroll_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<ScrollRequest>,
) -> AppResult<axum::http::StatusCode> {
    // One screenful per notch is already generous; anything larger is a bug or
    // an attempt to make the runtime spin on tmux calls.
    if request.lines.abs() > 10_000 {
        return Err(AppError::BadRequest("Scroll distance is too large".into()));
    }
    state.terminals.scroll(&session_id, request.lines).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateRequest {
    #[serde(default)]
    mode: Option<TerminateMode>,
}

/// `POST /api/terminals/{id}/terminate` — interrupt, end the process, or
/// destroy the persistent session (plan §15.5). An empty body means `process`,
/// which is what the pre-§15 parameterless route did.
pub async fn terminate_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    body: Option<Json<TerminateRequest>>,
) -> AppResult<Json<TerminalSession>> {
    // Ending a session is a lifecycle decision, so it moves with the record.
    // The `Terminate` frame on the WebSocket is not gated: it is the user
    // pressing Ctrl+C in a pane they are looking at, which is execution.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Session).await?;
    let session = db::get_terminal_session(&state.pool, &session_id).await?;
    let mode = body
        .map(|Json(request)| request.mode.unwrap_or_default())
        .unwrap_or_default();
    match state.terminals.terminate(&session_id, mode).await {
        Ok(()) => {}
        // A session that already finished is not an error for the caller.
        Err(AppError::NotFound(_)) if session.status != "running" => {}
        Err(error) => return Err(error),
    }
    Ok(Json(state.terminals.session(&session_id).await?))
}

/// `POST /api/terminals/{id}/recycle` — same logical session, next generation.
pub async fn recycle_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<TerminalSession>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Session).await?;
    db::get_terminal_session(&state.pool, &session_id).await?;
    Ok(Json(state.terminals.recycle(&session_id).await?))
}
