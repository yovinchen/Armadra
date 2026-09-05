//! The controlled embedded browser — B01,
//! [editor & browser design](../../../../docs/editor-browser-design.md) §5-§9.
//!
//! ## What a session is
//!
//! One canvas browser node owns one `BrowserSession`: a Chromium-family
//! process started against a private 0700 profile under
//! `<data_dir>/browser-profiles/<sessionId>`, driven over a narrow CDP
//! adaptation. The human and any linked agent drive **the same** session —
//! there is no second, agent-only browser — which is the whole point of B01.
//!
//! ## What outlives what
//!
//! * Closing the node stops the picture. The page keeps running, so an agent
//!   that is mid-task is not interrupted by somebody tidying the canvas (§9).
//! * Only an explicit terminate ends the session, kills the process group and
//!   deletes the profile. Logins live in that profile and nowhere else.
//! * A Runtime restart relaunches every kept session from its row and its
//!   profile and re-navigates to the recorded URL. What cannot come back — the
//!   page's JavaScript heap and any unsubmitted form — is stated in the design
//!   rather than pretended away.
//!
//! ## What this module refuses to be
//!
//! There is no generic `eval`, no raw CDP passthrough and no way for a caller
//! to name a protocol method. Every page-side helper is a constant in
//! [`dom`], and caller strings reach it only as JSON string literals.

pub mod agent;
pub mod cdp;
pub mod dom;
pub mod launch;
pub mod routes;
pub mod session;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::{
    AppState,
    error::{AppError, AppResult},
    model::Workspace,
};

pub use launch::Availability;
pub use session::Live;

/* --------------------------------- domain --------------------------------- */

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

    fn parse(value: &str) -> Self {
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

/* --------------------------------- service -------------------------------- */

/// Live sessions for one data directory.
///
/// Keyed by data directory in a process-wide registry rather than stored in
/// [`AppState`], for the same reason `collab` is: adding a subsystem must not
/// require reshaping a struct every other feature also constructs.
pub struct BrowserService {
    pub data_dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Live>>>,
    /// Serializes launches. Two clients opening the same node at once must
    /// produce one browser, not two processes fighting over one profile —
    /// Chrome refuses a second instance on the same user data directory.
    pub(crate) launching: tokio::sync::Mutex<()>,
    /// Set once the subscription sweep task is running.
    pub(crate) sweeping: Mutex<bool>,
}

impl BrowserService {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            launching: tokio::sync::Mutex::new(()),
            sweeping: Mutex::new(false),
        }
    }

    pub fn live(&self, session_id: &str) -> Option<Arc<Live>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
    }

    pub fn all(&self) -> Vec<Arc<Live>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }

    pub(crate) fn insert(&self, live: Arc<Live>) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(live.session_id.clone(), live);
    }

    pub(crate) fn remove(&self, session_id: &str) -> Option<Arc<Live>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)
    }
}

static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<BrowserService>>>> = OnceLock::new();

/// The browser service for this runtime's data directory.
pub fn service(state: &AppState) -> Arc<BrowserService> {
    let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = state.hooks.data_dir().to_path_buf();
    guard
        .entry(key.clone())
        .or_insert_with(|| Arc::new(BrowserService::new(key)))
        .clone()
}

pub fn availability(state: &AppState) -> Availability {
    launch::availability(&state.settings)
}

/* ------------------------------ URL admission ----------------------------- */

/// Where a controlled browser may be pointed.
///
/// Design §6 wants a full network policy (management ports, cloud metadata,
/// non-project intranet targets, redirect and resolution checks). This is the
/// part that is implemented: scheme admission, the link-local metadata
/// address, and the Runtime's own loopback ports. Redirects are **not**
/// re-checked, which the design doc records as an open gap rather than a
/// solved problem.
pub fn admit_url(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::BadRequest("A URL is required".into()));
    }
    if value.len() > 4_000 {
        return Err(AppError::BadRequest("That URL is too long".into()));
    }
    // A bare host gets `https://`, but only when it carries no scheme at all:
    // `javascript:` and `data:` have no authority, so treating them as hosts
    // would turn a refusal into `https://javascript:alert(1)`.
    let with_scheme = if value.contains("://") {
        value.to_owned()
    } else if let Some(colon) = value.find(':')
        && value[..colon]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && value[..colon].starts_with(|c: char| c.is_ascii_alphabetic())
        // `127.0.0.1:5173` is a host and a port, not a scheme.
        && !value[colon + 1..].starts_with(|c: char| c.is_ascii_digit())
    {
        return Err(AppError::BadRequest(
            "Only http and https addresses can be opened".into(),
        ));
    } else {
        format!("https://{value}")
    };
    let (scheme, rest) = with_scheme
        .split_once("://")
        .ok_or_else(|| AppError::BadRequest("That URL has no scheme".into()))?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(AppError::BadRequest(
            "Only http and https addresses can be opened".into(),
        ));
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (host, port) = split_authority(&authority);
    // Cloud instance metadata is reachable from every VM and hands out
    // credentials to anything that asks.
    if host == "169.254.169.254" || host == "metadata.google.internal" || host == "metadata" {
        return Err(AppError::Forbidden(
            "Instance metadata addresses cannot be opened".into(),
        ));
    }
    // A page must not be able to steer the browser at the app's own control
    // surfaces. This does not stop a page's own `fetch`; that is what the
    // Runtime's CORS allow-list is for.
    if is_loopback(host) && port.is_some_and(|port| RESERVED_LOOPBACK_PORTS.contains(&port)) {
        return Err(AppError::Forbidden(
            "Armadra's own service ports cannot be opened in a browser node".into(),
        ));
    }
    Ok(with_scheme)
}

/// The Runtime and the Go Host. A browser node exists to look at the project's
/// dev server, not at the app that is driving it.
const RESERVED_LOOPBACK_PORTS: &[u16] = &[crate::DEFAULT_PORT, crate::DEFAULT_PORT + 1];

fn split_authority(authority: &str) -> (&str, Option<u16>) {
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: the port, if any, follows the closing bracket.
        let Some((host, tail)) = rest.split_once(']') else {
            return (authority, None);
        };
        return (host, tail.strip_prefix(':').and_then(|p| p.parse().ok()));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()),
        None => (authority, None),
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/* --------------------------------- storage -------------------------------- */

/// One persisted session. The bytes here are enough to relaunch it; nothing
/// about the page's content or its cookies is stored.
#[derive(Debug, Clone)]
pub struct StoredSession {
    pub id: String,
    pub workspace_id: String,
    pub node_id: String,
    pub url: String,
    pub title: String,
    pub viewport: Viewport,
    pub profile_dir: String,
    pub headful: bool,
    pub keep_alive: bool,
    pub generation: u64,
    pub state: SessionState,
    pub reason_code: String,
    pub created_at: String,
    pub updated_at: String,
}

impl StoredSession {
    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Self {
        Self {
            id: row.get("id"),
            workspace_id: row.get("workspace_id"),
            node_id: row.get("node_id"),
            url: row.get("url"),
            title: row.get("title"),
            viewport: Viewport {
                width: row.get::<i64, _>("viewport_width").max(0) as u32,
                height: row.get::<i64, _>("viewport_height").max(0) as u32,
                device_scale_factor: row.get("device_scale_factor"),
            },
            profile_dir: row.get("profile_dir"),
            headful: row.get::<i64, _>("headful") != 0,
            keep_alive: row.get::<i64, _>("keep_alive") != 0,
            generation: row.get::<i64, _>("generation").max(0) as u64,
            state: SessionState::parse(&row.get::<String, _>("state")),
            reason_code: row.get("reason_code"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        }
    }
}

/// Every column of a stored session, written out once per query because sqlx
/// only accepts literal SQL.
const SELECT: &str = "SELECT id, workspace_id, node_id, url, title, viewport_width, \
     viewport_height, device_scale_factor, profile_dir, headful, keep_alive, generation, \
     state, reason_code, created_at, updated_at FROM browser_sessions";

pub async fn stored(pool: &SqlitePool, session_id: &str) -> AppResult<Option<StoredSession>> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(StoredSession::from_row))
}

pub async fn stored_for_node(pool: &SqlitePool, node_id: &str) -> AppResult<Option<StoredSession>> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!("{SELECT} WHERE node_id = ?")))
        .bind(node_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(StoredSession::from_row))
}

pub async fn stored_for_workspace(
    pool: &SqlitePool,
    workspace_id: &str,
) -> AppResult<Vec<StoredSession>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE workspace_id = ? ORDER BY created_at"
    )))
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(StoredSession::from_row).collect())
}

pub async fn stored_all(pool: &SqlitePool) -> AppResult<Vec<StoredSession>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!("{SELECT} ORDER BY created_at")))
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(StoredSession::from_row).collect())
}

pub async fn insert_stored(pool: &SqlitePool, session: &StoredSession) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO browser_sessions (id, workspace_id, node_id, url, title, viewport_width, \
         viewport_height, device_scale_factor, profile_dir, headful, keep_alive, generation, \
         state, reason_code, created_at, updated_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&session.id)
    .bind(&session.workspace_id)
    .bind(&session.node_id)
    .bind(&session.url)
    .bind(&session.title)
    .bind(session.viewport.width as i64)
    .bind(session.viewport.height as i64)
    .bind(session.viewport.device_scale_factor)
    .bind(&session.profile_dir)
    .bind(i64::from(session.headful))
    .bind(i64::from(session.keep_alive))
    .bind(session.generation as i64)
    .bind(session.state.as_str())
    .bind(&session.reason_code)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Writes back the fields a running session changes. Never the profile path or
/// the node binding: those identify the session and must not drift.
pub async fn persist(pool: &SqlitePool, session: &BrowserSession) -> AppResult<()> {
    sqlx::query(
        "UPDATE browser_sessions SET url = ?, title = ?, viewport_width = ?, viewport_height = ?, \
         device_scale_factor = ?, generation = ?, state = ?, reason_code = ?, keep_alive = ?, \
         updated_at = ? WHERE id = ?",
    )
    .bind(&session.url)
    .bind(&session.title)
    .bind(session.viewport.width as i64)
    .bind(session.viewport.height as i64)
    .bind(session.viewport.device_scale_factor)
    .bind(session.generation as i64)
    .bind(session.state.as_str())
    .bind(&session.reason_code)
    .bind(i64::from(session.keep_alive))
    .bind(Utc::now().to_rfc3339())
    .bind(&session.session_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_stored(pool: &SqlitePool, session_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM browser_sessions WHERE id = ?")
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

/* -------------------------------- workspace ------------------------------- */

/// A browser node reads and writes inside its workspace (screenshots and
/// downloads), so read permission is the floor for every route here.
pub async fn readable_workspace(state: &AppState, workspace_id: &str) -> AppResult<Workspace> {
    let workspace = crate::db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    Ok(workspace)
}

/// Where a capture or an accepted download lands. Both live under `.armadra/`
/// so they are inside the project an agent can already read, and out of the
/// way of the project's own tree.
pub fn capture_dir(root: &std::path::Path) -> PathBuf {
    root.join(".armadra").join("browser")
}

pub fn download_dir(root: &std::path::Path) -> PathBuf {
    root.join(".armadra").join("downloads")
}

/// Staging for a download Chrome has produced but nobody has accepted. Inside
/// the data directory, *not* the workspace: an unconfirmed download must not
/// appear in the project tree at all (design §6).
pub fn staging_dir(data_dir: &std::path::Path, session_id: &str) -> PathBuf {
    data_dir.join("browser-downloads").join(session_id)
}

/// A page-supplied filename reduced to one safe path segment.
pub fn safe_filename(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('.');
    let cleaned: String = trimmed
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "download".to_owned();
    }
    match cleaned.char_indices().nth(120) {
        Some((index, _)) => cleaned[..index].to_owned(),
        None => cleaned.to_owned(),
    }
}
