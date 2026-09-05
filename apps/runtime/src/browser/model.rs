//! The domain types a browser session is described with.
//!
//! Everything here is plain data with a `camelCase` JSON shape that matches
//! `proto/armadra/v1/browser.proto` field for field, so the same session can
//! be read over loopback JSON today and over Protobuf from another device
//! without a second vocabulary.

use serde::{Deserialize, Serialize};

use super::Availability;

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<BrowserSession>,
    pub availability: Availability,
}

/* ------------------------------- ring buffers ------------------------------ */

/// How many console and network entries one session remembers. Bounded on
/// purpose: a page that logs in a loop must not be able to grow the Runtime.
pub const RING_CAPACITY: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub at: String,
    pub level: String,
    pub text: String,
    pub url: String,
    pub line: u32,
}

/// A request summary. Deliberately no headers and no body: design §6 keeps
/// sensitive material out of the debugging surface by not collecting it,
/// rather than by collecting it and hoping the redaction is complete.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEntry {
    pub at: String,
    pub method: String,
    pub url: String,
    pub status: u32,
    pub mime_type: String,
    pub encoded_bytes: u64,
    pub failure_code: String,
    pub from_cache: bool,
}

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
}

/* --------------------------------- reads ---------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadMode {
    Text,
    Elements,
    Links,
    Title,
    Console,
    Network,
}

impl ReadMode {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "text" => Self::Text,
            "elements" => Self::Elements,
            "links" => Self::Links,
            "title" => Self::Title,
            "console" => Self::Console,
            "network" => Self::Network,
            _ => return None,
        })
    }

    pub const NAMES: &'static [&'static str] =
        &["text", "elements", "links", "title", "console", "network"];
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    /// `e<navigationEpoch>-<index>`. Bound to the epoch it was read in, so a
    /// reference that survived a navigation is refused rather than resolved
    /// against a different document (design §7).
    pub element_ref: String,
    pub role: String,
    pub name: String,
    pub value: String,
    pub selector: String,
    pub visible: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponse {
    pub session_id: String,
    pub navigation_epoch: u64,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    pub elements: Vec<Element>,
    pub console: Vec<ConsoleEntry>,
    pub network: Vec<NetworkEntry>,
    pub truncated: bool,
}

/// Byte budget for a page-text read. Same number as a linked-node file read,
/// so an agent's context budget behaves the same wherever the text came from.
pub const MAX_TEXT_BYTES: usize = 200 * 1024;
pub const MAX_ELEMENTS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    /// Workspace-relative, under `.armadra/`. Never an absolute host path.
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub bytes: u64,
    pub navigation_epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitOutcome {
    pub matched: bool,
    pub reason_code: String,
    pub navigation_epoch: u64,
    pub waited_ms: u32,
}

/* ------------------------------- subscriptions ----------------------------- */

/// How much picture a subscriber wants. `Hidden` still holds the session open
/// — an occluded node must not kill a page an agent is driving (design §9) —
/// but produces no frames at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Hidden,
    Visible,
    Focused,
}

impl Visibility {
    /// Quality, `everyNthFrame` and the frame ceiling the Worker itself
    /// enforces. The last number is real: frames arriving faster are dropped
    /// after being acknowledged, so the reported `maxFps` is not advisory.
    pub fn budget(self) -> (u32, u32, u32) {
        match self {
            Self::Focused => (65, 1, 15),
            Self::Visible => (40, 2, 5),
            Self::Hidden => (0, 0, 0),
        }
    }
}

/// A subscription lapses after this long; the canvas renews while the node is
/// mounted. Two missed renewals of slack at the client's usual cadence.
pub const SUBSCRIPTION_TTL_SECONDS: i64 = 15;
/// Above this, a session refuses new subscriptions rather than growing.
pub const MAX_SUBSCRIPTIONS: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub subscription_id: String,
    pub expires_at: String,
    pub quality: u32,
    pub max_fps: u32,
}
