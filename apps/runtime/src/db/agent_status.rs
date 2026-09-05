//! The `agent_status` table: the reduced per-node agent state, its read
//! receipts, and the staleness and ownership queries built on it.

use chrono::Utc;
use sqlx::{Row, SqlitePool};

use super::AGENT_STATES;
use crate::{
    error::{AppError, AppResult},
    model::AgentStatus,
};

// ---------------------------------------------------------------------------
// Agent status
// ---------------------------------------------------------------------------

pub struct AgentStatusPatch {
    pub node_id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub state: Option<String>,
    pub unread: bool,
    pub session_id: Option<String>,
    pub pending_id: Option<String>,
    pub verified: bool,
    pub transcript_path: Option<String>,
    pub session_phase: Option<String>,
    /// How the turn that reached `done` ended. `None` while a turn is open.
    pub errored: Option<bool>,
    pub interrupted: Option<bool>,
    /// When the hook report that produced this state arrived. `None` for writes
    /// that are not hook reports (the read receipt, the stale sweep), which then
    /// keep whatever the row already had.
    pub last_event_at: Option<String>,
}

fn agent_status_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<AgentStatus, sqlx::Error> {
    Ok(AgentStatus {
        node_id: row.try_get("node_id")?,
        workspace_id: row.try_get("workspace_id")?,
        agent_id: row.try_get("agent_id")?,
        state: row.try_get("state")?,
        unread: row.try_get::<i64, _>("unread")? != 0,
        session_id: row.try_get("session_id")?,
        pending_id: row.try_get("pending_id")?,
        verified: row.try_get::<i64, _>("verified")? != 0,
        restored: row.try_get::<i64, _>("restored")? != 0,
        updated_at: row.try_get("updated_at")?,
        transcript_path: row.try_get("transcript_path")?,
        last_event_at: row.try_get("last_event_at")?,
        session_phase: row.try_get("session_phase")?,
        errored: row
            .try_get::<Option<i64>, _>("errored")?
            .map(|value| value != 0),
        interrupted: row
            .try_get::<Option<i64>, _>("interrupted")?
            .map(|value| value != 0),
        // Never persisted: only the publisher fills it in.
        last_message: None,
    })
}

/// Every `agent_status` column `agent_status_from_row` reads. `sqlx::query`
/// only accepts SQL that is known at compile time, so the list is a macro
/// rather than a runtime `format!`.
macro_rules! agent_status_select {
    ($tail:literal) => {
        concat!(
            "SELECT node_id, workspace_id, agent_id, state, unread, session_id, pending_id, ",
            "verified, restored, updated_at, transcript_path, last_event_at, session_phase, ",
            "errored, interrupted ",
            "FROM agent_status ",
            $tail
        )
    };
}

/// Writes the reduced state for one node. A row written by this process is
/// never `restored`; the flag is only set by `mark_agent_status_restored` at
/// start-up so the UI can tell a stale `done` from a fresh one.
pub async fn upsert_agent_status(
    pool: &SqlitePool,
    patch: AgentStatusPatch,
) -> AppResult<AgentStatus> {
    if let Some(state) = patch.state.as_deref()
        && !AGENT_STATES.contains(&state)
    {
        return Err(AppError::BadRequest("Unknown agent state".into()));
    }
    let now = Utc::now().to_rfc3339();
    let last_event_at = patch.last_event_at.clone();
    sqlx::query(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, session_id, pending_id, \
           verified, restored, updated_at, transcript_path, last_event_at, session_phase, errored, interrupted) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, agent_id = excluded.agent_id, \
           state = excluded.state, unread = excluded.unread, session_id = excluded.session_id, \
           pending_id = excluded.pending_id, verified = excluded.verified, restored = 0, updated_at = excluded.updated_at, \
           transcript_path = excluded.transcript_path, session_phase = excluded.session_phase, \
           errored = excluded.errored, interrupted = excluded.interrupted, \
           last_event_at = COALESCE(excluded.last_event_at, agent_status.last_event_at)",
    )
    .bind(&patch.node_id)
    .bind(&patch.workspace_id)
    .bind(&patch.agent_id)
    .bind(&patch.state)
    .bind(i64::from(patch.unread))
    .bind(&patch.session_id)
    .bind(&patch.pending_id)
    .bind(i64::from(patch.verified))
    .bind(&now)
    .bind(&patch.transcript_path)
    .bind(&last_event_at)
    .bind(&patch.session_phase)
    .bind(patch.errored.map(i64::from))
    .bind(patch.interrupted.map(i64::from))
    .execute(pool)
    .await?;
    get_agent_status(pool, &patch.node_id)
        .await?
        .ok_or_else(|| AppError::Internal("Agent status disappeared after writing it".into()))
}

pub async fn get_agent_status(pool: &SqlitePool, node_id: &str) -> AppResult<Option<AgentStatus>> {
    let row = sqlx::query(agent_status_select!("WHERE node_id = ?"))
        .bind(node_id)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(row) => Some(agent_status_from_row(&row)?),
        None => None,
    })
}

pub async fn list_agent_status(
    pool: &SqlitePool,
    workspace_id: &str,
) -> AppResult<Vec<AgentStatus>> {
    let rows = sqlx::query(agent_status_select!(
        "WHERE workspace_id = ? ORDER BY updated_at DESC"
    ))
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(agent_status_from_row)
        .collect::<Result<Vec<_>, _>>()?)
}

/// Outcome of a read receipt. `cleared` distinguishes "this call put the badge
/// out" from "the badge was already out", which is what lets the caller skip a
/// broadcast that would tell every client something it already knows.
pub struct ReadReceipt {
    pub status: AgentStatus,
    pub cleared: bool,
}

/// Clears the unread badge for one node. Returns `None` when the node never
/// reported, so the caller can answer 404 instead of inventing a row.
///
/// Idempotent: receipts are fired automatically by a focused client whenever a
/// turn finishes under the user's eyes, so "already read" is a routine call,
/// not a client bug.
pub async fn mark_agent_status_read(
    pool: &SqlitePool,
    node_id: &str,
) -> AppResult<Option<ReadReceipt>> {
    let cleared = sqlx::query(
        "UPDATE agent_status SET unread = 0, updated_at = ? WHERE node_id = ? AND unread <> 0",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(node_id)
    .execute(pool)
    .await?
    .rows_affected()
        > 0;
    Ok(get_agent_status(pool, node_id)
        .await?
        .map(|status| ReadReceipt { status, cleared }))
}

/// One node the stale-working sweep has to close out (plan §5.4: 20 minutes
/// without a hook report). Ordered oldest first so a burst is capped fairly.
#[derive(Debug, Clone)]
pub struct StaleAgent {
    pub node_id: String,
    pub workspace_id: String,
    pub agent_id: String,
}

pub async fn stale_working_agents(
    pool: &SqlitePool,
    older_than: &str,
    limit: i64,
) -> AppResult<Vec<StaleAgent>> {
    let rows = sqlx::query(
        "SELECT node_id, workspace_id, agent_id FROM agent_status a \
         WHERE a.state = 'working' AND COALESCE(a.last_event_at, a.updated_at) < ? \
           -- Neither `agent_status` nor `terminal_sessions` keys on `nodes`, so
           -- both outlive a node the user deleted. Closing one out would put a
           -- frame on the socket for something that is no longer on the canvas.
           AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id) \
         ORDER BY COALESCE(a.last_event_at, a.updated_at) ASC LIMIT ?",
    )
    .bind(older_than)
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(StaleAgent {
                node_id: row.try_get("node_id")?,
                workspace_id: row.try_get("workspace_id")?,
                agent_id: row.try_get("agent_id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

/// Nodes whose agent is still shown as live but whose terminal is gone.
///
/// A hook only reports while its CLI runs, so a terminal that dies mid-turn —
/// killed by the user, or reaped with its pane — leaves the row saying
/// `working` forever. `SessionEnd` cannot cover it: it does not fire on
/// SIGKILL, and `terminate_tree` now correctly kills the CLI outright.
///
/// `ended_before` is a grace cutoff: a session that has only just ended may
/// still have a final `Stop` in flight, and a synthetic close would race it.
pub async fn agents_with_dead_terminals(
    pool: &SqlitePool,
    ended_before: &str,
    limit: i64,
) -> AppResult<Vec<StaleAgent>> {
    let rows = sqlx::query(
        "SELECT a.node_id AS node_id, a.workspace_id AS workspace_id, a.agent_id AS agent_id \
         FROM agent_status a \
         WHERE a.state IS NOT NULL AND a.state <> 'done' \
           -- A node with no session at all is not ours to close: the CLI may be
           -- running in a terminal the user opened, exporting ARMADRA_NODE_ID.
           AND EXISTS (SELECT 1 FROM terminal_sessions t WHERE t.owner_node_id = a.node_id) \
           -- Same reason as the silence sweep: a deleted node is nobody's to close.
           AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id) \
           AND NOT EXISTS ( \
             SELECT 1 FROM terminal_sessions t WHERE t.owner_node_id = a.node_id \
               AND (t.status = 'running' OR COALESCE(t.ended_at, '') >= ?) \
           ) \
         ORDER BY a.updated_at ASC LIMIT ?",
    )
    .bind(ended_before)
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(StaleAgent {
                node_id: row.try_get("node_id")?,
                workspace_id: row.try_get("workspace_id")?,
                agent_id: row.try_get("agent_id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

/// Which workspace a hook report belongs to. A hook only knows its node id, so
/// the terminal session that owns the node is the primary answer; a node that
/// has no session yet (or whose session was recycled away) is still resolvable
/// through the board it lives on.
#[derive(Debug, Clone)]
pub struct NodeOwner {
    pub workspace_id: String,
    /// The agent the session was created with, when there was one.
    pub agent_id: Option<String>,
}

pub async fn find_node_owner(pool: &SqlitePool, node_id: &str) -> AppResult<Option<NodeOwner>> {
    let row = sqlx::query(
        "SELECT workspace_id, agent_id FROM terminal_sessions \
         WHERE owner_node_id = ? ORDER BY generation DESC, created_at DESC LIMIT 1",
    )
    .bind(node_id)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = row {
        return Ok(Some(NodeOwner {
            workspace_id: row.try_get("workspace_id")?,
            agent_id: row.try_get("agent_id")?,
        }));
    }
    let row = sqlx::query(
        "SELECT b.workspace_id AS workspace_id FROM nodes n \
         JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .bind(node_id)
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        Some(row) => Some(NodeOwner {
            workspace_id: row.try_get("workspace_id")?,
            agent_id: None,
        }),
        None => None,
    })
}

/// Called once at start-up: nothing that survived a restart is live knowledge.
pub async fn mark_agent_status_restored(pool: &SqlitePool) -> AppResult<u64> {
    Ok(sqlx::query("UPDATE agent_status SET restored = 1")
        .execute(pool)
        .await?
        .rows_affected())
}
