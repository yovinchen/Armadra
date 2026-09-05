//! Terminal sessions: selection between the tmux and direct backends, the
//! database mirror of every session, and the lifecycle the API layer talks to.
//!
//! Plan §15. The API layer never touches a backend: it asks the
//! [`TerminalManager`] for a session, an attachment, a capture or a
//! termination, and the manager decides which backend owns the key, whether the
//! caller's generation is still current, and what the database should say.

pub mod backend;
pub mod direct;
pub mod gc;
pub mod ssh;
pub mod tmux;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use chrono::Utc;
use portable_pty::PtySize;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::{RwLock, broadcast, mpsc};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    events::{EventHub, WorkspaceEvent},
    model::TerminalSession,
    paths,
    security::redact_secrets,
    settings::{BackendChoice, SettingsStore},
};

pub use backend::{
    AttachHandle, BackendKind, BackendRef, ForegroundInfo, SessionKey, TerminalBackend,
    TerminalSpec,
};

/// One managed session as [`TerminalManager::managed_sessions`] reports it.
///
/// Everything the resource sampler is allowed to look at, and nothing else: a
/// pid this runtime started, plus the identity needed to point the panel back
/// at the canvas node that owns it.
#[derive(Debug, Clone)]
pub struct ManagedSession {
    pub session_id: String,
    pub session_key: String,
    pub workspace_id: String,
    pub owner_node_id: Option<String>,
    pub backend: BackendKind,
    pub generation: u64,
    pub pid: Option<i64>,
    pub cwd: String,
    /// The program the session runs — an explicit command, else the shell.
    pub executable: String,
    pub exited: bool,
}

/// The size a session starts at, before the first `resize` from a socket.
pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_COLS: u16 = 80;

/// How often the tmux server is polled for sessions that ended while nothing
/// was attached to them.
const LIVENESS_INTERVAL: Duration = Duration::from_secs(3);
/// How often unattached sessions are checked against
/// `terminal.dormantAfterSeconds`. Coarse on purpose: the whole point of the
/// mechanism is to stop doing work for sessions nobody is watching, so its own
/// timer must not be one of the wakeups.
const DORMANCY_INTERVAL: Duration = Duration::from_secs(5);
/// `last_output_at` is a "how long has this been quiet" signal, not an audit
/// trail: one write every few seconds of continuous output is enough.
const ACTIVITY_THROTTLE: Duration = Duration::from_secs(5);

/* ------------------------------ output batching --------------------------- */

/// Plan §18.3, "输出吞吐". A PTY under `yes` hands us an 8 KiB read every
/// fraction of a millisecond; forwarding each one as its own WebSocket frame
/// buries the browser in JSON parsing and makes xterm redraw thousands of
/// times a second. One frame per 16 ms (a display frame) or per 64 KiB —
/// whichever comes first — keeps latency invisible and the frame count sane.
pub const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
pub const OUTPUT_FLUSH_BYTES: usize = 64 * 1024;

/// The flush interval of a session nothing is attached to (design §7.2).
///
/// A dormant session still has to keep every byte — the process is running and
/// its screen is what the next attach replays — but nobody is waiting for those
/// bytes at display latency. Coalescing 16 ms batches into half-second ones
/// costs nothing visible and removes ~30 wakeups, broadcast sends and
/// `terminal_logs` inserts per second per session, which is what makes thirty
/// idle-but-chatty terminals affordable.
pub const DORMANT_FLUSH_INTERVAL: Duration = Duration::from_millis(500);

/// The batching rule on its own, with no threads and no clock of its own, so
/// the interesting part is unit-testable.
#[derive(Debug)]
pub struct OutputBatch {
    buffer: Vec<u8>,
    /// When the first still-unsent byte arrived.
    started: Option<Instant>,
    /// How long a batch may wait before it has to go out. Not a constant: a
    /// session with no attached client widens it (see [`DORMANT_FLUSH_INTERVAL`]).
    flush_interval: Duration,
}

impl Default for OutputBatch {
    fn default() -> Self {
        Self {
            buffer: Vec::new(),
            started: None,
            flush_interval: OUTPUT_FLUSH_INTERVAL,
        }
    }
}

impl OutputBatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Widens or narrows the deadline. A batch already in flight keeps its
    /// start time, so narrowing takes effect immediately rather than at the
    /// next batch.
    pub fn set_flush_interval(&mut self, interval: Duration) {
        self.flush_interval = interval;
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Appends, and hands back a batch as soon as the byte budget is reached.
    pub fn push(&mut self, chunk: &[u8]) -> Option<Bytes> {
        if self.buffer.is_empty() {
            self.started = Some(Instant::now());
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() >= OUTPUT_FLUSH_BYTES {
            self.take()
        } else {
            None
        }
    }

    /// Everything buffered so far; `None` when there is nothing to send.
    pub fn take(&mut self) -> Option<Bytes> {
        self.started = None;
        if self.buffer.is_empty() {
            return None;
        }
        Some(Bytes::from(std::mem::take(&mut self.buffer)))
    }

    /// How long the caller may still block waiting for more input before this
    /// batch has to go out. `None` when nothing is buffered — then it may
    /// block forever.
    pub fn remaining(&self) -> Option<Duration> {
        let started = self.started?;
        Some(self.flush_interval.saturating_sub(started.elapsed()))
    }
}

/// The flush cadence of one session, in milliseconds, shared with whoever may
/// change it. [`TerminalManager`] widens it when the last client detaches and
/// narrows it again on the next attach.
pub type FlushCadence = Arc<std::sync::atomic::AtomicU64>;

/// A cadence handle starting at the interactive interval.
pub fn interactive_cadence() -> FlushCadence {
    Arc::new(std::sync::atomic::AtomicU64::new(
        OUTPUT_FLUSH_INTERVAL.as_millis() as u64,
    ))
}

/// Runs [`OutputBatch`] on its own thread. Returns the sender the PTY reader
/// pushes raw chunks into; `sink` receives the coalesced batches, and `on_eof`
/// runs once, **after** the final flush, so the last output always precedes the
/// exit status.
///
/// `cadence` is read once per turn rather than captured, so making a session
/// dormant changes the deadline of the batch already in flight instead of
/// waiting for the next one.
pub fn spawn_output_batcher(
    name: &str,
    cadence: FlushCadence,
    sink: impl Fn(Bytes) + Send + 'static,
    on_eof: impl FnOnce() + Send + 'static,
) -> std::sync::mpsc::Sender<Bytes> {
    use std::sync::mpsc::RecvTimeoutError;

    let (sender, receiver) = std::sync::mpsc::channel::<Bytes>();
    let _ = std::thread::Builder::new()
        .name(format!("pty-batch-{name}"))
        .spawn(move || {
            let mut batch = OutputBatch::new();
            loop {
                batch.set_flush_interval(Duration::from_millis(
                    cadence.load(Ordering::Relaxed).max(1),
                ));
                let received = match batch.remaining() {
                    Some(wait) => receiver.recv_timeout(wait),
                    None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match received {
                    Ok(chunk) => {
                        if let Some(ready) = batch.push(&chunk) {
                            sink(ready);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if let Some(ready) = batch.take() {
                            sink(ready);
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        if let Some(ready) = batch.take() {
                            sink(ready);
                        }
                        break;
                    }
                }
            }
            on_eof();
        });
    sender
}

/* ---------------------------------- requests ------------------------------ */

pub struct SpawnRequest {
    pub workspace_id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub kind: String,
    pub owner_node_id: Option<String>,
    pub agent_id: Option<String>,
    /// Extra environment for the child, e.g. the `ARMADRA_*` hook variables.
    pub env: Vec<(String, String)>,
}

impl SpawnRequest {
    /// A plain terminal with no node owner and no injected environment.
    pub fn plain(workspace_id: String, cwd: String) -> Self {
        Self {
            workspace_id,
            cwd,
            shell: None,
            command: None,
            args: vec![],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        }
    }
}

/// Plan §15.5: three levels, from "stop what you are doing" to "this session
/// should not exist any more".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminateMode {
    /// Ctrl+C to the foreground process group. The shell survives.
    Interrupt,
    /// Kill the session's process tree. A persistent session is left behind
    /// empty and is reclaimed later.
    #[default]
    Process,
    /// Kill the process tree and the persistent session with it.
    Session,
}

impl TerminateMode {
    fn intent(self) -> &'static str {
        match self {
            Self::Interrupt => "none",
            Self::Process => "process",
            Self::Session => "session",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Terminate {
        #[serde(default)]
        mode: Option<TerminateMode>,
    },
}

/* ---------------------------------- outputs ------------------------------- */

#[derive(Debug, Clone)]
pub struct StatusEvent {
    pub status: String,
    pub exit_code: Option<i64>,
}

/// `GET /api/terminals/backend`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub effective: BackendKind,
    pub configured: String,
    pub tmux_version: Option<String>,
    pub tmux_socket: Option<String>,
    /// Why the effective backend is not the configured one, when it is not.
    pub reason: Option<String>,
    /// `"unix"` or `"windows"`. The web side needs it before it opens xterm:
    /// ConPTY needs `windowsPty` set, and that option cannot be changed after
    /// `open()` (plan §18.3, Windows row).
    pub platform: &'static str,
}

/// `GET /api/terminals/{id}/capture`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    pub generation: u64,
    pub lines: usize,
    pub data: String,
}

/// What one socket needs to serve a terminal: the first `hello` frame, the
/// optional `snapshot`, and the two streams behind them.
pub struct AttachSession {
    pub session_id: String,
    pub generation: u64,
    pub backend: BackendKind,
    pub rows: u16,
    pub cols: u16,
    pub alive: bool,
    /// Direct backend only; the tmux client redraws the screen itself.
    pub snapshot: Option<String>,
    pub output: broadcast::Receiver<Bytes>,
    pub status: broadcast::Receiver<StatusEvent>,
    /// The terminal was already over before this socket connected.
    pub current_status: Option<StatusEvent>,
    /// Detaches when the socket closes. Never kills the session.
    pub detach: backend::DetachGuard,
}

/* ---------------------------------- manager ------------------------------- */

#[derive(Clone)]
struct SessionRecord {
    id: String,
    key: SessionKey,
    workspace_id: String,
    owner_node_id: Option<String>,
    kind: BackendKind,
    generation: u64,
    pid: Option<i64>,
    rows: u16,
    cols: u16,
    exited: bool,
    /// Kept so `recycle` can restart the same terminal, environment included.
    spec: TerminalSpec,
    input_revision: u64,
    input_safety: InputSafety,
    last_input_source_revision: Option<u64>,
    observation: Option<AgentObservation>,
}

#[derive(Clone, Default)]
struct InputSafety {
    pending: bool,
    in_paste: bool,
    escape: Vec<u8>,
}
impl InputSafety {
    fn consume(&mut self, data: &[u8]) -> (bool, bool) {
        let was_pending = self.pending;
        let mut edited = false;
        let mut submitted = false;
        for &byte in data {
            if !self.escape.is_empty() {
                self.escape.push(byte);
                if self.escape == b"\x1b[200~" {
                    self.in_paste = true;
                    self.pending = true;
                    edited = true;
                    self.escape.clear();
                    continue;
                }
                if self.escape == b"\x1b[201~" {
                    self.in_paste = false;
                    self.escape.clear();
                    continue;
                }
                if b"\x1b[200~".starts_with(&self.escape) || b"\x1b[201~".starts_with(&self.escape)
                {
                    continue;
                }
                if self.escape.len() >= 3 && self.escape[1] == b'[' && (0x40..=0x7e).contains(&byte)
                {
                    let response = matches!(byte, b'c' | b'R' | b'n')
                        && self.escape[2..self.escape.len() - 1]
                            .iter()
                            .all(|byte| byte.is_ascii_digit() || b";?>".contains(byte));
                    if !response {
                        self.pending = true;
                        edited = true;
                    }
                    self.escape.clear();
                    continue;
                }
                if self.escape.len() > 64 || (self.escape.len() == 2 && byte != b'[') {
                    self.pending = true;
                    edited = true;
                    self.escape.clear();
                }
                continue;
            }
            if byte == 0x1b {
                self.escape.push(byte);
                continue;
            }
            if !self.in_paste && matches!(byte, b'\r' | b'\n') {
                self.pending = false;
                submitted = true;
                edited = true;
            } else {
                self.pending = true;
                edited = true;
            }
        }
        (edited, submitted || (!was_pending && self.pending))
    }
}

#[derive(Clone, Debug)]
pub struct AgentObservation {
    pub revision: u64,
    pub provider_session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub observed_at: String,
    pub idle_input_revision: Option<u64>,
}

pub struct AgentReport {
    pub revision: u64,
    pub provider_session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub idle: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardedPasteOutcome {
    Submitted,
    NotWritten(&'static str),
    Unknown,
}

struct Inner {
    shutting_down: AtomicBool,
    creation_gate: RwLock<()>,
    pool: SqlitePool,
    events: EventHub,
    settings: SettingsStore,
    data_dir: PathBuf,
    direct: Arc<direct::DirectBackend>,
    tmux: Option<Arc<tmux::TmuxBackend>>,
    detection: tmux::TmuxDetection,
    configured: BackendChoice,
    effective: BackendKind,
    reason: Option<String>,
    records: RwLock<HashMap<String, SessionRecord>>,
    /// `session_key -> session id`; a key has exactly one live session.
    by_key: RwLock<HashMap<SessionKey, String>>,
    key_gates: std::sync::Mutex<HashMap<SessionKey, Arc<tokio::sync::Mutex<()>>>>,
    statuses: RwLock<HashMap<String, broadcast::Sender<StatusEvent>>>,
    /// How many sockets are attached to each session, and since when there
    /// have been none. A plain `std::sync::Mutex` because the release side runs
    /// inside a `Drop`, which cannot await (design §7.2).
    attachments: std::sync::Mutex<HashMap<String, Attachment>>,
}

/// One session's attachment bookkeeping.
#[derive(Debug, Default)]
struct Attachment {
    /// Live sockets. Not a flag: several devices may watch one terminal.
    sockets: usize,
    /// When `sockets` last fell to zero. `None` while something is attached.
    idle_since: Option<Instant>,
    dormant: bool,
}

/// Replaces the old `PtyManager`. Cheap to clone; the background tasks hold a
/// weak reference so dropping the last clone stops them.
#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

/// One attached socket, counted for as long as this value lives.
///
/// A weak reference, so a lease outliving the manager (a socket task still
/// unwinding while the runtime shuts down) releases into nothing instead of
/// keeping the whole manager alive.
struct AttachLease {
    inner: std::sync::Weak<Inner>,
    session_id: String,
}

impl Drop for AttachLease {
    fn drop(&mut self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let mut attachments = inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = attachments.get_mut(&self.session_id) {
            entry.sockets = entry.sockets.saturating_sub(1);
            if entry.sockets == 0 {
                entry.idle_since = Some(Instant::now());
            }
        }
    }
}

impl TerminalManager {
    /// Uses the on-disk settings and the real data directory.
    pub fn new(pool: SqlitePool, events: EventHub) -> Self {
        Self::with_config(pool, events, SettingsStore::load(), paths::data_dir())
    }

    /// Tests and the desktop shell hand in their own settings and data
    /// directory so a run never touches the user's tmux server.
    pub fn with_config(
        pool: SqlitePool,
        events: EventHub,
        settings: SettingsStore,
        data_dir: PathBuf,
    ) -> Self {
        let (notices, notice_receiver) = mpsc::unbounded_channel();
        let direct = Arc::new(direct::DirectBackend::new(notices.clone()));
        let configured = settings.terminal().backend;
        let detection = tmux::detect();

        let mut reason = detection.reason.clone();
        let wanted_tmux = match configured {
            BackendChoice::Direct => {
                reason = Some("terminal.backend is set to direct".into());
                false
            }
            BackendChoice::Tmux | BackendChoice::Auto => detection.usable,
        };
        let tmux = if wanted_tmux {
            match tmux::TmuxBackend::with_data_dir(&data_dir, notices.clone()) {
                Ok(backend) => Some(Arc::new(backend)),
                Err(error) => {
                    reason = Some(format!("tmux could not be configured: {error}"));
                    None
                }
            }
        } else {
            None
        };

        let effective = if tmux.is_some() {
            BackendKind::Tmux
        } else {
            BackendKind::Direct
        };

        let inner = Arc::new(Inner {
            shutting_down: AtomicBool::new(false),
            creation_gate: RwLock::new(()),
            pool,
            events,
            settings,
            data_dir,
            direct,
            tmux,
            detection,
            configured,
            effective,
            reason,
            records: RwLock::new(HashMap::new()),
            by_key: RwLock::new(HashMap::new()),
            key_gates: std::sync::Mutex::new(HashMap::new()),
            statuses: RwLock::new(HashMap::new()),
            attachments: std::sync::Mutex::new(HashMap::new()),
        });
        let manager = Self { inner };
        manager.spawn_notice_loop(notice_receiver);
        manager.spawn_liveness_loop();
        manager.spawn_dormancy_loop();
        manager.spawn_sweeper();
        manager
    }

    fn backend(&self, kind: BackendKind) -> Arc<dyn TerminalBackend> {
        match (kind, self.inner.tmux.as_ref()) {
            (BackendKind::Tmux, Some(tmux)) => tmux.clone() as Arc<dyn TerminalBackend>,
            _ => self.inner.direct.clone() as Arc<dyn TerminalBackend>,
        }
    }

    fn key_gate(&self, key: &SessionKey) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .key_gates
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub fn backend_info(&self) -> BackendInfo {
        BackendInfo {
            effective: self.inner.effective,
            configured: self.inner.configured.as_str().to_owned(),
            tmux_version: self.inner.detection.version.clone(),
            tmux_socket: self
                .inner
                .tmux
                .as_ref()
                .map(|tmux| tmux.socket().to_string_lossy().into_owned()),
            reason: self.inner.reason.clone(),
            platform: if cfg!(windows) { "windows" } else { "unix" },
        }
    }

    async fn record(&self, session_id: &str) -> Option<SessionRecord> {
        self.inner.records.read().await.get(session_id).cloned()
    }

    async fn require(&self, session_id: &str) -> AppResult<SessionRecord> {
        self.record(session_id)
            .await
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))
    }

    /// The generation a socket must present to be allowed to write.
    pub async fn generation(&self, session_id: &str) -> Option<u64> {
        self.record(session_id)
            .await
            .map(|record| record.generation)
    }

    /// `None` once the session has ended, so the sessions sidebar can show it
    /// as no longer alive.
    pub async fn pid(&self, session_id: &str) -> Option<i64> {
        let record = self.record(session_id).await?;
        (!record.exited).then_some(record.pid).flatten()
    }

    pub async fn is_alive(&self, session_id: &str) -> bool {
        self.record(session_id)
            .await
            .is_some_and(|record| !record.exited)
    }

    /// Context reports must target the currently selected PTY for this node,
    /// including when an older session record still awaits its exit notice.
    pub async fn is_current_node_session(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
    ) -> bool {
        if self
            .inner
            .by_key
            .read()
            .await
            .get(&SessionKey::new(node_id.to_owned()))
            .map(String::as_str)
            != Some(session_id)
        {
            return false;
        }
        self.record(session_id)
            .await
            .is_some_and(|record| !record.exited && record.generation == generation)
    }

    /* ------------------------------- lifecycle ---------------------------- */

    pub async fn spawn(&self, request: SpawnRequest) -> AppResult<TerminalSession> {
        let _creation = self.inner.creation_gate.read().await;
        if self.is_shutting_down() {
            return Err(AppError::Conflict("Runtime is shutting down".into()));
        }
        let id = Uuid::now_v7().to_string();
        let key = SessionKey::new(request.owner_node_id.clone().unwrap_or_else(|| id.clone()));
        let _key_guard = self.key_gate(&key).lock_owned().await;
        let shell = request.shell.clone().unwrap_or_else(default_shell);
        let spec = TerminalSpec {
            session_key: key.clone(),
            workspace_id: request.workspace_id.clone(),
            generation: 1,
            cwd: request.cwd.clone(),
            shell: shell.clone(),
            command: request.command.clone(),
            args: request.args.clone(),
            env: context_session_environment(
                with_utf8_locale(request.env.clone()),
                &self.inner.data_dir,
                &id,
                1,
            ),
            size: PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            },
        };
        let kind = self.inner.effective;
        let handle = self.backend(kind).create(spec.clone()).await?;

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind, \
             owner_node_id, agent_id, status, created_at, session_key, backend_kind, \
             backend_ref, generation, attach_state, termination_intent) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 'detached', 'none')",
        )
        .bind(&id)
        .bind(&request.workspace_id)
        .bind(&request.cwd)
        .bind(&shell)
        .bind(&request.command)
        .bind(&request.kind)
        .bind(&request.owner_node_id)
        .bind(&request.agent_id)
        .bind(&now)
        .bind(key.as_str())
        .bind(kind.as_str())
        .bind(&handle.backend_ref)
        .bind(handle.generation as i64)
        .execute(&self.inner.pool)
        .await?;

        self.remember(SessionRecord {
            id: id.clone(),
            key: key.clone(),
            workspace_id: request.workspace_id.clone(),
            owner_node_id: request.owner_node_id.clone(),
            kind,
            generation: handle.generation,
            pid: handle.pid,
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
            exited: false,
            input_revision: 0,
            input_safety: InputSafety::default(),
            last_input_source_revision: Some(0),
            observation: None,
            spec,
        })
        .await;

        Ok(TerminalSession {
            id,
            workspace_id: request.workspace_id,
            cwd: request.cwd,
            shell,
            command: request.command,
            kind: request.kind,
            owner_node_id: request.owner_node_id,
            agent_id: request.agent_id,
            status: "running".into(),
            exit_code: None,
            pid: handle.pid,
            created_at: now,
            ended_at: None,
            session_key: key.to_string(),
            backend: kind.as_str().to_owned(),
            generation: handle.generation as i64,
            attach_state: "detached".into(),
            last_output_at: None,
        })
    }

    async fn remember(&self, record: SessionRecord) {
        self.inner
            .by_key
            .write()
            .await
            .insert(record.key.clone(), record.id.clone());
        let mut statuses = self.inner.statuses.write().await;
        statuses
            .entry(record.id.clone())
            .or_insert_with(|| broadcast::channel(16).0);
        drop(statuses);
        // A session starts unwatched. Registering it here rather than on the
        // first attach is what makes a terminal that is created and never
        // opened — a scripted spawn, a node restored off-screen — eligible for
        // dormancy at all.
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(record.id.clone())
            .or_insert_with(|| Attachment {
                sockets: 0,
                idle_since: Some(Instant::now()),
                dormant: false,
            });
        self.inner
            .records
            .write()
            .await
            .insert(record.id.clone(), record);
    }

    /// Same `session_key`, next generation (plan §15.5). Sockets attached to
    /// the old generation are told to clear and reconnect.
    pub async fn recycle(&self, session_id: &str) -> AppResult<TerminalSession> {
        let _creation = self.inner.creation_gate.read().await;
        if self.is_shutting_down() {
            return Err(AppError::Conflict("Runtime is shutting down".into()));
        }
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.require(session_id).await?;
        let backend = self.backend(record.kind);
        let next_generation = record.generation + 1;
        // The bump has to be visible *before* the old session is destroyed.
        // Destroying it closes the output stream every attached socket is
        // reading, and each of those sockets then asks what the current
        // generation is: still seeing the old one, they would close silently
        // instead of sending `stale`, and the client would treat a planned
        // recycle as a dropped connection. Marking it exited at the same time
        // silences the exit its own watcher is about to report.
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.generation = next_generation;
            record.exited = true;
        }
        let _ = backend.destroy(&record.key).await;

        let mut spec = record.spec.clone();
        spec.generation = next_generation;
        spec.env = context_session_environment(
            spec.env,
            &self.inner.data_dir,
            session_id,
            next_generation,
        );
        spec.size = PtySize {
            rows: record.rows,
            cols: record.cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        // The backend may have changed since the session started (settings, or
        // tmux appearing on PATH), so re-pick it here.
        let kind = self.inner.effective;
        let handle = match self.backend(kind).create(spec.clone()).await {
            Ok(handle) => handle,
            Err(error) => {
                // The old session is already gone, so the row must not keep
                // claiming to be running.
                let _ = sqlx::query(
                    "UPDATE terminal_sessions SET status = 'exited', attach_state = 'exited', \
                     ended_at = ? WHERE id = ? AND status = 'running'",
                )
                .bind(Utc::now().to_rfc3339())
                .bind(session_id)
                .execute(&self.inner.pool)
                .await;
                return Err(error);
            }
        };

        sqlx::query(
            "UPDATE terminal_sessions SET generation = ?, backend_kind = ?, backend_ref = ?, \
             status = 'running', exit_code = NULL, ended_at = NULL, attach_state = 'detached', \
             termination_intent = 'recycle', last_output_at = NULL WHERE id = ?",
        )
        .bind(handle.generation as i64)
        .bind(kind.as_str())
        .bind(&handle.backend_ref)
        .bind(session_id)
        .execute(&self.inner.pool)
        .await?;

        self.remember(SessionRecord {
            kind,
            generation: handle.generation,
            input_revision: 0,
            input_safety: InputSafety::default(),
            last_input_source_revision: Some(0),
            observation: None,
            pid: handle.pid,
            exited: false,
            spec,
            ..record
        })
        .await;
        self.publish_status(session_id, "running", None).await;
        self.session(session_id).await
    }

    /// The database row plus whatever this runtime knows about the process.
    pub async fn session(&self, session_id: &str) -> AppResult<TerminalSession> {
        let mut session = crate::db::get_terminal_session(&self.inner.pool, session_id).await?;
        session.pid = self.pid(session_id).await;
        Ok(session)
    }

    /* -------------------------------- attach ------------------------------ */

    pub async fn attach(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<AttachSession> {
        let _creation = self.inner.creation_gate.read().await;
        if self.is_shutting_down() {
            return Err(AppError::Conflict("Runtime is shutting down".into()));
        }
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let Some(record) = self.record(session_id).await else {
            // Nothing live: the row is all there is. The socket still gets a
            // `hello` and the final `status`, so the UI can show the exit.
            let session = crate::db::get_terminal_session(&self.inner.pool, session_id).await?;
            let (_, output) = broadcast::channel(1);
            let (_, status) = broadcast::channel(1);
            return Ok(AttachSession {
                session_id: session.id,
                generation: session.generation.max(0) as u64,
                backend: if session.backend == "tmux" {
                    BackendKind::Tmux
                } else {
                    BackendKind::Direct
                },
                rows: size.rows,
                cols: size.cols,
                alive: false,
                snapshot: None,
                output,
                status,
                current_status: Some(StatusEvent {
                    status: session.status,
                    exit_code: session.exit_code,
                }),
                detach: backend::DetachGuard::none(),
            });
        };

        let status = self
            .inner
            .statuses
            .read()
            .await
            .get(session_id)
            .map(|sender| sender.subscribe());
        let handle = self
            .backend(record.kind)
            .attach(&record.key, record.generation, size)
            .await?;
        // Waking is deliberately *after* the backend attach and deliberately
        // not a create: a dormant session is a running process whose delivery
        // was slowed down, so all that has to be undone is the slowing down
        // (design §7.2).
        if self.take_dormant(session_id) {
            let _ = self
                .backend(record.kind)
                .set_dormant(&record.key, false)
                .await;
        }
        let lease = self.lease(session_id);
        // The direct backend has no screen to redraw, so the socket gets the
        // replay buffer as one `snapshot` frame instead.
        let snapshot = match record.kind {
            BackendKind::Direct => self.inner.direct.snapshot(&record.key).await,
            BackendKind::Tmux => None,
        };
        self.note_size(session_id, size.cols, size.rows).await;
        if !record.exited {
            self.set_attach_state(session_id, "live").await;
        }
        // A session that ended before this socket connected has no status frame
        // left to broadcast, so the row provides it.
        let current_status = if record.exited {
            crate::db::get_terminal_session(&self.inner.pool, session_id)
                .await
                .ok()
                .map(|session| StatusEvent {
                    status: session.status,
                    exit_code: session.exit_code,
                })
        } else {
            None
        };

        let (_, fallback) = broadcast::channel(1);
        Ok(AttachSession {
            session_id: session_id.to_owned(),
            generation: handle.generation,
            backend: record.kind,
            rows: size.rows,
            cols: size.cols,
            alive: !record.exited,
            snapshot,
            output: handle.output,
            status: status.unwrap_or(fallback),
            current_status,
            // The backend's own detach first (it ends a tmux client), then the
            // lease. Both run on every path out of the socket handler,
            // including the early returns where `detached()` is never reached.
            detach: backend::DetachGuard::new(move || {
                drop(handle.detach);
                drop(lease);
            }),
        })
    }

    /// Called when a socket closes. Detaching is not terminating.
    pub async fn detached(&self, session_id: &str) {
        if self.is_alive(session_id).await {
            self.set_attach_state(session_id, "detached").await;
        }
    }

    /* ------------------------------- dormancy ----------------------------- */

    /// Registers one attached socket. The returned lease releases it on drop,
    /// which is the only reliable place: the socket handler has several early
    /// returns and a panic path, and none of them may leave a session counted
    /// as watched forever.
    fn lease(&self, session_id: &str) -> AttachLease {
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = attachments.entry(session_id.to_owned()).or_default();
        entry.sockets += 1;
        entry.idle_since = None;
        AttachLease {
            inner: Arc::downgrade(&self.inner),
            session_id: session_id.to_owned(),
        }
    }

    /// Clears the dormant flag, answering whether it had been set — so the
    /// caller only pays for a backend round trip when there is something to
    /// undo.
    fn take_dormant(&self, session_id: &str) -> bool {
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = attachments.entry(session_id.to_owned()).or_default();
        std::mem::replace(&mut entry.dormant, false)
    }

    /// Whether this session has been put to sleep. The process is running
    /// either way; this only says how its output is being delivered.
    pub fn is_dormant(&self, session_id: &str) -> bool {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .is_some_and(|entry| entry.dormant)
    }

    /// How many sockets are watching this session right now.
    pub fn attached_sockets(&self, session_id: &str) -> usize {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .map_or(0, |entry| entry.sockets)
    }

    /// The sessions that have been unwatched for longer than `after`.
    fn dormancy_due(&self, after: Duration) -> Vec<String> {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(_, entry)| {
                !entry.dormant
                    && entry.sockets == 0
                    && entry
                        .idle_since
                        .is_some_and(|since| since.elapsed() >= after)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Marks one session dormant and tells its backend. Skipped for a session
    /// that is already over — a dead process has nothing to slow down.
    async fn make_dormant(&self, session_id: &str) {
        let Some(record) = self.record(session_id).await else {
            self.forget_attachment(session_id);
            return;
        };
        if record.exited {
            self.forget_attachment(session_id);
            return;
        }
        if self
            .backend(record.kind)
            .set_dormant(&record.key, true)
            .await
            .is_err()
        {
            return;
        }
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = attachments.get_mut(session_id)
            && entry.sockets == 0
        {
            entry.dormant = true;
            tracing::debug!(session_id, "terminal session is dormant");
        }
    }

    fn forget_attachment(&self, session_id: &str) {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    /// Moves a session's idle clock back so a test can reach the dormancy
    /// deadline without sleeping through it.
    #[cfg(test)]
    fn backdate_idle_for_test(&self, session_id: &str, by: Duration) {
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = attachments.get_mut(session_id)
            && let Some(since) = entry.idle_since
        {
            entry.idle_since = since.checked_sub(by);
        }
    }

    /// Runs the dormancy policy. Separate from the loop so a test can drive it
    /// without waiting five seconds per turn.
    pub async fn apply_dormancy(&self) {
        let after = self.inner.settings.terminal().dormant_after_seconds;
        if after == 0 {
            return;
        }
        for session_id in self.dormancy_due(Duration::from_secs(after)) {
            self.make_dormant(&session_id).await;
        }
    }

    fn spawn_dormancy_loop(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(DORMANCY_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { break };
                TerminalManager { inner }.apply_dormancy().await;
            }
        });
    }

    async fn note_size(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.cols = cols;
            record.rows = rows;
        }
    }

    async fn set_attach_state(&self, session_id: &str, state: &str) {
        let _ = sqlx::query("UPDATE terminal_sessions SET attach_state = ? WHERE id = ? AND (? = 'exited' OR status = 'running')")
            .bind(state)
            .bind(session_id)
            .bind(state)
            .execute(&self.inner.pool)
            .await;
    }

    /* --------------------------------- io --------------------------------- */

    /// A write from a socket that still believes in `generation`.
    pub async fn write(&self, session_id: &str, generation: u64, data: &str) -> AppResult<()> {
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.checked(session_id, generation).await?;
        self.note_input(session_id, data.as_bytes()).await;
        self.backend(record.kind)
            .write(&record.key, data.as_bytes())
            .await
    }

    pub async fn resize(
        &self,
        session_id: &str,
        generation: u64,
        cols: u16,
        rows: u16,
    ) -> AppResult<()> {
        let record = self.checked(session_id, generation).await?;
        self.note_size(session_id, cols.max(2), rows.max(2)).await;
        self.backend(record.kind)
            .resize(
                &record.key,
                PtySize {
                    rows: rows.max(2),
                    cols: cols.max(2),
                    pixel_width: 0,
                    pixel_height: 0,
                },
            )
            .await
    }

    async fn checked(&self, session_id: &str, generation: u64) -> AppResult<SessionRecord> {
        let record = self.require(session_id).await?;
        if record.exited
            || self
                .inner
                .by_key
                .read()
                .await
                .get(&record.key)
                .map(String::as_str)
                != Some(session_id)
        {
            return Err(AppError::NotFound(
                "Terminal session is no longer current".into(),
            ));
        }
        if record.generation != generation {
            return Err(AppError::Conflict(format!(
                "Terminal generation {generation} is stale; the session is at {}",
                record.generation
            )));
        }
        Ok(record)
    }

    pub async fn capture(
        &self,
        session_id: &str,
        lines: u32,
        with_escapes: bool,
    ) -> AppResult<CaptureResponse> {
        let record = self.require(session_id).await?;
        let data = self
            .backend(record.kind)
            .capture(&record.key, lines, with_escapes)
            .await?;
        Ok(CaptureResponse {
            generation: record.generation,
            lines: if data.is_empty() {
                0
            } else {
                data.split('\n').count()
            },
            data,
        })
    }

    pub async fn paste(&self, session_id: &str, text: &str, press_enter: bool) -> AppResult<()> {
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.require(session_id).await?;
        let frame = format!(
            "{}{}{}{}",
            backend::PASTE_START,
            backend::sanitize_paste(text),
            backend::PASTE_END,
            if press_enter { "\r" } else { "" }
        );
        self.note_input(session_id, frame.as_bytes()).await;
        self.backend(record.kind)
            .paste(&record.key, text, press_enter)
            .await
    }

    async fn note_input(&self, session_id: &str, data: &[u8]) {
        let generation = {
            let mut records = self.inner.records.write().await;
            let Some(record) = records.get_mut(session_id) else {
                return;
            };
            let (edited, fence) = record.input_safety.consume(data);
            if edited {
                record.input_revision = record.input_revision.saturating_add(1);
            }
            if !fence {
                return;
            }
            record.last_input_source_revision = None;
            record.generation
        };
        let directory = self.inner.data_dir.clone();
        let session = session_id.to_owned();
        let operation = tokio::task::spawn_blocking(move || {
            crate::context_usage::advance_sequence(&directory, &session, generation)
        });
        let revision = match tokio::time::timeout(Duration::from_millis(250), operation).await {
            Ok(Ok(Ok(revision))) => Some(revision),
            _ => None,
        };
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.last_input_source_revision = revision;
        }
    }

    pub async fn agent_observation(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Option<AgentObservation> {
        self.record(session_id)
            .await
            .filter(|record| record.generation == generation && !record.exited)
            .and_then(|record| record.observation)
    }

    pub async fn observe_agent(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        report: AgentReport,
    ) -> bool {
        let AgentReport {
            revision,
            provider_session_id,
            transcript_path,
            idle,
        } = report;
        let Some(first) = self.record(session_id).await else {
            return false;
        };
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        if !self
            .is_current_node_session(node_id, session_id, generation)
            .await
        {
            return false;
        }
        let mut records = self.inner.records.write().await;
        let Some(record) = records.get_mut(session_id) else {
            return false;
        };
        if record
            .observation
            .as_ref()
            .is_some_and(|old| old.revision >= revision)
        {
            return false;
        }
        let provider_session_id = provider_session_id.or_else(|| {
            record
                .observation
                .as_ref()
                .and_then(|old| old.provider_session_id.clone())
        });
        let same_provider = record
            .observation
            .as_ref()
            .is_some_and(|old| old.provider_session_id == provider_session_id);
        let transcript_path = transcript_path.or_else(|| {
            same_provider
                .then(|| {
                    record
                        .observation
                        .as_ref()
                        .and_then(|old| old.transcript_path.clone())
                })
                .flatten()
        });
        record.observation = Some(AgentObservation {
            revision,
            provider_session_id,
            transcript_path,
            observed_at: Utc::now().to_rfc3339(),
            idle_input_revision: (idle
                && !record.input_safety.pending
                && record.input_safety.escape.is_empty()
                && record
                    .last_input_source_revision
                    .is_some_and(|input| input < revision))
            .then_some(record.input_revision),
        });
        true
    }

    pub async fn handoff_idle(&self, node_id: &str, session_id: &str, generation: u64) -> bool {
        if !self
            .is_current_node_session(node_id, session_id, generation)
            .await
        {
            return false;
        }
        self.record(session_id).await.is_some_and(|record| {
            !record.input_safety.pending
                && record.input_safety.escape.is_empty()
                && record.observation.as_ref().is_some_and(|observation| {
                    observation.idle_input_revision == Some(record.input_revision)
                })
        })
    }

    /// Only preflight failures prove no input was submitted. Once the backend
    /// is called, any failure is uncertain and must never trigger blind retry.
    /// Key ownership stays locked across generation/idle checks and the frame.
    pub async fn paste_handoff(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        expected_programs: &[String],
        text: &str,
    ) -> GuardedPasteOutcome {
        if self.is_shutting_down() {
            return GuardedPasteOutcome::NotWritten("runtimeStopping");
        }
        let Some(first) = self.record(session_id).await else {
            return GuardedPasteOutcome::NotWritten("targetUnavailable");
        };
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        if !self.handoff_idle(node_id, session_id, generation).await {
            return GuardedPasteOutcome::NotWritten("targetBusy");
        }
        let Ok(record) = self.checked(session_id, generation).await else {
            return GuardedPasteOutcome::NotWritten("targetChanged");
        };
        let foreground = self.backend(record.kind).foreground(&record.key).await;
        if !foreground.is_ok_and(|foreground| {
            crate::collab::messaging::pane_runs_agent(&foreground, expected_programs)
        }) {
            return GuardedPasteOutcome::NotWritten("targetNotAgentPane");
        }
        let frame = format!(
            "{}{}{}\r",
            backend::PASTE_START,
            backend::sanitize_paste(text),
            backend::PASTE_END
        );
        self.note_input(session_id, frame.as_bytes()).await;
        match self
            .backend(record.kind)
            .paste(&record.key, &backend::sanitize_paste(text), true)
            .await
        {
            Ok(()) => GuardedPasteOutcome::Submitted,
            Err(_) => GuardedPasteOutcome::Unknown,
        }
    }

    /// Wheel bridge (plan §18.5). Positive `lines` scrolls towards older
    /// output. A no-op on the direct backend, where xterm owns the scrollback.
    pub async fn scroll(&self, session_id: &str, lines: i32) -> AppResult<()> {
        let record = self.require(session_id).await?;
        self.backend(record.kind).scroll(&record.key, lines).await
    }

    pub async fn foreground(&self, session_id: &str) -> AppResult<ForegroundInfo> {
        let record = self.require(session_id).await?;
        self.backend(record.kind).foreground(&record.key).await
    }

    /* -------------------------------- resources --------------------------- */

    /// Every session this runtime currently manages, for the resource panel
    /// (T02, design §8).
    ///
    /// The list comes from the in-memory records rather than the database on
    /// purpose: those are exactly the sessions whose process this runtime owns
    /// and may therefore measure. A row for a session that some other runtime
    /// started has no pid we are allowed to sample.
    pub async fn managed_sessions(&self) -> Vec<ManagedSession> {
        let mut sessions: Vec<ManagedSession> = self
            .inner
            .records
            .read()
            .await
            .values()
            .map(|record| ManagedSession {
                session_id: record.id.clone(),
                session_key: record.key.to_string(),
                workspace_id: record.workspace_id.clone(),
                owner_node_id: record.owner_node_id.clone(),
                backend: record.kind,
                generation: record.generation,
                pid: record.pid,
                cwd: record.spec.cwd.clone(),
                executable: record.spec.executable(),
                exited: record.exited,
            })
            .collect();
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        sessions
    }

    /// Persistent backend sessions that are alive right now, by the backend's
    /// own handle. Empty when the effective backend has no such thing (a
    /// direct PTY dies with the runtime, so it can never be an orphan).
    pub async fn alive_backend_references(&self) -> Vec<BackendRef> {
        let Some(tmux) = self.inner.tmux.clone() else {
            return Vec::new();
        };
        tmux.list_alive().await.unwrap_or_default()
    }

    /// Destroy a persistent session by the backend's handle — the orphan case,
    /// where no session record points at it any more.
    pub async fn destroy_backend_reference(&self, reference: &str) -> AppResult<()> {
        let Some(tmux) = self.inner.tmux.clone() else {
            return Err(AppError::NotFound(
                "This runtime has no persistent terminal sessions".into(),
            ));
        };
        tmux.destroy_by_reference(reference).await
    }

    /* ------------------------------ termination --------------------------- */

    pub async fn terminate(&self, session_id: &str, mode: TerminateMode) -> AppResult<()> {
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.require(session_id).await?;
        let backend = self.backend(record.kind);
        let _ = sqlx::query("UPDATE terminal_sessions SET termination_intent = ? WHERE id = ?")
            .bind(mode.intent())
            .bind(session_id)
            .execute(&self.inner.pool)
            .await;
        if mode == TerminateMode::Interrupt {
            return backend.interrupt(&record.key).await;
        }
        // Marked before the kill: the exit that follows is this termination,
        // not an independent one, and must not overwrite it with `exited`.
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.exited = true;
        }
        backend.terminate_process(&record.key).await?;
        if mode == TerminateMode::Session {
            backend.destroy(&record.key).await?;
        }
        // The exit watcher would report `exited`; an explicit kill is recorded
        // as `terminated` and wins because the watcher only touches `running`.
        sqlx::query(
            "UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited', \
             ended_at = ? WHERE id = ? AND status = 'running'",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(session_id)
        .execute(&self.inner.pool)
        .await?;
        self.publish_status(session_id, "terminated", None).await;
        Ok(())
    }

    /// Every session of one workspace, killed and destroyed for good.
    ///
    /// `DELETE /api/workspaces/{id}` calls this before the row goes away.
    /// Deleting the workspace cascades the `terminal_sessions` rows out of the
    /// database, so anything still running — a direct PTY, or a tmux session
    /// that is designed to outlive us — would be left with nothing pointing at
    /// it. Hence `destroy`, not `terminate`: the session must not exist any
    /// more. Backend failures are ignored on purpose; a session we cannot
    /// reach is already gone as far as the removal is concerned.
    ///
    /// Returns the session ids it dealt with.
    pub async fn destroy_workspace(&self, workspace_id: &str) -> Vec<String> {
        // In-memory first (a session may have been spawned but not yet
        // reconciled), then the database (a session may have been left behind
        // by a previous run of the runtime).
        let mut ids: Vec<String> = self
            .inner
            .records
            .read()
            .await
            .values()
            .filter(|record| record.workspace_id == workspace_id)
            .map(|record| record.id.clone())
            .collect();
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, backend_ref FROM terminal_sessions WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_all(&self.inner.pool)
        .await
        .unwrap_or_default();
        let mut references: HashMap<String, Option<String>> = HashMap::new();
        for (id, reference) in rows {
            if !ids.contains(&id) {
                ids.push(id.clone());
            }
            references.insert(id, reference);
        }

        for session_id in &ids {
            if let Some(record) = self.record(session_id).await {
                let _key_guard = self.key_gate(&record.key).lock_owned().await;
                // Marked before the kill so the exit watcher reports this
                // teardown rather than an independent exit.
                if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
                    record.exited = true;
                }
                let backend = self.backend(record.kind);
                let _ = backend.terminate_process(&record.key).await;
                let _ = backend.destroy(&record.key).await;
                self.forget(session_id).await;
            } else if let Some(reference) = references.get(session_id).cloned().flatten()
                && let Some(tmux) = self.inner.tmux.as_ref()
            {
                // Not ours to attach to, but the tmux server still has it.
                let _ = tmux.destroy_by_reference(&reference).await;
            }
        }
        ids
    }

    /// Runtime shutdown. tmux sessions are left running on purpose: that is the
    /// whole point of the backend. Direct sessions cannot survive us.
    pub async fn shutdown_all(&self) {
        self.begin_shutdown();
        let _quiescent = self.inner.creation_gate.write().await;
        self.inner.direct.detach_all().await;
        if let Some(tmux) = self.inner.tmux.as_ref() {
            tmux.detach_all().await;
            let _ = sqlx::query(
                "UPDATE terminal_sessions SET attach_state = 'detached' \
                 WHERE backend_kind = 'tmux' AND attach_state = 'live' AND status = 'running'",
            )
            .execute(&self.inner.pool)
            .await;
        }
    }

    pub fn begin_shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::SeqCst)
    }

    /// Explicit desktop Quit, unlike a Runtime restart: stop all owned sessions.
    /// The caller bounds the entire operation and treats any error as failure.
    pub async fn shutdown_owned_sessions(&self) -> AppResult<()> {
        self.begin_shutdown();
        let _quiescent = self.inner.creation_gate.write().await;
        // Capture active history before teardown. Completed/failed sessions stay
        // unchanged even though a backend may retain their ended screen state.
        let mut failures = Vec::new();
        let running: std::collections::HashSet<String> = match sqlx::query_scalar::<_, String>(
            "SELECT id FROM terminal_sessions WHERE status = 'running'",
        )
        .fetch_all(&self.inner.pool)
        .await
        {
            Ok(ids) => ids.into_iter().collect(),
            Err(error) => {
                // Losing metadata must not prevent the owned process handles
                // from being stopped. Preserve the error as an incomplete quit.
                failures.push(format!("read terminal shutdown metadata: {error}"));
                Default::default()
            }
        };
        let records: Vec<SessionRecord> = self
            .inner
            .records
            .read()
            .await
            .values()
            .filter(|record| !record.exited && running.contains(&record.id))
            .cloned()
            .collect();
        // Both backends own sessions even if database insertion failed after
        // process creation; cleanup must enumerate their own registries as well.
        let direct = self.inner.direct.shutdown_owned_checked();
        let tmux = async {
            if let Some(tmux) = self.inner.tmux.as_ref() {
                tmux.shutdown_owned_checked().await
            } else {
                Ok(())
            }
        };
        let (direct, tmux) = tokio::join!(direct, tmux);
        if let Err(error) = direct {
            failures.push(format!("direct terminals: {error}"));
        }
        if let Err(error) = tmux {
            failures.push(format!("tmux terminals: {error}"));
        }
        if failures.is_empty() {
            for record in records {
                if let Some(stored) = self.inner.records.write().await.get_mut(&record.id) {
                    stored.exited = true;
                }
                match sqlx::query("UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited', termination_intent = 'session', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status IN ('running', 'exited')")
                    .bind(Utc::now().to_rfc3339()).bind(&record.id).execute(&self.inner.pool).await {
                    Ok(_) => self.publish_status(&record.id, "terminated", None).await,
                    Err(error) => failures.push(format!("persist terminal {} shutdown: {error}", record.id)),
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Internal(failures.join("; ")))
        }
    }

    async fn publish_status(&self, session_id: &str, status: &str, exit_code: Option<i64>) {
        if let Some(sender) = self.inner.statuses.read().await.get(session_id) {
            let _ = sender.send(StatusEvent {
                status: status.to_owned(),
                exit_code,
            });
        }
    }

    /* ----------------------------- reconciliation ------------------------- */

    /// Plan §15.2. Run once at startup, before the first request is served.
    pub async fn reconcile(&self) -> AppResult<gc::ReconcileReport> {
        let Some(tmux) = self.inner.tmux.clone() else {
            return Ok(gc::ReconcileReport::default());
        };
        tmux.adopt_server().await;
        let (report, adopted) = gc::reconcile(&self.inner.pool, tmux.as_ref()).await?;
        for (key, reference, generation) in adopted {
            tmux.adopt(&key, &reference, generation).await;
            if let Ok(session) =
                crate::db::get_terminal_session_by_key(&self.inner.pool, key.as_str()).await
            {
                let owner = session.owner_node_id.clone();
                let agent = session.agent_id.clone();
                self.remember(SessionRecord {
                    id: session.id.clone(),
                    key: key.clone(),
                    workspace_id: session.workspace_id.clone(),
                    owner_node_id: owner.clone(),
                    kind: BackendKind::Tmux,
                    generation,
                    pid: tmux.pane_pid(&key).await,
                    rows: DEFAULT_ROWS,
                    cols: DEFAULT_COLS,
                    exited: false,
                    input_revision: 0,
                    input_safety: InputSafety::default(),
                    last_input_source_revision: Some(0),
                    observation: None,
                    spec: TerminalSpec {
                        session_key: key.clone(),
                        workspace_id: session.workspace_id,
                        generation,
                        cwd: session.cwd,
                        shell: session.shell,
                        command: session.command,
                        args: Vec::new(),
                        env: with_utf8_locale(match (owner.as_deref(), agent.as_deref()) {
                            (Some(node), Some(agent)) => agent_environment(node, agent),
                            _ => Vec::new(),
                        }),
                        size: PtySize {
                            rows: DEFAULT_ROWS,
                            cols: DEFAULT_COLS,
                            pixel_width: 0,
                            pixel_height: 0,
                        },
                    },
                })
                .await;
            }
        }
        Ok(report)
    }

    /// One reclamation round (plan §15.6). Returns the sessions it destroyed.
    pub async fn sweep(&self) -> AppResult<Vec<String>> {
        if self.inner.tmux.is_none() {
            return Ok(Vec::new());
        }
        let grace = self.inner.settings.terminal().detached_grace_minutes;
        let rows = gc::attachable_rows(&self.inner.pool).await?;
        let candidates = gc::gc_candidates(&rows, Utc::now(), grace);
        let mut destroyed = Vec::new();
        for session_id in candidates {
            // Somebody may have attached between the query and now.
            if crate::db::terminal_attach_state(&self.inner.pool, &session_id)
                .await
                .as_deref()
                != Some("detached")
            {
                continue;
            }
            if let Some(record) = self.record(&session_id).await {
                let _ = self.backend(record.kind).destroy(&record.key).await;
                self.forget(&session_id).await;
            } else if let Ok(Some(reference)) =
                crate::db::terminal_backend_ref(&self.inner.pool, &session_id).await
                && let Some(tmux) = self.inner.tmux.as_ref()
            {
                let _ = tmux.destroy_by_reference(&reference).await;
            }
            let _ = sqlx::query(
                "UPDATE terminal_sessions SET attach_state = 'exited', \
                 status = CASE WHEN status = 'running' THEN 'exited' ELSE status END, \
                 ended_at = COALESCE(ended_at, ?) WHERE id = ?",
            )
            .bind(Utc::now().to_rfc3339())
            .bind(&session_id)
            .execute(&self.inner.pool)
            .await;
            destroyed.push(session_id);
        }
        Ok(destroyed)
    }

    async fn forget(&self, session_id: &str) {
        if let Some(record) = self.inner.records.write().await.remove(session_id) {
            self.inner.by_key.write().await.remove(&record.key);
        }
        self.inner.statuses.write().await.remove(session_id);
        self.forget_attachment(session_id);
    }

    /* ------------------------------ background ---------------------------- */

    fn spawn_notice_loop(&self, mut receiver: mpsc::UnboundedReceiver<backend::BackendNotice>) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut last_activity: HashMap<String, Instant> = HashMap::new();
            while let Some(notice) = receiver.recv().await {
                let Some(inner) = weak.upgrade() else { break };
                let manager = TerminalManager { inner };
                match notice {
                    backend::BackendNotice::Output {
                        session_key,
                        generation,
                        data,
                    } => {
                        manager
                            .on_output(&session_key, generation, &data, &mut last_activity)
                            .await;
                    }
                    backend::BackendNotice::Exited {
                        session_key,
                        generation,
                        exit_code,
                    } => {
                        manager.on_exit(&session_key, generation, exit_code).await;
                    }
                }
            }
        });
    }

    async fn on_output(
        &self,
        key: &SessionKey,
        generation: u64,
        data: &Bytes,
        last_activity: &mut HashMap<String, Instant>,
    ) {
        let Some(session_id) = self.inner.by_key.read().await.get(key).cloned() else {
            return;
        };
        let Some(record) = self.record(&session_id).await else {
            return;
        };
        if record.generation != generation {
            return;
        }
        // The tmux client stream is mostly redraws of a screen tmux already
        // keeps; only real process output is worth a log row.
        if record.kind == BackendKind::Direct {
            let redacted = redact_secrets(&String::from_utf8_lossy(data));
            let _ = sqlx::query("INSERT INTO terminal_logs (id, session_id, stream, content, created_at) VALUES (?, ?, 'stdout', ?, ?)")
                .bind(Uuid::now_v7().to_string())
                .bind(&session_id)
                .bind(redacted)
                .bind(Utc::now().to_rfc3339())
                .execute(&self.inner.pool)
                .await;
        }
        let fresh = last_activity
            .get(&session_id)
            .is_none_or(|seen| seen.elapsed() >= ACTIVITY_THROTTLE);
        if fresh {
            last_activity.insert(session_id.clone(), Instant::now());
            let _ = sqlx::query("UPDATE terminal_sessions SET last_output_at = ? WHERE id = ?")
                .bind(Utc::now().to_rfc3339())
                .bind(&session_id)
                .execute(&self.inner.pool)
                .await;
        }
    }

    async fn on_exit(&self, key: &SessionKey, generation: u64, exit_code: Option<i64>) {
        let Some(session_id) = self.inner.by_key.read().await.get(key).cloned() else {
            return;
        };
        let Some(record) = self.record(&session_id).await else {
            return;
        };
        if record.generation != generation || record.exited {
            return;
        }
        if let Some(record) = self.inner.records.write().await.get_mut(&session_id) {
            record.exited = true;
        }
        // `AND status = 'running'` keeps an explicit `terminated` from being
        // overwritten by the exit that follows it.
        let changed = sqlx::query(
            "UPDATE terminal_sessions SET status = 'exited', exit_code = ?, ended_at = ?, \
             attach_state = 'exited' WHERE id = ? AND status = 'running'",
        )
        .bind(exit_code)
        .bind(Utc::now().to_rfc3339())
        .bind(&session_id)
        .execute(&self.inner.pool)
        .await
        .is_ok_and(|result| result.rows_affected() == 1);
        if !changed {
            let _ = self.set_attach_state(&session_id, "exited").await;
            return;
        }
        self.publish_status(&session_id, "exited", exit_code).await;
        self.inner.events.publish(
            &record.workspace_id,
            WorkspaceEvent::TerminalExit {
                session_id,
                node_id: record.owner_node_id.clone(),
                exit_code,
            },
        );
    }

    /// tmux sessions can end while nothing is attached; nobody would notice
    /// until the next attach. One `list-sessions` covers every session at once.
    fn spawn_liveness_loop(&self) {
        if self.inner.tmux.is_none() {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(LIVENESS_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { break };
                let manager = TerminalManager { inner };
                let Some(tmux) = manager.inner.tmux.clone() else {
                    break;
                };
                let Ok(alive) = tmux.list_alive().await else {
                    continue;
                };
                let alive: std::collections::HashSet<String> =
                    alive.into_iter().map(|reference| reference.name).collect();
                let records: Vec<SessionRecord> = manager
                    .inner
                    .records
                    .read()
                    .await
                    .values()
                    .filter(|record| record.kind == BackendKind::Tmux && !record.exited)
                    .cloned()
                    .collect();
                for record in records {
                    let reference =
                        backend::session_name(&record.workspace_id, &record.key, record.generation);
                    if !alive.contains(&reference) {
                        manager.on_exit(&record.key, record.generation, None).await;
                    }
                }
            }
        });
    }

    fn spawn_sweeper(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(gc::SWEEP_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { break };
                let manager = TerminalManager { inner };
                match manager.sweep().await {
                    Ok(destroyed) if !destroyed.is_empty() => {
                        tracing::info!(count = destroyed.len(), "reclaimed detached terminals");
                    }
                    Err(error) => tracing::warn!(%error, "terminal sweep failed"),
                    _ => {}
                }
            }
        });
    }
}

/* --------------------------------- helpers -------------------------------- */

/// Guarantees the child sees a UTF-8 locale. GUI-launched runtimes (Tauri on
/// macOS, in particular) frequently start with no `LANG` at all; shells and
/// tmux then fall back to the C locale and mangle every multi-byte character.
pub fn with_utf8_locale(mut env: Vec<(String, String)>) -> Vec<(String, String)> {
    let is_utf8 = |value: &str| {
        let lower = value.to_ascii_lowercase();
        lower.contains("utf-8") || lower.contains("utf8")
    };
    let inherited_ok = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|key| std::env::var(key).map(|v| is_utf8(&v)).unwrap_or(false));
    let overridden = env
        .iter()
        .any(|(key, _)| key == "LANG" || key == "LC_ALL" || key == "LC_CTYPE");
    if !inherited_ok && !overridden {
        env.push(("LANG".to_owned(), "en_US.UTF-8".to_owned()));
        env.push(("LC_CTYPE".to_owned(), "en_US.UTF-8".to_owned()));
    }
    env
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Environment injected into an agent terminal (plan §5.2). Addresses only —
/// the per-node token lives in a 0600 file, never in the environment, because
/// any process of the same user can read another process' environment.
pub fn agent_environment(node_id: &str, agent_id: &str) -> Vec<(String, String)> {
    vec![
        ("ARMADRA_NODE_ID".to_owned(), node_id.to_owned()),
        ("ARMADRA_AGENT_ID".to_owned(), agent_id.to_owned()),
        (
            "ARMADRA_ENDPOINT_FILE".to_owned(),
            paths::hook_endpoint_file().to_string_lossy().into_owned(),
        ),
        ("ARMADRA_CANVAS_CONTROL".to_owned(), "1".to_owned()),
    ]
}

fn context_session_environment(
    mut env: Vec<(String, String)>,
    data_dir: &std::path::Path,
    session_id: &str,
    generation: u64,
) -> Vec<(String, String)> {
    env.retain(|(key, _)| key != "ARMADRA_SESSION_ID" && key != "ARMADRA_SESSION_GENERATION");
    if !env.iter().any(|(key, _)| key == "ARMADRA_NODE_ID") {
        return env;
    }
    if crate::context_usage::initialize_sequence(data_dir, session_id, generation).is_err() {
        // Telemetry failure never prevents a user's terminal from starting.
        return env;
    }
    env.push(("ARMADRA_SESSION_ID".into(), session_id.into()));
    env.push(("ARMADRA_SESSION_GENERATION".into(), generation.to_string()));
    env
}

/// Chunk-by-chunk UTF-8 decoding: a PTY read can end in the middle of a
/// multi-byte character, and `from_utf8_lossy` would turn that into a permanent
/// replacement character on screen.
#[derive(Default)]
pub struct Utf8Decoder {
    tail: Vec<u8>,
}

impl Utf8Decoder {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.tail.extend_from_slice(chunk);
        match std::str::from_utf8(&self.tail) {
            Ok(text) => {
                let text = text.to_owned();
                self.tail.clear();
                text
            }
            Err(error) => {
                let valid = error.valid_up_to();
                // An incomplete tail is held back; a genuinely invalid byte is
                // replaced so the stream cannot stall on it.
                let complete = String::from_utf8_lossy(&self.tail[..valid]).into_owned();
                let rest = self.tail.split_off(valid);
                self.tail = rest;
                if error.error_len().is_some() {
                    self.tail.remove(0);
                    return format!("{complete}\u{fffd}");
                }
                if self.tail.len() > 4 {
                    self.tail.clear();
                }
                complete
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests;

#[cfg(test)]
mod batch_tests {
    use super::*;

    /// Plan §18.3, "输出吞吐": below the byte budget nothing goes out on its
    /// own — the 16 ms timer is what releases it, and that is the batcher
    /// thread's job, not the buffer's.
    #[test]
    fn small_writes_accumulate_instead_of_becoming_one_frame_each() {
        let mut batch = OutputBatch::new();
        for _ in 0..100 {
            assert!(batch.push(b".").is_none());
        }
        assert!(!batch.is_empty());
        let flushed = batch.take().expect("a batch");
        assert_eq!(flushed.len(), 100);
        assert!(batch.is_empty());
        assert!(batch.take().is_none());
    }

    /// A flood does not wait for the timer: the batch goes out the moment it
    /// crosses 64 KiB, and the buffer starts over empty.
    #[test]
    fn the_byte_budget_flushes_without_waiting_for_the_timer() {
        let mut batch = OutputBatch::new();
        let block = vec![b'x'; 8 * 1024];
        let mut flushed = None;
        for _ in 0..8 {
            if let Some(ready) = batch.push(&block) {
                flushed = Some(ready);
            }
        }
        let flushed = flushed.expect("the eighth 8 KiB write reaches 64 KiB");
        assert_eq!(flushed.len(), OUTPUT_FLUSH_BYTES);
        assert!(batch.is_empty());
        assert!(batch.remaining().is_none());
    }

    /// Order is preserved across the batch boundary, and the deadline is armed
    /// by the first byte rather than by the most recent one.
    #[test]
    fn batches_preserve_order_and_arm_the_deadline_once() {
        let mut batch = OutputBatch::new();
        assert!(batch.remaining().is_none());
        assert!(batch.push(b"he").is_none());
        let first = batch.remaining().expect("armed");
        assert!(first <= OUTPUT_FLUSH_INTERVAL);
        assert!(batch.push(b"llo").is_none());
        assert!(batch.remaining().expect("still armed") <= first);
        assert_eq!(batch.take().unwrap().as_ref(), b"hello");
    }

    /// The batcher thread flushes what it has and only then reports EOF, so a
    /// process' last line can never arrive after its exit status.
    #[test]
    fn the_batcher_flushes_before_it_reports_eof() {
        use std::sync::{Arc, Mutex};

        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (done, wait) = std::sync::mpsc::channel::<()>();
        let sink = {
            let seen = seen.clone();
            move |chunk: Bytes| {
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&chunk).into_owned());
            }
        };
        let eof = {
            let seen = seen.clone();
            move || {
                seen.lock().unwrap().push("eof".to_owned());
                let _ = done.send(());
            }
        };

        let sender = spawn_output_batcher("test", interactive_cadence(), sink, eof);
        sender.send(Bytes::from_static(b"one")).unwrap();
        sender.send(Bytes::from_static(b"two")).unwrap();
        drop(sender);

        wait.recv_timeout(Duration::from_secs(5)).expect("eof");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.last().map(String::as_str), Some("eof"));
        assert_eq!(seen[..seen.len() - 1].concat(), "onetwo");
    }

    /// Dormancy widens the deadline; it never drops or reorders bytes. The byte
    /// budget still cuts a batch short, because a dormant session that suddenly
    /// produces a megabyte should not hold it all in one buffer.
    #[test]
    fn a_dormant_cadence_only_makes_the_batch_wait_longer() {
        let mut batch = OutputBatch::new();
        batch.push(b"quiet");
        let interactive = batch.remaining().expect("armed");
        assert!(interactive <= OUTPUT_FLUSH_INTERVAL);

        batch.set_flush_interval(DORMANT_FLUSH_INTERVAL);
        let dormant = batch.remaining().expect("still armed");
        assert!(
            dormant > OUTPUT_FLUSH_INTERVAL,
            "the deadline of the batch already in flight must move too"
        );
        assert!(dormant <= DORMANT_FLUSH_INTERVAL);

        // Narrowing again takes effect at once rather than at the next batch.
        batch.set_flush_interval(OUTPUT_FLUSH_INTERVAL);
        assert!(batch.remaining().expect("armed") <= OUTPUT_FLUSH_INTERVAL);

        let flooded = batch.push(&vec![b'x'; OUTPUT_FLUSH_BYTES]);
        assert!(flooded.is_some(), "the byte budget still applies");
        assert!(flooded.unwrap().starts_with(b"quiet"));
    }
}

#[cfg(all(test, unix))]
mod desktop_shutdown_tests {
    use super::*;

    async fn fixture(backend: &str) -> (TerminalManager, tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("quit.db").display()
        ))
        .await
        .unwrap();
        let workspace = crate::db::create_workspace(
            &pool,
            "keep project",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        let board: String = sqlx::query_scalar("SELECT id FROM boards WHERE workspace_id = ?")
            .bind(&workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO nodes(id, board_id, type, x, y, data_json, created_at, updated_at) VALUES ('keep-node', ?, 'sticky', 0, 0, '{}', 'now', 'now')").bind(board).execute(&pool).await.unwrap();
        let settings =
            SettingsStore::in_memory(serde_json::json!({"terminal":{"backend":backend}}));
        let manager = TerminalManager::with_config(
            pool,
            EventHub::new(),
            settings,
            directory.path().to_owned(),
        );
        (manager, directory, workspace.id)
    }

    fn request(workspace: &str, directory: &std::path::Path) -> SpawnRequest {
        let mut request =
            SpawnRequest::plain(workspace.into(), directory.to_string_lossy().into_owned());
        request.command = Some("/bin/sh".into());
        request.args = vec!["-c".into(), "sleep 60".into()];
        request
    }

    #[tokio::test]
    async fn desktop_shutdown_direct_process_exit_and_creation_gate() {
        let (manager, directory, workspace) = fixture("direct").await;
        let mut histories = Vec::new();
        for failed in [false, true] {
            let mut done = request(&workspace, directory.path());
            done.args = vec!["-c".into(), "exit 0".into()];
            let finished = manager.spawn(done).await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while manager.session(&finished.id).await.unwrap().status == "running" {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            if failed {
                sqlx::query("UPDATE terminal_sessions SET status = 'failed' WHERE id = ?")
                    .bind(&finished.id)
                    .execute(&manager.inner.pool)
                    .await
                    .unwrap();
            }
            let saved = manager.session(&finished.id).await.unwrap();
            histories.push((saved.id, saved.status, saved.ended_at, saved.exit_code));
        }
        let session = manager
            .spawn(request(&workspace, directory.path()))
            .await
            .unwrap();
        let gate = manager.inner.creation_gate.read().await;
        let worker = manager.clone();
        let shutdown = tokio::spawn(async move { worker.shutdown_owned_sessions().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !manager.is_shutting_down() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let worker = manager.clone();
        let next = request(&workspace, directory.path());
        let mut racing = tokio::spawn(async move { worker.spawn(next).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut racing)
                .await
                .is_err()
        );
        drop(gate);
        tokio::time::timeout(Duration::from_secs(7), shutdown)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(racing.await.unwrap(), Err(AppError::Conflict(_))));
        assert!(matches!(
            manager.recycle(&session.id).await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            manager.attach(&session.id, 80, 24).await,
            Err(AppError::Conflict(_))
        ));
        // Simulate an old connection's delayed detach after explicit shutdown.
        manager.set_attach_state(&session.id, "detached").await;
        assert_eq!(
            manager.session(&session.id).await.unwrap().attach_state,
            "exited"
        );
        assert!(!manager.is_alive(&session.id).await);
        assert_eq!(
            manager.session(&session.id).await.unwrap().status,
            "terminated"
        );
        let node: i64 = sqlx::query_scalar("SELECT count(*) FROM nodes WHERE id = 'keep-node'")
            .fetch_one(&manager.inner.pool)
            .await
            .unwrap();
        assert_eq!(node, 1);
        assert!(
            crate::db::get_workspace(&manager.inner.pool, &workspace)
                .await
                .is_ok()
        );
        for (id, status, ended_at, exit_code) in histories {
            let saved = manager.session(&id).await.unwrap();
            assert_eq!(
                (saved.status, saved.ended_at, saved.exit_code),
                (status, ended_at, exit_code),
                "Quit must not rewrite completed session history"
            );
        }
    }

    #[tokio::test]
    async fn desktop_shutdown_still_stops_owned_children_when_metadata_is_unavailable() {
        let (manager, directory, workspace) = fixture("direct").await;
        let session = manager
            .spawn(request(&workspace, directory.path()))
            .await
            .unwrap();
        let pid = manager.pid(&session.id).await.unwrap();
        manager.inner.pool.close().await;
        let result =
            tokio::time::timeout(Duration::from_secs(7), manager.shutdown_owned_sessions())
                .await
                .unwrap();
        assert!(
            result.is_err(),
            "failed metadata must not be reported as complete shutdown"
        );
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[tokio::test]
    async fn desktop_shutdown_tmux_preserves_on_restart_then_quit_removes_owned_session() {
        if !tmux::detect().usable {
            eprintln!("tmux unavailable; real tmux shutdown test skipped");
            return;
        }
        let (manager, directory, workspace) = fixture("tmux").await;
        let session = manager
            .spawn(request(&workspace, directory.path()))
            .await
            .unwrap();
        assert_eq!(session.backend, "tmux");
        let backend = manager.inner.tmux.as_ref().unwrap();
        let before = backend.list_alive().await.unwrap();
        assert_eq!(before.len(), 1);
        manager.shutdown_all().await;
        assert_eq!(
            backend.list_alive().await.unwrap().len(),
            1,
            "ordinary Runtime restart preserves tmux"
        );
        tokio::time::timeout(Duration::from_secs(7), manager.shutdown_owned_sessions())
            .await
            .unwrap()
            .unwrap();
        assert!(backend.list_alive().await.unwrap().is_empty());
        assert_eq!(
            manager.session(&session.id).await.unwrap().status,
            "terminated"
        );
        assert!(
            crate::db::get_workspace(&manager.inner.pool, &workspace)
                .await
                .is_ok()
        );
    }
}

/// T03, design §7.2: a session nothing is attached to keeps its process and
/// its replay buffer, and gives up only the delivery cadence.
#[cfg(all(test, unix))]
mod dormancy_tests {
    use super::*;

    async fn fixture(dormant_after: u64) -> (TerminalManager, tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("dormancy.db").display()
        ))
        .await
        .unwrap();
        let workspace = crate::db::create_workspace(
            &pool,
            "dormancy project",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        let settings = SettingsStore::in_memory(serde_json::json!({
            "terminal": { "backend": "direct", "dormantAfterSeconds": dormant_after }
        }));
        let manager = TerminalManager::with_config(
            pool,
            EventHub::new(),
            settings,
            directory.path().to_owned(),
        );
        (manager, directory, workspace.id)
    }

    fn request(workspace: &str, directory: &std::path::Path) -> SpawnRequest {
        let mut request =
            SpawnRequest::plain(workspace.into(), directory.to_string_lossy().into_owned());
        request.command = Some("/bin/sh".into());
        request.args = vec!["-c".into(), "sleep 60".into()];
        request
    }

    /// The whole promise in one test: a session goes dormant on its own, wakes
    /// on attach, and is the *same process* on the other side.
    #[tokio::test]
    async fn an_unwatched_session_sleeps_and_wakes_without_restarting_its_process() {
        let (manager, directory, workspace) = fixture(5).await;
        let session = manager
            .spawn(request(&workspace, directory.path()))
            .await
            .unwrap();
        let pid = manager.pid(&session.id).await.expect("a running pid");

        // Freshly created and never attached: eligible, but not yet due.
        manager.apply_dormancy().await;
        assert!(!manager.is_dormant(&session.id));

        // Pretend the idle period has passed rather than sleeping through it.
        manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
        manager.apply_dormancy().await;
        assert!(manager.is_dormant(&session.id));

        let attach = manager.attach(&session.id, 80, 24).await.unwrap();
        assert!(
            !manager.is_dormant(&session.id),
            "attaching wakes the session"
        );
        assert_eq!(manager.attached_sockets(&session.id), 1);
        assert_eq!(
            manager.pid(&session.id).await,
            Some(pid),
            "waking must never be a create"
        );
        assert!(attach.alive);

        drop(attach);
        assert_eq!(manager.attached_sockets(&session.id), 0);
        // Still awake: the clock restarts from this detach, not from the last one.
        manager.apply_dormancy().await;
        assert!(!manager.is_dormant(&session.id));

        let _ = manager.terminate(&session.id, TerminateMode::Session).await;
    }

    /// Two sockets on one terminal: the first to leave must not put a session
    /// somebody else is still watching to sleep.
    #[tokio::test]
    async fn one_socket_leaving_does_not_sleep_a_session_another_is_watching() {
        // Below MIN_DORMANT_AFTER_SECONDS the setting is rejected, so the
        // shortest honest deadline is what the test drives.
        let (manager, directory, workspace) = fixture(5).await;
        let session = manager
            .spawn(request(&workspace, directory.path()))
            .await
            .unwrap();
        let first = manager.attach(&session.id, 80, 24).await.unwrap();
        let second = manager.attach(&session.id, 80, 24).await.unwrap();
        assert_eq!(manager.attached_sockets(&session.id), 2);

        drop(first);
        manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
        manager.apply_dormancy().await;
        assert!(
            !manager.is_dormant(&session.id),
            "one socket is still attached"
        );

        drop(second);
        manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
        manager.apply_dormancy().await;
        assert!(manager.is_dormant(&session.id));

        let _ = manager.terminate(&session.id, TerminateMode::Session).await;
    }

    /// `dormantAfterSeconds: 0` is off, not "immediately".
    #[tokio::test]
    async fn dormancy_can_be_turned_off() {
        let (manager, directory, workspace) = fixture(0).await;
        let session = manager
            .spawn(request(&workspace, directory.path()))
            .await
            .unwrap();
        manager.backdate_idle_for_test(&session.id, Duration::from_secs(86_400));
        manager.apply_dormancy().await;
        assert!(!manager.is_dormant(&session.id));
        let _ = manager.terminate(&session.id, TerminateMode::Session).await;
    }

    /// A session that has already ended is not worth a backend round trip, and
    /// must not linger in the attachment table.
    #[tokio::test]
    async fn an_exited_session_is_dropped_instead_of_slept() {
        // Below MIN_DORMANT_AFTER_SECONDS the setting is rejected, so the
        // shortest honest deadline is what the test drives.
        let (manager, directory, workspace) = fixture(5).await;
        let mut done = request(&workspace, directory.path());
        done.args = vec!["-c".into(), "exit 0".into()];
        let session = manager.spawn(done).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while manager.session(&session.id).await.unwrap().status == "running" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
        manager.apply_dormancy().await;
        assert!(!manager.is_dormant(&session.id));
        assert_eq!(manager.attached_sockets(&session.id), 0);
    }
}
