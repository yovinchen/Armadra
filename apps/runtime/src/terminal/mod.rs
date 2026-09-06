//! Terminal sessions: selection between the tmux and direct backends, the
//! database mirror of every session, and the lifecycle the API layer talks to.
//!
//! Plan §15. The API layer never touches a backend: it asks the
//! [`TerminalManager`] for a session, an attachment, a capture or a
//! termination, and the manager decides which backend owns the key, whether the
//! caller's generation is still current, and what the database should say.

mod attachments;
pub mod backend;
mod batch;
pub mod bridge;
pub mod direct;
pub mod gc;
mod input;
mod observation;
mod reconcile;
mod records;
mod session;
#[cfg(windows)]
pub mod session_host;
pub mod ssh;
#[cfg(test)]
mod tests;
pub mod tmux;

pub use batch::{FlushCadence, OutputBatch, interactive_cadence, spawn_output_batcher};
use input::InputSafety;
use records::SessionRecord;
pub use records::{
    AgentObservation, AgentReport, AttachSession, BackendInfo, CaptureResponse, ClientMessage,
    GuardedPasteOutcome, PromptTurn, SpawnRequest, StatusEvent, TerminateMode,
};

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

struct Inner {
    shutting_down: AtomicBool,
    creation_gate: RwLock<()>,
    pool: SqlitePool,
    events: EventHub,
    settings: SettingsStore,
    data_dir: PathBuf,
    direct: Arc<direct::DirectBackend>,
    tmux: Option<Arc<tmux::TmuxBackend>>,
    /// Windows only (T01). `None` everywhere else, and also on Windows when
    /// the host could not be reached — in which case `reason` says so and the
    /// effective backend is honestly `direct`, not a session host that is not
    /// there.
    #[cfg(windows)]
    session_host: Option<Arc<session_host::SessionHostBackend>>,
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
    /// `session id -> writer id -> highest input id actually written`.
    ///
    /// A client that loses its socket cannot tell whether the keystrokes it had
    /// sent reached the pty. This is the answer: on the next attach it asks
    /// what its own writer already reached, and resends only what is above that
    /// mark. Nothing here authorizes anything — a writer id is a client's own
    /// label for its input stream, checked against nothing, and the worst a
    /// forged one can do is make that client resend its own keystrokes.
    input_acks: RwLock<HashMap<String, HashMap<String, u64>>>,
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

/// How many independent writers one session remembers. A terminal has one
/// keyboard; the extra room is for a reconnect that overlaps its predecessor.
/// Past it the session forgets them all, which costs a client at most one
/// unnecessary resend of input it already knows was never acknowledged.
const MAX_TRACKED_WRITERS: usize = 8;

/// Replaces the old `PtyManager`. Cheap to clone; the background tasks hold a
/// weak reference so dropping the last clone stops them.
#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

/// A backend that can take a session it finds at startup back under
/// management, and say what pid is behind it.
///
/// Not part of [`TerminalBackend`]: only a backend whose sessions outlive the
/// runtime has anything to adopt, and a default implementation on the trait
/// would invite the other two to pretend they do.
#[async_trait::async_trait]
trait Adoptable {
    async fn adopt(&self, key: &SessionKey, reference: &str, generation: u64) -> Option<i64>;
}

#[async_trait::async_trait]
impl Adoptable for tmux::TmuxBackend {
    async fn adopt(&self, key: &SessionKey, reference: &str, generation: u64) -> Option<i64> {
        tmux::TmuxBackend::adopt(self, key, reference, generation).await;
        self.pane_pid(key).await
    }
}

#[cfg(windows)]
#[async_trait::async_trait]
impl Adoptable for session_host::SessionHostBackend {
    async fn adopt(&self, key: &SessionKey, reference: &str, generation: u64) -> Option<i64> {
        session_host::SessionHostBackend::adopt(self, key, reference, generation).await
    }
}

fn merge(left: gc::ReconcileReport, right: gc::ReconcileReport) -> gc::ReconcileReport {
    gc::ReconcileReport {
        detached: left.detached + right.detached,
        exited: left.exited + right.exited,
        orphans_destroyed: left.orphans_destroyed + right.orphans_destroyed,
    }
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
            BackendChoice::SessionHost => false,
            // On Windows `auto` never means tmux: tmux there is an MSYS
            // compatibility layer between Win32 CLIs and a Unix pty, and the
            // session host is the native answer. Asking for it explicitly
            // still works.
            BackendChoice::Auto if cfg!(windows) => false,
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

        // T01: Windows sessions belong to `armadra-session-host` unless the
        // user explicitly asked for something else. The connection is lazy —
        // see `SessionHostBackend::new` — so a host that cannot start becomes
        // a visible error on the first terminal rather than a silent downgrade
        // to sessions that die with this process.
        #[cfg(windows)]
        let session_host = match configured {
            BackendChoice::Direct => None,
            BackendChoice::Tmux if tmux.is_some() => None,
            _ => Some(Arc::new(session_host::SessionHostBackend::new(
                &data_dir,
                notices.clone(),
            ))),
        };

        #[cfg(windows)]
        let effective = if session_host.is_some() {
            BackendKind::SessionHost
        } else if tmux.is_some() {
            BackendKind::Tmux
        } else {
            BackendKind::Direct
        };
        #[cfg(not(windows))]
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
            #[cfg(windows)]
            session_host,
            detection,
            configured,
            effective,
            reason,
            records: RwLock::new(HashMap::new()),
            by_key: RwLock::new(HashMap::new()),
            key_gates: std::sync::Mutex::new(HashMap::new()),
            statuses: RwLock::new(HashMap::new()),
            attachments: std::sync::Mutex::new(HashMap::new()),
            input_acks: RwLock::new(HashMap::new()),
        });
        let manager = Self { inner };
        manager.spawn_notice_loop(notice_receiver);
        manager.spawn_liveness_loop();
        manager.spawn_dormancy_loop();
        manager.spawn_sweeper();
        manager
    }

    fn backend(&self, kind: BackendKind) -> Arc<dyn TerminalBackend> {
        #[cfg(windows)]
        if kind == BackendKind::SessionHost
            && let Some(host) = self.inner.session_host.as_ref()
        {
            return host.clone() as Arc<dyn TerminalBackend>;
        }
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
