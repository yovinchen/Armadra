use chrono::Utc;
use serde_json::Value;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::{
        AgentApproval, AgentDelivery, AgentStatus, Board, BoardBrief, BoardDocument, CanvasEdge,
        CanvasNode, ContextLink, ContextLinkDocument, DEFAULT_BOARD_NAME, DEFAULT_WORKSPACE_COLOR,
        HookInstall, Position, SessionSummary, Size, Viewport, Workspace, WorkspacePermissions,
        WorkspaceSummary,
    },
};

/// The node types a board is made of. Mirrored as `NODE_TYPES` in
/// packages/shared/src/domain.ts. Ink, text and images are whiteboard-native
/// tldraw shapes and live in `boards.whiteboard_json`, not here.
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

fn legacy_archive_summary(
    row: &sqlx::sqlite::SqliteRow,
) -> AppResult<crate::model::LegacyKanbanArchiveSummary> {
    Ok(crate::model::LegacyKanbanArchiveSummary {
        canvas_id: row.try_get("canvas_id")?,
        workspace_id: row.try_get("workspace_id")?,
        workspace_name: row.try_get("workspace_name")?,
        canvas_name: row.try_get("canvas_name")?,
        archived_at: row.try_get("archived_at")?,
        kanban_bytes: row
            .try_get::<i64, _>("kanban_bytes")?
            .try_into()
            .map_err(|_| AppError::Internal("Invalid archive length".into()))?,
        label_count: row
            .try_get::<i64, _>("label_count")?
            .try_into()
            .map_err(|_| AppError::Internal("Invalid archive count".into()))?,
    })
}

/// Global local-data management; callers must not infer this authority from a
/// live project's read permission. Deleted projects retain their snapshots.
pub async fn list_legacy_kanban_archives(
    pool: &SqlitePool,
    cursor: Option<&str>,
    limit: u32,
) -> AppResult<crate::model::LegacyKanbanArchivePage> {
    if limit == 0 || limit > 200 {
        return Err(AppError::BadRequest(
            "Archive page size must be between 1 and 200".into(),
        ));
    }
    let rows=sqlx::query("SELECT a.canvas_id,a.workspace_id,a.workspace_name,a.canvas_name,a.archived_at, \
        length(CAST(a.kanban_json AS BLOB)) AS kanban_bytes, \
        (SELECT count(*) FROM legacy_node_label_archives l WHERE l.canvas_id=a.canvas_id) AS label_count \
        FROM legacy_kanban_archives a WHERE (? IS NULL OR a.canvas_id > ?) ORDER BY a.canvas_id LIMIT ?")
        .bind(cursor).bind(cursor).bind(i64::from(limit)+1).fetch_all(pool).await?;
    let more = rows.len() > limit as usize;
    let archives = rows
        .iter()
        .take(limit as usize)
        .map(legacy_archive_summary)
        .collect::<AppResult<Vec<_>>>()?;
    let next_cursor = if more {
        archives.last().map(|record| record.canvas_id.clone())
    } else {
        None
    };
    Ok(crate::model::LegacyKanbanArchivePage {
        archives,
        next_cursor,
    })
}

pub async fn get_legacy_kanban_archive(
    pool: &SqlitePool,
    canvas_id: &str,
) -> AppResult<crate::model::LegacyKanbanArchive> {
    use sha2::{Digest, Sha256};
    let row=sqlx::query("SELECT a.*, length(CAST(a.kanban_json AS BLOB)) AS kanban_bytes, \
        (SELECT count(*) FROM legacy_node_label_archives l WHERE l.canvas_id=a.canvas_id) AS label_count \
        FROM legacy_kanban_archives a WHERE a.canvas_id=?")
        .bind(canvas_id).fetch_optional(pool).await?.ok_or_else(||AppError::NotFound("Historical archive not found".into()))?;
    let raw: String = row.try_get("kanban_json")?;
    let labels=sqlx::query_as::<_,crate::model::LegacyNodeLabelArchive>("SELECT node_id,canvas_id,workspace_id,node_title,node_type,labels_json,note,node_created_at,node_updated_at,archived_at FROM legacy_node_label_archives WHERE canvas_id=? ORDER BY node_id")
        .bind(canvas_id).fetch_all(pool).await?;
    Ok(crate::model::LegacyKanbanArchive {
        summary: legacy_archive_summary(&row)?,
        kanban_sha256: format!("{:x}", Sha256::digest(raw.as_bytes())),
        kanban_json: raw,
        canvas_created_at: row.try_get("canvas_created_at")?,
        canvas_updated_at: row.try_get("canvas_updated_at")?,
        labels,
    })
}

pub const EDGE_KINDS: &[&str] = &["link"];
pub const AGENT_STATES: &[&str] = &["working", "waiting", "blocked", "done"];
pub const PERMISSION_MODES: &[&str] = &["default", "auto-edit", "full-auto", "plan"];
pub const BUILTIN_AGENT_IDS: &[&str] = crate::agent::AGENT_IDS;
pub const DIFF_SCOPES: &[&str] = &["worktree", "staged"];

const MAX_STICKY_CONTENT: usize = 20_000;
/// Whiteboard snapshot cap — tldraw plan §6.1, mirrored as
/// `MAX_WHITEBOARD_BYTES` in packages/shared/src/domain.ts. Images travel
/// through the asset endpoint rather than inside the snapshot, so this only has
/// to hold ink, text and shape records.
pub const MAX_WHITEBOARD_BYTES: usize = 8 * 1024 * 1024;
/* Node annotation bounds, mirrored in packages/shared. */
const MAX_NODE_LABELS: usize = 8;
const MAX_NODE_LABEL_CHARS: usize = 24;
const MAX_NODE_NOTE_CHARS: usize = 4_000;
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

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

fn workspace_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Workspace, sqlx::Error> {
    let permissions_json: String = row.try_get("permissions_json")?;
    let permissions = serde_json::from_str::<WorkspacePermissions>(&permissions_json)
        .unwrap_or_else(|_| WorkspacePermissions::default());
    Ok(Workspace {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        root_path: row.try_get("root_path")?,
        color: row.try_get("color")?,
        permissions,
        // The column is nullable; every read coalesces it so the wire contract
        // keeps `lastOpenedAt` non-null.
        last_opened_at: row.try_get("last_opened_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn create_workspace(
    pool: &SqlitePool,
    name: &str,
    root_path: &str,
    color: Option<&str>,
    permissions: Option<&WorkspacePermissions>,
) -> AppResult<Workspace> {
    let id = Uuid::now_v7().to_string();
    let board_id = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    let color = normalize_color(color)?;
    let permissions = permissions.cloned().unwrap_or_default();
    let permissions_json = serde_json::to_string(&permissions)
        .map_err(|error| AppError::Internal(error.to_string()))?;

    let mut transaction = pool.begin().await?;
    let result = sqlx::query(
        "INSERT INTO workspaces (id, name, root_path, color, permissions_json, last_opened_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_path) DO NOTHING",
    )
    .bind(&id)
    .bind(name)
    .bind(root_path)
    .bind(&color)
    .bind(&permissions_json)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        transaction.rollback().await?;
        return get_workspace_by_root(pool, root_path).await;
    }
    sqlx::query(
        "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, created_at, updated_at) \
         VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(&board_id)
    .bind(&id)
    .bind(DEFAULT_BOARD_NAME)
    .bind(serde_json::to_string(&Viewport::default()).expect("viewport serializes"))
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    Ok(Workspace {
        id,
        name: name.to_owned(),
        root_path: root_path.to_owned(),
        color,
        permissions,
        last_opened_at: now.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn list_workspaces(pool: &SqlitePool) -> AppResult<Vec<WorkspaceSummary>> {
    let rows = sqlx::query(
        "SELECT id, name, root_path, color, permissions_json, \
          COALESCE(last_opened_at, updated_at) AS last_opened_at, created_at, updated_at \
         FROM workspaces ORDER BY COALESCE(last_opened_at, updated_at) DESC, created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    let workspaces = rows
        .iter()
        .map(workspace_from_row)
        .collect::<Result<Vec<_>, _>>()?;

    let brief_rows = sqlx::query(
        "SELECT b.workspace_id AS workspace_id, b.id AS id, b.name AS name, \
         (SELECT COUNT(*) FROM nodes n WHERE n.board_id = b.id) AS node_count \
         FROM boards b ORDER BY b.sort_order, b.created_at",
    )
    .fetch_all(pool)
    .await?;

    let mut summaries = workspaces
        .into_iter()
        .map(|workspace| WorkspaceSummary {
            workspace,
            boards: Vec::new(),
        })
        .collect::<Vec<_>>();
    for row in brief_rows {
        let workspace_id: String = row.try_get("workspace_id")?;
        if let Some(summary) = summaries
            .iter_mut()
            .find(|summary| summary.workspace.id == workspace_id)
        {
            summary.boards.push(BoardBrief {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                node_count: row.try_get("node_count")?,
            });
        }
    }
    Ok(summaries)
}

pub async fn get_workspace(pool: &SqlitePool, id: &str) -> AppResult<Workspace> {
    let row = sqlx::query(
        "SELECT id, name, root_path, color, permissions_json, \
          COALESCE(last_opened_at, updated_at) AS last_opened_at, created_at, updated_at \
         FROM workspaces WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Workspace was not found".into()))?;
    Ok(workspace_from_row(&row)?)
}

pub async fn get_workspace_by_root(pool: &SqlitePool, root_path: &str) -> AppResult<Workspace> {
    let row = sqlx::query(
        "SELECT id, name, root_path, color, permissions_json, \
          COALESCE(last_opened_at, updated_at) AS last_opened_at, created_at, updated_at \
         FROM workspaces WHERE root_path = ?",
    )
    .bind(root_path)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Workspace was not found".into()))?;
    Ok(workspace_from_row(&row)?)
}

pub struct WorkspacePatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub permissions: Option<WorkspacePermissions>,
}

pub async fn update_workspace(
    pool: &SqlitePool,
    id: &str,
    patch: WorkspacePatch,
) -> AppResult<Workspace> {
    let current = get_workspace(pool, id).await?;
    let name = match patch.name {
        Some(name) => {
            let name = name.trim().to_owned();
            if name.is_empty() || name.chars().count() > 120 {
                return Err(AppError::BadRequest("Workspace name is invalid".into()));
            }
            name
        }
        None => current.name,
    };
    let color = match patch.color {
        Some(color) => normalize_color(Some(&color))?,
        None => current.color,
    };
    let permissions = patch.permissions.unwrap_or(current.permissions);
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE workspaces SET name = ?, color = ?, permissions_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(&color)
    .bind(serde_json::to_string(&permissions).map_err(|error| AppError::Internal(error.to_string()))?)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    get_workspace(pool, id).await
}

/// 从列表移除 (plan §20): the workspace row and everything the schema hangs off
/// it — boards → nodes/edges, terminal sessions → logs, agent status,
/// approvals, context links, deliveries — go away through `ON DELETE CASCADE`.
///
/// Nothing under `root_path` is touched: this removes the entry, not the
/// project. Terminating the live sessions is the caller's job (the API layer
/// owns the `TerminalManager`), and it has to happen before this call — the
/// cascade drops the rows that say which sessions existed.
pub async fn delete_workspace(pool: &SqlitePool, id: &str) -> AppResult<()> {
    let result = sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Workspace was not found".into()));
    }
    Ok(())
}

pub async fn touch_workspace_opened(pool: &SqlitePool, id: &str) -> AppResult<Workspace> {
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Workspace was not found".into()));
    }
    get_workspace(pool, id).await
}

fn normalize_color(color: Option<&str>) -> AppResult<String> {
    let Some(color) = color else {
        return Ok(DEFAULT_WORKSPACE_COLOR.to_owned());
    };
    let color = color.trim();
    if !is_hex_color(color) {
        return Err(AppError::BadRequest(
            "Workspace color must be a #RRGGBB value".into(),
        ));
    }
    Ok(color.to_ascii_uppercase())
}

fn is_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

fn board_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Board, sqlx::Error> {
    let viewport_json: String = row.try_get("viewport_json")?;
    Ok(Board {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        name: row.try_get("name")?,
        sort_order: row.try_get("sort_order")?,
        viewport: serde_json::from_str(&viewport_json).unwrap_or_default(),
        // Opaque to the runtime (0009): whatever the client stored comes back
        // byte for byte, so there is nothing here to parse or repair.
        whiteboard: row.try_get("whiteboard_json")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn list_boards(pool: &SqlitePool, workspace_id: &str) -> AppResult<Vec<Board>> {
    get_workspace(pool, workspace_id).await?;
    let rows = sqlx::query(
        "SELECT id, workspace_id, name, sort_order, viewport_json, whiteboard_json, \
         created_at, updated_at \
         FROM boards WHERE workspace_id = ? ORDER BY sort_order, created_at",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(board_from_row)
        .collect::<Result<Vec<_>, _>>()?)
}

pub async fn get_board(pool: &SqlitePool, workspace_id: &str, board_id: &str) -> AppResult<Board> {
    let row = sqlx::query(
        "SELECT id, workspace_id, name, sort_order, viewport_json, whiteboard_json, \
         created_at, updated_at FROM boards WHERE id = ? AND workspace_id = ?",
    )
    .bind(board_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Board was not found".into()))?;
    Ok(board_from_row(&row)?)
}

fn validate_board_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::BadRequest("Board name is invalid".into()));
    }
    Ok(name.to_owned())
}

pub async fn create_board(pool: &SqlitePool, workspace_id: &str, name: &str) -> AppResult<Board> {
    get_workspace(pool, workspace_id).await?;
    let name = validate_board_name(name)?;
    let id = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    let next_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM boards WHERE workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
    sqlx::query(
        "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(workspace_id)
    .bind(&name)
    .bind(next_order)
    .bind(serde_json::to_string(&Viewport::default()).expect("viewport serializes"))
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    get_board(pool, workspace_id, &id).await
}

pub async fn update_board(
    pool: &SqlitePool,
    workspace_id: &str,
    board_id: &str,
    name: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<Board> {
    let current = get_board(pool, workspace_id, board_id).await?;
    let name = match name {
        Some(name) => validate_board_name(&name)?,
        None => current.name,
    };
    let sort_order = match sort_order {
        Some(order) if !(0..=10_000).contains(&order) => {
            return Err(AppError::BadRequest("Board order is out of range".into()));
        }
        Some(order) => order,
        None => current.sort_order,
    };
    sqlx::query("UPDATE boards SET name = ?, sort_order = ? WHERE id = ? AND workspace_id = ?")
        .bind(&name)
        .bind(sort_order)
        .bind(board_id)
        .bind(workspace_id)
        .execute(pool)
        .await?;
    get_board(pool, workspace_id, board_id).await
}

pub async fn delete_board(pool: &SqlitePool, workspace_id: &str, board_id: &str) -> AppResult<()> {
    get_board(pool, workspace_id, board_id).await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM boards WHERE workspace_id = ?")
        .bind(workspace_id)
        .fetch_one(pool)
        .await?;
    if total <= 1 {
        return Err(AppError::Conflict(
            "A workspace must keep at least one board".into(),
        ));
    }
    sqlx::query("DELETE FROM boards WHERE id = ? AND workspace_id = ?")
        .bind(board_id)
        .bind(workspace_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Board documents
// ---------------------------------------------------------------------------

pub async fn load_board(
    pool: &SqlitePool,
    workspace_id: &str,
    board_id: &str,
) -> AppResult<BoardDocument> {
    let board = get_board(pool, workspace_id, board_id).await?;

    let node_rows = sqlx::query(
        "SELECT id, board_id, type, title, color, x, y, width, height, collapsed, expanded_height, \
                parent_id, labels_json, note, data_json, created_at, updated_at \
         FROM nodes WHERE board_id = ? ORDER BY created_at",
    )
    .bind(&board.id)
    .fetch_all(pool)
    .await?;
    let nodes = node_rows
        .into_iter()
        .map(|row| {
            let data_json: String = row.try_get("data_json")?;
            let collapsed: i64 = row.try_get("collapsed")?;
            // Same reasoning as the board's kanban blob: a label list we cannot
            // decode is a missing chip, not a board that refuses to open.
            let labels_json: String = row.try_get("labels_json")?;
            Ok(CanvasNode {
                id: row.try_get("id")?,
                board_id: row.try_get("board_id")?,
                node_type: row.try_get("type")?,
                title: row.try_get("title")?,
                color: row.try_get("color")?,
                position: Position {
                    x: row.try_get("x")?,
                    y: row.try_get("y")?,
                },
                size: match (row.try_get("width")?, row.try_get("height")?) {
                    (Some(width), Some(height)) => Some(Size { width, height }),
                    _ => None,
                },
                collapsed: (collapsed != 0).then_some(true),
                expanded_height: row.try_get("expanded_height")?,
                parent_id: row.try_get("parent_id")?,
                labels: serde_json::from_str(&labels_json).unwrap_or_default(),
                note: row.try_get("note")?,
                data: serde_json::from_str(&data_json)
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let edge_rows = sqlx::query(
        "SELECT id, board_id, source_node_id, target_node_id, kind, created_at, updated_at \
         FROM edges WHERE board_id = ? ORDER BY created_at",
    )
    .bind(&board.id)
    .fetch_all(pool)
    .await?;
    let edges = edge_rows
        .into_iter()
        .map(|row| {
            Ok(CanvasEdge {
                id: row.try_get("id")?,
                board_id: row.try_get("board_id")?,
                source: row.try_get("source_node_id")?,
                target: row.try_get("target_node_id")?,
                kind: row.try_get("kind")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    Ok(BoardDocument {
        board,
        nodes,
        edges,
    })
}

pub struct SaveBoardRequest<'a> {
    pub expected_updated_at: &'a str,
    pub nodes: &'a [CanvasNode],
    pub edges: &'a [CanvasEdge],
    pub viewport: Viewport,
    /// Omitting the drawing snapshot preserves the stored whiteboard.
    pub whiteboard: Option<&'a str>,
}

pub async fn save_board(
    pool: &SqlitePool,
    workspace_id: &str,
    board_id: &str,
    request: SaveBoardRequest<'_>,
) -> AppResult<BoardDocument> {
    let board = get_board(pool, workspace_id, board_id).await?;
    validate_document(&board.id, request.nodes, request.edges)?;
    validate_viewport(&request.viewport)?;

    let viewport_json = serde_json::to_string(&request.viewport)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let whiteboard = match request.whiteboard {
        Some(snapshot) => {
            validate_whiteboard(snapshot)?;
            snapshot
        }
        None => board.whiteboard.as_str(),
    };

    let mut transaction = pool.begin().await?;
    let next_updated_at = Utc::now().to_rfc3339();
    let updated = sqlx::query(
        "UPDATE boards SET updated_at = ?, viewport_json = ?, whiteboard_json = ? \
         WHERE id = ? AND updated_at = ?",
    )
    .bind(&next_updated_at)
    .bind(&viewport_json)
    .bind(whiteboard)
    .bind(&board.id)
    .bind(request.expected_updated_at)
    .execute(&mut *transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "Board changed since it was loaded; reload before saving".into(),
        ));
    }
    sqlx::query("DELETE FROM edges WHERE board_id = ?")
        .bind(&board.id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM nodes WHERE board_id = ?")
        .bind(&board.id)
        .execute(&mut *transaction)
        .await?;

    for node in request.nodes {
        sqlx::query(
            "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, collapsed, \
                                expanded_height, parent_id, labels_json, note, data_json, \
                                created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&node.id)
        .bind(&node.board_id)
        .bind(&node.node_type)
        .bind(&node.title)
        .bind(&node.color)
        .bind(node.position.x)
        .bind(node.position.y)
        .bind(node.size.as_ref().map(|size| size.width))
        .bind(node.size.as_ref().map(|size| size.height))
        .bind(i64::from(node.collapsed.unwrap_or(false)))
        .bind(node.expanded_height)
        .bind(&node.parent_id)
        .bind(
            serde_json::to_string(&node.labels)
                .map_err(|error| AppError::BadRequest(error.to_string()))?,
        )
        .bind(&node.note)
        .bind(
            serde_json::to_string(&node.data)
                .map_err(|error| AppError::BadRequest(error.to_string()))?,
        )
        .bind(&node.created_at)
        .bind(&node.updated_at)
        .execute(&mut *transaction)
        .await?;
    }
    for edge in request.edges {
        sqlx::query(
            "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&edge.id)
        .bind(&edge.board_id)
        .bind(&edge.source)
        .bind(&edge.target)
        .bind(&edge.kind)
        .bind(&edge.created_at)
        .bind(&edge.updated_at)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    load_board(pool, workspace_id, board_id).await
}

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

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

fn approval_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<AgentApproval, sqlx::Error> {
    let request_json: String = row.try_get("request_json")?;
    Ok(AgentApproval {
        id: row.try_get("id")?,
        node_id: row.try_get("node_id")?,
        workspace_id: row.try_get("workspace_id")?,
        request: serde_json::from_str(&request_json).unwrap_or(Value::Null),
        answer: row.try_get("answer")?,
        answered_by: row.try_get("answered_by")?,
        created_at: row.try_get("created_at")?,
        answered_at: row.try_get("answered_at")?,
    })
}

pub async fn insert_approval(
    pool: &SqlitePool,
    pending_id: &str,
    node_id: &str,
    workspace_id: &str,
    request: &Value,
) -> AppResult<AgentApproval> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at) \
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(pending_id)
    .bind(node_id)
    .bind(workspace_id)
    .bind(serde_json::to_string(request).map_err(|error| AppError::BadRequest(error.to_string()))?)
    .bind(&now)
    .execute(pool)
    .await?;
    get_approval(pool, pending_id).await
}

pub async fn get_approval(pool: &SqlitePool, pending_id: &str) -> AppResult<AgentApproval> {
    let row = sqlx::query(
        "SELECT id, node_id, workspace_id, request_json, answer, answered_by, created_at, answered_at \
         FROM agent_approvals WHERE id = ?",
    )
    .bind(pending_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Approval request was not found".into()))?;
    Ok(approval_from_row(&row)?)
}

/// Records the user's decision. Answering twice is a conflict, not a silent
/// overwrite: the first answer is the one the CLI already acted on.
pub async fn answer_approval(
    pool: &SqlitePool,
    pending_id: &str,
    answer: &str,
    answered_by: Option<&str>,
) -> AppResult<AgentApproval> {
    if !["allow", "deny"].contains(&answer) {
        return Err(AppError::BadRequest(
            "Approval decision must be allow or deny".into(),
        ));
    }
    let existing = get_approval(pool, pending_id).await?;
    if existing.answer.is_some() {
        return Err(AppError::Conflict(
            "Approval request was already answered".into(),
        ));
    }
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE agent_approvals SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answer IS NULL",
    )
    .bind(answer)
    .bind(answered_by)
    .bind(&now)
    .bind(pending_id)
    .execute(pool)
    .await?;
    get_approval(pool, pending_id).await
}

// ---------------------------------------------------------------------------
// Context links
// ---------------------------------------------------------------------------

pub async fn put_context_links(
    pool: &SqlitePool,
    workspace_id: &str,
    node_id: &str,
    links: &[ContextLink],
) -> AppResult<ContextLinkDocument> {
    if links.len() > 64 {
        return Err(AppError::BadRequest(
            "A node cannot link more than 64 other nodes".into(),
        ));
    }
    for link in links {
        if let Some(content) = &link.content
            && (content
                .status
                .as_deref()
                .is_some_and(|status| !["pending", "ready", "error"].contains(&status))
                || content
                    .source_shape_id
                    .as_ref()
                    .is_some_and(|id| id.len() > 160)
                || content
                    .shape_type
                    .as_ref()
                    .is_some_and(|kind| kind.len() > 40))
        {
            return Err(AppError::BadRequest(
                "Invalid whiteboard reference metadata".into(),
            ));
        }
        if Uuid::parse_str(&link.id).is_err() || link.title.len() > 160 || link.kind.len() > 40 {
            return Err(AppError::BadRequest("Context link is invalid".into()));
        }
        // A `shape` link carries its own readable payload (tldraw plan §6.3);
        // it is stored verbatim and later handed to an agent, so bound it here
        // rather than trusting whatever the canvas serialized.
        if let Some(content) = &link.content
            && (content
                .text
                .as_ref()
                .is_some_and(|text| text.len() > 20_000)
                || content
                    .png_path
                    .as_ref()
                    .is_some_and(|path| path.len() > 4_096))
        {
            return Err(AppError::BadRequest(
                "Context link content is too large".into(),
            ));
        }
    }
    let links_json =
        serde_json::to_string(links).map_err(|error| AppError::BadRequest(error.to_string()))?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO context_links (node_id, workspace_id, links_json, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, \
           links_json = excluded.links_json, updated_at = excluded.updated_at",
    )
    .bind(node_id)
    .bind(workspace_id)
    .bind(&links_json)
    .bind(&now)
    .execute(pool)
    .await?;
    get_context_links(pool, node_id).await
}

pub async fn get_context_links(pool: &SqlitePool, node_id: &str) -> AppResult<ContextLinkDocument> {
    let row =
        sqlx::query("SELECT node_id, links_json, updated_at FROM context_links WHERE node_id = ?")
            .bind(node_id)
            .fetch_optional(pool)
            .await?;
    let Some(row) = row else {
        return Ok(ContextLinkDocument {
            node_id: node_id.to_owned(),
            links: vec![],
            updated_at: Utc::now().to_rfc3339(),
        });
    };
    let links_json: String = row.try_get("links_json")?;
    Ok(ContextLinkDocument {
        node_id: row.try_get("node_id")?,
        links: serde_json::from_str(&links_json).unwrap_or_default(),
        updated_at: row.try_get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Message deliveries
// ---------------------------------------------------------------------------

pub struct DeliveryRecord<'a> {
    pub trace_id: &'a str,
    pub workspace_id: &'a str,
    pub source_node_id: &'a str,
    pub target_node_id: &'a str,
    pub outcome: &'a str,
    pub receipt: Option<&'a str>,
    pub body_chars: i64,
}

pub async fn insert_delivery(pool: &SqlitePool, record: DeliveryRecord<'_>) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_deliveries (trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt, body_chars, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trace_id) DO NOTHING",
    )
    .bind(record.trace_id)
    .bind(record.workspace_id)
    .bind(record.source_node_id)
    .bind(record.target_node_id)
    .bind(record.outcome)
    .bind(record.receipt)
    .bind(record.body_chars)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_deliveries(
    pool: &SqlitePool,
    workspace_id: &str,
    limit: i64,
) -> AppResult<Vec<AgentDelivery>> {
    let rows = sqlx::query(
        "SELECT trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt, body_chars, created_at \
         FROM agent_deliveries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(workspace_id)
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(AgentDelivery {
                trace_id: row.try_get("trace_id")?,
                workspace_id: row.try_get("workspace_id")?,
                source_node_id: row.try_get("source_node_id")?,
                target_node_id: row.try_get("target_node_id")?,
                outcome: row.try_get("outcome")?,
                receipt: row.try_get("receipt")?,
                body_chars: row.try_get("body_chars")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

// ---------------------------------------------------------------------------
// Hook installs
// ---------------------------------------------------------------------------

pub async fn upsert_hook_install(
    pool: &SqlitePool,
    agent_id: &str,
    client_revision: i64,
    config_path: Option<&str>,
) -> AppResult<HookInstall> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO hook_installs (agent_id, client_revision, installed_at, config_path) VALUES (?, ?, ?, ?) \
         ON CONFLICT(agent_id) DO UPDATE SET client_revision = excluded.client_revision, \
           installed_at = excluded.installed_at, config_path = excluded.config_path",
    )
    .bind(agent_id)
    .bind(client_revision)
    .bind(&now)
    .bind(config_path)
    .execute(pool)
    .await?;
    Ok(HookInstall {
        agent_id: agent_id.to_owned(),
        client_revision,
        installed_at: now,
        config_path: config_path.map(str::to_owned),
    })
}

pub async fn remove_hook_install(pool: &SqlitePool, agent_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM hook_installs WHERE agent_id = ?")
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_hook_installs(pool: &SqlitePool) -> AppResult<Vec<HookInstall>> {
    let rows = sqlx::query(
        "SELECT agent_id, client_revision, installed_at, config_path FROM hook_installs",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(HookInstall {
                agent_id: row.try_get("agent_id")?,
                client_revision: row.try_get("client_revision")?,
                installed_at: row.try_get("installed_at")?,
                config_path: row.try_get("config_path")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_viewport(viewport: &Viewport) -> AppResult<()> {
    let valid = viewport.x.is_finite()
        && viewport.y.is_finite()
        && viewport.zoom.is_finite()
        && viewport.zoom > 0.0
        && viewport.zoom <= 16.0;
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest("Board viewport is invalid".into()))
    }
}

pub fn validate_document(
    board_id: &str,
    nodes: &[CanvasNode],
    edges: &[CanvasEdge],
) -> AppResult<()> {
    let node_ids = nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let group_ids = nodes
        .iter()
        .filter(|node| node.node_type == "group")
        .map(|node| node.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    for node in nodes {
        let kind = node.data.get("kind").and_then(Value::as_str);
        let valid_identity = Uuid::parse_str(&node.id).is_ok()
            && Uuid::parse_str(&node.board_id).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&node.created_at).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&node.updated_at).is_ok();
        let valid_geometry = node.position.x.is_finite()
            && node.position.y.is_finite()
            && node.size.as_ref().is_none_or(|size| {
                size.width.is_finite()
                    && size.height.is_finite()
                    && size.width > 0.0
                    && size.height > 0.0
            })
            && node
                .expanded_height
                .is_none_or(|height| height.is_finite() && height > 0.0);
        let valid_header = !node.title.is_empty()
            && node.title.chars().count() <= 160
            && is_hex_color(&node.color);
        // Labels are a filter, not a field: eight short chips at most, none of
        // them blank. The note is prose and only has an upper bound.
        let valid_annotations = node.labels.len() <= MAX_NODE_LABELS
            && node.labels.iter().all(|label| {
                let label = label.trim();
                !label.is_empty() && label.chars().count() <= MAX_NODE_LABEL_CHARS
            })
            && node.note.chars().count() <= MAX_NODE_NOTE_CHARS;
        // A child may only live inside a group that is part of the same save.
        let valid_parent = node.parent_id.as_deref().is_none_or(|parent| {
            parent != node.id && group_ids.contains(parent) && Uuid::parse_str(parent).is_ok()
        });
        if node.board_id != board_id
            || !NODE_TYPES.contains(&node.node_type.as_str())
            || kind != Some(&node.node_type)
            || !valid_identity
            || !valid_geometry
            || !valid_header
            || !valid_annotations
            || !valid_parent
            || !valid_node_data(node)
        {
            return Err(AppError::BadRequest(
                "Board contains an invalid node".into(),
            ));
        }
    }
    for edge in edges {
        let valid_identity = Uuid::parse_str(&edge.id).is_ok()
            && Uuid::parse_str(&edge.board_id).is_ok()
            && Uuid::parse_str(&edge.source).is_ok()
            && Uuid::parse_str(&edge.target).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&edge.created_at).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&edge.updated_at).is_ok();
        if edge.board_id != board_id
            || !EDGE_KINDS.contains(&edge.kind.as_str())
            || !node_ids.contains(edge.source.as_str())
            || !node_ids.contains(edge.target.as_str())
            || !valid_identity
        {
            return Err(AppError::BadRequest(
                "Board contains an invalid or dangling edge".into(),
            ));
        }
    }
    Ok(())
}

/// The snapshot is opaque, so the only thing worth checking is its size: an
/// unbounded blob would be written straight into the row on every autosave.
pub fn validate_whiteboard(snapshot: &str) -> AppResult<()> {
    if snapshot.len() > MAX_WHITEBOARD_BYTES {
        return Err(AppError::BadRequest(
            "Whiteboard snapshot is too large".into(),
        ));
    }
    Ok(())
}

pub fn valid_node_data(node: &CanvasNode) -> bool {
    let data = &node.data;
    match node.node_type.as_str() {
        "terminal" => {
            optional_bounded_string(data, "cwd", 4_000)
                && optional_bounded_string(data, "shell", 1_024)
                && optional_uuid_field(data, "sessionId")
                && data
                    .get("lastExitCode")
                    .is_none_or(|value| value.is_null() || value.as_i64().is_some())
                && data
                    .get("agent")
                    .is_none_or(|value| value.is_null() || valid_agent_block(value))
        }
        "sticky" => bounded_string_field(data, "content", MAX_STICKY_CONTENT),
        // The label is `node.title` and the tint is `node.color`; the payload
        // carries nothing else.
        "group" => true,
        "editor" => {
            string_field(data, "path")
                && optional_bounded_string(data, "language", 40)
                && data
                    .get("readonly")
                    .is_none_or(|value| value.is_null() || value.is_boolean())
        }
        "diff" => {
            string_field(data, "repoPath")
                && data
                    .get("scope")
                    .and_then(Value::as_str)
                    .is_some_and(|scope| DIFF_SCOPES.contains(&scope))
                && data.get("paths").is_none_or(|value| {
                    value.is_null()
                        || value.as_array().is_some_and(|paths| {
                            paths.len() <= 1_000 && paths.iter().all(Value::is_string)
                        })
                })
        }
        "files" => string_field(data, "path"),
        "browser" => bounded_string_field(data, "url", 4_000),
        // The node only references a Host-owned plan; the schedule, state and
        // results are read from the Host, never persisted onto the board.
        "automation" => {
            string_field(data, "planId")
                && string_field(data, "planWorkspaceId")
                && string_field(data, "executionHostId")
                && data.get("scheduleKind").is_none_or(|value| {
                    value.is_null()
                        || value
                            .as_str()
                            .is_some_and(|kind| AUTOMATION_SCHEDULE_KINDS.contains(&kind))
                })
                && optional_bounded_string(data, "timezone", 64)
        }
        // A read-only observation card. Identity is the observed session's, so
        // a title collision can never merge two different native jobs.
        "agentActivity" => {
            data.get("sourceNodeId")
                .and_then(Value::as_str)
                .is_some_and(|value| Uuid::parse_str(value).is_ok())
                && data.get("source").is_none_or(|value| {
                    value.is_null()
                        || value
                            .as_str()
                            .is_some_and(|source| AGENT_ACTIVITY_SOURCES.contains(&source))
                })
                && optional_bounded_string(data, "sessionId", 200)
                && optional_bounded_string(data, "executionHostId", 200)
                && optional_bounded_string(data, "nativeJobId", 200)
                && data.get("generation").is_none_or(|value| {
                    value.is_null() || value.as_u64().is_some_and(|v| v < (1 << 53))
                })
        }
        _ => false,
    }
}

/// `data.agent` on a terminal node — plan §5.1.
fn valid_agent_block(agent: &Value) -> bool {
    let valid_id = agent
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(valid_agent_id);
    let valid_permission = agent.get("permissionMode").is_none_or(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|mode| PERMISSION_MODES.contains(&mode))
    });
    let valid_pending = agent.get("pendingLaunch").is_none_or(|value| {
        value.is_null()
            || (bounded_string_field(value, "command", 4_000)
                && value.get("after").is_none_or(|after| {
                    after.as_array().is_some_and(|ids| {
                        ids.len() <= 32
                            && ids
                                .iter()
                                .all(|id| id.as_str().is_some_and(|id| Uuid::parse_str(id).is_ok()))
                    })
                }))
    });
    // `account` mirrors AccountRef / CredentialBinding (S02). It is reserved:
    // stored when a client sends it, never interpreted here, and no secret may
    // hide in it — `credentialRef` is a name in a credential store.
    let valid_account = agent.get("account").is_none_or(|value| {
        value.is_null()
            || (value
                .get("accountId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && id.len() <= 120)
                && optional_bounded_string(value, "providerId", 120)
                && optional_bounded_string(value, "label", 200)
                && optional_bounded_string(value, "credentialRef", 200))
    });
    valid_id
        && valid_permission
        && valid_pending
        && valid_account
        && optional_bounded_string(agent, "accountId", 120)
        && optional_bounded_string(agent, "model", 120)
        && optional_bounded_string(agent, "sessionId", 200)
        && optional_bounded_string(agent, "initialCommand", 4_000)
}

/// Built-in ids plus `custom:<id>` for user-defined CLIs.
pub fn valid_agent_id(value: &str) -> bool {
    if BUILTIN_AGENT_IDS.contains(&value) {
        return true;
    }
    match value.strip_prefix("custom:") {
        Some(suffix) => {
            !suffix.is_empty()
                && suffix.len() <= 64
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".:_-".contains(c))
        }
        None => false,
    }
}

fn bounded_string_field(data: &Value, name: &str, max: usize) -> bool {
    data.get(name)
        .and_then(Value::as_str)
        .is_some_and(|value| value.len() <= max)
}

fn optional_bounded_string(data: &Value, name: &str, max: usize) -> bool {
    data.get(name)
        .is_none_or(|value| value.is_null() || value.as_str().is_some_and(|v| v.len() <= max))
}

fn optional_uuid_field(data: &Value, name: &str) -> bool {
    data.get(name).is_none_or(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|value| Uuid::parse_str(value).is_ok())
    })
}

fn string_field(data: &Value, name: &str) -> bool {
    data.get(name)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && value.len() <= 4_000)
}

#[cfg(test)]
mod tests {
    use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
    use tempfile::tempdir;

    use super::*;

    /// How many files `migrations/` holds. Counted rather than written out, so
    /// adding a numbered migration does not silently break two unrelated
    /// assertions about migration bookkeeping.
    fn migration_count() -> i64 {
        std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
            .expect("the migrations directory ships with the crate")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "sql"))
            .count() as i64
    }

    async fn fixture(name: &str) -> (SqlitePool, tempfile::TempDir, Workspace) {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join(format!("{name}.db")).display()
        );
        let pool = connect(&database_url).await.unwrap();
        let workspace = create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        (pool, directory, workspace)
    }

    /// Writes a `_sqlx_migrations` ledger and a table that only that build knew
    /// about, so the file on disk looks exactly like one written by an older
    /// version of this binary.
    async fn seed_foreign_database(database_url: &str, version: i64, checksum: &[u8]) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE _sqlx_migrations ( \
               version BIGINT PRIMARY KEY, \
               description TEXT NOT NULL, \
               installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
               success BOOLEAN NOT NULL, \
               checksum BLOB NOT NULL, \
               execution_time BIGINT NOT NULL )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES (?, 'from another build', TRUE, ?, 0)",
        )
        .bind(version)
        .bind(checksum)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE canvases (id TEXT PRIMARY KEY, strokes_json TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO canvases VALUES ('kept', '{\"strokes\":[1,2,3]}')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    fn database_url(path: &std::path::Path) -> String {
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .to_url_lossy()
            .to_string()
    }

    fn assert_no_legacy(directory: &std::path::Path) {
        assert!(
            !std::fs::read_dir(directory)
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().contains(".legacy-"))
        );
    }

    async fn assert_foreign_data_preserved(url: &str) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(url)
            .await
            .unwrap();
        let payload: String =
            sqlx::query_scalar("SELECT strokes_json FROM canvases WHERE id = 'kept'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(payload, "{\"strokes\":[1,2,3]}");
        pool.close().await;
    }

    /// Rejected histories are left in place, including their ledger and data.
    #[tokio::test]
    async fn incompatible_database_preflight_preserves_data_and_ledger() {
        for (version, checksum) in [
            (1_i64, b"not our checksum".to_vec()),
            (999_i64, vec![0_u8; 48]),
        ] {
            let directory = tempdir().unwrap();
            let path = directory.path().join("canvas.db");
            let url = database_url(&path);
            seed_foreign_database(&url, version, &checksum).await;
            assert!(connect(&url).await.is_err());
            assert!(path.exists());
            assert_no_legacy(directory.path());
            assert_foreign_data_preserved(&url).await;
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .unwrap();
            let ledger: Vec<(i64, Vec<u8>, i64)> =
                sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(ledger, vec![(version, checksum, 1)]);
            let new_tables: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('workspaces', 'agent_mailbox')",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(new_tables, 0);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn dirty_or_malformed_ledger_is_never_treated_as_empty() {
        let migrator = sqlx::migrate!("./migrations");
        for statement in [
            "UPDATE _sqlx_migrations SET success = FALSE",
            "UPDATE _sqlx_migrations SET success = 2",
            "UPDATE _sqlx_migrations SET version = 'broken'",
            "UPDATE _sqlx_migrations SET checksum = 'not a blob'",
            "ALTER TABLE _sqlx_migrations DROP COLUMN checksum",
            "DELETE FROM _sqlx_migrations",
            "DROP TABLE _sqlx_migrations",
        ] {
            let directory = tempdir().unwrap();
            let url = database_url(&directory.path().join("ledger.db"));
            seed_foreign_database(&url, 1, migrator.iter().next().unwrap().checksum.as_ref()).await;
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .unwrap();
            sqlx::query(sqlx::AssertSqlSafe(statement))
                .execute(&pool)
                .await
                .unwrap();
            let schema_before: Vec<(String, String)> = sqlx::query_as(
                "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            pool.close().await;
            let bytes_before = std::fs::read(directory.path().join("ledger.db")).unwrap();
            assert!(connect(&url).await.is_err(), "accepted {statement}");
            assert_foreign_data_preserved(&url).await;
            assert_no_legacy(directory.path());
            // This quiet DELETE-journal fixture should not change even at the
            // byte level; live WAL recovery is not covered by this assertion.
            assert_eq!(
                std::fs::read(directory.path().join("ledger.db")).unwrap(),
                bytes_before
            );
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .unwrap();
            let schema_after: Vec<(String, String)> = sqlx::query_as(
                "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            assert_eq!(schema_after, schema_before);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn unknown_schema_without_ledger_and_unreadable_ledger_are_preserved() {
        for view_ledger in [false, true] {
            let directory = tempdir().unwrap();
            let url = database_url(&directory.path().join("unknown.db"));
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE foreign_data (value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO foreign_data VALUES ('keep me')")
                .execute(&pool)
                .await
                .unwrap();
            if view_ledger {
                sqlx::query("CREATE VIEW _sqlx_migrations AS SELECT * FROM missing_table")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            pool.close().await;
            assert!(connect(&url).await.is_err());
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT value FROM foreign_data")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "keep me"
            );
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='_sqlx_migrations'").fetch_one(&pool).await.unwrap(), 0);
            pool.close().await;
            assert_no_legacy(directory.path());
        }
    }

    #[tokio::test]
    async fn corrupt_database_is_not_replaced() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("corrupt.db");
        let original = b"this file is not a SQLite database";
        std::fs::write(&path, original).unwrap();
        assert!(connect(&database_url(&path)).await.is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert_no_legacy(directory.path());
    }

    #[tokio::test]
    async fn compatible_old_migration_prefix_upgrades_without_resetting_data() {
        let directory = tempdir().unwrap();
        let url = database_url(&directory.path().join("old.db"));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!("./migrations")
            .run_to(1, &pool)
            .await
            .unwrap();
        let workspace = create_workspace(
            &pool,
            "kept project",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        let first_checksum: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=1")
                .fetch_one(&pool)
                .await
                .unwrap();
        pool.close().await;
        let upgraded = connect(&url).await.unwrap();
        assert_eq!(
            get_workspace(&upgraded, &workspace.id).await.unwrap().name,
            "kept project"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
                .fetch_one(&upgraded)
                .await
                .unwrap(),
            migration_count()
        );
        assert_eq!(
            sqlx::query_scalar::<_, Vec<u8>>(
                "SELECT checksum FROM _sqlx_migrations WHERE version=1"
            )
            .fetch_one(&upgraded)
            .await
            .unwrap(),
            first_checksum
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_mailbox")
                .fetch_one(&upgraded)
                .await
                .unwrap(),
            0
        );
        upgraded.close().await;
        assert_no_legacy(directory.path());
    }

    #[tokio::test]
    async fn migration_history_gaps_fail_before_missing_migrations_run() {
        let directory = tempdir().unwrap();
        let url = database_url(&directory.path().join("gap.db"));
        let migrator = sqlx::migrate!("./migrations");
        let second = migrator
            .iter()
            .find(|migration| migration.version == 2)
            .unwrap();
        seed_foreign_database(&url, second.version, second.checksum.as_ref()).await;
        assert!(connect(&url).await.is_err());
        assert_foreign_data_preserved(&url).await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='workspaces'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        pool.close().await;
        assert_no_legacy(directory.path());
    }

    #[tokio::test]
    async fn rejected_preflight_does_not_reconcile_running_sessions() {
        let directory = tempdir().unwrap();
        let url = database_url(&directory.path().join("sessions.db"));
        let pool = connect(&url).await.unwrap();
        let workspace = create_workspace(
            &pool,
            "keep running",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, status, attach_state, created_at) VALUES ('session', ?, '/tmp', '/bin/sh', 'running', 'attached', '2026-09-05')")
            .bind(&workspace.id).execute(&pool).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET success = 0 WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        assert!(connect(&url).await.is_err());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let session: (String, String, Option<String>) = sqlx::query_as(
            "SELECT status, attach_state, ended_at FROM terminal_sessions WHERE id='session'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(session, ("running".into(), "attached".into(), None));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT success FROM _sqlx_migrations WHERE version=1")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        pool.close().await;
        assert_no_legacy(directory.path());
    }

    #[tokio::test]
    async fn rejected_preflight_preserves_committed_wal_data_without_retiring_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("wal.db");
        let url = database_url(&path);
        seed_foreign_database(&url, 999, &[0; 48]).await;
        let keeper = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&keeper)
            .await
            .unwrap();
        sqlx::query("UPDATE canvases SET strokes_json = 'committed in WAL' WHERE id='kept'")
            .execute(&keeper)
            .await
            .unwrap();
        assert!(directory.path().join("wal.db-wal").exists());
        assert!(connect(&url).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT strokes_json FROM canvases WHERE id='kept'")
                .fetch_one(&keeper)
                .await
                .unwrap(),
            "committed in WAL"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations")
                .fetch_one(&keeper)
                .await
                .unwrap(),
            999
        );
        assert!(path.exists());
        assert!(directory.path().join("wal.db-wal").exists());
        assert_no_legacy(directory.path());
        keeper.close().await;
    }

    #[tokio::test]
    async fn later_startup_failure_rolls_back_new_migrations_and_releases_lock() {
        let directory = tempdir().unwrap();
        let url = database_url(&directory.path().join("incomplete.db"));
        let migrator = sqlx::migrate!("./migrations");
        seed_foreign_database(&url, 1, migrator.iter().next().unwrap().checksum.as_ref()).await;
        // Ledger itself is known, but its original business tables are missing.
        // Migration 2 can run; subsequent session recovery must fail atomically.
        assert!(connect(&url).await.is_err());
        assert_foreign_data_preserved(&url).await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("PRAGMA busy_timeout = 100")
            .execute(&pool)
            .await
            .unwrap();
        let mut lock = pool.begin_with("BEGIN EXCLUSIVE").await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
                .fetch_one(&mut *lock)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='agent_mailbox'"
            )
            .fetch_one(&mut *lock)
            .await
            .unwrap(),
            0
        );
        lock.rollback().await.unwrap();
        pool.close().await;
        assert_no_legacy(directory.path());
    }

    #[tokio::test]
    async fn sqlx_encoded_filenames_and_memory_urls_use_the_same_preflight() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("canvas ?# 空间.db");
        let url = database_url(&path);
        let pool = connect(&url).await.unwrap();
        pool.close().await;
        assert!(path.is_file());
        for url in ["sqlite::memory:", "sqlite://:memory:?cache=shared"] {
            let pool = connect(url).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                migration_count()
            );
            pool.close().await;
        }
        let memory_url = format!(
            "sqlite://file:memory-{}?mode=memory&cache=shared",
            Uuid::new_v4()
        );
        let keeper = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&memory_url)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE foreign_data (value TEXT)")
            .execute(&keeper)
            .await
            .unwrap();
        sqlx::query("INSERT INTO foreign_data VALUES ('kept in memory')")
            .execute(&keeper)
            .await
            .unwrap();
        assert!(connect(&memory_url).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM foreign_data")
                .fetch_one(&keeper)
                .await
                .unwrap(),
            "kept in memory"
        );
        keeper.close().await;
    }

    /// The complement: a database this build itself wrote is opened as it is.
    #[tokio::test]
    async fn a_database_written_by_this_build_is_reopened_untouched() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("canvas.db");
        let database_url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = connect(&database_url).await.unwrap();
        let workspace = create_workspace(
            &pool,
            "kept",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        pool.close().await;

        let pool = connect(&database_url).await.unwrap();
        assert_eq!(
            get_workspace(&pool, &workspace.id).await.unwrap().name,
            "kept"
        );
        assert!(
            !std::fs::read_dir(directory.path())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().contains(".legacy-"))
        );
    }

    async fn default_board(pool: &SqlitePool, workspace_id: &str) -> Board {
        list_boards(pool, workspace_id)
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    fn sticky_node(board_id: &str) -> CanvasNode {
        let now = Utc::now().to_rfc3339();
        CanvasNode {
            id: Uuid::now_v7().to_string(),
            board_id: board_id.to_owned(),
            node_type: "sticky".into(),
            title: "Sticky".into(),
            color: crate::model::DEFAULT_NODE_COLOR.into(),
            position: Position { x: 0.0, y: 0.0 },
            size: Some(Size {
                width: 240.0,
                height: 200.0,
            }),
            collapsed: None,
            expanded_height: None,
            parent_id: None,
            labels: Vec::new(),
            note: String::new(),
            data: serde_json::json!({ "kind": "sticky", "content": "hello" }),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Migration 0009 plus the `None` = "leave it alone" rule the whiteboard
    /// shares with the kanban (tldraw plan §6.1).
    #[tokio::test]
    async fn a_whiteboard_snapshot_is_kept_overwritten_and_bounded() {
        let (pool, _directory, workspace) = fixture("whiteboard").await;
        let board = default_board(&pool, &workspace.id).await;
        assert_eq!(board.whiteboard, "", "0009 defaults to no whiteboard");

        let snapshot = r#"{"store":{"shape:ink":{"type":"draw"}},"schema":{}}"#;
        let saved = save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: Some(snapshot),
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.board.whiteboard, snapshot);
        // It survives a reload, and it is on the board brief too.
        assert_eq!(
            load_board(&pool, &workspace.id, &board.id)
                .await
                .unwrap()
                .board
                .whiteboard,
            snapshot
        );
        assert_eq!(
            list_boards(&pool, &workspace.id).await.unwrap()[0].whiteboard,
            snapshot
        );

        // A client that knows nothing about the whiteboard saves a node and
        // must not wipe the drawing.
        let kept = save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &saved.board.updated_at,
                nodes: &[sticky_node(&board.id)],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(kept.board.whiteboard, snapshot);

        // An explicit empty string is how the client says "I erased it".
        let cleared = save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &kept.board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: Some(""),
            },
        )
        .await
        .unwrap();
        assert_eq!(cleared.board.whiteboard, "");

        let oversized = "x".repeat(MAX_WHITEBOARD_BYTES + 1);
        assert!(matches!(
            save_board(
                &pool,
                &workspace.id,
                &board.id,
                SaveBoardRequest {
                    expected_updated_at: &cleared.board.updated_at,
                    nodes: &[],
                    edges: &[],
                    viewport: Viewport::default(),
                    whiteboard: Some(&oversized),
                },
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
    }

    /// A `shape` link carries its own readable payload (tldraw plan §6.3), so
    /// it has to survive the round trip through `links_json` — and be bounded.
    #[tokio::test]
    async fn shape_links_round_trip_their_content() {
        let (pool, _directory, workspace) = fixture("shape-links").await;
        let node_id = Uuid::now_v7().to_string();
        let shape_id = Uuid::now_v7().to_string();
        let links = vec![ContextLink {
            id: shape_id.clone(),
            title: "架构图".into(),
            kind: "shape".into(),
            content: Some(crate::model::ContextLinkContent {
                text: Some("runtime -> web".into()),
                png_path: Some(".armadra/exports/diagram.png".into()),
                ..Default::default()
            }),
        }];
        put_context_links(&pool, &workspace.id, &node_id, &links)
            .await
            .unwrap();
        let stored = get_context_links(&pool, &node_id).await.unwrap();
        let content = stored.links[0].content.as_ref().unwrap();
        assert_eq!(content.text.as_deref(), Some("runtime -> web"));
        assert_eq!(
            content.png_path.as_deref(),
            Some(".armadra/exports/diagram.png")
        );

        assert!(matches!(
            put_context_links(
                &pool,
                &workspace.id,
                &node_id,
                &[ContextLink {
                    id: shape_id,
                    title: "太大".into(),
                    kind: "shape".into(),
                    content: Some(crate::model::ContextLinkContent {
                        text: Some("x".repeat(20_001)),
                        png_path: None,
                        ..Default::default()
                    }),
                }],
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn authorizing_the_same_root_reopens_the_existing_workspace() {
        let (pool, directory, first) = fixture("idempotent-workspace").await;
        let root = directory.path().to_str().unwrap();
        let reopened = create_workspace(&pool, "Ignored replacement", root, None, None)
            .await
            .unwrap();

        assert_eq!(reopened.id, first.id);
        assert_eq!(reopened.name, "fixture");
        assert_eq!(list_workspaces(&pool).await.unwrap().len(), 1);
        let boards = list_boards(&pool, &first.id).await.unwrap();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].name, "Default");
        assert_eq!(boards[0].viewport.zoom, 1.0);
    }

    #[tokio::test]
    async fn workspace_summaries_are_ordered_by_last_opened() {
        let (pool, directory, first) = fixture("summaries").await;
        let second_root = directory.path().join("second");
        std::fs::create_dir(&second_root).unwrap();
        let second = create_workspace(
            &pool,
            "second",
            second_root.to_str().unwrap(),
            Some("#abcdef"),
            Some(&WorkspacePermissions {
                read: true,
                write: false,
                execute: true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(second.color, "#ABCDEF");
        assert!(!second.permissions.write);

        touch_workspace_opened(&pool, &first.id).await.unwrap();
        let summaries = list_workspaces(&pool).await.unwrap();
        assert_eq!(summaries[0].workspace.id, first.id);
        assert_eq!(summaries[0].boards.len(), 1);
        assert_eq!(summaries[0].boards[0].node_count, 0);
        assert_eq!(summaries[1].workspace.id, second.id);
    }

    #[tokio::test]
    async fn workspace_patch_updates_only_the_supplied_fields() {
        let (pool, _directory, workspace) = fixture("patch").await;
        let updated = update_workspace(
            &pool,
            &workspace.id,
            WorkspacePatch {
                name: None,
                color: Some("#123456".into()),
                permissions: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "fixture");
        assert_eq!(updated.color, "#123456");
        assert!(matches!(
            update_workspace(
                &pool,
                &workspace.id,
                WorkspacePatch {
                    name: None,
                    color: Some("red".into()),
                    permissions: None,
                },
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn boards_can_be_created_renamed_reordered_and_deleted() {
        let (pool, _directory, workspace) = fixture("boards").await;
        let extra = create_board(&pool, &workspace.id, "Review").await.unwrap();
        assert_eq!(extra.sort_order, 1);
        let renamed = update_board(
            &pool,
            &workspace.id,
            &extra.id,
            Some("Reviewed".into()),
            Some(0),
        )
        .await
        .unwrap();
        assert_eq!(renamed.name, "Reviewed");
        assert_eq!(renamed.sort_order, 0);

        delete_board(&pool, &workspace.id, &extra.id).await.unwrap();
        let remaining = list_boards(&pool, &workspace.id).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(matches!(
            delete_board(&pool, &workspace.id, &remaining[0].id).await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn accepts_every_v3_node_kind() {
        let (pool, _directory, workspace) = fixture("v3-kinds").await;
        let board = default_board(&pool, &workspace.id).await;
        let payloads = [
            serde_json::json!({"kind":"terminal","cwd":".","shell":"/bin/zsh","agent":{"id":"claude","permissionMode":"plan","model":"opus","initialCommand":"claude --permission-mode plan"}}),
            serde_json::json!({"kind":"sticky","content":"hello"}),
            serde_json::json!({"kind":"group"}),
            serde_json::json!({"kind":"editor","path":"src/App.tsx","language":"tsx","readonly":false}),
            serde_json::json!({"kind":"diff","repoPath":".","scope":"staged","paths":["a.ts"]}),
            serde_json::json!({"kind":"files","path":"src"}),
            serde_json::json!({"kind":"browser","url":"https://example.com"}),
            serde_json::json!({"kind":"automation","planId":"plan-1","planWorkspaceId":"workspace-1","executionHostId":"0123456789abcdef0123456789abcdef","scheduleKind":"interval"}),
            serde_json::json!({"kind":"agentActivity","sourceNodeId":"3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21","source":"subagent"}),
        ];
        assert_eq!(payloads.len(), NODE_TYPES.len());
        let mut nodes = payloads
            .into_iter()
            .map(|data| {
                let mut node = sticky_node(&board.id);
                node.node_type = data["kind"].as_str().unwrap().to_owned();
                node.title = node.node_type.clone();
                node.data = data;
                node
            })
            .collect::<Vec<_>>();
        // Park the sticky inside the group to exercise parent/child validation.
        let group_id = nodes
            .iter()
            .find(|node| node.node_type == "group")
            .map(|node| node.id.clone())
            .unwrap();
        nodes[1].parent_id = Some(group_id);
        nodes[1].collapsed = Some(true);
        nodes[1].expanded_height = Some(200.0);

        let edge = CanvasEdge {
            id: Uuid::now_v7().to_string(),
            board_id: board.id.clone(),
            source: nodes[0].id.clone(),
            target: nodes[1].id.clone(),
            kind: "link".into(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };

        let saved = save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &nodes,
                edges: std::slice::from_ref(&edge),
                viewport: Viewport {
                    x: 12.0,
                    y: -8.0,
                    zoom: 0.75,
                },
                whiteboard: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.nodes.len(), NODE_TYPES.len());
        assert_eq!(saved.edges.len(), 1);
        assert_eq!(saved.edges[0].kind, "link");
        assert_eq!(saved.board.viewport.zoom, 0.75);
        let sticky = saved
            .nodes
            .iter()
            .find(|node| node.node_type == "sticky")
            .unwrap();
        assert_eq!(sticky.collapsed, Some(true));
        assert_eq!(sticky.expanded_height, Some(200.0));
        assert!(sticky.parent_id.is_some());
    }

    #[tokio::test]
    async fn rejects_retired_types_statuses_and_edge_kinds() {
        let (pool, _directory, workspace) = fixture("v2-rejected").await;
        let board = default_board(&pool, &workspace.id).await;

        for retired in ["task", "agent", "note", "file", "context", "log"] {
            let mut node = sticky_node(&board.id);
            node.node_type = retired.into();
            node.data = serde_json::json!({ "kind": retired, "content": "x" });
            assert!(
                matches!(
                    validate_document(&board.id, &[node], &[]),
                    Err(AppError::BadRequest(_))
                ),
                "{retired} was accepted"
            );
        }

        let source = sticky_node(&board.id);
        let target = sticky_node(&board.id);
        let edge = CanvasEdge {
            id: Uuid::now_v7().to_string(),
            board_id: board.id.clone(),
            source: source.id.clone(),
            target: target.id.clone(),
            kind: "dispatch".into(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        assert!(matches!(
            validate_document(&board.id, &[source, target], &[edge]),
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn rejects_invalid_headers_parents_and_agents() {
        let (pool, _directory, workspace) = fixture("guards").await;
        let board = default_board(&pool, &workspace.id).await;

        let mut untitled = sticky_node(&board.id);
        untitled.title = String::new();
        assert!(validate_document(&board.id, &[untitled], &[]).is_err());

        let mut bad_color = sticky_node(&board.id);
        bad_color.color = "red".into();
        assert!(validate_document(&board.id, &[bad_color], &[]).is_err());

        // A parent that is not a group node in the same document is rejected.
        let parent = sticky_node(&board.id);
        let mut child = sticky_node(&board.id);
        child.parent_id = Some(parent.id.clone());
        assert!(validate_document(&board.id, &[parent, child], &[]).is_err());

        let mut agent = sticky_node(&board.id);
        agent.node_type = "terminal".into();
        agent.data = serde_json::json!({ "kind": "terminal", "agent": { "id": "unknown-cli" } });
        assert!(validate_document(&board.id, &[agent.clone()], &[]).is_err());
        for id in crate::agent::AGENT_IDS {
            agent.data = serde_json::json!({ "kind": "terminal", "agent": { "id": id } });
            validate_document(&board.id, &[agent.clone()], &[]).unwrap();
        }
        agent.data = serde_json::json!({ "kind": "terminal", "agent": { "id": "custom:mytool" } });
        validate_document(&board.id, &[agent.clone()], &[]).unwrap();
        agent.data = serde_json::json!({
            "kind": "terminal",
            "agent": { "id": "claude", "permissionMode": "yolo" }
        });
        assert!(validate_document(&board.id, &[agent], &[]).is_err());
    }

    #[tokio::test]
    async fn rejects_a_stale_board_revision() {
        let (pool, _directory, workspace) = fixture("revision").await;
        let board = default_board(&pool, &workspace.id).await;
        save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();

        assert!(matches!(
            save_board(
                &pool,
                &workspace.id,
                &board.id,
                SaveBoardRequest {
                    expected_updated_at: &board.updated_at,
                    nodes: &[],
                    edges: &[],
                    viewport: Viewport::default(),
                    whiteboard: None,
                },
            )
            .await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn agent_status_approvals_links_and_deliveries_round_trip() {
        let (pool, _directory, workspace) = fixture("agent-tables").await;
        let node_id = Uuid::now_v7().to_string();

        let status = upsert_agent_status(
            &pool,
            AgentStatusPatch {
                node_id: node_id.clone(),
                workspace_id: workspace.id.clone(),
                agent_id: "claude".into(),
                state: Some("working".into()),
                unread: false,
                session_id: Some("s-1".into()),
                pending_id: None,
                verified: true,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(status.state.as_deref(), Some("working"));
        assert!(status.verified);
        assert!(!status.restored);

        let blocked = upsert_agent_status(
            &pool,
            AgentStatusPatch {
                node_id: node_id.clone(),
                workspace_id: workspace.id.clone(),
                agent_id: "claude".into(),
                state: Some("blocked".into()),
                unread: true,
                session_id: Some("s-1".into()),
                pending_id: Some("p-1".into()),
                verified: true,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(blocked.pending_id.as_deref(), Some("p-1"));
        assert!(blocked.unread);
        assert_eq!(
            list_agent_status(&pool, &workspace.id).await.unwrap().len(),
            1
        );
        assert!(matches!(
            upsert_agent_status(
                &pool,
                AgentStatusPatch {
                    node_id: node_id.clone(),
                    workspace_id: workspace.id.clone(),
                    agent_id: "claude".into(),
                    state: Some("thinking".into()),
                    unread: false,
                    session_id: None,
                    pending_id: None,
                    verified: false,
                    transcript_path: None,
                    session_phase: None,
                    errored: None,
                    interrupted: None,
                    last_event_at: None,
                },
            )
            .await,
            Err(AppError::BadRequest(_))
        ));

        assert_eq!(mark_agent_status_restored(&pool).await.unwrap(), 1);
        assert!(
            get_agent_status(&pool, &node_id)
                .await
                .unwrap()
                .unwrap()
                .restored
        );

        let approval = insert_approval(
            &pool,
            "p-1",
            &node_id,
            &workspace.id,
            &serde_json::json!({ "tool": "Bash", "command": "rm -rf /" }),
        )
        .await
        .unwrap();
        assert_eq!(approval.request["tool"], "Bash");
        assert!(approval.answer.is_none());
        let answered = answer_approval(&pool, "p-1", "deny", Some("user"))
            .await
            .unwrap();
        assert_eq!(answered.answer.as_deref(), Some("deny"));
        assert!(answered.answered_at.is_some());
        assert!(matches!(
            answer_approval(&pool, "p-1", "allow", None).await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            answer_approval(&pool, "p-1", "maybe", None).await,
            Err(AppError::BadRequest(_))
        ));

        let target = Uuid::now_v7().to_string();
        let links = vec![ContextLink {
            id: target.clone(),
            title: "Codex".into(),
            kind: "terminal".into(),
            content: None,
        }];
        let document = put_context_links(&pool, &workspace.id, &node_id, &links)
            .await
            .unwrap();
        assert_eq!(document.links.len(), 1);
        assert_eq!(document.links[0].title, "Codex");
        assert_eq!(
            get_context_links(&pool, &node_id).await.unwrap().links[0].id,
            target
        );
        assert!(
            get_context_links(&pool, "unlinked-node")
                .await
                .unwrap()
                .links
                .is_empty()
        );
        assert!(matches!(
            put_context_links(
                &pool,
                &workspace.id,
                &node_id,
                &[ContextLink {
                    id: "not-a-uuid".into(),
                    title: "x".into(),
                    kind: "terminal".into(),
                    content: None,
                }],
            )
            .await,
            Err(AppError::BadRequest(_))
        ));

        insert_delivery(
            &pool,
            DeliveryRecord {
                trace_id: "t-1",
                workspace_id: &workspace.id,
                source_node_id: &node_id,
                target_node_id: &target,
                outcome: "delivered",
                receipt: Some("newTurn"),
                body_chars: 42,
            },
        )
        .await
        .unwrap();
        let deliveries = list_deliveries(&pool, &workspace.id, 10).await.unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].outcome, "delivered");
        assert_eq!(deliveries[0].body_chars, 42);

        upsert_hook_install(&pool, "claude", 1, Some("/home/u/.claude/settings.json"))
            .await
            .unwrap();
        upsert_hook_install(&pool, "claude", 2, None).await.unwrap();
        let installs = list_hook_installs(&pool).await.unwrap();
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].client_revision, 2);
        remove_hook_install(&pool, "claude").await.unwrap();
        assert!(list_hook_installs(&pool).await.unwrap().is_empty());
    }

    /* ------------------------ kanban / labels / note ---------------------- */

    #[tokio::test]
    async fn labels_and_notes_still_round_trip_after_board_retirement() {
        let (pool, _directory, workspace) = fixture("annotations").await;
        let board = default_board(&pool, &workspace.id).await;
        let mut node = sticky_node(&board.id);
        node.labels = vec!["ship".into(), "P0".into()];
        node.note = "保留节点备注".into();
        let saved = save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: std::slice::from_ref(&node),
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.nodes[0].labels, ["ship", "P0"]);
        assert_eq!(saved.nodes[0].note, "保留节点备注");
        assert!(
            serde_json::to_value(saved.board)
                .unwrap()
                .get("kanban")
                .is_none()
        );
    }

    #[test]
    fn labels_and_notes_are_bounded() {
        let board_id = Uuid::now_v7().to_string();
        let mut node = sticky_node(&board_id);

        node.labels = (0..9).map(|index| format!("l{index}")).collect();
        assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

        node.labels = vec!["x".repeat(25)];
        assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

        node.labels = vec!["  ".into()];
        assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

        node.labels = vec!["ok".into()];
        node.note = "n".repeat(4_001);
        assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

        node.note = "n".repeat(4_000);
        assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_ok());
    }

    /// Existing node annotation defaults still decode without extra writes.
    #[tokio::test]
    async fn the_column_defaults_decode_as_empty() {
        let (pool, _directory, workspace) = fixture("phase4-defaults").await;
        let board = default_board(&pool, &workspace.id).await;
        let node = sticky_node(&board.id);
        save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: std::slice::from_ref(&node),
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();
        // Put the pre-0008 literals back and read the document again.
        sqlx::query("UPDATE boards SET kanban_json = '{}' WHERE id = ?")
            .bind(&board.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE nodes SET labels_json = '[]', note = '' WHERE board_id = ?")
            .bind(&board.id)
            .execute(&pool)
            .await
            .unwrap();
        let document = load_board(&pool, &workspace.id, &board.id).await.unwrap();
        assert!(
            serde_json::to_value(&document.board)
                .unwrap()
                .get("kanban")
                .is_none()
        );
        assert!(document.nodes[0].labels.is_empty());
        assert!(document.nodes[0].note.is_empty());
        // And the whole document still passes the v3 validator.
        assert!(validate_document(&board.id, &document.nodes, &document.edges).is_ok());
    }
}

#[cfg(test)]
mod default_node_payload_tests {
    use super::valid_node_data;
    use crate::model::{CanvasNode, DEFAULT_NODE_COLOR, Position};

    fn node(node_type: &str, data: serde_json::Value) -> CanvasNode {
        CanvasNode {
            id: "n".into(),
            board_id: "b".into(),
            node_type: node_type.into(),
            title: "t".into(),
            color: DEFAULT_NODE_COLOR.into(),
            position: Position { x: 0.0, y: 0.0 },
            size: None,
            collapsed: None,
            expanded_height: None,
            parent_id: None,
            labels: Vec::new(),
            note: String::new(),
            data,
            created_at: "2026-09-02T00:00:00+00:00".into(),
            updated_at: "2026-09-02T00:00:00+00:00".into(),
        }
    }

    /// Mirrors the node defaults in apps/web: every palette entry must be
    /// saveable before the user types anything.
    #[test]
    fn palette_defaults_are_valid() {
        let cases = [
            ("terminal", serde_json::json!({ "kind": "terminal" })),
            (
                "sticky",
                serde_json::json!({ "kind": "sticky", "content": "" }),
            ),
            ("group", serde_json::json!({ "kind": "group" })),
            (
                "editor",
                serde_json::json!({ "kind": "editor", "path": "src/App.tsx" }),
            ),
            (
                "diff",
                serde_json::json!({ "kind": "diff", "repoPath": ".", "scope": "worktree" }),
            ),
            ("files", serde_json::json!({ "kind": "files", "path": "." })),
            (
                "browser",
                serde_json::json!({ "kind": "browser", "url": "" }),
            ),
            (
                "automation",
                serde_json::json!({
                    "kind": "automation",
                    "planId": "plan-1",
                    "planWorkspaceId": "workspace-1",
                    "executionHostId": "0123456789abcdef0123456789abcdef",
                    "scheduleKind": "cron",
                    "timezone": "Asia/Shanghai"
                }),
            ),
            (
                "agentActivity",
                serde_json::json!({
                    "kind": "agentActivity",
                    "sourceNodeId": "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
                    "source": "loop"
                }),
            ),
        ];
        assert_eq!(cases.len(), super::NODE_TYPES.len());
        for (node_type, data) in cases {
            assert!(
                valid_node_data(&node(node_type, data)),
                "{node_type} default rejected"
            );
        }
    }

    /// The two Host-owned cards keep separate shapes on purpose: neither may be
    /// saved with the other's payload, so one can never drift into the other.
    #[test]
    fn automation_and_activity_payloads_do_not_substitute_for_each_other() {
        let automation = serde_json::json!({
            "kind": "automation",
            "planId": "plan-1",
            "planWorkspaceId": "workspace-1",
            "executionHostId": "0123456789abcdef0123456789abcdef"
        });
        let activity = serde_json::json!({
            "kind": "agentActivity",
            "sourceNodeId": "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21"
        });
        assert!(!valid_node_data(&node("automation", activity.clone())));
        assert!(!valid_node_data(&node("agentActivity", automation.clone())));
        // A plan reference with no Host binding is not a plan reference.
        let mut orphan = automation.clone();
        orphan["executionHostId"] = serde_json::json!("");
        assert!(!valid_node_data(&node("automation", orphan)));
        // An observation card must name a real node, never a free-text title.
        let mut untitled = activity.clone();
        untitled["sourceNodeId"] = serde_json::json!("nightly build");
        assert!(!valid_node_data(&node("agentActivity", untitled)));
        let mut unknown = automation;
        unknown["scheduleKind"] = serde_json::json!("whenever");
        assert!(!valid_node_data(&node("automation", unknown)));
    }

    /// The reserved account binding (S02) is optional and bounded. A node
    /// without it stays valid, which is why nothing in the UI shows a binding
    /// control today.
    #[test]
    fn reserved_account_binding_is_optional_and_bounded() {
        let with = |account: serde_json::Value| {
            node(
                "terminal",
                serde_json::json!({ "kind": "terminal", "agent": { "id": "claude", "account": account } }),
            )
        };
        assert!(valid_node_data(&node(
            "terminal",
            serde_json::json!({ "kind": "terminal", "agent": { "id": "claude" } })
        )));
        assert!(valid_node_data(&with(serde_json::json!({
            "accountId": "default",
            "providerId": "claude",
            "label": "工作账号",
            "credentialRef": "keychain://armadra/claude/default",
        }))));
        assert!(valid_node_data(&with(
            serde_json::json!({ "accountId": "default" })
        )));
        // An account without an id, or an oversized reference, is not storable.
        assert!(!valid_node_data(&with(serde_json::json!({}))));
        assert!(!valid_node_data(&with(
            serde_json::json!({ "accountId": "" })
        )));
        assert!(!valid_node_data(&with(
            serde_json::json!({ "accountId": "default", "credentialRef": "x".repeat(201) })
        )));
    }
}

#[cfg(test)]
mod legacy_archive_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::borrow::Cow;

    const RAW: &str = " {\n \"columns\": [{\"id\":\"old\",\"title\":\"原始列\"}], \"cards\": {\"shape:orphan\":{\"columnId\":\"missing\",\"order\":1.25}}, \"unknown\":true }\n";
    const LABELS: &str = "[ \"旧标签\", \"needs review\" ]";
    const NOTE: &str = "原始备注\n  保留空白";
    const DRAWING: &str = "{ \"records\": [{\"id\":\"shape:ink\",\"type\":\"draw\"}] }";

    async fn before_retirement() -> (SqlitePool, String, String, String) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let all = sqlx::migrate!("./migrations");
        let old = sqlx::migrate::Migrator {
            migrations: Cow::Owned(
                all.iter()
                    .filter(|migration| migration.version <= 2)
                    .cloned()
                    .collect(),
            ),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        old.run(&pool).await.unwrap();
        let (workspace, canvas, node) = (
            Uuid::now_v7().to_string(),
            Uuid::now_v7().to_string(),
            Uuid::now_v7().to_string(),
        );
        sqlx::query("INSERT INTO workspaces(id,name,root_path,created_at,updated_at) VALUES(?,'Original workspace','/archive-fixture','2026-09-05T01:02:03.004+08:00','2026-09-05T01:02:04.005+08:00')").bind(&workspace).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO boards(id,workspace_id,name,kanban_json,whiteboard_json,created_at,updated_at) VALUES(?,?,'Original canvas',?,?,'2026-09-05T01:02:03.004+08:00','2026-09-05T01:02:04.005+08:00')").bind(&canvas).bind(&workspace).bind(RAW).bind(DRAWING).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO nodes(id,board_id,type,x,y,title,labels_json,note,data_json,created_at,updated_at) VALUES(?,?,'sticky',1,2,'Original node',?,?, '{\"kind\":\"sticky\",\"content\":\"content\"}','2026-09-05T01:02:03.004+08:00','2026-09-05T01:02:04.005+08:00')").bind(&node).bind(&canvas).bind(LABELS).bind(NOTE).execute(&pool).await.unwrap();
        (pool, workspace, canvas, node)
    }

    #[tokio::test]
    async fn retirement_preserves_raw_data_and_survives_live_deletion() {
        let (pool, workspace, canvas, node) = before_retirement().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let archive = get_legacy_kanban_archive(&pool, &canvas).await.unwrap();
        assert_eq!(archive.kanban_json, RAW);
        assert_eq!(archive.summary.workspace_name, "Original workspace");
        assert_eq!(archive.summary.canvas_name, "Original canvas");
        assert_eq!(archive.canvas_created_at, "2026-09-05T01:02:03.004+08:00");
        assert_eq!(archive.labels[0].node_id, node);
        assert_eq!(archive.labels[0].labels_json, LABELS);
        assert_eq!(archive.labels[0].note, NOTE);
        assert_eq!(archive.labels[0].archived_at, archive.summary.archived_at);
        let board = get_board(&pool, &workspace, &canvas).await.unwrap();
        assert_eq!(board.whiteboard, DRAWING);
        // Deleting every live node must neither prune task-card references nor
        // rewrite the old JSON into a newly normalized representation.
        save_board(
            &pool,
            &workspace,
            &canvas,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();
        let raw: String = sqlx::query_scalar("SELECT kanban_json FROM boards WHERE id=?")
            .bind(&canvas)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(raw, RAW);
        assert_eq!(
            get_board(&pool, &workspace, &canvas)
                .await
                .unwrap()
                .whiteboard,
            DRAWING
        );
        sqlx::query("DELETE FROM workspaces WHERE id=?")
            .bind(&workspace)
            .execute(&pool)
            .await
            .unwrap();
        let archived = get_legacy_kanban_archive(&pool, &canvas).await.unwrap();
        assert_eq!(archived.kanban_json, RAW);
        assert_eq!(archived.labels[0].note, NOTE);
        assert_eq!(
            list_legacy_kanban_archives(&pool, None, 50)
                .await
                .unwrap()
                .archives
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn old_column_and_archive_rows_are_write_protected() {
        let (pool, _, canvas, _) = before_retirement().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        assert!(
            sqlx::query("UPDATE boards SET kanban_json='{}' WHERE id=?")
                .bind(&canvas)
                .execute(&pool)
                .await
                .is_err()
        );
        for query in [
            "UPDATE legacy_kanban_archives SET canvas_name='changed'",
            "DELETE FROM legacy_kanban_archives",
            "INSERT INTO legacy_kanban_archives SELECT * FROM legacy_kanban_archives",
            "UPDATE legacy_node_label_archives SET note='changed'",
            "DELETE FROM legacy_node_label_archives",
            "INSERT INTO legacy_node_label_archives SELECT * FROM legacy_node_label_archives",
        ] {
            assert!(
                sqlx::query(sqlx::AssertSqlSafe(query))
                    .execute(&pool)
                    .await
                    .is_err(),
                "{query}"
            );
        }
        assert_eq!(
            get_legacy_kanban_archive(&pool, &canvas)
                .await
                .unwrap()
                .kanban_json,
            RAW
        );
    }

    #[tokio::test]
    async fn fresh_canvases_have_no_writable_board_state_and_notes_remain_editable() {
        let (pool, workspace, canvas, _) = before_retirement().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let before = get_legacy_kanban_archive(&pool, &canvas).await.unwrap();
        let mut document = load_board(&pool, &workspace, &canvas).await.unwrap();
        document.nodes[0].note = "Updated live note".into();
        document.nodes[0].labels = vec!["current label".into()];
        let saved = save_board(
            &pool,
            &workspace,
            &canvas,
            SaveBoardRequest {
                expected_updated_at: &document.board.updated_at,
                nodes: &document.nodes,
                edges: &document.edges,
                viewport: document.board.viewport,
                whiteboard: Some("new drawing"),
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.nodes[0].note, "Updated live note");
        assert_eq!(saved.board.whiteboard, "new drawing");
        assert_eq!(
            get_legacy_kanban_archive(&pool, &canvas)
                .await
                .unwrap()
                .labels[0]
                .note,
            before.labels[0].note
        );
        let fresh = create_board(&pool, &workspace, "Fresh canvas")
            .await
            .unwrap();
        assert!(
            serde_json::to_value(&fresh)
                .unwrap()
                .get("kanban")
                .is_none()
        );
        let inert: String = sqlx::query_scalar("SELECT kanban_json FROM boards WHERE id=?")
            .bind(&fresh.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(inert, "{}");
        assert_eq!(
            list_legacy_kanban_archives(&pool, None, 50)
                .await
                .unwrap()
                .archives
                .len(),
            1
        );
        assert!(sqlx::query("INSERT INTO boards(id,workspace_id,name,kanban_json,created_at,updated_at) VALUES('old-writer',?,'Old writer',?,'t','t')").bind(&workspace).bind(RAW).execute(&pool).await.is_err());
    }
}
