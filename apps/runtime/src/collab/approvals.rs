//! Hook-reply permission answers — plan §5.5.
//!
//! Two mechanisms, one route. When the `aicc-hook` client is waiting on a
//! permission request it has written `<data>/pending/<id>.json` and is polling
//! for `<id>.answer`; writing that file is deterministic — the CLI gets the
//! decision through its own hook protocol and never sees a keystroke.
//!
//! When there is no pending file (an older client, a CLI without hook replies,
//! a runtime that restarted since the request) the only thing left is to type
//! the answer into the PTY the way a human would. That is best effort by
//! definition: it depends on the CLI's prompt still being on screen.
//!
//! Orphan files are swept at start-up and hourly, because a client that was
//! killed mid-wait leaves both files behind and they contain the tool call the
//! agent wanted to make.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    model::AgentApproval,
    paths,
};

use super::collab;

/// Pending files older than this are the remains of a client that went away.
pub const ORPHAN_MINUTES: i64 = 10;
/// How often the sweep runs after the one at start-up.
const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);
/// `AICC_PERM_WAIT_SECS` for a CLI that supports hook replies.
pub const PERM_WAIT_SECONDS: u32 = 45;

/// Records the user's decision and gets it back to the waiting CLI.
pub async fn answer(
    state: &AppState,
    pending_id: &str,
    decision: &str,
) -> AppResult<(AgentApproval, &'static str)> {
    if !valid_pending_id(pending_id) {
        return Err(AppError::BadRequest("Approval id is invalid".into()));
    }
    // Validates the decision and refuses a second answer.
    let approval = db::answer_approval(&state.pool, pending_id, decision, Some("user")).await?;

    let directory = collab(state).pending_dir();
    let route = if write_answer_file(&directory, pending_id, decision)? {
        "file"
    } else if type_into_pty(state, &approval, decision).await {
        "keys"
    } else {
        "none"
    };

    state.events.publish(
        &approval.workspace_id,
        WorkspaceEvent::AgentApproval {
            node_id: approval.node_id.clone(),
            pending_id: approval.id.clone(),
            // Resolution reuses the event: `request.resolved` tells a client
            // this is the answer rather than a new question.
            request: resolved_payload(&approval, decision, route),
        },
    );
    Ok((approval, route))
}

fn resolved_payload(
    approval: &AgentApproval,
    decision: &str,
    route: &'static str,
) -> serde_json::Value {
    let mut value = serde_json::to_value(approval).unwrap_or(serde_json::Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.insert("resolved".into(), serde_json::json!(true));
        object.insert("decision".into(), serde_json::json!(decision));
        object.insert("route".into(), serde_json::json!(route));
    }
    value
}

/// Writes `<pending>/<id>.answer` atomically, 0600. `false` means there was no
/// pending request file, so nobody is polling for the answer.
pub fn write_answer_file(directory: &Path, pending_id: &str, decision: &str) -> AppResult<bool> {
    if !valid_pending_id(pending_id) {
        return Err(AppError::BadRequest("Approval id is invalid".into()));
    }
    if !directory.join(format!("{pending_id}.json")).is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(directory)?;
    paths::harden_directory(directory);
    let target = directory.join(format!("{pending_id}.answer"));
    let temporary = directory.join(format!(".{pending_id}.answer.tmp"));
    std::fs::write(&temporary, decision.as_bytes())?;
    paths::harden_file(&temporary);
    std::fs::rename(&temporary, &target)?;
    paths::harden_file(&target);
    Ok(true)
}

/// The fallback: the keys a human would press. Claude's permission prompt is a
/// numbered menu, the others answer y/n.
async fn type_into_pty(state: &AppState, approval: &AgentApproval, decision: &str) -> bool {
    let Ok(Some(session)) = super::load_session(&state.pool, &approval.node_id).await else {
        return false;
    };
    let agent_id = match super::load_node(&state.pool, &approval.node_id).await {
        Ok(Some(node)) => node.agent_id,
        _ => None,
    };
    let agent_id = match agent_id {
        Some(agent_id) => agent_id,
        None => match db::get_agent_status(&state.pool, &approval.node_id).await {
            Ok(Some(status)) => status.agent_id,
            _ => "claude".to_owned(),
        },
    };
    let keys = answer_keys(&agent_id, decision);
    let Some(generation) = state.terminals.generation(&session.session_id).await else {
        return false;
    };
    state
        .terminals
        .write(&session.session_id, generation, keys)
        .await
        .is_ok()
}

/// The keystrokes each CLI reads as allow / deny.
pub fn answer_keys(agent_id: &str, decision: &str) -> &'static str {
    let allow = decision == "allow";
    match agent_id {
        // A numbered menu: 1 = yes, 3 = no and tell it what to do instead.
        "claude" => {
            if allow {
                "1\r"
            } else {
                "3\r"
            }
        }
        _ => {
            if allow {
                "y\r"
            } else {
                "n\r"
            }
        }
    }
}

/// `<nodeId>-<epochMs>-<pid>`; anything that could escape the directory or name
/// a file we did not write is refused before it reaches the filesystem.
pub fn valid_pending_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !value.contains("..")
}

/* ---------------------------------- sweep --------------------------------- */

/// Deletes pending request and answer files older than [`ORPHAN_MINUTES`].
/// Returns how many files went away.
pub fn sweep_orphans(directory: &Path, older_than: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ours = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension, "json" | "answer" | "tmp"));
        if !is_ours {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map(|modified| modified.elapsed().unwrap_or_default() > older_than)
            .unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Starts the start-up sweep and the hourly one. Idempotent: a second call on
/// the same data directory does nothing.
pub fn start_sweep(state: AppState) {
    let collab = collab(&state);
    {
        let mut sweeping = collab
            .sweeping
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *sweeping {
            return;
        }
        *sweeping = true;
    }
    let directory = collab.pending_dir();
    tokio::spawn(async move {
        let age = Duration::from_secs((ORPHAN_MINUTES * 60) as u64);
        loop {
            let removed = sweep_orphans(&directory, age);
            if removed > 0 {
                tracing::info!(removed, "cleared orphaned permission requests");
            }
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    });
}

/// Where the pending files live, for callers outside this module.
pub fn pending_dir(state: &AppState) -> PathBuf {
    collab(state).pending_dir()
}
