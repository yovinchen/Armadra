//! Reconciliation and reclamation (plan §15.2 and §15.6).
//!
//! A tmux session outlives the runtime, which means the database and the tmux
//! server can disagree: rows for sessions that died while the app was closed,
//! and `aicc-*` sessions whose row was deleted. [`reconcile`] settles that once
//! at startup; [`sweep`] runs every ten minutes and destroys the sessions that
//! nothing will ever attach to again.

use std::{collections::HashSet, time::Duration};

use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use crate::{
    error::AppResult,
    terminal::backend::{SessionKey, TerminalBackend},
};

/// Plan §15.6: "every 10 minutes".
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(600);
/// Plan §15.6: "at most 8 per round" — a sweep must never look like a purge.
pub const MAX_DESTROYS_PER_SWEEP: usize = 8;

/// One detached session as the reclaim policy sees it.
#[derive(Debug, Clone)]
pub struct GcRow {
    pub session_id: String,
    pub session_key: String,
    pub backend_ref: Option<String>,
    pub attach_state: String,
    /// `last_output_at`, or the creation time when nothing was ever written.
    pub last_activity: DateTime<Utc>,
    /// The owning node is still on a board.
    pub node_present: bool,
    /// The workspace still exists.
    pub workspace_open: bool,
}

/// Pure policy: which detached sessions may be destroyed right now.
///
/// A session is reclaimable when it is detached, has been quiet for longer than
/// the grace period, and nothing can reach it any more (its node is gone or its
/// workspace is gone). `live` sessions are never candidates however old they
/// are — somebody is looking at them.
pub fn gc_candidates(rows: &[GcRow], now: DateTime<Utc>, grace_minutes: u64) -> Vec<String> {
    let grace = chrono::Duration::minutes(grace_minutes.min(i64::MAX as u64) as i64);
    let mut candidates: Vec<&GcRow> = rows
        .iter()
        .filter(|row| row.attach_state == "detached")
        .filter(|row| now.signed_duration_since(row.last_activity) > grace)
        .filter(|row| !row.node_present || !row.workspace_open)
        .collect();
    // Oldest first, so a backlog drains deterministically over several rounds.
    candidates.sort_by_key(|row| row.last_activity);
    candidates
        .into_iter()
        .take(MAX_DESTROYS_PER_SWEEP)
        .map(|row| row.session_id.clone())
        .collect()
}

/// Every session row that is still supposed to be attachable.
pub async fn attachable_rows(pool: &SqlitePool) -> AppResult<Vec<GcRow>> {
    let rows = sqlx::query(
        "SELECT s.id AS id, s.session_key AS session_key, s.backend_ref AS backend_ref, \
                s.attach_state AS attach_state, s.last_output_at AS last_output_at, \
                s.created_at AS created_at, \
                EXISTS(SELECT 1 FROM nodes n WHERE n.id = s.owner_node_id) AS node_present, \
                EXISTS(SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id) AS workspace_open \
         FROM terminal_sessions s \
         WHERE s.backend_kind = 'tmux' AND s.attach_state <> 'exited'",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let last_output_at: Option<String> = row.get("last_output_at");
            let created_at: String = row.get("created_at");
            let node_present: i64 = row.get("node_present");
            let workspace_open: i64 = row.get("workspace_open");
            GcRow {
                session_id: row.get("id"),
                session_key: row.get("session_key"),
                backend_ref: row.get("backend_ref"),
                attach_state: row.get("attach_state"),
                last_activity: parse_time(last_output_at.as_deref().unwrap_or(&created_at)),
                node_present: node_present != 0,
                workspace_open: workspace_open != 0,
            }
        })
        .collect())
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or_else(|_| DateTime::<Utc>::MIN_UTC)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ReconcileReport {
    /// Rows whose tmux session is still there: re-attachable.
    pub detached: usize,
    /// Rows whose tmux session is gone: the process died while we were away.
    pub exited: usize,
    /// `aicc-*` sessions with no row at all.
    pub orphans_destroyed: usize,
}

/// Startup reconciliation of plan §15.2. Returns the keys that are still alive
/// so the manager can re-adopt them into its in-memory map.
pub async fn reconcile(
    pool: &SqlitePool,
    backend: &dyn TerminalBackend,
) -> AppResult<(ReconcileReport, Vec<(SessionKey, String, u64)>)> {
    let mut report = ReconcileReport::default();
    let alive: HashSet<String> = backend
        .list_alive()
        .await?
        .into_iter()
        .map(|reference| reference.name)
        .collect();

    let rows = sqlx::query(
        "SELECT id, session_key, backend_ref, generation FROM terminal_sessions \
         WHERE backend_kind = 'tmux' AND (status = 'running' OR attach_state <> 'exited')",
    )
    .fetch_all(pool)
    .await?;
    let mut adopted = Vec::new();
    let mut known = HashSet::new();
    for row in rows {
        let id: String = row.get("id");
        let session_key: String = row.get("session_key");
        let backend_ref: Option<String> = row.get("backend_ref");
        let generation: i64 = row.get("generation");
        let reference = backend_ref.unwrap_or_default();
        known.insert(reference.clone());
        if alive.contains(&reference) {
            sqlx::query(
                "UPDATE terminal_sessions SET attach_state = 'detached', status = 'running' WHERE id = ?",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            adopted.push((
                SessionKey::new(session_key),
                reference,
                generation.max(0) as u64,
            ));
            report.detached += 1;
        } else {
            sqlx::query(
                "UPDATE terminal_sessions SET attach_state = 'exited', status = \
                 CASE WHEN status = 'running' THEN 'exited' ELSE status END, \
                 ended_at = COALESCE(ended_at, ?) WHERE id = ?",
            )
            .bind(Utc::now().to_rfc3339())
            .bind(&id)
            .execute(pool)
            .await?;
            report.exited += 1;
        }
    }

    for name in alive.difference(&known) {
        if backend.destroy_by_reference(name).await.is_ok() {
            report.orphans_destroyed += 1;
        }
    }
    Ok((report, adopted))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, minutes_idle: i64, state: &str, node: bool, workspace: bool) -> GcRow {
        GcRow {
            session_id: id.into(),
            session_key: id.into(),
            backend_ref: Some(format!("aicc-ws-{id}-1")),
            attach_state: state.into(),
            last_activity: Utc::now() - chrono::Duration::minutes(minutes_idle),
            node_present: node,
            workspace_open: workspace,
        }
    }

    #[test]
    fn only_unreachable_detached_sessions_are_reclaimed() {
        let rows = vec![
            // Idle for two days, node deleted: reclaim.
            row("gone-node", 2880, "detached", false, true),
            // Idle for two days, workspace deleted: reclaim.
            row("gone-workspace", 2900, "detached", true, false),
            // Idle for two days but the node is still on a board: keep.
            row("still-on-board", 2880, "detached", true, true),
            // Node deleted but only ten minutes idle: keep.
            row("recent", 10, "detached", false, true),
            // Somebody is watching it right now: keep, whatever its age.
            row("live", 9000, "live", false, false),
            // Already gone.
            row("exited", 9000, "exited", false, false),
        ];
        let candidates = gc_candidates(&rows, Utc::now(), 1440);
        assert_eq!(candidates, vec!["gone-workspace", "gone-node"]);
    }

    #[test]
    fn a_sweep_never_destroys_more_than_the_cap() {
        let rows: Vec<GcRow> = (0..20)
            .map(|index| row(&format!("s{index}"), 5000 - index, "detached", false, true))
            .collect();
        assert_eq!(
            gc_candidates(&rows, Utc::now(), 1440).len(),
            MAX_DESTROYS_PER_SWEEP
        );
    }

    #[test]
    fn a_zero_grace_still_keeps_reachable_sessions() {
        let rows = vec![
            row("reachable", 600, "detached", true, true),
            row("unreachable", 600, "detached", false, true),
        ];
        assert_eq!(
            gc_candidates(&rows, Utc::now(), 0),
            vec!["unreachable".to_owned()]
        );
    }
}
