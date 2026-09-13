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

/// Per-session ceiling. A page that opens more gets `tab_limit` rather than an
/// unbounded fan of renderers (§2.2).
pub const MAX_TABS: usize = 16;

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

/// Where an action lands. Both halves empty means the active tab's main
/// frame, which is what every caller written before tabs existed meant.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRef {
    #[serde(default)]
    pub tab_id: String,
    #[serde(default)]
    pub frame_id: String,
}

impl TargetRef {
    pub fn is_default(&self) -> bool {
        self.tab_id.is_empty() && self.frame_id.is_empty()
    }
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

/// How long an unanswered dialog blocks its tab before it is dismissed and
/// the reason written to the console (§2.4).
pub const DIALOG_TIMEOUT_SECONDS: u64 = 120;

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

/// A chooser nobody answers is filled with nothing rather than left holding
/// the page open forever (§2.3).
pub const FILE_CHOOSER_TIMEOUT_SECONDS: u64 = 60;

/// Most files one `upload` may name.
pub const MAX_UPLOAD_FILES: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<BrowserSession>,
    pub availability: Availability,
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
    /// Which tab produced it. Downloads are collected browser-wide, so this is
    /// the only thing that says where one came from (§2.3).
    pub tab_id: String,
    /// Only computable once the transfer finished, so an in-flight download
    /// carries an empty digest rather than a wrong one.
    pub sha256: String,
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
    /// Which tab and frame the reference is bound to. Empty means the active
    /// tab's main frame, which is what an unaddressed read produced.
    pub tab_id: String,
    pub frame_id: String,
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
    /// The LAN budget, which is what a node on the same machine gets.
    /// Kept as a method because everything that is not a link-quality
    /// decision still asks a `Visibility` what it wants.
    pub fn budget(self) -> (u32, u32, u32) {
        let budget = Budget::of(self, BandwidthClass::Lan);
        (budget.quality, budget.every_nth, budget.max_fps)
    }
}

/// How much link there is between one subscriber and this session (§2.9).
///
/// The subscriber says what it can afford; the Worker decides the budget and
/// reports back what it settled on, so a phone shows the degradation rather
/// than assuming it did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BandwidthClass {
    #[default]
    Lan,
    Wan,
    Metered,
}

/// How a frame's bytes are encoded (§2.9).
///
/// Chrome's protocol dump lists only `jpeg` and `png` for
/// `Page.startScreencast`, but a real Chrome 152 answers `format: "webp"` with
/// genuine VP8 WebP — verified against a live browser, and re-checked at
/// runtime because a build that refuses it must not cost anyone their picture.
/// PNG is not offered: a lossless screenshot of a web page is several times a
/// JPEG of it, which is the wrong direction for every link class in the table
/// below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameEncoding {
    #[default]
    Jpeg,
    Webp,
}

impl FrameEncoding {
    /// What the bytes themselves are, from their magic number.
    ///
    /// Chrome keeps delivering frames of the old format for a moment after a
    /// screencast restarts in another one, so labelling by "what the stream
    /// is running" is wrong exactly while a viewer is being switched over.
    /// JPEG opens with `FF D8`; WebP is a RIFF container whose form type is
    /// `WEBP`. Anything else is left to the caller's word.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0xff, 0xd8]) {
            Some(Self::Jpeg)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }

    /// What Chrome is told, and what the frame says it is.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }

    /// The quality to ask for at a given JPEG quality.
    ///
    /// WebP's scale is not JPEG's: the same number is a visibly better and
    /// distinctly larger picture, which would spend the saving on quality
    /// nobody asked for. The shift is the configurable part
    /// (`ARMADRA_BROWSER_WEBP_QUALITY_SHIFT`, default 10) because the right
    /// trade differs between a LAN desktop and a metered phone, and because a
    /// number nobody can change is a number nobody can measure.
    pub fn quality_from(self, jpeg_quality: u32) -> u32 {
        match self {
            Self::Jpeg => jpeg_quality,
            Self::Webp => jpeg_quality.saturating_sub(webp_quality_shift()).max(5),
        }
    }
}

/// How far below the JPEG quality WebP is asked to sit. Read once per call
/// rather than cached: it is only read when a screencast starts.
fn webp_quality_shift() -> u32 {
    std::env::var("ARMADRA_BROWSER_WEBP_QUALITY_SHIFT")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .map(|shift| shift.min(50))
        .unwrap_or(10)
}

/// What one subscriber is actually served.
///
/// `max_fps` is real rather than advisory: frames arriving faster are dropped
/// after being acknowledged. `max_width` of zero means "no ceiling", which is
/// not the same as a ceiling of zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub quality: u32,
    /// The design §2.9 thinning factor. It is *not* handed to Chrome's
    /// `everyNthFrame`, which counts repaints rather than time and therefore
    /// swallows the last frame of a click; the thinning happens per
    /// subscriber, where the newest frame always survives. Kept because it is
    /// what makes one class's budget wider than another's.
    pub every_nth: u32,
    pub max_fps: u32,
    pub max_width: u32,
}

impl Budget {
    pub const NOTHING: Self = Self {
        quality: 0,
        every_nth: 0,
        max_fps: 0,
        max_width: 0,
    };

    /// The table in design §2.9. A hidden subscriber gets nothing at all in
    /// every class — it still holds the session open, it just costs no frames.
    pub fn of(visibility: Visibility, bandwidth: BandwidthClass) -> Self {
        let (quality, every_nth, max_fps, max_width) = match (visibility, bandwidth) {
            (Visibility::Hidden, _) => return Self::NOTHING,
            (Visibility::Focused, BandwidthClass::Lan) => (65, 1, 15, 0),
            (Visibility::Visible, BandwidthClass::Lan) => (40, 2, 5, 0),
            (Visibility::Focused, BandwidthClass::Wan) => (50, 2, 8, 1_280),
            (Visibility::Visible, BandwidthClass::Wan) => (35, 3, 3, 1_280),
            (Visibility::Focused, BandwidthClass::Metered) => (45, 3, 4, 960),
            // Design §2.9 pins only the focused row for a metered link; a
            // visible one gets the WAN cadence under the metered ceiling.
            (Visibility::Visible, BandwidthClass::Metered) => (35, 3, 3, 960),
        };
        Self {
            quality,
            every_nth,
            max_fps,
            max_width,
        }
    }

    /// The subscriber's own ceiling, applied on top of its class. A client
    /// that asks for less gets less; it can never ask for more.
    pub fn with_client_ceiling(mut self, requested: u32) -> Self {
        if requested > 0 {
            self.max_width = match self.max_width {
                0 => requested,
                current => current.min(requested),
            };
        }
        self
    }

    /// The one screencast the page can run has to satisfy the most demanding
    /// subscriber; every other one is thinned down from it per frame.
    pub fn widen(self, other: Self) -> Self {
        if other == Self::NOTHING {
            return self;
        }
        if self == Self::NOTHING {
            return other;
        }
        Self {
            quality: self.quality.max(other.quality),
            every_nth: self.every_nth.min(other.every_nth).max(1),
            max_fps: self.max_fps.max(other.max_fps),
            // Zero is "no ceiling", so it wins over any number.
            max_width: match (self.max_width, other.max_width) {
                (0, _) | (_, 0) => 0,
                (left, right) => left.max(right),
            },
        }
    }
}

/// A subscription lapses after this long; the canvas renews while the node is
/// mounted. Two missed renewals of slack at the client's usual cadence.
pub const SUBSCRIPTION_TTL_SECONDS: i64 = 15;
/// Above this, a session refuses new subscriptions rather than growing.
pub const MAX_SUBSCRIPTIONS: usize = 16;
/// Frames a subscriber may leave unacknowledged before it starts being
/// skipped rather than queued behind (§2.9). Every subscriber is counted on
/// its own, so a slow phone does not hold up a desktop node.
pub const MAX_UNACKED_FRAMES: u64 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub subscription_id: String,
    pub expires_at: String,
    pub quality: u32,
    pub max_fps: u32,
    /// What the Worker settled on, not what was asked for. Zero means the
    /// picture is sent at the page's own width.
    pub max_width: u32,
    /// The encoding the frames on this stream carry. One page runs one
    /// screencast, so this is a session-wide answer even though every
    /// subscriber asks for itself.
    pub encoding: FrameEncoding,
}
