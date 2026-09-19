//! `browser_sessions` rows: what is enough to relaunch a session, and nothing
//! about what the page contains.
//!
//! Migration 0010 added the process identity (`pid`, `pid_started_at`,
//! `cdp_port`), the lease generation and the active tab's URL, so a restarted
//! Runtime can tell its own still-running browser from a stranger that now
//! owns the profile (design §2.10).

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
    /// The browser process this row was last launched against, and the start
    /// time that says the number still means the same process. Both zero when
    /// nothing is running, and a zero start time is treated as *no* identity
    /// rather than as a match (§2.10).
    pub process: ProcessIdentity,
    /// The lease's generation counter, kept across restarts so a pre-restart
    /// generation cannot be mistaken for a current one (§2.6).
    pub lease_generation: u64,
    /// Only the active tab's URL survives a restart. The other tabs are not
    /// stored, and the node says so rather than pretending they came back.
    pub active_tab_url: String,
}

/// A process id is not an identity on its own — the number gets reused — so
/// it is only ever trusted together with the start time the operating system
/// reports for that same process.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// Milliseconds since the epoch. Zero means "not recorded".
    pub started_at_unix_ms: i64,
    /// The loopback DevTools port a re-attach can try before reading
    /// `DevToolsActivePort` out of the profile.
    pub cdp_port: u16,
}

impl ProcessIdentity {
    /// True when this row claims a browser that could still be running.
    pub fn is_recorded(self) -> bool {
        self.pid != 0 && self.started_at_unix_ms != 0
    }
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
            process: ProcessIdentity {
                pid: row.get::<i64, _>("pid").clamp(0, i64::from(u32::MAX)) as u32,
                started_at_unix_ms: row.get::<i64, _>("pid_started_at").max(0),
                cdp_port: row.get::<i64, _>("cdp_port").clamp(0, i64::from(u16::MAX)) as u16,
            },
            lease_generation: row.get::<i64, _>("lease_generation").max(0) as u64,
            active_tab_url: row.get("active_tab_url"),
        }
    }
}

/// Every column of a stored session, written out once per query because sqlx
/// only accepts literal SQL.
const SELECT: &str = "SELECT id, workspace_id, node_id, url, title, viewport_width, \
     viewport_height, device_scale_factor, profile_dir, headful, keep_alive, generation, \
     state, reason_code, created_at, updated_at, pid, pid_started_at, cdp_port, \
     lease_generation, active_tab_url FROM browser_sessions";

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
         state, reason_code, created_at, updated_at, pid, pid_started_at, cdp_port, \
         lease_generation, active_tab_url) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
    .bind(i64::from(session.process.pid))
    .bind(session.process.started_at_unix_ms)
    .bind(i64::from(session.process.cdp_port))
    .bind(session.lease_generation as i64)
    .bind(&session.active_tab_url)
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

/// Records the browser this session was just launched against, or clears the
/// identity on an orderly exit. Separate from [`persist`] because it is the
/// process that changed, not what the page is showing.
pub async fn persist_process(
    pool: &SqlitePool,
    session_id: &str,
    process: ProcessIdentity,
    active_tab_url: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE browser_sessions SET pid = ?, pid_started_at = ?, cdp_port = ?, \
         active_tab_url = ?, updated_at = ? WHERE id = ?",
    )
    .bind(i64::from(process.pid))
    .bind(process.started_at_unix_ms)
    .bind(i64::from(process.cdp_port))
    .bind(active_tab_url)
    .bind(Utc::now().to_rfc3339())
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Records where the active tab is now.
///
/// Its own statement rather than part of [`persist_process`] because under the
/// Electron shell there is no process of ours to record: the page is a guest in
/// the window, and this column is the only thing about it this side stores.
/// It is also the reason the column has ONE writer — the node's own `data.url`
/// is what the page draws, and a second writer would be a second truth.
pub async fn persist_active_tab_url(
    pool: &SqlitePool,
    session_id: &str,
    url: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE browser_sessions SET active_tab_url = ?, updated_at = ? WHERE id = ?")
        .bind(url)
        .bind(Utc::now().to_rfc3339())
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Moves the lease generation forward. It is stored rather than derived so a
/// client that slept through a restart cannot present a generation that has
/// come back around to being current.
pub async fn persist_lease_generation(
    pool: &SqlitePool,
    session_id: &str,
    generation: u64,
) -> AppResult<()> {
    sqlx::query("UPDATE browser_sessions SET lease_generation = ? WHERE id = ?")
        .bind(generation as i64)
        .bind(session_id)
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
