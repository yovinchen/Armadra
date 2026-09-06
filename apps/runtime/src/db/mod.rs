//! The canvas database: the connection pool, the startup preflight, and one
//! module per table group. `mod.rs` only owns the shared schema vocabulary and
//! the wiring; every query lives in a sibling module and is re-exported here so
//! callers keep using `crate::db::*`.

use chrono::Utc;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};

use crate::error::{AppError, AppResult};

mod agent_status;
mod approvals;
mod boards;
mod context_links;
mod deliveries;
mod documents;
mod hook_installs;
mod legacy_archive;
mod sessions;
mod validation;
mod workspaces;

#[cfg(test)]
mod tests;

pub use self::{
    agent_status::*, approvals::*, boards::*, context_links::*, deliveries::*, documents::*,
    hook_installs::*, legacy_archive::*, sessions::*, validation::*, workspaces::*,
};

/// The node types a board is made of. Mirrored as `NODE_TYPES` in
/// packages/shared/src/domain.ts. Ink, text and images are whiteboard items
/// and live in `boards.whiteboard_json`, not here.
pub const NODE_TYPES: &[&str] = &[
    "terminal",
    "sticky",
    "group",
    "editor",
    "diff",
    "files",
    "browser",
    "automation",
    "agentActivity",
];

/// Schedule shapes an `automation` node may cache for display. The Host owns
/// the real schedule; this is only what the card draws while it is offline.
pub const AUTOMATION_SCHEDULE_KINDS: &[&str] = &["once", "interval", "cron", "loop"];
/// Where an `agentActivity` card's observations come from.
pub const AGENT_ACTIVITY_SOURCES: &[&str] = &["loop", "subagent"];

pub const EDGE_KINDS: &[&str] = &["link"];
pub const AGENT_STATES: &[&str] = &["working", "waiting", "blocked", "done"];
pub const PERMISSION_MODES: &[&str] = &["default", "auto-edit", "full-auto", "plan"];
pub const BUILTIN_AGENT_IDS: &[&str] = crate::agent::AGENT_IDS;
pub const DIFF_SCOPES: &[&str] = &["worktree", "staged"];

/// Whiteboard snapshot cap — docs/design/canvas-react-flow.md §3.1, mirrored
/// as `MAX_WHITEBOARD_BYTES` in packages/shared/src/domain.ts. Images travel
/// through the asset endpoint rather than inside the snapshot, so this only has
/// to hold ink, text and shape items.
pub const MAX_WHITEBOARD_BYTES: usize = 8 * 1024 * 1024;

pub async fn connect(database_url: &str) -> AppResult<SqlitePool> {
    let migrator = sqlx::migrate!("./migrations");
    // SQLx owns URL parsing, including percent-encoded filenames and all memory
    // modes. Never infer a filesystem path or rename a database from this URL.
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;
    if let Err(error) = initialize_database(&pool, &migrator).await {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

async fn initialize_database(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> AppResult<()> {
    // SQLx's SQLite migration lock is a no-op. One write transaction keeps the
    // read-only preflight and all migration writes on the same schema snapshot.
    // SQLx applies its individual migrations using nested savepoints here.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let result: AppResult<()> = async {
        preflight_database(&mut transaction, migrator).await?;
        migrator.run(&mut *transaction).await.map_err(|error| {
            AppError::Internal(format!("Could not migrate the local database: {error}"))
        })?;
        // A direct PTY died with the process that wrote the row. A tmux session
        // and a Windows session host session did not: `terminal::gc::reconcile`
        // decides what happened to those.
        sqlx::query(
            "UPDATE terminal_sessions SET status = 'failed', attach_state = 'exited', ended_at = ? \
         WHERE status = 'running' AND backend_kind NOT IN ('tmux', 'sessionHost')",
        )
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => transaction.commit().await?,
        Err(error) => {
            transaction.rollback().await?;
            return Err(error);
        }
    }
    Ok(())
}

/// Unknown or damaged history requires an explicit recovery/upgrade decision.
/// This check only reads schema and ledger data; it never creates or repairs the
/// migration table. SQLite may maintain journals normally, but rejection must
/// leave business data and the migration ledger unchanged.
async fn preflight_database(
    connection: &mut sqlx::SqliteConnection,
    migrator: &sqlx::migrate::Migrator,
) -> AppResult<()> {
    let objects: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .fetch_all(&mut *connection)
    .await?;
    let ledger = objects.iter().find(|(name, _)| name == "_sqlx_migrations");
    match ledger {
        None if objects.is_empty() => return Ok(()),
        None => return Err(AppError::Internal("Database has an unrecognized schema without a migration ledger; startup refused without changing its data".into())),
        Some((_, kind)) if kind != "table" => return Err(AppError::Internal("Database migration ledger is not a table; startup refused".into())),
        _ => {}
    }
    let columns = sqlx::query("PRAGMA table_info('_sqlx_migrations')")
        .fetch_all(&mut *connection)
        .await?;
    let expected = [
        "version",
        "description",
        "installed_on",
        "success",
        "checksum",
        "execution_time",
    ];
    if columns.len() != expected.len()
        || expected.iter().any(|name| {
            !columns.iter().any(|column| {
                column
                    .try_get::<String, _>("name")
                    .is_ok_and(|actual| actual == *name)
                    && column
                        .try_get::<i64, _>("pk")
                        .is_ok_and(|pk| pk == if *name == "version" { 1 } else { 0 })
                    && (*name == "version"
                        || column
                            .try_get::<i64, _>("notnull")
                            .is_ok_and(|required| required == 1))
            })
        })
    {
        return Err(AppError::Internal(
            "Database migration ledger has an unrecognized structure; startup refused".into(),
        ));
    }
    let applied = sqlx::query(
        "SELECT version, checksum, success, typeof(version) AS version_type, \
         typeof(checksum) AS checksum_type, typeof(success) AS success_type \
         FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(&mut *connection)
    .await?;
    if applied.is_empty() && objects.iter().any(|(name, _)| name != "_sqlx_migrations") {
        return Err(AppError::Internal(
            "Database schema has no recorded migrations; startup refused without changing its data"
                .into(),
        ));
    }
    let known = migrator
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .collect::<Vec<_>>();
    for (index, row) in applied.iter().enumerate() {
        if row.try_get::<String, _>("version_type")? != "integer"
            || row.try_get::<String, _>("checksum_type")? != "blob"
            || row.try_get::<String, _>("success_type")? != "integer"
        {
            return Err(AppError::Internal(
                "Database migration ledger contains invalid values; startup refused".into(),
            ));
        }
        let version: i64 = row.try_get("version")?;
        let success: i64 = row.try_get("success")?;
        if success != 1 {
            return Err(AppError::Internal(format!(
                "Database migration {version} is dirty or invalid; startup refused without changing its data"
            )));
        }
        let checksum: Vec<u8> = row.try_get("checksum")?;
        let Some(migration) = known.iter().find(|migration| migration.version == version) else {
            return Err(AppError::Internal(format!(
                "Database migration {version} is unknown to this build; startup refused without changing its data"
            )));
        };
        if migration.checksum.as_ref() != checksum.as_slice() {
            return Err(AppError::Internal(format!(
                "Database migration {version} checksum does not match this build; startup refused without changing its data"
            )));
        }
        if known
            .get(index)
            .is_none_or(|migration| migration.version != version)
        {
            return Err(AppError::Internal(
                "Database migration history is not a complete known prefix; startup refused".into(),
            ));
        }
    }
    Ok(())
}
