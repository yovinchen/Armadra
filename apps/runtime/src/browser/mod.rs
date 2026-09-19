//! The browser node's Runtime half — B01, now under the Electron shell
//! ([desktop shell migration](../../../../docs/design/electron-migration.md) §4).
//!
//! ## Where the page is
//!
//! In a `<webview>` guest of the desktop window. This process does not start a
//! browser, does not hold a profile and does not see a pixel: W3.5 removed the
//! managed Chromium, the CDP client and the picture stream entirely. What is
//! left here is what was never about a page.
//!
//! ## What is left
//!
//! * **Authorization** — the three rules in [`agent`]: only a linked node, the
//!   same session a person is looking at, and a closed list of seventeen verbs.
//! * **The lease** — [`session::lease`], the state machine that decides who may
//!   drive. A fact about people and agents, not about Chrome.
//! * **The drive channel** — [`shell`], one narrow loopback WebSocket carrying
//!   verbs (never CDP method names) to the shell that started this process.
//! * **One column** — `browser_sessions.active_tab_url`, so a restart knows
//!   where the guest was. See [`store`].
//! * **The URL policy** — [`policy`], kept as the Runtime-side statement of
//!   what a browser node may be pointed at.
//!
//! ## What this module refuses to be
//!
//! There is no generic `eval`, no raw CDP passthrough and no way for a caller
//! to name a protocol method. The interface to the shell is a verb, so a
//! Runtime that has been talked into something still cannot name a protocol
//! method, and a shell that has been talked into something still cannot decide
//! who may drive.

pub mod agent;
pub mod model;
pub mod policy;
pub mod session;
pub mod shell;
pub mod store;

#[cfg(test)]
mod tests;

use std::path::PathBuf;

use crate::{
    AppState,
    error::{AppError, AppResult},
    model::Workspace,
};

pub use model::*;
pub use policy::*;
pub use store::*;

/* -------------------------------- workspace ------------------------------- */

/// A browser node reads and writes inside its workspace (screenshots and
/// downloads), so read permission is the floor for every verb here.
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
///
/// The write itself happens in the shell, which resolves this against the
/// workspace root it is handed and enforces the jail there. This side names
/// the convention; neither half is sufficient alone (design §4.1).
pub fn capture_dir(root: &std::path::Path) -> PathBuf {
    root.join(".armadra").join("browser")
}

pub fn download_dir(root: &std::path::Path) -> PathBuf {
    root.join(".armadra").join("downloads")
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
