//! The request, event and record shapes the API layer exchanges with the
//! terminal manager.

use super::*;

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
    pub(super) fn intent(self) -> &'static str {
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
        /// Monotonic per writer, acknowledged once the bytes reach the pty.
        /// Absent from a client that does not track its own input.
        #[serde(default, rename = "inputId")]
        input_id: Option<u64>,
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
pub(super) struct SessionRecord {
    pub(super) id: String,
    pub(super) key: SessionKey,
    pub(super) workspace_id: String,
    pub(super) owner_node_id: Option<String>,
    pub(super) kind: BackendKind,
    pub(super) generation: u64,
    pub(super) pid: Option<i64>,
    pub(super) rows: u16,
    pub(super) cols: u16,
    pub(super) exited: bool,
    /// Kept so `recycle` can restart the same terminal, environment included.
    pub(super) spec: TerminalSpec,
    pub(super) input_revision: u64,
    pub(super) input_safety: InputSafety,
    pub(super) last_input_source_revision: Option<u64>,
    pub(super) observation: Option<AgentObservation>,
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

/// What a delivered prompt's turn can be said to have done. Deliberately not a
/// success/failure pair: "we cannot tell whose turn that was" is its own answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTurn {
    /// The Agent has not finished a turn since the paste.
    Pending,
    /// A turn finished and no other input could have produced it.
    Completed,
    /// Input arrived after ours, so no later turn belongs to this delivery.
    Unattributable,
    /// The session ended or was replaced before any turn finished.
    SessionGone,
}
