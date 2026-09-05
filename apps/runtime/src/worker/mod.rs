//! Read-only execution bridge over a parent-owned anonymous pipe. This mode
//! never starts the legacy HTTP server, migrates canvas.db or recovers PTYs.
//!
//! One action writes: scheduled prompt delivery is *proxied* to the live
//! Runtime that owns the terminal (see [`agent_bridge`]). This process still
//! opens no PTY of its own.
pub mod agent_bridge;
pub mod channel;
pub mod outbox;
pub mod socket;

use crate::{error::AppError, files, ownership, security};
use armadra_protocol::{Message, v1::*};
use sha2::{Digest, Sha256};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME: usize = 1 << 20;
pub const MAX_CHUNK: usize = 256 << 10;
const MAX_ROOTS: usize = 1024;

pub struct Worker {
    host: Option<String>,
    instance: String,
    roots: HashMap<String, PathBuf>,
    command_path: Option<PathBuf>,
    commands: Option<crate::command::Manager>,
    /// Present only in command mode: the bridge to the Runtime that owns the
    /// terminals. A read-only Worker answers UNSUPPORTED for agent actions.
    agents: Option<agent_bridge::Bridge>,
    /// The Runtime's canvas database, opened only for the ownership handoff
    /// (host protocol design §4, step 5). Absent unless `--canvas-database`
    /// named one, and then every ownership action answers UNSUPPORTED rather
    /// than inventing a record.
    canvas: Option<SqlitePool>,
    /// The upward half of the resident channel. Present only when a durable
    /// outbox was opened, because a Worker that cannot persist a report must
    /// not advertise that it can deliver one.
    upcalls: Option<channel::Upcaller>,
    /// The socket bearer's published address, reported in the handshake so a
    /// controller can reattach without respawning this process.
    bearer: (Option<String>, Option<String>),
}
impl Default for Worker {
    fn default() -> Self {
        Self {
            host: None,
            instance: uuid::Uuid::new_v4().simple().to_string(),
            roots: HashMap::new(),
            command_path: None,
            commands: None,
            agents: None,
            canvas: None,
            upcalls: None,
            bearer: (None, None),
        }
    }
}

/// Opens the Runtime's database for ownership handoffs.
///
/// Migrations are deliberately not run and the file is never created: a Worker
/// started against a Runtime that has never migrated must fail loudly instead
/// of silently upgrading, or worse, creating, the database it was pointed at.
pub async fn open_canvas_database(path: &Path) -> anyhow::Result<SqlitePool> {
    anyhow::ensure!(path.is_absolute(), "--canvas-database must be absolute");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false),
        )
        .await?;
    let known: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?")
            .bind("write_ownership")
            .fetch_one(&pool)
            .await?;
    if known != 1 {
        pool.close().await;
        anyhow::bail!("--canvas-database has no write ownership table");
    }
    Ok(pool)
}
fn invalid(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
fn host_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn error_response(error: AppError) -> ErrorResponse {
    let code = match &error {
        AppError::BadRequest(_) => "INVALID_ARGUMENT",
        AppError::Forbidden(_) => "PERMISSION_DENIED",
        AppError::NotFound(_) => "NOT_FOUND",
        AppError::Conflict(_) | AppError::OwnershipMoved(_) => "CONFLICT",
        AppError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => "NOT_FOUND",
        AppError::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            "PERMISSION_DENIED"
        }
        _ => "INTERNAL",
    };
    // File bodies and raw OS diagnostics do not enter controller logs.
    ErrorResponse {
        code: code.into(),
        message: match code {
            "INVALID_ARGUMENT" => "Invalid Worker request",
            "PERMISSION_DENIED" => "Worker path or permission denied",
            "NOT_FOUND" => "Worker resource was not found",
            "CONFLICT" => "Worker root, file version or write ownership changed",
            _ => "Worker request failed",
        }
        .into(),
    }
}

/// No database, no answer. A fabricated ownership record would let a
/// controller believe a switch it never made had been persisted.
fn unsupported_ownership() -> worker_response::Result {
    worker_response::Result::Error(ErrorResponse {
        code: "UNSUPPORTED".into(),
        message: "Canvas write ownership is not configured".into(),
    })
}

/// The stored row on the wire. `updated_at` is RFC 3339 in the database and
/// milliseconds in the protocol; an unparsable stamp is damage, not a zero.
fn write_ownership(record: ownership::WriteOwnership) -> Result<WorkerWriteOwnership, AppError> {
    let updated_at = chrono::DateTime::parse_from_rfc3339(&record.updated_at)
        .map_err(|_| AppError::Internal("Stored write ownership timestamp is invalid".into()))?;
    Ok(WorkerWriteOwnership {
        domain: record.domain,
        owner: record.owner.to_wire(),
        epoch: record.epoch,
        updated_at_unix_ms: updated_at.timestamp_millis(),
        reason_code: record.reason_code,
    })
}

impl Worker {
    /// A Worker that may also answer the ownership handoff.
    pub fn with_canvas(canvas: SqlitePool) -> Self {
        Self {
            canvas: Some(canvas),
            ..Self::default()
        }
    }
    /// The instance id this Worker will report, needed before the handshake by
    /// whatever opens the outbox: the deduplication key is
    /// `(worker_instance_id, sequence)`, so the outbox has to be opened under
    /// the same id the handshake will publish.
    pub fn instance_id(&self) -> &str {
        &self.instance
    }
    /// Attaches the resident channel's upward half and the bearer address the
    /// handshake should publish. Without it the Worker answers exactly as it
    /// did before this batch and advertises no upcall capability.
    pub fn attach_channel(
        &mut self,
        upcalls: channel::Upcaller,
        socket: Option<String>,
        pipe: Option<String>,
    ) {
        self.upcalls = Some(upcalls);
        self.bearer = (socket, pipe);
    }
    fn root(&self, root_id: &str) -> Result<PathBuf, AppError> {
        if !id(root_id) {
            return Err(invalid("Invalid root identity"));
        }
        let original = self
            .roots
            .get(root_id)
            .ok_or_else(|| AppError::NotFound("Root is not registered".into()))?;
        let current = security::canonical_directory(original)?;
        if &current != original {
            return Err(AppError::Conflict("Registered root changed".into()));
        }
        Ok(current)
    }
    pub async fn handle(&mut self, request: WorkerRequest) -> WorkerResponse {
        let request_id = request.request_id.clone();
        let deadline = request.deadline_unix_ms;
        let response_host = self.host.as_ref().unwrap_or(&request.host_id).clone();
        let now = chrono::Utc::now().timestamp_millis();
        let result = if !id(&request.request_id)
            || !host_id(&request.host_id)
            || request.deadline_unix_ms <= 0
            || request.deadline_unix_ms > now.saturating_add(120_000)
        {
            worker_response::Result::Error(error_response(invalid("Invalid request envelope")))
        } else if request.deadline_unix_ms <= now {
            worker_response::Result::Error(ErrorResponse {
                code: "TIMEOUT".into(),
                message: "Worker request deadline expired".into(),
            })
        } else if self
            .host
            .as_ref()
            .is_some_and(|host| host != &request.host_id)
            || (self.host.is_some() && request.expected_instance_id != self.instance)
        {
            worker_response::Result::Error(ErrorResponse {
                code: "STALE_GENERATION".into(),
                message: "Worker identity does not match the request".into(),
            })
        } else {
            match self.dispatch(request).await {
                Ok(result) => result,
                Err(error) => worker_response::Result::Error(error_response(error)),
            }
        };
        let result = if chrono::Utc::now().timestamp_millis() > deadline && deadline > 0 {
            worker_response::Result::Error(ErrorResponse {
                code: "TIMEOUT".into(),
                message: "Worker request deadline expired".into(),
            })
        } else {
            result
        };
        WorkerResponse {
            request_id,
            host_id: self.host.clone().unwrap_or(response_host),
            instance_id: self.instance.clone(),
            result: Some(result),
        }
    }
    async fn dispatch(
        &mut self,
        request: WorkerRequest,
    ) -> Result<worker_response::Result, AppError> {
        use worker_request::Action;
        use worker_response::Result as Response;
        if self.host.is_none() && !matches!(request.action, Some(Action::Hello(_))) {
            return Err(AppError::Forbidden("Worker handshake is required".into()));
        }
        match request
            .action
            .ok_or_else(|| invalid("Worker action is missing"))?
        {
            Action::Hello(hello) => {
                if self.host.is_some() || !request.expected_instance_id.is_empty() {
                    return Err(AppError::Conflict("Worker is already initialized".into()));
                }
                if hello
                    .protocol
                    .as_ref()
                    .is_none_or(|version| version.major != 1)
                {
                    return Ok(Response::Error(ErrorResponse {
                        code: "UNSUPPORTED".into(),
                        message: "Worker protocol is incompatible".into(),
                    }));
                }
                if let Some(path) = self.command_path.clone() {
                    self.commands = Some(
                        crate::command::Manager::open(path, request.host_id.clone())
                            .await
                            .map_err(|_| {
                                AppError::Internal("Command journal could not be opened".into())
                            })?,
                    );
                    // The bridge re-reads the live Runtime's own endpoint file
                    // out of the shared data directory on every call, because
                    // that Runtime may restart on a different address under us.
                    // It is also the resident channel's first consumer.
                    self.agents = Some(
                        agent_bridge::Bridge::new(crate::paths::data_dir())
                            .with_upcalls(self.upcalls.clone()),
                    );
                }
                self.command_path = None;
                self.host = Some(request.host_id.clone());
                Ok(Response::Hello(WorkerHelloResponse {
                    protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
                    host_id: request.host_id,
                    instance_id: self.instance.clone(),
                    platform: std::env::consts::OS.into(),
                    architecture: std::env::consts::ARCH.into(),
                    runtime_version: env!("CARGO_PKG_VERSION").into(),
                    capabilities: {
                        let mut capabilities: Vec<String> = vec![
                            "worker.roots.v1".into(),
                            "files.directory-read.v1".into(),
                            "files.text-read.v1".into(),
                            "files.text-write.v1".into(),
                            crate::remote::client::REMOTE_CAPABILITY.into(),
                        ];
                        if self.agents.is_some() {
                            capabilities.push(agent_bridge::CAPABILITY.into());
                        }
                        // Advertised only when a database was actually opened,
                        // so a controller never plans a handoff this Worker
                        // would have to refuse.
                        if self.canvas.is_some() {
                            capabilities.push("canvas.ownership.v1".into());
                        }
                        // Only a Worker with a durable outbox claims it can
                        // report upward. Claiming it without one would promise
                        // a delivery this process cannot survive a crash to
                        // make good on.
                        if self.upcalls.is_some() {
                            capabilities.push(channel::CAPABILITY.into());
                        }
                        capabilities
                    },
                    channel: match self.upcalls.as_ref() {
                        Some(upcalls) => Some(
                            upcalls
                                .capability(self.bearer.0.clone(), self.bearer.1.clone())
                                .await,
                        ),
                        None => None,
                    },
                    max_frame_bytes: MAX_FRAME as u32,
                    max_file_chunk_bytes: MAX_CHUNK as u32,
                    max_text_file_bytes: 1 << 20,
                    commands: self
                        .commands
                        .as_ref()
                        .map(|_| crate::command::capabilities()),
                }))
            }
            // Proxied to the Runtime that owns the terminal. A read-only
            // Worker has no bridge and says so, rather than answering as
            // though a target were simply not ready.
            Action::Agent(input) => match self.agents.as_ref() {
                Some(bridge) => Ok(Response::Agent(bridge.handle(input).await?)),
                None => Ok(Response::Error(ErrorResponse {
                    code: "UNSUPPORTED".into(),
                    message: "Scheduled prompt delivery is not configured".into(),
                })),
            },
            Action::Command(input) => {
                match self.commands.as_ref() {
                    Some(manager) => Ok(Response::Command(manager.handle(input).await.map_err(
                        |_| AppError::Conflict("Command operation was rejected".into()),
                    )?)),
                    None => Ok(Response::Error(ErrorResponse {
                        code: "UNSUPPORTED".into(),
                        message: "Command execution is not configured".into(),
                    })),
                }
            }
            Action::SetWriteOwnership(input) => {
                let Some(pool) = self.canvas.as_ref() else {
                    return Ok(unsupported_ownership());
                };
                let record = ownership::apply(
                    pool,
                    ownership::OwnershipHandoff {
                        domain: input.domain,
                        owner: ownership::WriteOwner::from_wire(input.owner)?,
                        epoch: input.epoch,
                        expected_epoch: input.expected_epoch,
                        reason_code: input.reason_code,
                    },
                )
                .await?;
                Ok(Response::WriteOwnership(write_ownership(record)?))
            }
            Action::GetWriteOwnership(input) => {
                let Some(pool) = self.canvas.as_ref() else {
                    return Ok(unsupported_ownership());
                };
                Ok(Response::WriteOwnership(write_ownership(
                    ownership::read(pool, &input.domain).await?,
                )?))
            }
            Action::RegisterRoot(input) => {
                if !id(&input.root_id) || input.path.is_empty() || input.path.len() > 32_768 {
                    return Err(invalid("Invalid root registration"));
                }
                let path = PathBuf::from(input.path);
                if !path.is_absolute() {
                    return Err(invalid("Root must be absolute"));
                }
                let canonical =
                    tokio::task::spawn_blocking(move || security::canonical_directory(&path))
                        .await??;
                if self
                    .roots
                    .get(&input.root_id)
                    .is_some_and(|old| old != &canonical)
                {
                    return Err(AppError::Conflict("Root identity is already bound".into()));
                }
                if !self.roots.contains_key(&input.root_id) && self.roots.len() >= MAX_ROOTS {
                    return Err(invalid("Too many registered roots"));
                }
                let canonical_path = canonical
                    .to_str()
                    .ok_or_else(|| invalid("Root must be valid Unicode"))?
                    .to_owned();
                self.roots.insert(input.root_id.clone(), canonical);
                Ok(Response::RegisteredRoot(RegisteredRoot {
                    root_id: input.root_id,
                    canonical_path,
                }))
            }
            Action::ListDirectory(input) => {
                if input.path.len() > 32_768 || input.path.contains('\\') {
                    return Err(invalid("Path exceeds limit"));
                }
                let root = self.root(&input.root_id)?;
                let directory =
                    tokio::task::spawn_blocking(move || files::list_directory(&root, &input.path))
                        .await??;
                let mut result = WorkerDirectory {
                    root_id: input.root_id,
                    path: directory.path,
                    entries: vec![],
                    truncated: directory.truncated,
                };
                let mut used = result.encoded_len() + 1024;
                for entry in directory.entries {
                    // The first bridge uses portable slash-separated paths.
                    // Unsupported POSIX names must not poison the whole frame.
                    if entry.name.contains('\\') {
                        result.truncated = true;
                        continue;
                    }
                    let entry = WorkerFileEntry {
                        name: entry.name,
                        path: entry.path,
                        kind: entry.kind.into(),
                        size: entry.size,
                        readonly: entry.readonly,
                    };
                    used += entry.encoded_len() + 10;
                    if used > MAX_FRAME {
                        result.truncated = true;
                        break;
                    }
                    result.entries.push(entry);
                }
                Ok(Response::Directory(result))
            }
            Action::ReadFile(input) => {
                if input.path.len() > 32_768
                    || input.path.contains('\\')
                    || input.max_bytes == 0
                    || input.max_bytes as usize > MAX_CHUNK
                    || input
                        .expected_sha256
                        .as_ref()
                        .is_some_and(|digest| digest.len() != 32)
                    || (input.offset > 0 && input.expected_sha256.is_none())
                {
                    return Err(invalid("Invalid file chunk request"));
                }
                let root = self.root(&input.root_id)?;
                let path = input.path.clone();
                let file = tokio::task::spawn_blocking(move || files::read_text_file(&root, &path))
                    .await??;
                let bytes = file.content.as_bytes();
                let sha256 = Sha256::digest(bytes).to_vec();
                if input
                    .expected_sha256
                    .as_ref()
                    .is_some_and(|expected| expected != &sha256)
                {
                    return Err(AppError::Conflict(
                        "File changed while reading chunks".into(),
                    ));
                }
                let offset =
                    usize::try_from(input.offset).map_err(|_| invalid("Invalid offset"))?;
                if offset > bytes.len() {
                    return Err(invalid("Offset exceeds file size"));
                }
                let end = offset
                    .saturating_add(input.max_bytes as usize)
                    .min(bytes.len());
                Ok(Response::FileChunk(WorkerFileChunk {
                    root_id: input.root_id,
                    path: file.path,
                    mime_type: file.mime_type,
                    sha256,
                    total_bytes: bytes.len() as u64,
                    offset: input.offset,
                    data: bytes[offset..end].to_vec(),
                    eof: end == bytes.len(),
                }))
            }
            // An editor save on this machine (H02). The content version is
            // mandatory for an overwrite: without `expected_sha256` the write
            // is create-only, so a controller that never read the file cannot
            // replace it.
            Action::WriteFile(input) => {
                if input.path.len() > 32_768
                    || input.path.contains('\\')
                    || input
                        .expected_sha256
                        .as_ref()
                        .is_some_and(|digest| digest.len() != 64)
                {
                    return Err(invalid("Invalid file write request"));
                }
                let root = self.root(&input.root_id)?;
                let root_id = input.root_id.clone();
                let written = tokio::task::spawn_blocking(move || {
                    files::write_text_file(
                        &root,
                        &input.path,
                        &input.content,
                        input.expected_sha256.as_deref(),
                        input.bom,
                    )
                })
                .await??;
                Ok(Response::FileWritten(WorkerFileWritten {
                    root_id,
                    path: written.path,
                    sha256: written.sha256,
                    size: written.size,
                }))
            }
            // Version-locked operations proxied from a controller. The list is
            // closed and the payload is this build's own JSON; see
            // `remote::service` for why that is safe here and nowhere else.
            Action::Service(input) => {
                let Ok(operation) = WorkerServiceOperation::try_from(input.operation) else {
                    return Ok(Response::Error(ErrorResponse {
                        code: "UNSUPPORTED".into(),
                        message: "Worker service operation is not recognized".into(),
                    }));
                };
                let root = self.root(&input.root_id)?;
                let (http_status, response_json) = crate::remote::service::handle(
                    root,
                    operation,
                    input.request_json,
                    input.allow_write,
                    input.allow_execute,
                )
                .await;
                if response_json.len() > MAX_FRAME - 1024 {
                    return Ok(Response::Error(ErrorResponse {
                        code: "RESOURCE_EXHAUSTED".into(),
                        message: "The answer is larger than one Worker frame".into(),
                    }));
                }
                Ok(Response::Service(WorkerServiceResponse {
                    http_status,
                    response_json,
                }))
            }
        }
    }
}

pub async fn serve<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut input: R,
    mut output: W,
    canvas: Option<SqlitePool>,
) -> anyhow::Result<()> {
    let mut worker = match canvas {
        Some(pool) => Worker::with_canvas(pool),
        None => Worker::default(),
    };
    loop {
        let mut prefix = [0u8; 4];
        if input.read(&mut prefix[..1]).await? == 0 {
            return Ok(());
        }
        input.read_exact(&mut prefix[1..]).await?;
        let length = u32::from_be_bytes(prefix) as usize;
        anyhow::ensure!(
            length > 0 && length <= MAX_FRAME,
            "Invalid Worker frame length"
        );
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes).await?;
        let request = WorkerRequest::decode(bytes.as_slice())?;
        let response = worker.handle(request).await;
        let bytes = response.encode_to_vec();
        anyhow::ensure!(
            bytes.len() <= MAX_FRAME,
            "Worker response exceeds frame limit"
        );
        output
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        output.write_all(&bytes).await?;
        output.flush().await?;
    }
}

/// Command mode: the resident bidirectional channel over stdio, plus a private
/// socket bearer for a controller that has to reattach (§2.9).
///
/// Reading runs in its own task, so end of input is noticed while a request is
/// still being handled and a dead controller cannot leave an otherwise healthy
/// Worker running jobs on its behalf. That property predates the upward flow
/// and [`channel::serve`] keeps it for both bearers.
///
/// The outbox is opened before the handshake, because the handshake has to say
/// truthfully whether this Worker can report upward *and* how much it already
/// owes. A Worker whose outbox will not open still serves requests: losing the
/// upward flow is visible to the Host, losing execution is not what was asked
/// for.
pub async fn serve_commands<R, W>(
    input: R,
    output: W,
    path: PathBuf,
    canvas: Option<SqlitePool>,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut worker = Worker {
        command_path: Some(path.clone()),
        canvas,
        ..Default::default()
    };
    // The state directory's privacy is proven here, once, exactly as the
    // command journal proves it; the outbox and the bearer both live inside it.
    let state_dir = crate::command::store::private_directory(&path)?;
    let instance = worker.instance.clone();
    let channel = match outbox::Outbox::open(&state_dir, &instance).await {
        Ok(outbox) => Some(std::sync::Arc::new(channel::Channel::new(outbox))),
        Err(error) => {
            tracing::error!(%error, "the upcall outbox could not be opened; this Worker will not report upward");
            None
        }
    };
    let bearer = match channel.as_ref() {
        Some(_) => match socket::bind(&state_dir, &instance) {
            Ok(bearer) => Some(bearer),
            Err(error) => {
                // stdio still works; only the reattach path is lost, and the
                // handshake will not claim an address that does not exist.
                tracing::warn!(%error, "the upcall socket bearer could not be bound");
                None
            }
        },
        None => None,
    };
    if let Some(channel) = channel.as_ref() {
        let (socket, pipe) = match bearer.as_ref() {
            Some(bearer) => (bearer.socket.clone(), bearer.pipe.clone()),
            None => (None, None),
        };
        worker.attach_channel(channel.upcaller(), socket, pipe);
    }
    let worker = std::sync::Arc::new(tokio::sync::Mutex::new(worker));
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let bearer_task = match (bearer, channel.as_ref()) {
        (Some(bearer), Some(channel)) => {
            let worker = std::sync::Arc::clone(&worker);
            let channel = std::sync::Arc::clone(channel);
            Some(tokio::spawn(async move {
                bearer.serve(worker, channel, stop_rx).await
            }))
        }
        _ => None,
    };
    let result = channel::serve(
        input,
        output,
        std::sync::Arc::clone(&worker),
        channel.clone(),
    )
    .await;
    let _ = stop.send(true);
    if let Some(task) = bearer_task {
        task.abort();
        let _ = task.await;
    }
    if let Some(channel) = channel {
        channel.outbox().close().await;
    }
    let manager = worker.lock().await.commands.take();
    if let Some(manager) = manager {
        let confirmation = manager.shutdown().await?;
        anyhow::ensure!(
            confirmation.cleanup_confirmed,
            "Worker command cleanup was not confirmed"
        );
    }
    result
}
