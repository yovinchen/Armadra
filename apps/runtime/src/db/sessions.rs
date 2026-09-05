//! The `terminal_sessions` table: lookups by id or key, attach state, the
//! backend reference and the sessions sidebar query.

use sqlx::{Row, SqlitePool};

use super::workspaces::get_workspace;
use crate::{
    error::{AppError, AppResult},
    model::SessionSummary,
};

// ---------------------------------------------------------------------------
// Terminal sessions
// ---------------------------------------------------------------------------

// Every column the API serializes, including the §15.2 backend columns. Spelled
// out in each query because sqlx only accepts `&'static str` SQL.

pub async fn get_terminal_session(
    pool: &SqlitePool,
    session_id: &str,
) -> AppResult<crate::model::TerminalSession> {
    sqlx::query_as::<_, crate::model::TerminalSession>(
        "SELECT id, workspace_id, cwd, shell, command, kind, owner_node_id, agent_id, status, \
         exit_code, created_at, ended_at, session_key, backend_kind, generation, attach_state, \
         last_output_at FROM terminal_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Terminal session was not found".into()))
}

/// The newest session for a logical key — what a restarted runtime re-adopts.
pub async fn get_terminal_session_by_key(
    pool: &SqlitePool,
    session_key: &str,
) -> AppResult<crate::model::TerminalSession> {
    sqlx::query_as::<_, crate::model::TerminalSession>(
        "SELECT id, workspace_id, cwd, shell, command, kind, owner_node_id, agent_id, status, \
         exit_code, created_at, ended_at, session_key, backend_kind, generation, attach_state, \
         last_output_at FROM terminal_sessions WHERE session_key = ? \
         ORDER BY generation DESC, created_at DESC LIMIT 1",
    )
    .bind(session_key)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Terminal session was not found".into()))
}

pub async fn terminal_attach_state(pool: &SqlitePool, session_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT attach_state FROM terminal_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

pub async fn terminal_backend_ref(
    pool: &SqlitePool,
    session_id: &str,
) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT backend_ref FROM terminal_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?
            .flatten(),
    )
}

/// Sessions sidebar payload: every terminal session that still has a node on a
/// board, joined with the agent status mirror. `alive` is filled in by the API
/// layer, which is the only place that knows about live PTYs.
pub async fn list_sessions(
    pool: &SqlitePool,
    workspace_id: &str,
) -> AppResult<Vec<SessionSummary>> {
    get_workspace(pool, workspace_id).await?;
    let rows = sqlx::query(
        "SELECT s.id AS session_id, s.cwd AS cwd, s.owner_node_id AS node_id, \
                s.agent_id AS session_agent_id, s.created_at AS created_at, \
                n.board_id AS board_id, n.title AS title, \
                st.agent_id AS status_agent_id, st.state AS state, st.unread AS unread, \
                st.pending_id AS pending_id, st.updated_at AS status_updated_at \
         FROM terminal_sessions s \
         JOIN nodes n ON n.id = s.owner_node_id \
         LEFT JOIN agent_status st ON st.node_id = s.owner_node_id \
         WHERE s.workspace_id = ? AND s.owner_node_id IS NOT NULL \
         ORDER BY s.created_at DESC LIMIT 500",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let unread: Option<i64> = row.try_get("unread")?;
            let status_updated_at: Option<String> = row.try_get("status_updated_at")?;
            let created_at: String = row.try_get("created_at")?;
            let status_agent_id: Option<String> = row.try_get("status_agent_id")?;
            let session_agent_id: Option<String> = row.try_get("session_agent_id")?;
            Ok(SessionSummary {
                node_id: row.try_get("node_id")?,
                board_id: row.try_get("board_id")?,
                session_id: row.try_get("session_id")?,
                kind: "terminal".into(),
                title: row.try_get("title")?,
                cwd: row.try_get("cwd")?,
                agent_id: status_agent_id.or(session_agent_id),
                state: row.try_get("state")?,
                unread: unread.unwrap_or(0) != 0,
                pending_id: row.try_get("pending_id")?,
                updated_at: status_updated_at.unwrap_or(created_at),
                alive: false,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}
