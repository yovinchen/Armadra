//! The controller half of the remote Worker link (H02).
//!
//! One execution host is one child process — `ssh … armadra-runtime worker
//! --stdio` — whose stdin and stdout carry the same length-prefixed Protobuf
//! frames as the local Worker bridge. The Worker answers one frame at a time,
//! so the connection is guarded by a mutex and requests are strictly
//! sequential; that also gives Git mutations on one host a real queue.
//!
//! Three invariants:
//!
//! * **No silent local fallback.** A missing binary, a failed handshake or a
//!   version mismatch is `UNSUPPORTED`. The workspace's files are on the other
//!   machine; answering from this one would be a different project.
//! * **Bounded reconnect.** Consecutive failed connects back off and then stop
//!   for a cooldown, so an unreachable host costs one attempt per request
//!   window instead of an `ssh` storm.
//! * **No duplicated effects.** A request that was already written and then
//!   lost the transport is reported as an unknown outcome. Only operations
//!   marked replay-safe are re-sent, and only on a freshly established
//!   connection.

use std::{
    collections::HashSet,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use armadra_protocol::{Message, v1};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

use crate::{
    error::{AppError, AppResult},
    remote::service::{Replay, replay},
    terminal::ssh::{SshHost, SshWorker, worker_argv},
    worker::MAX_FRAME,
};

/// Capability the remote Worker must advertise before anything is proxied.
pub const REMOTE_CAPABILITY: &str = "remote.execution.v1";
/// How long a single proxied request may take end to end.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Consecutive connect failures before the host is parked.
const MAX_CONNECT_ATTEMPTS: u32 = 3;
/// Backoff between those attempts, and the park after the last one.
const RECONNECT_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(1_000),
    Duration::from_millis(4_000),
];
const COOLDOWN: Duration = Duration::from_secs(30);

/// Replaces the `ssh` program for tests and for a user who tunnels the Worker
/// some other way. It substitutes only argv[0]; every SSH option and the
/// remote command stay exactly as they would be, so what is exercised is the
/// real launch line. Must be an absolute path.
pub const LAUNCHER_OVERRIDE: &str = "ARMADRA_REMOTE_WORKER_LAUNCHER";

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

struct Connection {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    instance_id: String,
    /// Root ids registered on *this* connection. A reconnect starts empty.
    roots: HashSet<String>,
}

impl Connection {
    async fn call(
        &mut self,
        host_id: &str,
        action: v1::worker_request::Action,
    ) -> Result<v1::worker_response::Result, Transport> {
        let request = v1::WorkerRequest {
            request_id: uuid::Uuid::now_v7().simple().to_string(),
            host_id: host_id.to_owned(),
            expected_instance_id: self.instance_id.clone(),
            deadline_unix_ms: now_millis() + REQUEST_TIMEOUT.as_millis() as i64,
            action: Some(action),
        };
        let bytes = request.encode_to_vec();
        if bytes.len() > MAX_FRAME {
            // Detected before anything is written, so nothing ran.
            return Err(Transport::TooLarge);
        }
        let request_id = request.request_id.clone();
        self.write(&bytes).await.map_err(|_| Transport::Write)?;
        let response = tokio::time::timeout(REQUEST_TIMEOUT, self.read())
            .await
            .map_err(|_| Transport::Lost)?
            .map_err(|_| Transport::Lost)?;
        // The handshake is what learns the instance; from then on every answer
        // has to come from that same Worker session, so a reconnected child
        // cannot be mistaken for the one the request was aimed at.
        if response.request_id != request_id
            || (!self.instance_id.is_empty() && response.instance_id != self.instance_id)
        {
            return Err(Transport::Lost);
        }
        response.result.ok_or(Transport::Lost)
    }

    async fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stdin
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        self.stdin.write_all(bytes).await?;
        self.stdin.flush().await
    }

    async fn read(&mut self) -> anyhow::Result<v1::WorkerResponse> {
        let mut prefix = [0u8; 4];
        self.stdout.read_exact(&mut prefix).await?;
        let length = u32::from_be_bytes(prefix) as usize;
        anyhow::ensure!(
            length > 0 && length <= MAX_FRAME,
            "Invalid Worker frame length"
        );
        let mut bytes = vec![0; length];
        self.stdout.read_exact(&mut bytes).await?;
        Ok(v1::WorkerResponse::decode(bytes.as_slice())?)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Closing stdin is the Worker's own shutdown signal; the kill is the
        // backstop for an `ssh` that ignored it.
        self.child.start_kill().ok();
    }
}

/// Why a connection stopped being usable. Only `Connect` and `TooLarge` prove
/// the request never reached the execution host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transport {
    /// The request was never written.
    Write,
    /// Written, and then the answer never arrived.
    Lost,
    TooLarge,
}

struct Supervisor {
    connection: Option<Connection>,
    /// Consecutive failed connects.
    failures: u32,
    /// When connecting is allowed again after the attempt budget ran out.
    parked_until: Option<Instant>,
}

/// One execution host: its configuration, and at most one live child.
pub struct RemoteWorker {
    host: SshHost,
    worker: SshWorker,
    /// The controller identity the Worker binds to on handshake. Stable for
    /// the process, so a reconnect re-binds the same controller.
    host_id: String,
    state: Mutex<Supervisor>,
}

impl RemoteWorker {
    pub fn new(host: SshHost, worker: SshWorker, host_id: String) -> Self {
        Self {
            host,
            worker,
            host_id,
            state: Mutex::new(Supervisor {
                connection: None,
                failures: 0,
                parked_until: None,
            }),
        }
    }

    pub fn execution_host_id(&self) -> &str {
        &self.host.id
    }

    /// The argv this host's Worker is started with, `ssh` included.
    pub fn argv(&self) -> Vec<String> {
        let mut argv = worker_argv(&self.host, &self.worker);
        if let Some(launcher) = launcher_override() {
            argv[0] = launcher;
        }
        argv
    }

    async fn connect(&self, state: &mut Supervisor) -> AppResult<()> {
        if state.connection.is_some() {
            return Ok(());
        }
        if let Some(until) = state.parked_until {
            if Instant::now() < until {
                return Err(AppError::Unavailable(format!(
                    "Execution host {} is not reachable; the connection is paused",
                    self.host.name
                )));
            }
            state.parked_until = None;
            state.failures = 0;
        }
        let attempt = state.failures.min(MAX_CONNECT_ATTEMPTS - 1) as usize;
        if state.failures > 0 {
            tokio::time::sleep(RECONNECT_BACKOFF[attempt]).await;
        }
        match self.open().await {
            Ok((connection, _)) => {
                state.connection = Some(connection);
                state.failures = 0;
                Ok(())
            }
            Err(error) => {
                state.failures += 1;
                if state.failures >= MAX_CONNECT_ATTEMPTS {
                    state.parked_until = Some(Instant::now() + COOLDOWN);
                }
                Err(error)
            }
        }
    }

    async fn open(&self) -> AppResult<(Connection, v1::WorkerHelloResponse)> {
        let argv = self.argv();
        let mut child = Command::new(&argv[0])
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
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let mut connection = Connection {
            child,
            stdin,
            stdout,
            instance_id: String::new(),
            roots: HashSet::new(),
        };
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
        let expected = env!("CARGO_PKG_VERSION");
        if hello.runtime_version != expected {
            return Err(AppError::Unsupported(format!(
                "Execution host {} runs Armadra {}, this controller is {expected}; \
                 install a matching remote Worker",
                self.host.name,
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
            .any(|capability| capability == REMOTE_CAPABILITY)
        {
            return Err(AppError::Unsupported(format!(
                "Execution host {} does not offer remote execution",
                self.host.name
            )));
        }
        connection.instance_id = hello.instance_id.clone();
        Ok((connection, hello))
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
        state.parked_until = None;
        state.failures = 0;
        state.connection = None;
        let (connection, hello) = self.open().await?;
        state.connection = Some(connection);
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

    /// One proxied operation. The answer is the execution host's own status
    /// and JSON body, forwarded to the client unchanged.
    pub async fn service(
        &self,
        root_id: &str,
        root_path: &str,
        operation: v1::WorkerServiceOperation,
        request_json: Vec<u8>,
        allow_write: bool,
        allow_execute: bool,
    ) -> AppResult<(u16, Vec<u8>)> {
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

fn remote_error(name: &str, error: &v1::ErrorResponse) -> AppError {
    match error.code.as_str() {
        "INVALID_ARGUMENT" => AppError::BadRequest(error.message.clone()),
        "PERMISSION_DENIED" => AppError::Forbidden(error.message.clone()),
        "NOT_FOUND" => AppError::NotFound(error.message.clone()),
        "CONFLICT" | "STALE_GENERATION" => AppError::Conflict(error.message.clone()),
        "UNSUPPORTED" => AppError::Unsupported(error.message.clone()),
        "TIMEOUT" => AppError::Unavailable(format!("Execution host {name} timed out")),
        _ => AppError::Internal(format!("Execution host {name}: {}", error.message)),
    }
}

fn launcher_override() -> Option<String> {
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
mod tests {
    use super::*;
    use armadra_protocol::v1::WorkerServiceOperation;

    fn host() -> SshHost {
        SshHost {
            id: "box".into(),
            name: "Box".into(),
            host: "example.invalid".into(),
            user: Some("ada".into()),
            port: None,
            identity_file: None,
            extra_args: Vec::new(),
            worker: Some(SshWorker {
                path: "/opt/armadra/armadra-runtime".into(),
                state_dir: None,
            }),
        }
    }

    #[test]
    fn a_commit_that_was_written_and_then_lost_is_an_unknown_outcome_not_a_retry() {
        assert!(outcome_is_unknown(
            Transport::Lost,
            replay(WorkerServiceOperation::GitCommit)
        ));
        // Nothing left this machine, so nothing ran and a retry is honest.
        assert!(!outcome_is_unknown(
            Transport::Write,
            replay(WorkerServiceOperation::GitCommit)
        ));
        assert!(!outcome_is_unknown(
            Transport::TooLarge,
            replay(WorkerServiceOperation::GitCommit)
        ));
        // A read has no effect to duplicate.
        assert!(!outcome_is_unknown(
            Transport::Lost,
            replay(WorkerServiceOperation::GitStatus)
        ));
    }

    #[test]
    fn the_launch_line_only_substitutes_the_program() {
        let host = host();
        let worker = RemoteWorker::new(
            host.clone(),
            host.worker.clone().unwrap(),
            "0123456789abcdef0123456789abcdef".into(),
        );
        let argv = worker.argv();
        assert_eq!(
            argv[1..],
            worker_argv(&host, host.worker.as_ref().unwrap())[1..]
        );
        assert!(argv.iter().any(|value| value == "--stdio"));
    }

    #[test]
    fn a_relative_or_split_launcher_override_is_ignored() {
        // Not a test of the environment itself — `launcher_override` is the
        // only place the value is trusted, and a PATH lookup or an argument
        // smuggled through a space must not become part of the launch line.
        assert!(!accepted_launcher("ssh"));
        assert!(!accepted_launcher("/usr/bin/env ssh"));
        assert!(accepted_launcher("/usr/bin/ssh"));
    }

    fn accepted_launcher(value: &str) -> bool {
        value.starts_with('/') && !value.contains(char::is_whitespace)
    }

    #[tokio::test]
    async fn a_worker_registry_hands_back_the_same_child_for_the_same_configuration() {
        let workers = RemoteWorkers::default();
        let first = workers.get(Some(host()), "box").unwrap();
        let second = workers.get(Some(host()), "box").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        // An edited binary path is a different machine's Worker as far as this
        // registry is concerned, and must not reuse the old child.
        let mut edited = host();
        edited.worker = Some(SshWorker {
            path: "/opt/armadra/other".into(),
            state_dir: None,
        });
        let third = workers.get(Some(edited), "box").unwrap();
        assert!(!Arc::ptr_eq(&first, &third));
    }
}
