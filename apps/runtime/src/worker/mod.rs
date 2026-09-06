//! Read-only execution bridge over a parent-owned anonymous pipe. This mode
//! never starts the legacy HTTP server, migrates canvas.db or recovers PTYs.
//!
//! One action writes: scheduled prompt delivery is *proxied* to the live
//! Runtime that owns the terminal (see [`agent_bridge`]). This process still
//! opens no PTY of its own.
pub mod agent_bridge;
pub mod agent_host;
pub mod channel;
pub mod filesystem;
pub mod git;
pub mod hook_pump;
pub mod language_link;
pub mod outbox;
pub mod service;
pub mod session;
pub mod session_watch;
pub mod settings;
pub mod socket;
pub mod transport;
pub mod upload;
pub mod watch;

// The transport is a separate concern from what a request means, but the two
// entry points are the module's public surface and stay reachable as
// `worker::serve` / `worker::serve_commands`.
pub use transport::{serve, serve_commands};

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

pub const MAX_FRAME: usize = 1 << 20;
pub const MAX_CHUNK: usize = 256 << 10;
const MAX_ROOTS: usize = 1024;

/// Advertised when this Worker can apply a Host reverse export package
/// (Go Host 业务所有权迁移 §2.12), which is what lets a rollback be a rollback
/// rather than an export the operator has to accept as one.
pub const REVERSE_IMPORT_CAPABILITY: &str = "ownership.reverse-import.v1";

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
    /// The door to the resident Runtime the session frames need
    /// (Go Host 业务所有权迁移 §2.6). This process holds no PTY: starting,
    /// signalling and accounting for runs all go to the Runtime that does, over
    /// the same private endpoint the hook client uses. Absent when this Worker
    /// has no data directory to find that endpoint in, and then every
    /// execution-shaped session action answers UNSUPPORTED rather than
    /// pretending it started something.
    sessions: Option<session::Bridge>,
    /// The same door, for the agent domain's one execution verb: writing an
    /// answer into the file a blocked CLI is reading (§2.7). It is a separate
    /// value rather than a method on the session bridge because the two are
    /// different domains that happen to knock on one door.
    agents_host: Option<agent_host::Bridge>,
    /// The Runtime's `settings.json`, the file frame 25 reads and writes
    /// (Go Host 业务所有权迁移 §2.4). Absent unless `--settings-file` named
    /// one, and then the settings action answers UNSUPPORTED rather than
    /// guessing at a data directory this process was not pointed at.
    settings_file: Option<PathBuf>,
    /// The upward half of the resident channel. Present only when a durable
    /// outbox was opened, because a Worker that cannot persist a report must
    /// not advertise that it can deliver one.
    upcalls: Option<channel::Upcaller>,
    /// The socket bearer's published address, reported in the handshake so a
    /// controller can reattach without respawning this process.
    bearer: (Option<String>, Option<String>),
    /// The language link's state, present only on a `--language-link`
    /// connection. Without it every session action answers UNSUPPORTED, which
    /// is what a serial connection must say: the servers live in the process
    /// that holds the link, not in this one.
    language: Option<std::sync::Arc<language_link::Host>>,
    /// Chunked uploads in flight. Empty until a controller opens one, and
    /// dropped with this process, which is what cleans up their temporary
    /// files if the connection dies mid-stream.
    uploads: upload::Uploads,
    /// The connection's filesystem subscription. Present only once the serve
    /// loop has somewhere to put unsolicited frames, so a Worker whose
    /// transport cannot carry them never claims it can watch.
    watches: Option<watch::Watches>,
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
            sessions: None,
            agents_host: None,
            settings_file: None,
            upcalls: None,
            bearer: (None, None),
            language: None,
            uploads: upload::Uploads::default(),
            watches: None,
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
        AppError::Unsupported(_) => "UNSUPPORTED",
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
    //
    // UNSUPPORTED is the exception, and deliberately so: its message is written
    // by this Worker, names a capability rather than a path, and is the whole
    // content of the answer — "no transcript" and "this provider keeps none"
    // are different facts and a controller has to be able to tell them apart.
    if let AppError::Unsupported(message) = &error {
        return ErrorResponse {
            code: code.into(),
            message: message.clone(),
        };
    }
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
        message: "Write ownership is not configured".into(),
    })
}

/// No link, no session. A serial connection cannot hold a language server:
/// the second `ssh` connection is a different process, and answering as though
/// it could would open a session against a server nobody can reach.
fn unsupported_language() -> worker_response::Result {
    worker_response::Result::Error(ErrorResponse {
        code: "UNSUPPORTED".into(),
        message: "Language sessions need the Worker's language link".into(),
    })
}

/// The stored row on the wire. `updated_at` is RFC 3339 in the database and
/// milliseconds in the protocol; an unparsable stamp is damage, not a zero.
fn write_ownership(record: ownership::WriteOwnership) -> Result<WorkerWriteOwnership, AppError> {
    let updated_at = chrono::DateTime::parse_from_rfc3339(&record.updated_at)
        .map_err(|_| AppError::Internal("Stored write ownership timestamp is invalid".into()))?;
    Ok(WorkerWriteOwnership {
        domain: record.domain.as_str().into(),
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
    /// The settings file frame 25 exports and imports. Absolute, because a
    /// relative path would resolve against whatever directory the controller
    /// happened to spawn this process in.
    pub fn with_settings_file(mut self, file: PathBuf) -> Self {
        self.settings_file = Some(file);
        self
    }
    /// The data directory the session bridge finds the resident Runtime's
    /// endpoint file in. It is the Runtime's own layout — `canvas.db` and
    /// `hook-endpoint.env` sit side by side — so a controller that named the
    /// database has already named this, and no second flag can drift from it.
    pub fn with_session_bridge(mut self, data_dir: PathBuf) -> Self {
        self.agents_host = Some(agent_host::Bridge::new(data_dir.clone()));
        self.sessions = Some(session::Bridge::new(data_dir));
        self
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
        if let Some(bridge) = self.sessions.take() {
            self.sessions = Some(bridge.with_upcalls(Some(upcalls.clone())));
        }
        // The git domain's producers are process-global registries — the clone
        // jobs and the repository command runner — so it takes the handle
        // rather than being handed one per frame (§2.9 上行帧 180).
        git::attach_upcalls(upcalls.clone());
        self.upcalls = Some(upcalls);
        self.bearer = (socket, pipe);
    }
    /// Attaches the language link's state. Only `--language-link` does this,
    /// and only then does the handshake claim [`language_link::CAPABILITY`].
    pub fn attach_language(&mut self, host: std::sync::Arc<language_link::Host>) {
        self.language = Some(host);
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
                    // What the controller actually gates on. The exact
                    // version match it used to require rejected every pair of
                    // builds that differed by a patch even though their
                    // payloads were identical (design §3.5).
                    service_contract_version: crate::remote::service::replay::CONTRACT_VERSION,
                    capabilities: {
                        let mut capabilities: Vec<String> = vec![
                            "worker.roots.v1".into(),
                            "files.directory-read.v1".into(),
                            "files.text-read.v1".into(),
                            "files.text-write.v1".into(),
                            crate::remote::client::REMOTE_CAPABILITY.into(),
                            // Discovery needs nothing but this process: it
                            // runs `--version` and starts no server. Sessions
                            // need the link, which is claimed separately.
                            language_link::CAPABILITY_V1.into(),
                            // Served unconditionally: they need nothing this
                            // process might not have been given.
                            crate::remote::service::replay::GIT_PANEL_CAPABILITY.into(),
                            crate::remote::service::replay::FILES_MANAGE_CAPABILITY.into(),
                            crate::remote::service::replay::UPLOAD_CAPABILITY.into(),
                        ];
                        if self.language.is_some() {
                            capabilities.push(language_link::CAPABILITY.into());
                        }
                        // Only a transport that can carry unsolicited frames
                        // may claim to watch: without one, a controller would
                        // wait forever for events instead of falling back to
                        // the poll it already has.
                        if self.watches.is_some() {
                            capabilities.push(watch::CAPABILITY.into());
                        }
                        if self.agents.is_some() {
                            capabilities.push(agent_bridge::CAPABILITY.into());
                        }
                        // Advertised only when a database was actually opened,
                        // so a controller never plans a handoff this Worker
                        // would have to refuse.
                        if self.canvas.is_some() {
                            capabilities.push("canvas.ownership.v1".into());
                            // The reverse import is a separate capability: a
                            // first-phase controller that only moves epochs
                            // must not conclude this Worker can apply a
                            // package, and a controller that needs one must
                            // not plan a rollback against a Worker that cannot.
                            capabilities.push(REVERSE_IMPORT_CAPABILITY.into());
                            // The settings domain needs both halves: the file
                            // to read and write, and the ownership row an
                            // import has to check before it writes. A Worker
                            // that has only one of them would have to refuse
                            // half of what this capability promises.
                            if self.settings_file.is_some() {
                                capabilities.push(settings::CAPABILITY.into());
                            }
                            // And the filesystem domain's own read, which is a
                            // third, separate statement: a controller that
                            // needs a handback verified must not plan one
                            // against a Worker that cannot answer it.
                            capabilities.push(filesystem::CAPABILITY.into());
                            // And the session domain's read, which is a fourth
                            // separate statement for the same reason: a
                            // controller that needs a handback verified must
                            // not plan one against a Worker that cannot answer.
                            capabilities.push(session::CAPABILITY.into());
                            // And the agent domain.s, which is a fifth: a
                            // controller that plans a switch has to know
                            // this Worker can read the rows it will compare
                            // against, and a Worker with no database cannot.
                            capabilities.push(agent_host::CAPABILITY.into());
                        }
                        // The git domain needs neither a database nor a state
                        // directory: a command runs in the workspace root the
                        // frame names, so every Worker can answer. Advertising
                        // it unconditionally is what lets a switch establish
                        // that the queue is empty over the same link it moves
                        // the epoch on.
                        capabilities.push(git::CAPABILITY.into());
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
                        domain: ownership::OwnershipDomain::parse(&input.domain)?,
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
                    ownership::read(pool, ownership::OwnershipDomain::parse(&input.domain)?)
                        .await?,
                )?))
            }
            // The filesystem domain's read (business migration §2.9). It is a
            // query about this database's own rows, and a Worker that never
            // opened one answers UNSUPPORTED rather than an empty list the
            // Host would compare against its package and read as agreement.
            // The git domain (§2.8). It runs commands rather than moving
            // records, so it needs no ownership database -- what it needs is
            // the workspace root, which travels in the frame.
            Action::Git(input) => Ok(Response::Git(git::handle(input).await?)),
            Action::Filesystem(input) => {
                let Some(pool) = self.canvas.as_ref() else {
                    return Ok(unsupported_ownership());
                };
                Ok(Response::Filesystem(filesystem::handle(pool, input).await?))
            }
            // The session domain (§2.6). The listing is answered from this
            // Worker's own database and everything else from the resident
            // Runtime that holds the PTYs, because a file descriptor does not
            // travel between two processes.
            Action::Session(input) => Ok(Response::Session(
                session::handle(self.canvas.as_ref(), self.sessions.as_ref(), input).await?,
            )),
            // The agent domain (§2.7). The listing and the drain are answered
            // from this Worker's own database; the one execution verb — writing
            // an answer where a blocked CLI is looking — goes to the resident
            // Runtime that holds the pending directory.
            Action::AgentHost(input) => Ok(Response::AgentHost(
                agent_host::handle(self.canvas.as_ref(), self.agents_host.as_ref(), input).await?,
            )),
            // The rollback direction. Applying the Host's reverse export is a
            // write to this database and nothing else: the epoch stays where
            // it is until the controller has compared the report's digests
            // with the package it produced.
            Action::ApplyReverseExport(input) => {
                let Some(pool) = self.canvas.as_ref() else {
                    return Ok(unsupported_ownership());
                };
                Ok(Response::ReverseImport(
                    ownership::import::apply(pool, &input).await?,
                ))
            }
            // Both directions of the settings domain (§2.4). Without a
            // settings file there is no document to export and nowhere to
            // import one, and inventing a path would write over whichever
            // Runtime's data directory this process happened to inherit.
            Action::Settings(input) => match self.settings_file.clone() {
                Some(file) => settings::handle(&file, self.canvas.as_ref(), input).await,
                None => Ok(Response::Error(ErrorResponse {
                    code: "UNSUPPORTED".into(),
                    message: "Settings are not configured".into(),
                })),
            },
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
                // Two readers behind one message. The editor's asks for text
                // and gets the encoding, BOM and preview limit with it; a
                // download or a whiteboard asset asks for the bytes, because
                // neither of those is text and refusing them would make a
                // remote workspace's own pictures unreadable.
                let (relative, mime_type, bytes) = if input.raw {
                    tokio::task::spawn_blocking(move || files::read_raw_file(&root, &path))
                        .await??
                } else {
                    let file =
                        tokio::task::spawn_blocking(move || files::read_text_file(&root, &path))
                            .await??;
                    (file.path, file.mime_type, file.content.into_bytes())
                };
                let sha256 = Sha256::digest(&bytes).to_vec();
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
                    path: relative,
                    mime_type,
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
            // The three actions that work on a whole root rather than on one
            // file. Each has rules of its own, so they live in `service`.
            Action::Service(input) => self.service(input).await,
            Action::Watch(input) => self.watch(input),
            Action::Upload(input) => self.upload(input),
            // Editor language services (language service design §2.7, §2.8).
            // Discovery answers on any connection — it runs `--version` and
            // starts nothing. Everything that holds state needs the link,
            // because the servers live in the process that holds it.
            Action::LanguageCapabilities(input) => Ok(Response::LanguageCapabilities(
                match self.language.as_ref() {
                    Some(host) => host.capabilities(input.refresh).await,
                    None => language_link::discovery(input.refresh).await,
                },
            )),
            Action::OpenLanguageSession(input) => {
                let Some(host) = self.language.clone() else {
                    return Ok(unsupported_language());
                };
                let root = self.root(&input.root_id)?;
                Ok(Response::LanguageSession(host.open(root, input).await?))
            }
            Action::CloseLanguageSession(input) => match self.language.as_ref() {
                Some(host) => Ok(Response::LanguageSession(
                    host.close(&input.session_id, &input.reason).await,
                )),
                None => Ok(unsupported_language()),
            },
            Action::LanguageApplyEdit(input) => {
                let Some(host) = self.language.clone() else {
                    return Ok(unsupported_language());
                };
                let root = self.root(&input.root_id)?;
                Ok(Response::LanguageApplyEdit(
                    host.apply_edit(root, input).await?,
                ))
            }
            // Restart and stop reach the servers themselves, so they need the
            // link for the same reason session opening does: the serial
            // connection is another process and holds none of them.
            Action::LanguageControl(input) => match self.language.as_ref() {
                Some(host) => Ok(Response::LanguageControl(host.control(input).await?)),
                None => Ok(unsupported_language()),
            },
            // A pushed frame carries no request id and expects no answer, so
            // the link takes it off the request path before it reaches here.
            // Arriving on the serial connection is a controller mistake.
            Action::LanguageFrame(_) => Ok(unsupported_language()),
        }
    }
}
