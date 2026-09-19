//! The domain types a browser session is described with.
//!
//! Everything here is plain data with a `camelCase` JSON shape that matches
//! `proto/armadra/v1/browser.proto` field for field, so the same session can
//! be read over loopback JSON today and over Protobuf from another device
//! without a second vocabulary.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Starting,
    Ready,
    /// The browser went away but the session is still supposed to exist. The
    /// row and the profile survive, so it can be relaunched.
    Disconnected,
    Terminated,
    /// No usable browser on this execution host.
    Unsupported,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Disconnected => "disconnected",
            Self::Terminated => "terminated",
            Self::Unsupported => "unsupported",
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        match value {
            "ready" => Self::Ready,
            "starting" => Self::Starting,
            "terminated" => Self::Terminated,
            "unsupported" => Self::Unsupported,
            _ => Self::Disconnected,
        }
    }
}

/// CSS pixels. The canvas scales the picture inside its shape; it never writes
/// its own zoom into the page viewport (design §8).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    #[serde(default = "one")]
    pub device_scale_factor: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            width: 1024,
            height: 768,
            device_scale_factor: 1.0,
        }
    }
}

impl Viewport {
    /// A viewport the client asked for, clamped to something a browser can
    /// actually be told to render.
    pub fn clamped(self) -> Self {
        Self {
            width: self.width.clamp(MIN_VIEWPORT, MAX_VIEWPORT),
            height: self.height.clamp(MIN_VIEWPORT, MAX_VIEWPORT),
            device_scale_factor: if self.device_scale_factor.is_finite() {
                self.device_scale_factor.clamp(0.5, 3.0)
            } else {
                1.0
            },
        }
    }
}

pub const MIN_VIEWPORT: u32 = 200;
pub const MAX_VIEWPORT: u32 = 4_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub session_id: String,
    pub generation: u64,
    pub workspace_id: String,
    pub node_id: String,
    pub url: String,
    pub title: String,
    pub viewport: Viewport,
    pub state: SessionState,
    /// Stable machine code, localized by the client. Empty when nothing is
    /// wrong.
    pub reason_code: String,
    pub navigation_epoch: u64,
    pub headful: bool,
    pub keep_alive: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Who may drive this session right now (§2.6). Reads never consult it.
    pub lease: Lease,
    /// The stored counter the lease's generation continues from, so a client
    /// that slept through a Runtime restart cannot present a generation that
    /// has come back around to being current.
    pub lease_generation: u64,
    /// The tab every unaddressed action lands on, and how many there are
    /// (§2.2). A session that has never seen a second tab still reports its
    /// one, so a client never has to guess what "the page" means.
    pub active_tab_id: String,
    pub tab_count: u32,
    /// Set while a tab of this session is blocked in `alert` / `confirm` /
    /// `prompt` / `beforeunload`. Input aimed at that tab is refused with
    /// `DIALOG_PENDING` until somebody answers it (§2.4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_dialog: Option<Dialog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_file_chooser: Option<FileChooser>,
}

/* ----------------------------- tabs and frames ----------------------------- */

/// The tab id every action addresses. Runtime's own ordinal — the CDP
/// `targetId` is deliberately never handed out, because a caller that could
/// name one could address targets this module does not model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    /// Set when the page opened this tab itself, so a popup shows as one.
    pub opener_tab_id: String,
    pub navigation_epoch: u64,
    pub loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_dialog: Option<Dialog>,
    /// The tab's icon as a `data:` URL, or empty (§2.8).
    ///
    /// Resolved inside the controlled browser rather than handed out as a URL
    /// for each client to fetch. A tab strip that fetched icons itself would
    /// send every site a request from the *viewer's* browser and cookies —
    /// from a phone on the far side of the Host, no less — while the session
    /// that is actually visiting the site sits right here.
    pub favicon: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabList {
    pub tabs: Vec<Tab>,
    pub active_tab_id: String,
    pub limit: u32,
}

/* --------------------------------- dialogs --------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt,
    /// Never auto-accepted: whether leaving a page loses a form is a decision
    /// for a person (§2.4).
    #[serde(rename = "beforeunload")]
    BeforeUnload,
}

impl DialogKind {
    pub fn parse(value: &str) -> Self {
        match value {
            "confirm" => Self::Confirm,
            "prompt" => Self::Prompt,
            "beforeunload" => Self::BeforeUnload,
            _ => Self::Alert,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alert => "alert",
            Self::Confirm => "confirm",
            Self::Prompt => "prompt",
            Self::BeforeUnload => "beforeunload",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dialog {
    pub dialog_id: String,
    pub tab_id: String,
    pub kind: DialogKind,
    pub message: String,
    pub default_prompt: String,
    pub url: String,
    pub opened_at: String,
}

/// A file chooser the page opened and nobody has answered yet. `accept` is
/// the page's hint for the picker, never a filter this side enforces.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChooser {
    pub chooser_id: String,
    pub tab_id: String,
    pub frame_id: String,
    pub multiple: bool,
    pub accept: String,
    pub opened_at: String,
}

/* ---------------------------------- lease --------------------------------- */

/// Who is allowed to drive the page. One session, one holder (§2.6).
///
/// `HumanTakeover` is not merely "a human with a longer lease": it is the
/// state a person enters deliberately, and it revokes the agent's lease
/// instead of making the agent wait. That difference is the whole reason
/// there are two human states rather than one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LeaseState {
    Free,
    Human,
    HumanTakeover,
    Agent,
}

impl LeaseState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Human => "human",
            Self::HumanTakeover => "humanTakeover",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseHolder {
    /// `human` or `agent`.
    pub kind: &'static str,
    /// A viewer's own opaque id, or an agent's node id. Never an
    /// authenticated identity — the Host authenticates the device and does
    /// not forward that identity — so it only ever tells holders apart.
    pub id: String,
    pub display_name: String,
}

/// The lease as every client sees it. Matches `BrowserLease` in
/// `browser.proto` field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub state: LeaseState,
    pub generation: u64,
    /// RFC 3339, or empty when the state does not lapse on its own: a
    /// takeover is held until the person hands it back.
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder: Option<LeaseHolder>,
}

impl Lease {
    pub fn free(generation: u64) -> Self {
        Self {
            state: LeaseState::Free,
            generation,
            expires_at: String::new(),
            holder: None,
        }
    }
}

impl Default for Lease {
    fn default() -> Self {
        Self::free(0)
    }
}

/// One line of "who did what to this page" for the node header (§2.8).
///
/// Only the last few are kept, in memory. The durable record stays the board
/// log, which every agent action already writes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub session_id: String,
    /// `human` or `agent`.
    pub actor: &'static str,
    pub actor_id: String,
    pub verb: String,
    pub target: String,
    /// `ok`, `refused`, or `unknown` — the last for an action that was
    /// dispatched and then had its lease revoked. It is never retried.
    pub outcome: &'static str,
    pub reason_code: String,
    pub at: String,
}

/// How many activity lines one session remembers (§2.8).
pub const ACTIVITY_CAPACITY: usize = 20;

/* -------------------------------- downloads ------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadState {
    /// Staged outside the project and waiting for a human. Nothing has been
    /// written into the workspace's download directory yet.
    Pending,
    InProgress,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub download_id: String,
    pub session_id: String,
    pub url: String,
    pub suggested_filename: String,
    pub state: DownloadState,
    /// Workspace-relative, and only set once the download was accepted.
    pub path: String,
    pub total_bytes: u64,
    pub received_bytes: u64,
    pub created_at: String,
    pub reason_code: String,
    /// Which tab produced it. Downloads are collected browser-wide, so this is
    /// the only thing that says where one came from (§2.3).
    pub tab_id: String,
    /// Only computable once the transfer finished, so an in-flight download
    /// carries an empty digest rather than a wrong one.
    pub sha256: String,
}
