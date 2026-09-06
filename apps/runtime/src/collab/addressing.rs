//! Naming a peer — the one place that turns `--node` / `--to` into a link.
//!
//! Both collaboration surfaces address the same thing: a node the caller is
//! linked to on the canvas. `context-link` reads it, the mailbox posts to it,
//! and neither may reach a node the user did not connect. Keeping the rule
//! here means the two verbs cannot drift into resolving the same word
//! differently — the failure mode where an agent reads one peer and writes to
//! another.
//!
//! The order is deliberate, most specific first:
//!
//!   1. the node id, exactly;
//!   2. `data.handle`, exactly — a short alias the user assigned;
//!   3. the title, exactly, case-insensitively;
//!   4. the title, as a substring, when exactly one link contains it.
//!
//! Ambiguity is refused rather than guessed at every stage. Writing to the
//! wrong agent is worse than not writing at all, so a word that matches two
//! peers comes back with the candidates and a code the caller can branch on.

use std::collections::HashMap;

use axum::http::StatusCode;
use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::{error::AppResult, model::ContextLink};

use super::Refusal;

/* --------------------------------- handles -------------------------------- */

/// The longest a handle may be. Short on purpose: a handle exists so an agent
/// can type a peer's name without quoting a title.
pub const MAX_HANDLE_CHARS: usize = 24;

/// Normalizes `raw` into a handle, or `None` when it is not one.
///
/// A handle is 1–[`MAX_HANDLE_CHARS`] ASCII characters, starts with a letter or
/// a digit, and continues with letters, digits, `-` or `_`. Case is folded, so
/// `Review` and `review` are the same handle and neither can shadow the other.
/// The charset is narrow so a handle never collides with the id form and never
/// carries whitespace an agent would have to quote.
///
/// Mirrored by `handleSchema` in `packages/shared/src/domain/node-data.ts`.
pub fn normalize_handle(raw: &str) -> Option<String> {
    let handle = raw.trim().to_ascii_lowercase();
    if handle.is_empty() || handle.len() > MAX_HANDLE_CHARS {
        return None;
    }
    let mut characters = handle.chars();
    if !characters.next()?.is_ascii_alphanumeric() {
        return None;
    }
    if !characters.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(handle)
}

/// `node.data.handle`, re-validated rather than trusted: a board written by an
/// older client — or by hand — must not be able to register a handle that the
/// rename verb would have refused.
pub fn handle_of(data: &Value) -> Option<String> {
    data.get("handle")
        .and_then(Value::as_str)
        .and_then(normalize_handle)
}

/// node id → handle, for the nodes one link document points at.
///
/// Handles live in `node.data`, not in the link document: the canvas rewrites
/// links whenever an edge changes, so a copy there would go stale the moment a
/// node was renamed.
#[derive(Debug, Default, Clone)]
pub struct Handles(HashMap<String, String>);

impl Handles {
    pub fn get(&self, node_id: &str) -> Option<&str> {
        self.0.get(node_id).map(String::as_str)
    }
}

/// Reads the handles of every node a link document points at, in one query.
///
/// `shape` links are skipped: a whiteboard shape has no node row, so it has no
/// handle either (`docs/design/canvas-react-flow.md` §2.5).
pub async fn load_handles(pool: &SqlitePool, links: &[ContextLink]) -> AppResult<Handles> {
    let ids: Vec<&str> = links
        .iter()
        .filter(|link| link.kind != "shape")
        .map(|link| link.id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(Handles::default());
    }
    // Only the placeholder count varies; every id is still bound, so nothing a
    // link document carries reaches the statement text.
    let placeholders = vec!["?"; ids.len()].join(",");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id, data_json FROM nodes WHERE id IN ({placeholders})"
    )));
    for id in &ids {
        query = query.bind(*id);
    }
    let mut handles = HashMap::new();
    for row in query.fetch_all(pool).await? {
        let data_json: String = row.try_get("data_json")?;
        let Ok(data) = serde_json::from_str::<Value>(&data_json) else {
            continue;
        };
        if let Some(handle) = handle_of(&data) {
            handles.insert(row.try_get("id")?, handle);
        }
    }
    Ok(Handles(handles))
}

/* ------------------------------- resolution ------------------------------- */

/// Why a name did not become exactly one linked node.
///
/// Every variant carries a stable `code`, because "which agent did you mean?"
/// is a question a caller can act on — retry with an id, draw a link — and a
/// prose sentence is not something it can branch on.
#[derive(Debug, Clone)]
pub enum AddressError {
    /// The caller is not linked to anything at all.
    NoLinks,
    /// Several links and no name to choose between them.
    Unspecified { linked: usize },
    /// Nothing in the caller's link document answers to that name. Also what a
    /// node that exists elsewhere on the board comes back as: not being linked
    /// and not existing are the same answer from here.
    NotLinked { wanted: String },
    /// More than one linked node answers to that name.
    Ambiguous {
        wanted: String,
        /// `(title, id)` for every candidate, so the caller can pick one.
        matches: Vec<(String, String)>,
    },
}

impl AddressError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoLinks => "no_links",
            Self::Unspecified { .. } => "target_unspecified",
            Self::NotLinked { .. } => "target_not_linked",
            Self::Ambiguous { .. } => "target_ambiguous",
        }
    }

    /// Not being linked is a permission answer, not a lookup miss: the node may
    /// well exist, and saying so would let an agent probe the board by name.
    pub fn status(&self) -> StatusCode {
        match self {
            Self::NoLinks | Self::NotLinked { .. } => StatusCode::FORBIDDEN,
            Self::Unspecified { .. } | Self::Ambiguous { .. } => StatusCode::BAD_REQUEST,
        }
    }

    /// The candidates, rendered `标题（id）`-style for either language.
    fn candidates(matches: &[(String, String)]) -> String {
        matches
            .iter()
            .map(|(title, id)| format!("{title}（{id}）"))
            .collect::<Vec<_>>()
            .join("、")
    }

    /// The context-link sentence. That surface answers `text/plain` prose in
    /// Chinese and names its own flag, so the wording lives with the caller
    /// rather than with the rule.
    pub fn refusal(&self, flag: &str) -> Refusal {
        let message = match self {
            Self::NoLinks => "这个节点还没有连接任何其他节点，没有可读的上下文。".to_owned(),
            Self::Unspecified { linked } => {
                format!("这个节点连接了 {linked} 个节点，请用 {flag} 指明要读哪一个。")
            }
            Self::NotLinked { wanted } => {
                format!("「{wanted}」不在这个节点的链接列表里，已拒绝；先在画布上连一条线。")
            }
            Self::Ambiguous { wanted, matches } => format!(
                "「{wanted}」同时匹配 {} 个链接：{}。请用节点 ID 或短名指明。",
                matches.len(),
                Self::candidates(matches)
            ),
        };
        Refusal {
            status: self.status(),
            message,
        }
    }

    /// The mailbox sentence. The mailbox speaks English to its callers, and a
    /// refusal it hands back must read like the rest of that surface.
    pub fn english(&self, flag: &str) -> String {
        match self {
            Self::NoLinks => "Draw a canvas link to another agent before addressing it.".to_owned(),
            Self::Unspecified { linked } => format!(
                "{linked} nodes are linked; name one with {flag} <node id, handle or title>."
            ),
            Self::NotLinked { wanted } => {
                format!("No linked node answers to \"{wanted}\"; draw a canvas link to it first.")
            }
            Self::Ambiguous { wanted, matches } => format!(
                "\"{wanted}\" matches {} linked nodes: {}. Use the node id or a handle.",
                matches.len(),
                Self::candidates(matches)
            ),
        }
    }
}

fn ambiguous(wanted: &str, matches: &[&ContextLink]) -> AddressError {
    AddressError::Ambiguous {
        wanted: wanted.to_owned(),
        matches: matches
            .iter()
            .map(|link| (link.title.clone(), link.id.clone()))
            .collect(),
    }
}

/// Resolves one name against the caller's own link document.
///
/// `wanted` is `None` when the caller left the flag off: one link needs no
/// name, more than one does. Pass an empty [`Handles`] when handles do not
/// apply — resolution then falls straight through to the title rules.
pub fn resolve_link<'a>(
    links: &'a [ContextLink],
    handles: &Handles,
    wanted: Option<&str>,
) -> Result<&'a ContextLink, AddressError> {
    if links.is_empty() {
        return Err(AddressError::NoLinks);
    }
    let Some(wanted) = wanted.map(str::trim).filter(|wanted| !wanted.is_empty()) else {
        return match links {
            [only] => Ok(only),
            many => Err(AddressError::Unspecified { linked: many.len() }),
        };
    };
    if let Some(link) = links.iter().find(|link| link.id == wanted) {
        return Ok(link);
    }
    // A handle beats a title even when a *different* node is titled the same
    // word: the handle was assigned on purpose, the title collision was not.
    if let Some(handle) = normalize_handle(wanted) {
        let matches: Vec<&ContextLink> = links
            .iter()
            .filter(|link| handles.get(&link.id) == Some(handle.as_str()))
            .collect();
        match matches.as_slice() {
            [only] => return Ok(only),
            [] => {}
            many => return Err(ambiguous(wanted, many)),
        }
    }
    let lowered = wanted.to_lowercase();
    let exact: Vec<&ContextLink> = links
        .iter()
        .filter(|link| link.title.to_lowercase() == lowered)
        .collect();
    match exact.as_slice() {
        [only] => return Ok(only),
        [] => {}
        many => return Err(ambiguous(wanted, many)),
    }
    let partial: Vec<&ContextLink> = links
        .iter()
        .filter(|link| link.title.to_lowercase().contains(&lowered))
        .collect();
    match partial.as_slice() {
        [only] => Ok(only),
        [] => Err(AddressError::NotLinked {
            wanted: wanted.to_owned(),
        }),
        many => Err(ambiguous(wanted, many)),
    }
}
