//! The controller half of the remote Worker link (H02, completed in design
//! §3.4 and §3.5).
//!
//! One execution host is one child process — `ssh … armadra-runtime worker
//! --stdio` — whose stdin and stdout carry the same length-prefixed Protobuf
//! frames as the local Worker bridge. Requests are guarded by a mutex and are
//! strictly sequential; that also gives Git mutations on one host a real queue.
//! Reading, however, runs in its own task ([`connection`]), so the Worker can
//! push filesystem events between requests and a dead session is noticed the
//! moment it dies.
//!
//! Four invariants:
//!
//! * **No silent local fallback.** A missing binary, a failed handshake or an
//!   incompatible service contract is `UNSUPPORTED`. The workspace's files are
//!   on the other machine; answering from this one would be a different
//!   project.
//! * **Bounded reconnect.** Consecutive failed connects back off and then stop
//!   for a cooldown ([`supervisor`]).
//! * **No duplicated effects.** A request that was already written and then
//!   lost the transport is reported as an unknown outcome. Only operations
//!   marked replay-safe are re-sent, and only on a freshly established
//!   connection.
//! * **Missing capabilities are named, not fatal.** A Worker without the
//!   repository panel still serves files; the panel answers 501 saying which
//!   capability is absent ([`handshake`]).

pub mod connection;
pub mod handshake;
pub mod supervisor;

use std::{process::Stdio, sync::Arc};

use armadra_protocol::v1;
use tokio::{process::Command, sync::Mutex};

use crate::{
    error::{AppError, AppResult},
    remote::service::{Replay, capability, replay},
    terminal::ssh::{SshHost, SshWorker, language_link_argv, worker_argv},
};

use connection::{Connection, Transport};
use supervisor::Supervisor;

pub use handshake::REMOTE_CAPABILITY;

/// How many unsolicited frames may queue for a subscriber before the oldest is
/// dropped. A subscriber that falls this far behind reconciles by polling, so
/// dropping is preferable to holding the connection's reader hostage.
const EVENT_BACKLOG: usize = 256;

/// Replaces the `ssh` program for tests and for a user who tunnels the Worker
/// some other way. It substitutes only argv[0]; every SSH option and the
/// remote command stay exactly as they would be, so what is exercised is the
/// real launch line. Must be an absolute path.
pub const LAUNCHER_OVERRIDE: &str = "ARMADRA_REMOTE_WORKER_LAUNCHER";

/// One execution host: its configuration, and at most one live child.
pub struct RemoteWorker {
    host: SshHost,
    worker: SshWorker,
    /// The controller identity the Worker binds to on handshake. Stable for
    /// the process, so a reconnect re-binds the same controller.
    host_id: String,
    state: Mutex<Supervisor>,
    /// The second connection, opened only while an editor has a language
    /// session on this host (language service design §2.7). Idle hosts pay
    /// nothing for it, and `sshd`'s session limit is not spent on a link
    /// nobody is using.
    pub language: super::language::RemoteLanguage,
    /// Unsolicited frames. Created once and shared with every connection, so a
    /// subscriber survives a reconnect without re-subscribing here.
    events: tokio::sync::broadcast::Sender<v1::WorkerWatchEvent>,
}

impl RemoteWorker {
    pub fn new(host: SshHost, worker: SshWorker, host_id: String) -> Self {
        Self {
            host,
            worker,
            host_id,
            state: Mutex::new(Supervisor::default()),
            language: super::language::RemoteLanguage::default(),
            events: tokio::sync::broadcast::channel(EVENT_BACKLOG).0,
        }
    }

    pub fn execution_host_id(&self) -> &str {
        &self.host.id
    }

    /// The host's display name, for messages a person reads.
    pub fn display_name(&self) -> &str {
        &self.host.name
    }

    /// The controller identity this host's Worker sessions are bound to.
    pub fn controller_id(&self) -> &str {
        &self.host_id
    }

    /// Filesystem events this host pushes. Subscribing does not itself
    /// subscribe on the Worker; [`Self::watch_subscribe`] does that.
    pub fn events(&self) -> tokio::sync::broadcast::Receiver<v1::WorkerWatchEvent> {
        self.events.subscribe()
    }

    /// The Worker's own release when it differs from this controller's, for
    /// the node badge. `None` while nothing has connected yet.
    pub async fn version_badge(&self) -> Option<String> {
        self.state.lock().await.version_badge.clone()
    }

    /// Whether the live connection advertises `capability`. A host that is not
    /// connected reports `false` rather than connecting to find out.
    pub async fn advertises(&self, capability: &str) -> bool {
        self.state
            .lock()
            .await
            .connection
            .as_ref()
            .is_some_and(|connection| connection.has_capability(capability))
    }

    /// The argv this host's Worker is started with, `ssh` included.
    pub fn argv(&self) -> Vec<String> {
        substitute(worker_argv(&self.host, &self.worker))
    }

    /// The argv for the language link: the same line plus `--language-link`.
    pub fn language_argv(&self) -> Vec<String> {
        substitute(language_link_argv(&self.host, &self.worker))
    }

    async fn connect(&self, state: &mut Supervisor) -> AppResult<()> {
        if state.connection.is_some() {
            return Ok(());
        }
        if state.parked() {
            return Err(AppError::Unavailable(format!(
                "Execution host {} is not reachable; the connection is paused",
                self.host.name
            )));
        }
        if let Some(wait) = state.backoff() {
            tokio::time::sleep(wait).await;
        }
        match self.open().await {
            Ok((connection, _, accepted)) => {
                state.succeeded(connection, accepted.version_badge);
                Ok(())
            }
            Err(error) => {
                state.failed();
                Err(error)
            }
        }
    }

    async fn open(&self) -> AppResult<(Connection, v1::WorkerHelloResponse, handshake::Accepted)> {
        let argv = self.argv();
        let mut command = Command::new(&argv[0]);
        // A password prompt has no TTY to go to, so it goes to the person
        // through the Armadra client instead (design §3.6). Absent when this
        // Runtime has no address the helper could reach, in which case the
        // helper exits non-zero and `ssh` fails cleanly.
        if let Some(environment) = crate::terminal::ssh::askpass::child_environment(&self.host.id) {
            command.envs(environment);
        }
        let child = command
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // ssh diagnostics and the remote Worker's tracing go to the
            // Runtime's own stderr; they never enter the frame stream.
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                AppError::Unsupported(format!(
                    "Execution host {} could not be started: {error}",
                    self.host.name
                ))
            })?;
        let mut connection = Connection::open(child, self.events.clone());
        let result = connection
            .call(
                &self.host_id,
                v1::worker_request::Action::Hello(v1::WorkerHelloRequest {
                    protocol: Some(v1::ProtocolVersion { major: 1, minor: 0 }),
                }),
            )
            .await
            .map_err(|_| {
                AppError::Unsupported(format!(
                    "Execution host {} did not answer the Worker handshake; check the remote binary path",
                    self.host.name
                ))
            })?;
        let hello = match result {
            v1::worker_response::Result::Hello(hello) => hello,
            v1::worker_response::Result::Error(error) => {
                return Err(AppError::Unsupported(format!(
                    "Execution host {} refused the handshake: {}",
                    self.host.name, error.code
                )));
            }
            _ => {
                return Err(AppError::Unsupported(format!(
                    "Execution host {} answered the handshake with the wrong message",
                    self.host.name
                )));
            }
        };
        let accepted = handshake::accept(&self.host.name, &hello)?;
        connection.instance_id = accepted.instance_id.clone();
        connection.capabilities = accepted.capabilities.clone();
        Ok((connection, hello, accepted))
    }

    /// Send one action, registering `root` first when the current connection
    /// has not seen it. `replayable` decides what happens when the transport
    /// dies mid-request.
    async fn send(
        &self,
        root_id: &str,
        root_path: &str,
        action: v1::worker_request::Action,
        replayable: Replay,
    ) -> AppResult<v1::worker_response::Result> {
        let mut state = self.state.lock().await;
        for attempt in 0..2 {
            self.connect(&mut state).await?;
            let connection = state.connection.as_mut().expect("connected");
            if !connection.roots.contains(root_id) {
                // Registration is idempotent and has no effect of its own, so
                // it may always be replayed on a fresh connection.
                match connection
                    .call(
                        &self.host_id,
                        v1::worker_request::Action::RegisterRoot(v1::RegisterRootRequest {
                            root_id: root_id.to_owned(),
                            path: root_path.to_owned(),
                        }),
                    )
                    .await
                {
                    Ok(v1::worker_response::Result::RegisteredRoot(_)) => {
                        connection.roots.insert(root_id.to_owned());
                    }
                    Ok(v1::worker_response::Result::Error(error)) => {
                        return Err(remote_error(&self.host.name, &error));
                    }
                    Ok(_) => {
                        return Err(AppError::Unsupported(
                            "The execution host answered root registration incorrectly".into(),
                        ));
                    }
                    Err(_) => {
                        state.connection = None;
                        if attempt == 0 {
                            continue;
                        }
                        return Err(self.unavailable());
                    }
                }
            }
            let connection = state.connection.as_mut().expect("connected");
            match connection.call(&self.host_id, action.clone()).await {
                Ok(v1::worker_response::Result::Error(error)) => {
                    return Err(remote_error(&self.host.name, &error));
                }
                Ok(result) => return Ok(result),
                Err(Transport::TooLarge) => {
                    return Err(AppError::BadRequest(
                        "The request is larger than one Worker frame".into(),
                    ));
                }
                Err(failure) => {
                    state.connection = None;
                    if outcome_is_unknown(failure, replayable) {
                        return Err(AppError::UnknownOutcome(format!(
                            "The connection to {} dropped while the request was in flight; \
                             check the repository before retrying",
                            self.host.name
                        )));
                    }
                    if attempt == 0 {
                        continue;
                    }
                    return Err(self.unavailable());
                }
            }
        }
        Err(self.unavailable())
    }

    fn unavailable(&self) -> AppError {
        AppError::Unavailable(format!(
            "Execution host {} is not reachable",
            self.host.name
        ))
    }

    /// Start the Worker if it is not running and report its handshake. This
    /// is the settings page's "is the remote Worker actually there" answer,
    /// and it fails with the same `UNSUPPORTED` a workspace would get.
    pub async fn probe(&self) -> AppResult<v1::WorkerHelloResponse> {
        let mut state = self.state.lock().await;
        // A probe is the one place a parked host is retried immediately: the
        // user just asked, and "still parked" would be a useless answer.
        state.resume();
        let (connection, hello, accepted) = self.open().await?;
        state.succeeded(connection, accepted.version_badge);
        Ok(hello)
    }

    /// Register a root on the execution host and return its canonical path
    /// there. Idempotent: the same id and path answer the same way.
    pub async fn register_root(&self, root_id: &str, path: &str) -> AppResult<String> {
        let mut state = self.state.lock().await;
        self.connect(&mut state).await?;
        let connection = state.connection.as_mut().expect("connected");
        match connection
            .call(
                &self.host_id,
                v1::worker_request::Action::RegisterRoot(v1::RegisterRootRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                }),
            )
            .await
        {
            Ok(v1::worker_response::Result::RegisteredRoot(root)) => {
                connection.roots.insert(root_id.to_owned());
                Ok(root.canonical_path)
            }
            Ok(v1::worker_response::Result::Error(error)) => {
                Err(remote_error(&self.host.name, &error))
            }
            Ok(_) => Err(self.wrong_answer()),
            Err(_) => {
                state.connection = None;
                Err(self.unavailable())
            }
        }
    }

    /// `GET .../files` on the execution host.
    pub async fn list_directory(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
    ) -> AppResult<v1::WorkerDirectory> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::ListDirectory(v1::WorkerListDirectoryRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                }),
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::Directory(directory) => Ok(directory),
            _ => Err(self.wrong_answer()),
        }
    }

    /// One chunk of a text file. The caller loops until `eof`, passing the
    /// digest of the first chunk back so a file that changed mid-read is a
    /// conflict rather than a splice of two versions.
    pub async fn read_file(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        offset: u64,
        expected_sha256: Option<Vec<u8>>,
    ) -> AppResult<v1::WorkerFileChunk> {
        self.read(root_id, root_path, path, offset, expected_sha256, false)
            .await
    }

    /// The same chunked read, asked for bytes instead of editor text. Used by
    /// downloads and by whiteboard assets, neither of which is text.
    pub async fn read_raw_file(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        offset: u64,
        expected_sha256: Option<Vec<u8>>,
    ) -> AppResult<v1::WorkerFileChunk> {
        self.read(root_id, root_path, path, offset, expected_sha256, true)
            .await
    }

    async fn read(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        offset: u64,
        expected_sha256: Option<Vec<u8>>,
        raw: bool,
    ) -> AppResult<v1::WorkerFileChunk> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::ReadFile(v1::WorkerReadFileRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                    offset,
                    max_bytes: crate::worker::MAX_CHUNK as u32,
                    expected_sha256,
                    raw,
                }),
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::FileChunk(chunk) => Ok(chunk),
            _ => Err(self.wrong_answer()),
        }
    }

    /// An editor save on the execution host. `expected_sha256` is the content
    /// version the editor read; `None` means the file must not exist yet.
    pub async fn write_file(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        content: String,
        expected_sha256: Option<String>,
        bom: bool,
    ) -> AppResult<v1::WorkerFileWritten> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::WriteFile(v1::WorkerWriteFileRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                    content,
                    expected_sha256,
                    bom,
                }),
                Replay::Never,
            )
            .await?
        {
            v1::worker_response::Result::FileWritten(written) => Ok(written),
            _ => Err(self.wrong_answer()),
        }
    }

    /// Server discovery on the execution host, over the serial connection.
    ///
    /// Discovery starts nothing: it runs each candidate's `--version` and
    /// caches the answer. That is why it does not need the language link, and
    /// why a settings page can list a host's servers before anybody opens an
    /// editor on it.
    pub async fn language_capabilities(
        &self,
        root_id: &str,
        root_path: &str,
        refresh: bool,
    ) -> AppResult<v1::LanguageCapabilities> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::LanguageCapabilities(v1::LanguageCapabilitiesRequest {
                    root_id: root_id.to_owned(),
                    refresh,
                }),
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::LanguageCapabilities(capabilities) => Ok(capabilities),
            _ => Err(self.wrong_answer()),
        }
    }

    /// One proxied operation. The answer is the execution host's own status
    /// and JSON body, forwarded to the client unchanged.
    ///
    /// An operation whose capability this Worker does not advertise is refused
    /// here rather than sent: the Worker would answer `UNSUPPORTED` anyway, and
    /// naming the capability is more useful than relaying that.
    pub async fn service(
        &self,
        root_id: &str,
        root_path: &str,
        operation: v1::WorkerServiceOperation,
        request_json: Vec<u8>,
        allow_write: bool,
        allow_execute: bool,
    ) -> AppResult<(u16, Vec<u8>)> {
        if let Some(capability) = capability(operation) {
            self.require_capability(capability).await?;
        }
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::Service(v1::WorkerServiceRequest {
                    root_id: root_id.to_owned(),
                    operation: operation as i32,
                    request_json,
                    allow_write,
                    allow_execute,
                }),
                replay(operation),
            )
            .await?
        {
            v1::worker_response::Result::Service(response) => Ok((
                u16::try_from(response.http_status).unwrap_or(500),
                response.response_json,
            )),
            _ => Err(self.wrong_answer()),
        }
    }

    /// Subscribe to filesystem events for `paths`, or unsubscribe from them.
    ///
    /// A Worker without `remote.watch.v1` refuses here, and the caller falls
    /// back to polling rather than waiting for events that never come.
    pub async fn watch(
        &self,
        root_id: &str,
        root_path: &str,
        operation: v1::WorkerServiceOperation,
        paths: Vec<String>,
    ) -> AppResult<v1::WorkerWatchSubscription> {
        self.require_capability(crate::remote::service::replay::WATCH_CAPABILITY)
            .await?;
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::Watch(v1::WorkerWatchRequest {
                    root_id: root_id.to_owned(),
                    operation: operation as i32,
                    paths,
                }),
                // A subscription has no effect to duplicate: re-subscribing the
                // same path re-baselines it.
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::Watch(subscription) => Ok(subscription),
            _ => Err(self.wrong_answer()),
        }
    }

    /// Open a chunked upload. Answers the id the remaining steps use.
    pub async fn upload_begin(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        total_bytes: u64,
        sha256: String,
        overwrite_sha256: Option<String>,
    ) -> AppResult<String> {
        self.require_capability(crate::remote::service::replay::UPLOAD_CAPABILITY)
            .await?;
        Ok(self
            .upload_step(
                root_id,
                root_path,
                v1::worker_upload_request::Step::Begin(v1::WorkerUploadBegin {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                    total_bytes,
                    sha256,
                    overwrite_sha256,
                    allow_write: true,
                }),
            )
            .await?
            .upload_id)
    }

    /// Append one chunk; answers how many bytes the host now holds.
    pub async fn upload_chunk(
        &self,
        root_id: &str,
        root_path: &str,
        upload_id: &str,
        offset: u64,
        data: Vec<u8>,
    ) -> AppResult<u64> {
        Ok(self
            .upload_step(
                root_id,
                root_path,
                v1::worker_upload_request::Step::Chunk(v1::WorkerUploadChunk {
                    upload_id: upload_id.to_owned(),
                    offset,
                    data,
                }),
            )
            .await?
            .received_bytes)
    }

    pub async fn upload_commit(
        &self,
        root_id: &str,
        root_path: &str,
        upload_id: &str,
    ) -> AppResult<v1::WorkerUploadResponse> {
        self.upload_step(
            root_id,
            root_path,
            v1::worker_upload_request::Step::Commit(v1::WorkerUploadCommit {
                upload_id: upload_id.to_owned(),
            }),
        )
        .await
    }

    pub async fn upload_abort(
        &self,
        root_id: &str,
        root_path: &str,
        upload_id: &str,
    ) -> AppResult<v1::WorkerUploadResponse> {
        self.upload_step(
            root_id,
            root_path,
            v1::worker_upload_request::Step::Abort(v1::WorkerUploadAbort {
                upload_id: upload_id.to_owned(),
            }),
        )
        .await
    }

    async fn upload_step(
        &self,
        root_id: &str,
        root_path: &str,
        step: v1::worker_upload_request::Step,
    ) -> AppResult<v1::WorkerUploadResponse> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::Upload(v1::WorkerUploadRequest { step: Some(step) }),
                // Every step writes. A step that was sent and then lost its
                // answer may have landed, and re-sending it would either
                // duplicate bytes or publish a file twice.
                Replay::Never,
            )
            .await?
        {
            v1::worker_response::Result::Upload(response) => Ok(response),
            _ => Err(self.wrong_answer()),
        }
    }

    /// Refuse before sending when the live connection lacks `capability`.
    async fn require_capability(&self, capability: &str) -> AppResult<()> {
        let mut state = self.state.lock().await;
        self.connect(&mut state).await?;
        let connection = state.connection.as_ref().expect("connected");
        if connection.has_capability(capability) {
            Ok(())
        } else {
            Err(handshake::missing_capability(&self.host.name, capability))
        }
    }

    fn wrong_answer(&self) -> AppError {
        AppError::Unsupported(format!(
            "Execution host {} answered with the wrong message type",
            self.host.name
        ))
    }
}

/// Was the request already on its way when the transport died?
///
/// A write that was sent and then lost its answer may have committed. Resending
/// it could commit twice, so the caller is told the outcome is unknown and asked
/// to look, which is the only honest answer (design §3.4). Everything else — a
/// failure before the bytes left, or an operation with no effect to duplicate —
/// is safe to retry on a fresh connection.
fn outcome_is_unknown(failure: Transport, replayable: Replay) -> bool {
    failure == Transport::Lost && replayable == Replay::Never
}

pub(crate) fn remote_error(name: &str, error: &v1::ErrorResponse) -> AppError {
    match error.code.as_str() {
        "INVALID_ARGUMENT" => AppError::BadRequest(error.message.clone()),
        "PERMISSION_DENIED" => AppError::Forbidden(error.message.clone()),
        "NOT_FOUND" => AppError::NotFound(error.message.clone()),
        "CONFLICT" | "STALE_GENERATION" => AppError::Conflict(error.message.clone()),
        "UNSUPPORTED" => AppError::Unsupported(error.message.clone()),
        "RESOURCE_EXHAUSTED" => AppError::BadRequest(error.message.clone()),
        "TIMEOUT" => AppError::Unavailable(format!("Execution host {name} timed out")),
        _ => AppError::Internal(format!("Execution host {name}: {}", error.message)),
    }
}

/// Applies the launcher override to argv[0], and nothing else.
fn substitute(mut argv: Vec<String>) -> Vec<String> {
    if let Some(launcher) = launcher_override() {
        argv[0] = launcher;
    }
    argv
}

pub(crate) fn launcher_override() -> Option<String> {
    let value = std::env::var(LAUNCHER_OVERRIDE).ok()?;
    // Only an absolute path: a bare name would resolve through PATH, which is
    // not something a launch line should depend on.
    (value.starts_with('/') && !value.contains(char::is_whitespace)).then_some(value)
}

/// Every configured execution host, one live child each.
pub struct RemoteWorkers {
    workers: std::sync::Mutex<Vec<(String, Arc<RemoteWorker>)>>,
    host_id: String,
}

/// A registry with a fresh controller identity. Nothing is started until a
/// workspace names an execution host, so an unused one costs nothing.
impl Default for RemoteWorkers {
    fn default() -> Self {
        Self::new(uuid::Uuid::new_v4().simple().to_string())
    }
}

impl RemoteWorkers {
    pub fn new(host_id: String) -> Self {
        Self {
            workers: std::sync::Mutex::new(Vec::new()),
            host_id,
        }
    }

    /// The worker for `execution_host_id`, started on first use.
    ///
    /// A host that exists but has no `worker` configuration is `UNSUPPORTED`:
    /// it can run terminals over SSH and nothing else, and saying so is the
    /// whole point — the alternative would be reading the wrong machine's
    /// files.
    pub fn get(
        &self,
        host: Option<SshHost>,
        execution_host_id: &str,
    ) -> AppResult<Arc<RemoteWorker>> {
        let Some(host) = host else {
            return Err(AppError::Unsupported(format!(
                "Execution host {execution_host_id} is not configured"
            )));
        };
        let Some(worker) = host.worker.clone() else {
            return Err(AppError::Unsupported(format!(
                "Execution host {} has no Armadra Worker configured",
                host.name
            )));
        };
        let mut workers = self
            .workers
            .lock()
            .map_err(|_| AppError::Internal("Execution host registry unavailable".into()))?;
        // The stored worker is keyed by the host's full configuration, so an
        // edited address or binary path starts a new child instead of talking
        // to the old machine.
        let key = signature(&host, &worker);
        if let Some((_, existing)) = workers
            .iter()
            .find(|(stored, worker)| stored == &key && worker.execution_host_id() == host.id)
        {
            return Ok(existing.clone());
        }
        workers.retain(|(_, worker)| worker.execution_host_id() != host.id);
        let created = Arc::new(RemoteWorker::new(host, worker, self.host_id.clone()));
        workers.push((key, created.clone()));
        Ok(created)
    }
}

fn signature(host: &SshHost, worker: &SshWorker) -> String {
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
        host.id,
        host.host,
        host.user.as_deref().unwrap_or_default(),
        host.port.unwrap_or_default(),
        host.identity_file.as_deref().unwrap_or_default(),
        host.extra_args.join("\u{2}"),
        format_args!(
            "{}\u{2}{}",
            worker.path,
            worker.state_dir.as_deref().unwrap_or_default()
        ),
    )
}

#[cfg(test)]
mod tests;
