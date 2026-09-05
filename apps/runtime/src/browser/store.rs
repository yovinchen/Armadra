//! `browser_sessions` rows: what is enough to relaunch a session, and nothing
//! about what the page contains.

use chrono::Utc;
use sqlx::{Row, SqlitePool};

use crate::error::AppResult;

use super::{BrowserSession, SessionState, Viewport};

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
