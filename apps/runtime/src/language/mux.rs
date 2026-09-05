//! One server, many sessions (design §2.2 `mux`, §1.3).
//!
//! A [`Hub`] is everything that belongs to one `(workspace, serverId)` pair:
//! the process, the shadow documents, the sessions watching it and the table
//! that maps a request id back to whoever asked.
//!
//! ## The four directions
//!
//! * **Session → server** lives in [`super::session`]; it filters, rewrites
//!   and renames ids before anything is written.
//! * **Server → session** is here. A response goes to exactly the session that
//!   asked; `publishDiagnostics` goes to all of them; `$/progress` becomes a
//!   status rather than a message.
//! * **Server → client request** (`workspace/configuration`,
//!   `client/registerCapability`, `window/workDoneProgress/create`) is
//!   answered here and never reaches the browser. The browser is not the LSP
//!   client and cannot answer for a server it does not own.
//! * **Host → session** is the status stream: state changes, restarts and
//!   progress, published on the workspace event bus.
//!
//! ## Restarting is invisible
//!
//! A crash or an idle stop keeps the sessions and the shadow documents. The
//! restart re-runs `initialize` and replays `didOpen` for every open document,
//! so the editor sees diagnostics reappear rather than a session ending.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::{
    Feature, MAX_MESSAGE_BYTES, MAX_RESTARTS, RESTART_BACKOFF_SECONDS, RESTART_WINDOW_SECONDS,
    ServerState, documents::Documents, jsonrpc, policy, reason, server, uri,
};
use crate::events::{EventHub, WorkspaceEvent};

/// The id `initialize` travels under. It is not namespaced to any session,
/// because the host — not a session — is the client that sends it.
const INITIALIZE_ID: &str = "armadra:initialize";
/// A server that has not answered `initialize` by now is not going to.
const INITIALIZE_TIMEOUT_SECONDS: u64 = 60;

/// One session's end of the socket, plus what it is allowed to do.
pub struct Sink {
    pub client_id: String,
    pub allow_write: bool,
    pub outbox: mpsc::UnboundedSender<Vec<u8>>,
    /// Requests sent and not yet answered. Bounded by
    /// [`super::MAX_IN_FLIGHT`], so one session cannot make the server's
    /// queue everybody else's problem.
    pub in_flight: usize,
}

/// A request the server owes an answer to.
pub struct Pending {
    pub session_id: String,
    /// The id the *client* used, restored before the answer goes back.
    pub client_id: Value,
    pub method: String,
    pub sent_at: std::time::Instant,
}

pub struct State {
    pub process: Option<server::Process>,
    pub generation: u64,
    pub state: ServerState,
    pub reason: Option<String>,
    pub restart_count: u32,
    /// Crash timestamps inside the restart window.
    pub crashes: Vec<i64>,
    pub capabilities: Value,
    pub features: Vec<Feature>,
    pub documents: Documents,
    pub sessions: HashMap<String, Sink>,
    pub pending: HashMap<String, Pending>,
    pub sequence: u64,
    pub stderr_tail: String,
    /// When the last document closed; `None` while something is open.
    pub idle_since: Option<std::time::Instant>,
    /// Consecutive samples above the RSS ceiling.
    pub over_rss: u32,
    /// Set while a deliberate stop is in progress, so the exit that follows is
    /// not read as a crash.
    pub stopping: bool,
    initialize: Option<oneshot::Sender<Option<Value>>>,
}

/// One server and everything watching it.
pub struct Hub {
    pub workspace_id: String,
    pub server_id: String,
    pub language_id: String,
    pub root: PathBuf,
    pub rewriter: uri::Rewriter,
    pub launch: server::Launch,
    pub events: EventHub,
    pub state: Mutex<State>,
}

impl Hub {
    pub fn new(
        workspace_id: &str,
        language_id: &str,
        root: PathBuf,
        launch: server::Launch,
        events: EventHub,
    ) -> Arc<Self> {
        Arc::new(Self {
            workspace_id: workspace_id.to_owned(),
            server_id: launch.server_id.clone(),
            language_id: language_id.to_owned(),
            rewriter: uri::Rewriter::new(&root),
            root,
            launch,
            events,
            state: Mutex::new(State {
                process: None,
                generation: 0,
                state: ServerState::Available,
                reason: None,
                restart_count: 0,
                crashes: Vec::new(),
                capabilities: Value::Null,
                features: Vec::new(),
                documents: Documents::new(),
                sessions: HashMap::new(),
                pending: HashMap::new(),
                sequence: 0,
                stderr_tail: String::new(),
                idle_since: Some(std::time::Instant::now()),
                over_rss: 0,
                stopping: false,
                initialize: None,
            }),
        })
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts the process and completes the handshake.
    ///
    /// Idempotent: a hub that is already running returns immediately, so two
    /// sessions opening the same language at the same moment share one server
    /// rather than racing two into existence.
    pub async fn ensure_started(self: &Arc<Self>) -> Result<(), String> {
        {
            let state = self.lock();
            match state.state {
                ServerState::Running => return Ok(()),
                ServerState::Starting => return Ok(()),
                ServerState::Stopped | ServerState::Crashed
                    if state.reason.as_deref() == Some(reason::RESOURCE_EXHAUSTED)
                        || state.reason.as_deref() == Some(reason::RESTART_BUDGET_EXHAUSTED) =>
                {
                    // A ceiling or an exhausted budget is not retried on its
                    // own; only an explicit restart clears it.
                    return Err(state.reason.clone().unwrap_or_default());
                }
                _ => {}
            }
        }
        let (events, receiver) = mpsc::unbounded_channel();
        let process = match server::Process::start(&self.launch, events) {
            Ok(process) => process,
            Err(server::StartError::ContainmentUnavailable) => {
                self.set_state(
                    ServerState::Unsupported,
                    Some(reason::CONTAINMENT_UNAVAILABLE),
                );
                return Err(reason::CONTAINMENT_UNAVAILABLE.to_owned());
            }
            Err(server::StartError::Spawn(error)) => {
                tracing::warn!(server = %self.server_id, "language server failed to start: {}", error.kind());
                self.set_state(ServerState::Crashed, Some(reason::SERVER_PROBE_FAILED));
                return Err(reason::SERVER_PROBE_FAILED.to_owned());
            }
        };
        let (ready, wait) = oneshot::channel();
        let generation = {
            let mut state = self.lock();
            state.process = Some(process);
            state.generation += 1;
            state.state = ServerState::Starting;
            state.reason = None;
            state.stopping = false;
            state.initialize = Some(ready);
            state.generation
        };
        self.publish_status();
        pump(Arc::downgrade(self), receiver, generation);

        let params = server::initialize_params(
            &self.root,
            server::host_capabilities(),
            self.launch.initialization_options.clone(),
        );
        self.write(&jsonrpc::request(
            &Value::String(INITIALIZE_ID.into()),
            "initialize",
            params,
        ));
        let answer = tokio::time::timeout(
            std::time::Duration::from_secs(INITIALIZE_TIMEOUT_SECONDS),
            wait,
        )
        .await;
        let capabilities = match answer {
            Ok(Ok(Some(capabilities))) => capabilities,
            _ => {
                self.stop_process(ServerState::Crashed, reason::CRASHED)
                    .await;
                return Err(reason::CRASHED.to_owned());
            }
        };
        self.write(&jsonrpc::notification("initialized", serde_json::json!({})));
        {
            let mut state = self.lock();
            state.features = Feature::from_capabilities(&capabilities);
            state.capabilities = capabilities;
            state.state = ServerState::Running;
            state.reason = None;
        }
        self.replay_documents();
        self.publish_status();
        Ok(())
    }

    /// Re-sends `didOpen` for every shadow document (design §1.3).
    ///
    /// This is what makes a restart invisible: the server comes back knowing
    /// exactly the buffers the editor has open, including unsaved text, and
    /// republishes diagnostics without the browser doing anything.
    fn replay_documents(&self) {
        let opens: Vec<Value> = {
            let state = self.lock();
            state
                .documents
                .iter()
                .map(|document| {
                    jsonrpc::notification(
                        "textDocument/didOpen",
                        serde_json::json!({
                            "textDocument": {
                                "uri": self.rewriter.file_uri(
                                    &self.rewriter.relative_of(&document.uri).unwrap_or_default(),
                                ),
                                "languageId": document.language_id,
                                "version": document.version,
                                "text": document.text,
                            }
                        }),
                    )
                })
                .collect()
        };
        for open in &opens {
            self.write(open);
        }
    }

    /// Writes one message to the server. A hub with no process drops it: the
    /// caller has already been told the state, and queueing for a process that
    /// does not exist would deliver a stale request after a restart.
    pub fn write(&self, message: &Value) {
        let body = serde_json::to_vec(message).unwrap_or_default();
        let state = self.lock();
        if let Some(process) = state.process.as_ref() {
            process.send(&body);
        }
    }

    pub fn set_state(&self, next: ServerState, why: Option<&str>) {
        {
            let mut state = self.lock();
            state.state = next;
            state.reason = why.map(str::to_owned);
        }
        self.publish_status();
    }

    /// Ends the process and tells every session why.
    pub async fn stop_process(&self, next: ServerState, why: &str) {
        let process = {
            let mut state = self.lock();
            state.stopping = true;
            state.state = next;
            state.reason = Some(why.to_owned());
            if let Some(process) = state.process.as_ref() {
                state.stderr_tail = process.stderr_tail();
            }
            state.pending.clear();
            state.process.take()
        };
        if let Some(process) = process {
            // Ask first, then insist. A server given `shutdown`/`exit` closes
            // its own index files; one that ignores them gets five seconds.
            process.send(
                &serde_json::to_vec(&jsonrpc::request(
                    &Value::String("armadra:shutdown".into()),
                    "shutdown",
                    Value::Null,
                ))
                .unwrap_or_default(),
            );
            process.send(
                &serde_json::to_vec(&jsonrpc::notification("exit", Value::Null))
                    .unwrap_or_default(),
            );
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            process.terminate().await;
        }
        self.publish_status();
    }

    /// The descriptor the settings page and the resource panel read.
    pub fn descriptor(&self) -> super::ServerDescriptor {
        let state = self.lock();
        let (extensions, features) = super::registry::candidate(&self.server_id)
            .map(|(entry, candidate)| {
                (
                    entry
                        .extensions
                        .iter()
                        .map(|value| (*value).to_owned())
                        .collect::<Vec<_>>(),
                    candidate.features.to_vec(),
                )
            })
            .unwrap_or_default();
        super::ServerDescriptor {
            server_id: self.server_id.clone(),
            language_id: self.language_id.clone(),
            file_extensions: extensions,
            executable: self.launch.executable.to_string_lossy().into_owned(),
            version: String::new(),
            state: state.state,
            reason: state.reason.clone(),
            features: if state.features.is_empty() {
                features
            } else {
                state.features.clone()
            },
            restart_count: state.restart_count,
            pid: state.process.as_ref().and_then(|process| process.pid),
            start_time_unix_ms: state
                .process
                .as_ref()
                .and_then(|process| process.start_time_unix_ms),
            open_documents: state.documents.len() as u32,
            probed_at_unix_ms: 0,
        }
    }

    pub fn publish_status(&self) {
        let (server_state, why, restart_count, sessions, stderr) = {
            let state = self.lock();
            (
                state.state,
                state.reason.clone(),
                state.restart_count,
                state.sessions.keys().cloned().collect::<Vec<_>>(),
                state.stderr_tail.clone(),
            )
        };
        for session_id in sessions {
            self.events.publish(
                &self.workspace_id,
                WorkspaceEvent::LanguageSession {
                    workspace_id: self.workspace_id.clone(),
                    session_id,
                    server_id: self.server_id.clone(),
                    generation: self.lock().generation,
                    state: server_state,
                    reason: why.clone(),
                    restart_count,
                    progress: None,
                },
            );
        }
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::LanguageServer {
                workspace_id: self.workspace_id.clone(),
                execution_host_id: "local".into(),
                server: Box::new(self.descriptor()),
                // Only a crash carries the tail, and only in memory: it is
                // never written to a log or the database (design §3.4).
                stderr_tail: (server_state == ServerState::Crashed && !stderr.is_empty())
                    .then_some(stderr),
            },
        );
    }

    /// Sends one already-rewritten message to one session.
    pub fn deliver(&self, session_id: &str, message: &Value) {
        let state = self.lock();
        if let Some(sink) = state.sessions.get(session_id) {
            let _ = sink
                .outbox
                .send(serde_json::to_vec(message).unwrap_or_default());
        }
    }

    fn broadcast(&self, message: &Value) {
        let body = serde_json::to_vec(message).unwrap_or_default();
        let state = self.lock();
        for sink in state.sessions.values() {
            let _ = sink.outbox.send(body.clone());
        }
    }
}

/// Drains one process's events until it exits.
///
/// Holds a [`Weak`] reference so a hub nobody wants any more is dropped rather
/// than kept alive by its own reader.
fn pump(hub: Weak<Hub>, mut events: mpsc::UnboundedReceiver<server::Event>, generation: u64) {
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            let Some(hub) = hub.upgrade() else { return };
            // A message from a process that has already been replaced belongs
            // to a generation nobody is listening to.
            if hub.lock().generation != generation {
                return;
            }
            match event {
                server::Event::Message { body, oversize } => on_message(&hub, &body, oversize),
                server::Event::Exited { code } => {
                    on_exit(&hub, code).await;
                    return;
                }
            }
        }
    });
}

fn on_message(hub: &Arc<Hub>, body: &[u8], oversize: bool) {
    let Ok(mut message) = jsonrpc::Message::parse(body) else {
        return;
    };
    match message.kind {
        jsonrpc::Kind::Response => on_response(hub, &mut message, oversize),
        jsonrpc::Kind::Request => on_server_request(hub, &message),
        jsonrpc::Kind::Notification => on_notification(hub, &mut message),
    }
}

fn on_response(hub: &Arc<Hub>, message: &mut jsonrpc::Message, oversize: bool) {
    let id = message.id_string();
    if id == INITIALIZE_ID {
        let sender = hub.lock().initialize.take();
        if let Some(sender) = sender {
            let capabilities = message
                .value
                .get("result")
                .and_then(|result| result.get("capabilities"))
                .cloned();
            let _ = sender.send(capabilities);
        }
        return;
    }
    let Some(pending) = hub.lock().pending.remove(&id) else {
        // Nobody is waiting: an answer to a request whose session left, or to
        // one that already timed out. Dropping it is the whole handling.
        return;
    };
    {
        let mut state = hub.lock();
        if let Some(sink) = state.sessions.get_mut(&pending.session_id) {
            sink.in_flight = sink.in_flight.saturating_sub(1);
        }
    }
    if oversize {
        // The session gets a failure it can show, not silence. `-32803` is
        // LSP's own "this request failed for a non-protocol reason".
        let error = jsonrpc::error_response(
            Some(&pending.client_id),
            jsonrpc::REQUEST_FAILED,
            "The language server's answer was too large to deliver",
        );
        tracing::debug!(
            server = %hub.server_id,
            method = %pending.method,
            "language response exceeded the message ceiling",
        );
        hub.deliver(&pending.session_id, &error);
        return;
    }
    hub.rewriter
        .rewrite(&mut message.value, uri::Direction::ToWeb);
    if let Some(object) = message.value.as_object_mut() {
        object.insert("id".into(), pending.client_id.clone());
    }
    strip_command_actions(&pending.method, &mut message.value);
    hub.deliver(&pending.session_id, &message.value);
}

/// A code action whose only effect is a `command` would need
/// `workspace/executeCommand` to apply, which is refused (design §6.2). It is
/// removed here rather than shown and then rejected on click.
fn strip_command_actions(method: &str, message: &mut Value) {
    if method != "textDocument/codeAction" {
        return;
    }
    let Some(Value::Array(actions)) = message.get_mut("result") else {
        return;
    };
    actions.retain(policy::code_action_is_offered);
}

fn on_notification(hub: &Arc<Hub>, message: &mut jsonrpc::Message) {
    match message.method.as_str() {
        "textDocument/publishDiagnostics" => {
            hub.rewriter
                .rewrite(&mut message.value, uri::Direction::ToWeb);
            hub.broadcast(&message.value);
        }
        "$/progress" => publish_progress(hub, &message.value),
        // `window/logMessage` and `window/showMessage` carry server prose that
        // can quote file contents. It is not forwarded and not logged.
        _ => {}
    }
}

fn publish_progress(hub: &Arc<Hub>, message: &Value) {
    let Some(value) = message.get("params").and_then(|params| params.get("value")) else {
        return;
    };
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let progress = (kind != "end").then(|| crate::events::LanguageProgress {
        percent: value
            .get("percentage")
            .and_then(Value::as_u64)
            .map(|percent| percent.min(100) as u32),
        title: value
            .get("title")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    });
    let (server_state, why, restart_count, generation, sessions) = {
        let state = hub.lock();
        (
            state.state,
            state.reason.clone(),
            state.restart_count,
            state.generation,
            state.sessions.keys().cloned().collect::<Vec<_>>(),
        )
    };
    for session_id in sessions {
        hub.events.publish(
            &hub.workspace_id,
            WorkspaceEvent::LanguageSession {
                workspace_id: hub.workspace_id.clone(),
                session_id,
                server_id: hub.server_id.clone(),
                generation,
                state: server_state,
                reason: why.clone(),
                restart_count,
                progress: progress.clone(),
            },
        );
    }
}

/// Requests the server makes of its client. The Manager answers them; the
/// browser never sees them, because the browser is not the client.
fn on_server_request(hub: &Arc<Hub>, message: &jsonrpc::Message) {
    let id = message.id.clone().unwrap_or(Value::Null);
    let answer = match message.method.as_str() {
        // One entry per requested section. The runtime hands back the user's
        // own `language.servers.<id>.settings`, or null when they set none.
        "workspace/configuration" => {
            let items = message
                .value
                .get("params")
                .and_then(|params| params.get("items"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(1);
            let configuration = configuration_for(hub);
            jsonrpc::result_response(Some(&id), Value::Array(vec![configuration; items]))
        }
        // Dynamic registration is accepted so a server that insists on it can
        // start; what it registers still has to pass the method allowlist.
        "client/registerCapability" | "client/unregisterCapability" => {
            jsonrpc::result_response(Some(&id), Value::Null)
        }
        "window/workDoneProgress/create" => jsonrpc::result_response(Some(&id), Value::Null),
        "workspace/workspaceFolders" => jsonrpc::result_response(
            Some(&id),
            serde_json::json!([{
                "uri": format!("file://{}", hub.rewriter.root()),
                "name": hub.root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            }]),
        ),
        // A server asking to write files goes through the same preview and
        // sha-checked apply a rename does; until that flow exists for
        // server-initiated edits, the honest answer is "not applied".
        "workspace/applyEdit" => jsonrpc::result_response(
            Some(&id),
            serde_json::json!({ "applied": false, "failureReason": "unsupported" }),
        ),
        _ => jsonrpc::error_response(
            Some(&id),
            jsonrpc::METHOD_NOT_FOUND,
            "This client does not implement that request",
        ),
    };
    hub.write(&answer);
}

fn configuration_for(hub: &Arc<Hub>) -> Value {
    hub.launch
        .initialization_options
        .clone()
        .unwrap_or(Value::Null)
}

/// The process went away. Whether that is a crash depends on whether somebody
/// asked for it (design §1.3).
async fn on_exit(hub: &Arc<Hub>, code: Option<i32>) {
    let (stopping, tail, sessions) = {
        let mut state = hub.lock();
        let tail = state
            .process
            .as_ref()
            .map(server::Process::stderr_tail)
            .unwrap_or_default();
        state.process = None;
        state.pending.clear();
        let sessions: Vec<String> = state.sessions.keys().cloned().collect();
        (state.stopping, tail, sessions)
    };
    if stopping {
        return;
    }
    let now = chrono::Utc::now().timestamp();
    let restart = {
        let mut state = hub.lock();
        state
            .crashes
            .retain(|when| now - when < RESTART_WINDOW_SECONDS);
        state.crashes.push(now);
        state.stderr_tail = tail;
        state.state = ServerState::Crashed;
        state.reason = Some(reason::CRASHED.to_owned());
        let delay = restart_delay(state.crashes.len() as u32);
        match delay {
            Some(delay) => {
                state.restart_count = state.restart_count.saturating_add(1);
                Some(delay)
            }
            None => {
                state.reason = Some(reason::RESTART_BUDGET_EXHAUSTED.to_owned());
                None
            }
        }
    };
    tracing::info!(
        server = %hub.server_id,
        exit = ?code,
        sessions = sessions.len(),
        "language server exited",
    );
    hub.publish_status();
    let Some(backoff) = restart else { return };
    // Only restart while somebody is still watching: a server whose last
    // session left crashed on its way out, and reviving it would start a
    // process nobody asked for.
    if hub.lock().sessions.is_empty() {
        return;
    }
    let hub = hub.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        if hub.lock().sessions.is_empty() {
            return;
        }
        let _ = hub.ensure_started().await;
    });
}

/// How long to wait before the `attempt`-th restart inside the window, or
/// `None` once the budget is spent.
///
/// The budget exists because a server that fails on startup fails on startup
/// every time: without it, a broken `tsconfig` would become an endless restart
/// loop that looks like the machine is busy. Stopping at three, and staying
/// stopped until a person presses restart, is the honest end of that.
pub fn restart_delay(attempt: u32) -> Option<u64> {
    if attempt == 0 || attempt > MAX_RESTARTS {
        return None;
    }
    Some(RESTART_BACKOFF_SECONDS[(attempt as usize - 1).min(RESTART_BACKOFF_SECONDS.len() - 1)])
}

/// Requests older than the ceiling, cancelled and answered.
///
/// A hung server is the normal reason. The session is told `-32803` so the
/// editor stops waiting, and the server is sent `$/cancelRequest` so it stops
/// working on an answer nobody will read.
pub fn expire_requests(hub: &Arc<Hub>, older_than: std::time::Duration) {
    let expired: Vec<(String, Pending)> = {
        let mut state = hub.lock();
        let ids: Vec<String> = state
            .pending
            .iter()
            .filter(|(_, pending)| pending.sent_at.elapsed() > older_than)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| state.pending.remove(&id).map(|pending| (id, pending)))
            .collect()
    };
    for (id, pending) in expired {
        {
            let mut state = hub.lock();
            if let Some(sink) = state.sessions.get_mut(&pending.session_id) {
                sink.in_flight = sink.in_flight.saturating_sub(1);
            }
        }
        hub.write(&jsonrpc::notification(
            "$/cancelRequest",
            serde_json::json!({ "id": id }),
        ));
        hub.deliver(
            &pending.session_id,
            &jsonrpc::error_response(
                Some(&pending.client_id),
                jsonrpc::REQUEST_FAILED,
                "The language server did not answer in time",
            ),
        );
    }
}

/// The message ceiling, applied to what a session is about to send.
pub fn within_message_ceiling(body: &[u8]) -> bool {
    body.len() <= MAX_MESSAGE_BYTES as usize
}
