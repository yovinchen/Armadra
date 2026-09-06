//! The controller half of a remote language service (design §2.7, §4.1).
//!
//! ## What this is
//!
//! A second `ssh` connection to one execution host, opened the first time an
//! editor asks for a language session there and closed when the last one goes.
//! The serial connection ([`super::client`]) stays exactly what it was: one
//! request, one answer, one queue. This one is full duplex, because a server
//! pushes diagnostics nobody asked for and a slow completion must not stall a
//! file read.
//!
//! ## What the controller does and does not do
//!
//! It routes. It never parses a JSON-RPC payload, never logs one, and never
//! decides what a method may do — the execution host re-checks the method
//! allowlist and the workspace's grants, because it is the machine that would
//! run the thing (§3.1).
//!
//! ## Epochs
//!
//! The link announces a `link_epoch` as its first frame. Every frame in both
//! directions carries it, and a frame stamped with anything else is dropped.
//! When the connection dies, every session on it becomes `disconnected` and
//! its socket closes; the next session opens a new link with a new epoch. In
//! flight requests are not replayed — a rename that was written and then lost
//! its answer may already have touched files, and re-sending it is the one
//! thing that could do the damage twice.

use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use armadra_protocol::{Message, v1};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

use super::client::{RemoteWorker, remote_error};
use crate::{
    error::{AppError, AppResult},
    events::{EventHub, WorkspaceEvent},
    language::{self, link::Window},
};

/// Capability the second connection must advertise before a frame is written.
pub const LINK_CAPABILITY: &str = "language.link.v1";
/// How long one request on the link may take end to end.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// One session as the controller sees it: somewhere to put what arrives.
struct Sink {
    workspace_id: String,
    server_id: String,
    outbox: mpsc::UnboundedSender<Vec<u8>>,
}

/// What an opened remote session hands back, shaped like the local one so the
/// route does not care which machine answered.
pub struct OpenedSession {
    pub session_id: String,
    pub server_id: String,
    pub generation: u64,
    pub state: language::ServerState,
    pub reason: Option<String>,
    pub capabilities: serde_json::Value,
    pub outbox: mpsc::UnboundedReceiver<Vec<u8>>,
}

/// State shared between the reader task, the writer task and every caller.
struct Shared {
    controller_id: String,
    host_name: String,
    execution_host_id: String,
    outgoing: mpsc::UnboundedSender<v1::WorkerRequest>,
    /// Controller → execution host credit.
    window: Window,
    sessions: Mutex<HashMap<String, Sink>>,
    pending: Mutex<HashMap<String, oneshot::Sender<v1::worker_response::Result>>>,
    instance: Mutex<String>,
    epoch: Mutex<String>,
    roots: Mutex<HashSet<String>>,
    events: EventHub,
    alive: AtomicBool,
    /// The last descriptors the execution host reported, for the resource
    /// panel and the settings page.
    descriptors: Mutex<Vec<language::ServerDescriptor>>,
}

impl Shared {
    fn epoch(&self) -> String {
        self.epoch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Sink>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Sends one request and waits for its answer.
    async fn call(
        &self,
        action: v1::worker_request::Action,
    ) -> AppResult<v1::worker_response::Result> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(self.unavailable());
        }
        let request_id = uuid::Uuid::now_v7().simple().to_string();
        let (answer, wait) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request_id.clone(), answer);
        let request = v1::WorkerRequest {
            request_id: request_id.clone(),
            host_id: self.controller_id.clone(),
            expected_instance_id: self
                .instance
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
            deadline_unix_ms: chrono::Utc::now().timestamp_millis()
                + REQUEST_TIMEOUT.as_millis() as i64,
            action: Some(action),
        };
        if self.outgoing.send(request).is_err() {
            return Err(self.unavailable());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, wait).await {
            Ok(Ok(result)) => Ok(result),
            _ => {
                self.pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&request_id);
                Err(self.unavailable())
            }
        }
    }

    /// Pushes one frame. Frames are not requests: nothing waits for them.
    fn push(&self, mut frame: v1::LanguageFrame) -> Result<(), AppError> {
        frame.link_epoch = self.epoch();
        self.outgoing
            .send(v1::WorkerRequest {
                request_id: String::new(),
                host_id: self.controller_id.clone(),
                expected_instance_id: String::new(),
                deadline_unix_ms: 0,
                action: Some(v1::worker_request::Action::LanguageFrame(frame)),
            })
            .map_err(|_| self.unavailable())
    }

    fn unavailable(&self) -> AppError {
        AppError::Unavailable(format!(
            "The language link to {} is not available",
            self.host_name
        ))
    }

    /// The link is gone. Every session it held is `disconnected`, its socket
    /// closes, and every caller waiting for an answer is told the outcome is
    /// not known rather than being left to a timeout.
    fn fail(&self) {
        if !self.alive.swap(false, Ordering::SeqCst) {
            return;
        }
        self.window.close();
        let sessions: Vec<(String, Sink)> = self.sessions().drain().collect();
        for (session_id, sink) in sessions {
            self.events.publish(
                &sink.workspace_id,
                WorkspaceEvent::LanguageSession {
                    workspace_id: sink.workspace_id.clone(),
                    session_id,
                    server_id: sink.server_id.clone(),
                    generation: 0,
                    state: language::ServerState::Disconnected,
                    reason: Some(language::reason::LINK_LOST.into()),
                    restart_count: 0,
                    progress: None,
                },
            );
            // Dropping the sender closes the browser's socket, which is how a
            // client learns to stop waiting and re-open.
            drop(sink);
        }
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.descriptors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        tracing::info!(host = %self.execution_host_id, "the remote language link closed");
    }

    /// One frame from the execution host.
    fn frame(&self, frame: v1::LanguageFrame) {
        let epoch = self.epoch();
        if !epoch.is_empty() && !frame.link_epoch.is_empty() && frame.link_epoch != epoch {
            return;
        }
        match frame.payload {
            Some(v1::language_frame::Payload::Message(message)) => {
                let delivered = {
                    let sessions = self.sessions();
                    sessions
                        .get(&message.session_id)
                        .is_some_and(|sink| sink.outbox.send(message.payload_json).is_ok())
                };
                if !delivered {
                    tracing::debug!(
                        host = %self.execution_host_id,
                        method = %message.method,
                        "dropping a language message for a session that is gone",
                    );
                }
                // Acknowledged whether or not it landed: the credit is the
                // execution host's, and holding it back for a session that
                // already left would stall every other session on the link.
                let _ = self.push(language::link::ack_frame(
                    &message.session_id,
                    message.sequence,
                    language::link::CREDIT_BYTES as u32,
                ));
            }
            Some(v1::language_frame::Payload::Ack(ack)) => {
                self.window.acknowledge(ack.received_through)
            }
            Some(v1::language_frame::Payload::Status(status)) => self.status(status),
            // The epoch announcement: no payload, and the epoch is adopted by
            // the reader before this is ever called.
            None => {}
        }
    }

    fn status(&self, status: v1::LanguageSessionStatus) {
        let target = self
            .sessions()
            .get(&status.session_id)
            .map(|sink| (sink.workspace_id.clone(), sink.server_id.clone()));
        let Some((workspace_id, server_id)) = target else {
            return;
        };
        let state = state_of(status.state);
        self.events.publish(
            &workspace_id,
            WorkspaceEvent::LanguageSession {
                workspace_id: workspace_id.clone(),
                session_id: status.session_id,
                server_id,
                generation: status.generation,
                state,
                reason: (!status.reason.is_empty()).then_some(status.reason),
                restart_count: status.restart_count,
                progress: (status.progress_percent.is_some() || !status.progress_title.is_empty())
                    .then_some(crate::events::LanguageProgress {
                        percent: status.progress_percent,
                        title: status.progress_title,
                    }),
            },
        );
    }
}

fn state_of(value: i32) -> language::ServerState {
    use language::ServerState as State;
    match v1::LanguageServerState::try_from(value) {
        Ok(v1::LanguageServerState::Available) => State::Available,
        Ok(v1::LanguageServerState::Starting) => State::Starting,
        Ok(v1::LanguageServerState::Running) => State::Running,
        Ok(v1::LanguageServerState::IdleStopped) => State::IdleStopped,
        Ok(v1::LanguageServerState::Crashed) => State::Crashed,
        Ok(v1::LanguageServerState::Stopped) => State::Stopped,
        Ok(v1::LanguageServerState::Disconnected) => State::Disconnected,
        // An unspecified or unknown state is not guessed into "running".
        _ => State::Unsupported,
    }
}

/* ----------------------------------- link ---------------------------------- */

/// One live second connection.
pub struct Link {
    shared: Arc<Shared>,
    child: tokio::sync::Mutex<tokio::process::Child>,
}

impl Link {
    pub fn epoch(&self) -> String {
        self.shared.epoch()
    }

    pub fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    /// The servers the execution host last reported, for the resource panel.
    pub fn descriptors(&self) -> Vec<language::ServerDescriptor> {
        self.shared
            .descriptors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// One JSON-RPC message from a browser socket, on its way to the server.
    ///
    /// Waits for credit when the window is full: the browser's socket applies
    /// the back pressure to the tab rather than this process buffering without
    /// bound.
    pub async fn send(&self, session_id: &str, body: Vec<u8>) -> AppResult<()> {
        if body.len() > language::MAX_MESSAGE_BYTES as usize {
            return Err(AppError::BadRequest(
                "The request is larger than the language service accepts".into(),
            ));
        }
        let parsed = language::jsonrpc::Message::parse(&body)
            .map_err(|_| AppError::BadRequest("That is not a JSON-RPC message".into()))?;
        let Some(sequence) = self.shared.window.reserve(body.len()).await else {
            return Err(self.shared.unavailable());
        };
        self.shared.push(language::link::message_frame(
            session_id,
            sequence,
            parsed.kind,
            &parsed.method,
            &parsed.id_string(),
            body,
        ))
    }

    /// Registers `root_id` on this connection if it has not been seen yet.
    async fn ensure_root(&self, root_id: &str, root_path: &str) -> AppResult<()> {
        {
            let roots = self
                .shared
                .roots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if roots.contains(root_id) {
                return Ok(());
            }
        }
        match self
            .shared
            .call(v1::worker_request::Action::RegisterRoot(
                v1::RegisterRootRequest {
                    root_id: root_id.to_owned(),
                    path: root_path.to_owned(),
                },
            ))
            .await?
        {
            v1::worker_response::Result::RegisteredRoot(_) => {
                self.shared
                    .roots
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(root_id.to_owned());
                Ok(())
            }
            v1::worker_response::Result::Error(error) => {
                Err(remote_error(&self.shared.host_name, &error))
            }
            _ => Err(self.wrong_answer()),
        }
    }

    /// Opens one session on the execution host.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_session(
        &self,
        workspace_id: &str,
        root_id: &str,
        root_path: &str,
        language_id: &str,
        client_id: &str,
        allow_write: bool,
        allow_execute: bool,
    ) -> AppResult<OpenedSession> {
        self.ensure_root(root_id, root_path).await?;
        let answer = self
            .shared
            .call(v1::worker_request::Action::OpenLanguageSession(
                v1::OpenLanguageSessionRequest {
                    root_id: root_id.to_owned(),
                    workspace_id: workspace_id.to_owned(),
                    // The execution host mints the id: it owns the shadow
                    // documents and the pending table that id keys.
                    session_id: String::new(),
                    language_id: language_id.to_owned(),
                    client_id: client_id.to_owned(),
                    allow_write,
                    allow_execute,
                    client_capabilities_json: Vec::new(),
                },
            ))
            .await?;
        let session = match answer {
            v1::worker_response::Result::LanguageSession(session) => session,
            v1::worker_response::Result::Error(error) => {
                return Err(remote_error(&self.shared.host_name, &error));
            }
            _ => return Err(self.wrong_answer()),
        };
        let (outbox, receiver) = mpsc::unbounded_channel();
        self.shared.sessions().insert(
            session.session_id.clone(),
            Sink {
                workspace_id: workspace_id.to_owned(),
                server_id: session.server_id.clone(),
                outbox,
            },
        );
        self.refresh_descriptors().await;
        Ok(OpenedSession {
            session_id: session.session_id,
            server_id: session.server_id,
            generation: session.generation,
            state: state_of(session.state),
            reason: (!session.reason.is_empty()).then_some(session.reason),
            capabilities: serde_json::from_slice(&session.server_capabilities_json)
                .unwrap_or(serde_json::Value::Null),
            outbox: receiver,
        })
    }

    pub async fn close_session(&self, session_id: &str) -> bool {
        let known = self.shared.sessions().remove(session_id).is_some();
        let _ = self
            .shared
            .call(v1::worker_request::Action::CloseLanguageSession(
                v1::CloseLanguageSessionRequest {
                    session_id: session_id.to_owned(),
                    reason: language::reason::USER.into(),
                },
            ))
            .await;
        self.refresh_descriptors().await;
        known
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.shared.sessions().contains_key(session_id)
    }

    /// Whether anything at all is still using this link.
    pub fn has_any_session(&self) -> bool {
        !self.shared.sessions().is_empty()
    }

    /// Applies a `WorkspaceEdit` on the execution host. The versions travel
    /// with it, so the files are checked where they are written.
    pub async fn apply_edit(
        &self,
        root_id: &str,
        root_path: &str,
        session_id: &str,
        edit: &serde_json::Value,
        expected: HashMap<String, String>,
        allow_write: bool,
    ) -> AppResult<language::edits::ApplyResult> {
        self.ensure_root(root_id, root_path).await?;
        let answer = self
            .shared
            .call(v1::worker_request::Action::LanguageApplyEdit(
                v1::LanguageApplyEditRequest {
                    root_id: root_id.to_owned(),
                    session_id: session_id.to_owned(),
                    workspace_edit_json: serde_json::to_vec(edit).unwrap_or_default(),
                    expected_sha256: expected,
                    allow_write,
                },
            ))
            .await?;
        match answer {
            v1::worker_response::Result::LanguageApplyEdit(result) => Ok(from_proto(result)),
            v1::worker_response::Result::Error(error) => {
                Err(remote_error(&self.shared.host_name, &error))
            }
            _ => Err(self.wrong_answer()),
        }
    }

    /// Server discovery on the execution host.
    pub async fn capabilities(&self, refresh: bool) -> AppResult<Vec<language::ServerDescriptor>> {
        match self
            .shared
            .call(v1::worker_request::Action::LanguageCapabilities(
                v1::LanguageCapabilitiesRequest {
                    root_id: String::new(),
                    refresh,
                },
            ))
            .await?
        {
            v1::worker_response::Result::LanguageCapabilities(capabilities) => {
                Ok(descriptors(capabilities))
            }
            v1::worker_response::Result::Error(error) => {
                Err(remote_error(&self.shared.host_name, &error))
            }
            _ => Err(self.wrong_answer()),
        }
    }

    async fn refresh_descriptors(&self) {
        if let Ok(rows) = self.capabilities(false).await {
            *self
                .shared
                .descriptors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = rows;
        }
    }

    fn wrong_answer(&self) -> AppError {
        AppError::Unsupported(format!(
            "Execution host {} answered the language link with the wrong message type",
            self.shared.host_name
        ))
    }

    /// Ends the connection and every session on it.
    pub async fn close(&self) {
        self.shared.fail();
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.shared.fail();
    }
}

fn from_proto(result: v1::LanguageApplyEditResult) -> language::edits::ApplyResult {
    language::edits::ApplyResult {
        applied: result
            .applied
            .into_iter()
            .map(|file| language::edits::AppliedFile {
                path: file.path,
                sha256: file.sha256,
                size: file.size,
            })
            .collect(),
        failed: result
            .failed
            .into_iter()
            .map(|file| language::edits::FailedFile {
                path: file.path,
                code: file.code,
                message: file.message,
            })
            .collect(),
    }
}

/// The wire descriptors as the settings page and the panel read them.
pub fn descriptors(capabilities: v1::LanguageCapabilities) -> Vec<language::ServerDescriptor> {
    capabilities
        .servers
        .into_iter()
        .map(|server| language::ServerDescriptor {
            features: language::discover::declared_features(&server.server_id),
            server_id: server.server_id,
            language_id: server.language_id,
            file_extensions: server.file_extensions,
            executable: server.executable,
            version: server.version,
            state: state_of(server.state),
            reason: (!server.reason.is_empty()).then_some(server.reason),
            restart_count: server.restart_count,
            pid: server.pid,
            start_time_unix_ms: server.start_time_unix_ms,
            open_documents: server.open_documents,
            probed_at_unix_ms: server.probed_at_unix_ms,
        })
        .collect()
}

/* --------------------------------- lifetime -------------------------------- */

/// One execution host's link slot. Empty until an editor needs it.
#[derive(Default)]
pub struct RemoteLanguage {
    link: tokio::sync::Mutex<Option<Arc<Link>>>,
}

impl RemoteLanguage {
    /// The live link, or `None` when this host has never had one or lost it.
    pub async fn current(&self) -> Option<Arc<Link>> {
        let held = self.link.lock().await;
        held.as_ref().filter(|link| link.alive()).cloned()
    }

    /// The live link, connecting if there is none.
    pub async fn ensure(&self, worker: &RemoteWorker, events: &EventHub) -> AppResult<Arc<Link>> {
        let mut held = self.link.lock().await;
        if let Some(link) = held.as_ref()
            && link.alive()
        {
            return Ok(link.clone());
        }
        let link = Arc::new(connect(worker, events).await?);
        *held = Some(link.clone());
        Ok(link)
    }

    /// Drops the link, ending the `ssh` session. Called when the last session
    /// on this host closes: `sshd` allows ten by default, and one held open
    /// for an editor nobody has any more is one a terminal cannot have.
    pub async fn release(&self) {
        let taken = self.link.lock().await.take();
        if let Some(link) = taken {
            link.close().await;
        }
    }
}

async fn connect(worker: &RemoteWorker, events: &EventHub) -> AppResult<Link> {
    let argv = worker.language_argv();
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AppError::Unsupported(format!(
                "The language link to {} could not be started: {error}",
                worker.display_name()
            ))
        })?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let (outgoing, mut queued) = mpsc::unbounded_channel::<v1::WorkerRequest>();
    let shared = Arc::new(Shared {
        controller_id: worker.controller_id().to_owned(),
        host_name: worker.display_name().to_owned(),
        execution_host_id: worker.execution_host_id().to_owned(),
        outgoing,
        window: Window::default(),
        sessions: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        instance: Mutex::new(String::new()),
        epoch: Mutex::new(String::new()),
        roots: Mutex::new(HashSet::new()),
        events: events.clone(),
        alive: AtomicBool::new(true),
        descriptors: Mutex::new(Vec::new()),
    });

    let writer = Arc::clone(&shared);
    tokio::spawn(async move {
        while let Some(request) = queued.recv().await {
            let bytes = request.encode_to_vec();
            if bytes.is_empty() || bytes.len() > crate::worker::MAX_FRAME {
                // Refused here, before anything is written: a frame the
                // transport cannot carry must not desynchronise the stream.
                tracing::warn!("a language link frame exceeded the Worker frame limit");
                continue;
            }
            if stdin
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .await
                .is_err()
                || stdin.write_all(&bytes).await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
        writer.fail();
    });

    let (announced, epoch_ready) = oneshot::channel();
    let reader = Arc::clone(&shared);
    tokio::spawn(async move {
        read_frames(stdout, &reader, announced).await;
        reader.fail();
    });

    let hello = handshake(&shared, worker).await?;
    *shared
        .instance
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = hello.instance_id;
    // The epoch is announced without being asked for, so this waits on the
    // reader rather than making a round trip of its own.
    let epoch = tokio::time::timeout(REQUEST_TIMEOUT, epoch_ready)
        .await
        .map_err(|_| shared.unavailable())?
        .map_err(|_| shared.unavailable())?;
    *shared
        .epoch
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = epoch;
    tracing::info!(
        host = %shared.execution_host_id,
        "opened a language link to the execution host",
    );
    Ok(Link {
        shared,
        child: tokio::sync::Mutex::new(child),
    })
}

async fn handshake(
    shared: &Arc<Shared>,
    worker: &RemoteWorker,
) -> AppResult<v1::WorkerHelloResponse> {
    let result = shared
        .call(v1::worker_request::Action::Hello(v1::WorkerHelloRequest {
            protocol: Some(v1::ProtocolVersion { major: 1, minor: 0 }),
        }))
        .await
        .map_err(|_| {
            AppError::Unsupported(format!(
                "Execution host {} did not answer the language link handshake",
                worker.display_name()
            ))
        })?;
    let hello = match result {
        v1::worker_response::Result::Hello(hello) => hello,
        v1::worker_response::Result::Error(error) => {
            return Err(remote_error(worker.display_name(), &error));
        }
        _ => {
            return Err(AppError::Unsupported(format!(
                "Execution host {} answered the language link handshake with the wrong message",
                worker.display_name()
            )));
        }
    };
    let expected = env!("CARGO_PKG_VERSION");
    if hello.runtime_version != expected {
        return Err(AppError::Unsupported(format!(
            "Execution host {} runs Armadra {}, this controller is {expected}; \
             install a matching remote Worker",
            worker.display_name(),
            if hello.runtime_version.is_empty() {
                "an older build"
            } else {
                &hello.runtime_version
            },
        )));
    }
    if !hello
        .capabilities
        .iter()
        .any(|capability| capability == LINK_CAPABILITY)
    {
        return Err(AppError::Unsupported(format!(
            "Execution host {} does not offer editor language services",
            worker.display_name()
        )));
    }
    Ok(hello)
}

/// The reader task: one frame at a time, classified and handed on.
async fn read_frames<R: tokio::io::AsyncRead + Unpin>(
    mut stdout: R,
    shared: &Arc<Shared>,
    announced: oneshot::Sender<String>,
) {
    let mut announced = Some(announced);
    loop {
        let mut prefix = [0u8; 4];
        if stdout.read_exact(&mut prefix).await.is_err() {
            return;
        }
        let length = u32::from_be_bytes(prefix) as usize;
        if length == 0 || length > crate::worker::MAX_FRAME {
            return;
        }
        let mut bytes = vec![0; length];
        if stdout.read_exact(&mut bytes).await.is_err() {
            return;
        }
        let Ok(response) = v1::WorkerResponse::decode(bytes.as_slice()) else {
            return;
        };
        match response.result {
            Some(v1::worker_response::Result::LanguageFrame(frame)) => {
                if let Some(sender) = announced.take() {
                    // The link's first frame is its epoch announcement.
                    let _ = sender.send(frame.link_epoch.clone());
                    *shared
                        .epoch
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        frame.link_epoch.clone();
                }
                shared.frame(frame);
            }
            Some(result) => {
                let waiting = shared
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&response.request_id);
                if let Some(waiting) = waiting {
                    let _ = waiting.send(result);
                }
            }
            None => {}
        }
    }
}
