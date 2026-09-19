//! The controlled embedded browser — B01,
//! [editor & browser design](../../../../docs/design/editor-browser-design.md) §5-§9.
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
pub mod model;
pub mod policy;
pub mod routes;
pub mod session;
pub mod shell;
pub mod store;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use crate::{
    AppState,
    error::{AppError, AppResult},
    model::Workspace,
};

pub use launch::Availability;
pub use model::*;
pub use policy::*;
pub use session::Live;
pub use store::*;

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
    launch::availability(&state.settings, state.hooks.data_dir())
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
