//! Agent collaboration — plan §5.5 to §5.9.
//!
//! Four capabilities sit behind the two hook routes the `armadra-hook` client
//! calls (`POST /context-link/{verb}` and `POST /control/{verb}`):
//!
//!   * [`context_link`] — an agent reads a node it is linked to;
//!   * [`control`] — an agent opens, renames, colours or links nodes;
//!   * [`mailbox`] — an agent posts to a peer's inbox and reads its own;
//!   * [`approvals`] — the permission round trip closed by an answer file.
//!
//! Nothing here writes prose into another agent's terminal on that agent's
//! behalf. Collaboration is a pull: the sender stores a message, the receiver
//! reads it when it chooses to. The one write that remains is `interrupt`, and
//! it carries no text — it is the Escape key and nothing else.
//!
//! Everything here is defensive by construction. The caller is a CLI acting on
//! text it read somewhere, so every verb re-derives what the caller is allowed
//! to touch from the database rather than from the request: the link document
//! for reads, the board for writes, and the identity verdict for both.

pub mod addressing;
pub mod approvals;
pub mod board_log;
pub mod context_link;
pub mod control;
mod hook_write;
pub mod mailbox;
pub mod skills;
pub mod transcript;

#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use axum::{
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::{Row, SqlitePool};

use crate::{AppState, error::AppResult, hook::auth::Verdict};

/// The 7 node colours a control verb may set — mirrors `NODE_COLORS` in
/// packages/shared/src/domain.ts.
pub const NODE_PALETTE: &[&str] = &[
    "#0a84ff", "#32d74b", "#ffd60a", "#ff453a", "#bf5af2", "#6ac4dc", "#ff9f0a",
];

/// New nodes are placed to the right of the node that asked for them.
pub const PLACEMENT_GAP: f64 = 60.0;

/// Default geometry per node type (plan §3.4).
pub fn default_size(node_type: &str) -> (f64, f64) {
    match node_type {
        "terminal" => (640.0, 440.0),
        "sticky" => (240.0, 200.0),
        "group" => (520.0, 360.0),
        "editor" => (660.0, 460.0),
        "diff" => (860.0, 500.0),
        "files" => (340.0, 460.0),
        "browser" => (800.0, 560.0),
        "automation" => (360.0, 260.0),
        "agentActivity" => (340.0, 240.0),
        _ => (260.0, 200.0),
    }
}

/// argv[0] basenames that mean "this pane is still running that agent".
/// Mirrors `expectedProcess` in packages/shared/src/agents.ts.
pub fn expected_processes(agent_id: &str) -> Vec<String> {
    match agent_id {
        "claude" => vec!["claude".to_owned()],
        "codex" => vec!["codex".to_owned()],
        "gemini" => vec!["gemini".to_owned()],
        "opencode" => vec!["opencode".to_owned()],
        "pi" | "omp" | "copilot" => vec![agent_id.to_owned()],
        // `custom:<name>` — the suffix is the best guess we have.
        other => match other.strip_prefix("custom:") {
            Some(suffix) if !suffix.is_empty() => vec![suffix.to_owned()],
            _ => Vec::new(),
        },
    }
}

/// The pane gate: is the foreground of this PTY still the agent we think it is?
///
/// Nothing writes prose into somebody else's terminal any more, but two callers
/// still need the answer: the automation scheduler, before it starts a prompt
/// the user scheduled, and `interrupt`, before it sends an Escape.
pub fn pane_runs_agent(
    info: &crate::terminal::backend::ForegroundInfo,
    expected: &[String],
) -> bool {
    if expected.is_empty() {
        return false;
    }
    let mut haystacks: Vec<&str> = Vec::new();
    if let Some(command) = info.command.as_deref() {
        haystacks.push(command);
    }
    for child in &info.children {
        haystacks.push(child);
    }
    haystacks
        .iter()
        .any(|line| expected.iter().any(|name| line_names_program(line, name)))
}

/// `claude` matches `claude`, `/opt/bin/claude --resume` and
/// `node /usr/lib/claude/cli.js`, but not `claude-code-notifier`.
fn line_names_program(line: &str, name: &str) -> bool {
    line.split(|c: char| c.is_whitespace() || c == '/' || c == '\\')
        .any(|token| {
            let token = token.trim_end_matches(".exe");
            token == name || token.strip_suffix(".js").is_some_and(|stem| stem == name)
        })
}

/* ------------------------------ request shape ----------------------------- */

/// `{nodeId, args}` — the body every control route takes. Bare flags arrive as
/// `true`, `--flag value` as strings, repeated flags as arrays.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub args: Map<String, Value>,
}

/// Typed reads over the loosely typed `args` object.
pub struct Args<'a>(pub &'a Map<String, Value>);

impl Args<'_> {
    /// A flag's string value. A bare flag (`true`) is deliberately not a
    /// string: `--title` with no value must not silently become "true".
    pub fn text(&self, name: &str) -> Option<&str> {
        match self.0.get(name) {
            Some(Value::String(value)) => Some(value.trim()).filter(|value| !value.is_empty()),
            // A repeated flag keeps its first value for single-valued reads.
            Some(Value::Array(values)) => values
                .iter()
                .find_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            _ => None,
        }
    }

    /// A bare flag arrives as `true`; `--flag=true` and friends are accepted
    /// too. A flag carrying any other value is *not* a boolean — reading
    /// `--title Build` as `flag("title") == true` is how a typo becomes a
    /// surprise dry run.
    pub fn flag(&self, name: &str) -> bool {
        match self.0.get(name) {
            Some(Value::Bool(value)) => *value,
            Some(Value::String(value)) => {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "true" | "1" | "yes" | "on"
                )
            }
            _ => false,
        }
    }

    /// `-n` / `--lines`, clamped by the caller.
    pub fn count(&self, names: &[&str]) -> Option<i64> {
        names.iter().find_map(|name| match self.0.get(*name) {
            Some(Value::Number(number)) => number.as_i64(),
            Some(Value::String(value)) => value.trim().parse().ok(),
            _ => None,
        })
    }

    /// A repeatable flag, also accepting one comma-separated value.
    pub fn list(&self, name: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut push = |value: &str| {
            for part in value.split(',') {
                let part = part.trim();
                if !part.is_empty() {
                    out.push(part.to_owned());
                }
            }
        };
        match self.0.get(name) {
            Some(Value::String(value)) => push(value),
            Some(Value::Array(values)) => {
                for value in values.iter().filter_map(Value::as_str) {
                    push(value);
                }
            }
            _ => {}
        }
        out
    }
}

/* --------------------------------- refusals ------------------------------- */

/// A refusal carries the sentence the agent will read, so every early return
/// says *why* in the agent's own transcript rather than in our log.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub status: StatusCode,
    pub message: String,
}

impl Refusal {
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
}

/// A refusal plus the stable code a JSON caller branches on.
///
/// The prose surfaces only ever print `message`, but `/control` answers JSON,
/// and "which agent did you mean?" is a question a client can act on — retry
/// with an id, draw a link, pick a new handoff key. Kept beside [`Refusal`]
/// rather than inside it so every existing refusal keeps compiling and simply
/// falls back to the code its status implies.
#[derive(Debug, Clone)]
pub struct Refused {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl Refused {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    /// A refusal that already knows its own code.
    pub fn coded(refusal: Refusal, code: &'static str) -> Self {
        Self {
            status: refusal.status,
            code,
            message: refusal.message,
        }
    }
}

impl From<Refusal> for Refused {
    fn from(refusal: Refusal) -> Self {
        let code = match refusal.status {
            StatusCode::BAD_REQUEST => "bad_request",
            StatusCode::FORBIDDEN => "forbidden",
            StatusCode::NOT_FOUND => "not_found",
            StatusCode::CONFLICT => "conflict",
            StatusCode::TOO_MANY_REQUESTS => "too_many_requests",
            _ => "internal_error",
        };
        Self::coded(refusal, code)
    }
}

/// `text/plain` is the context-link contract: the client prints the body
/// verbatim, so a refusal must be one readable sentence and nothing else.
pub fn text_reply(status: StatusCode, body: impl Into<String>) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body.into(),
    )
        .into_response()
}

/// True when the caller asked for prose rather than JSON.
pub fn wants_text(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| {
            let accept = accept.to_ascii_lowercase();
            accept.contains("text/plain") && !accept.contains("application/json")
        })
}

/* ------------------------------- node lookup ------------------------------ */

/// One canvas node, resolved far enough to authorize against it.
#[derive(Debug, Clone)]
pub struct NodeRef {
    pub id: String,
    pub board_id: String,
    pub workspace_id: String,
    pub title: String,
    pub node_type: String,
    /// `data.agent.id` for a terminal node running an agent.
    pub agent_id: Option<String>,
    pub data: Value,
}

pub async fn load_node(pool: &SqlitePool, node_id: &str) -> AppResult<Option<NodeRef>> {
    let row = sqlx::query(
        "SELECT n.id AS id, n.board_id AS board_id, n.title AS title, n.type AS type, \
                n.data_json AS data_json, b.workspace_id AS workspace_id \
         FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .bind(node_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let data_json: String = row.try_get("data_json")?;
    let data: Value = serde_json::from_str(&data_json).unwrap_or(Value::Null);
    Ok(Some(NodeRef {
        id: row.try_get("id")?,
        board_id: row.try_get("board_id")?,
        workspace_id: row.try_get("workspace_id")?,
        title: row.try_get("title")?,
        node_type: row.try_get("type")?,
        agent_id: data
            .get("agent")
            .and_then(|agent| agent.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        data,
    }))
}

/// The newest terminal session a node owns, live or not.
#[derive(Debug, Clone)]
pub struct SessionRef {
    pub session_id: String,
    pub generation: u64,
    pub status: String,
}

pub async fn load_session(pool: &SqlitePool, node_id: &str) -> AppResult<Option<SessionRef>> {
    let row = sqlx::query(
        "SELECT id, generation, status FROM terminal_sessions WHERE owner_node_id = ? \
         ORDER BY generation DESC, created_at DESC LIMIT 1",
    )
    .bind(node_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let generation: i64 = row.try_get("generation")?;
    Ok(Some(SessionRef {
        session_id: row.try_get("id")?,
        generation: generation.max(0) as u64,
        status: row.try_get("status")?,
    }))
}

pub async fn workspace_root(pool: &SqlitePool, workspace_id: &str) -> AppResult<Option<String>> {
    let row = sqlx::query("SELECT root_path FROM workspaces WHERE id = ?")
        .bind(workspace_id)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(row) => Some(row.try_get("root_path")?),
        None => None,
    })
}

/* --------------------------------- caller --------------------------------- */

/// Who is calling, and how much we believe them.
#[derive(Debug, Clone)]
pub struct Caller {
    pub node: NodeRef,
    pub verdict: Verdict,
}

impl Caller {
    pub fn is_verified(&self) -> bool {
        self.verdict.is_verified()
    }

    /// Everything except `list` needs a token this runtime minted (plan §5.2).
    pub fn require_verified(&self, verb: &str) -> Result<(), Refusal> {
        if self.is_verified() {
            return Ok(());
        }
        Err(Refusal::forbidden(format!(
            "`{verb}` 需要本运行时签发的节点令牌；这个终端没有，已拒绝。"
        )))
    }
}

/// Resolves the calling node from the request body and the node-token header.
/// A body naming a node that is not on any board is refused rather than
/// silently accepted: unlike a status report, a control call has consequences.
pub async fn resolve_caller(
    state: &AppState,
    headers: &HeaderMap,
    node_id: &str,
) -> Result<Caller, Refusal> {
    if !crate::hook::auth::valid_node_id(node_id) {
        return Err(Refusal::bad_request("请求里的节点 ID 无法识别。"));
    }
    let verdict = state.hooks.verdict(
        node_id,
        headers
            .get(crate::hook::ingest::NODE_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok()),
    );
    if verdict == Verdict::Forged {
        return Err(Refusal::forbidden(
            "节点令牌由本运行时签发，但与该节点不匹配，已拒绝。",
        ));
    }
    let node = load_node(&state.pool, node_id)
        .await
        .map_err(|error| Refusal {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("读取节点失败：{error}"),
        })?
        .ok_or_else(|| Refusal::not_found("画布上没有这个节点，可能已被删除。"))?;
    Ok(Caller { node, verdict })
}

/* ----------------------------- collaboration state ------------------------ */

/// Per-runtime, in-memory state the plan does not persist: the board-log
/// fallback ring, and the verbs waiting on a human verdict.
///
/// Keyed by data directory rather than stored in `AppState`, so the routes can
/// be added without reshaping a struct three other agents also touch. One
/// process serves one data directory; a test fixture gets its own.
pub struct CollabState {
    pub data_dir: PathBuf,
    /// Board-log entries for workspaces whose root we cannot write.
    pub ring: Mutex<VecDeque<Value>>,
    /// Set once the orphan sweep task is running.
    pub sweeping: Mutex<bool>,
    /// `requestId` → the verb waiting for a human verdict (plan §5.8).
    pub confirms: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
}

impl CollabState {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            ring: Mutex::new(VecDeque::new()),
            sweeping: Mutex::new(false),
            confirms: Mutex::new(HashMap::new()),
        }
    }

    pub fn pending_dir(&self) -> PathBuf {
        self.data_dir.join("pending")
    }
}

static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<CollabState>>>> = OnceLock::new();

/// The collaboration state for this runtime's data directory.
pub fn collab(state: &AppState) -> Arc<CollabState> {
    let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = state.hooks.data_dir().to_path_buf();
    guard
        .entry(key.clone())
        .or_insert_with(|| Arc::new(CollabState::new(key)))
        .clone()
}

/* --------------------------------- helpers -------------------------------- */

/// Header fields must not be able to forge a frame line, so anything that
/// looks like a line break becomes a space.
pub fn collapse_newlines(value: &str) -> String {
    value
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Strips ESC and the other C0 controls a body has no business carrying into
/// somebody else's terminal. Tab and newline survive.
pub fn strip_control(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

/// A short, unguessable id. Used for delivery frames and trace ids.
pub fn nonce(length: usize) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let bytes: [u8; 24] = rand::random();
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    encoded.chars().take(length).collect()
}

/// Truncates on a character boundary and says so.
pub fn truncate(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…（已截断）", &text[..cut])
}
