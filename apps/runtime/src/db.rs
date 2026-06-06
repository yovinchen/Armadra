use chrono::Utc;
use serde_json::Value;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::{
        Board, BoardBrief, BoardDocument, CanvasEdge, CanvasNode, DEFAULT_BOARD_NAME,
        DEFAULT_WORKSPACE_COLOR, Position, Size, Stroke, Viewport, Workspace, WorkspacePermissions,
        WorkspaceSummary,
    },
};

pub const NODE_TYPES: &[&str] = &[
    "task", "agent", "terminal", "diff", "file", "context", "note", "browser", "image", "log",
];
pub const EDGE_TYPES: &[&str] = &["link", "dispatch", "produce", "write", "trigger", "ref"];
pub const NODE_STATUSES: &[&str] = &[
    "idle",
    "running",
    "waiting",
    "done",
    "review",
    "modified",
    "error",
    "disconnected",
    "connecting",
    "linked",
];
pub const NODE_ZOOMS: &[&str] = &["mini", "normal", "focus"];
pub const CONTEXT_CHIP_KINDS: &[&str] = &["file", "context", "note", "browser", "text"];
pub const DIFF_FILE_STATUSES: &[&str] = &["M", "A", "D", "R", "?"];
pub const DIFF_FILE_STATES: &[&str] = &["pending", "accepted", "reverted"];

const MAX_STROKES: usize = 2_000;
const MAX_STROKE_POINTS: usize = 20_000;
const MAX_IMAGE_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BROWSER_HISTORY: usize = 50;

pub async fn connect(database_url: &str) -> AppResult<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Could not migrate the local database: {error}"))
        })?;
    sqlx::query(
        "UPDATE terminal_sessions SET status = 'failed', ended_at = ? WHERE status = 'running'",
    )
    .bind(Utc::now().to_rfc3339())
    .execute(&pool)
    .await?;
    Ok(pool)
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
        gateway_enabled: row.try_get::<i64, _>("gateway_enabled")? != 0,
        // The column is nullable for legacy rows; every read coalesces it so the
        // wire contract keeps `lastOpenedAt` non-null.
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
    gateway_enabled: Option<bool>,
) -> AppResult<Workspace> {
    let id = Uuid::now_v7().to_string();
    let board_id = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    let color = normalize_color(color)?;
    let permissions = permissions.cloned().unwrap_or_default();
    let permissions_json = serde_json::to_string(&permissions)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let gateway_enabled = gateway_enabled.unwrap_or(false);

    let mut transaction = pool.begin().await?;
    let result = sqlx::query(
        "INSERT INTO workspaces (id, name, root_path, color, permissions_json, gateway_enabled, last_opened_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_path) DO NOTHING",
    )
    .bind(&id)
    .bind(name)
    .bind(root_path)
    .bind(&color)
    .bind(&permissions_json)
    .bind(i64::from(gateway_enabled))
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
        "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, strokes_json, created_at, updated_at) \
         VALUES (?, ?, ?, 0, ?, '[]', ?, ?)",
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
        gateway_enabled,
        last_opened_at: now.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn list_workspaces(pool: &SqlitePool) -> AppResult<Vec<WorkspaceSummary>> {
    let rows = sqlx::query(
        "SELECT id, name, root_path, color, permissions_json, gateway_enabled, \
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
        "SELECT id, name, root_path, color, permissions_json, gateway_enabled, \
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
        "SELECT id, name, root_path, color, permissions_json, gateway_enabled, \
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
    pub gateway_enabled: Option<bool>,
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
    let gateway_enabled = patch.gateway_enabled.unwrap_or(current.gateway_enabled);
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE workspaces SET name = ?, color = ?, permissions_json = ?, gateway_enabled = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(&color)
    .bind(serde_json::to_string(&permissions).map_err(|error| AppError::Internal(error.to_string()))?)
    .bind(i64::from(gateway_enabled))
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    get_workspace(pool, id).await
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
    let valid = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::BadRequest(
            "Workspace color must be a #RRGGBB value".into(),
        ));
    }
    Ok(color.to_ascii_uppercase())
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
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn list_boards(pool: &SqlitePool, workspace_id: &str) -> AppResult<Vec<Board>> {
    get_workspace(pool, workspace_id).await?;
    let rows = sqlx::query(
        "SELECT id, workspace_id, name, sort_order, viewport_json, created_at, updated_at FROM boards WHERE workspace_id = ? ORDER BY sort_order, created_at",
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
    let row = sqlx::query("SELECT id, workspace_id, name, sort_order, viewport_json, created_at, updated_at FROM boards WHERE id = ? AND workspace_id = ?")
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
        "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, strokes_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
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
    let strokes_json: String = sqlx::query_scalar("SELECT strokes_json FROM boards WHERE id = ?")
        .bind(&board.id)
        .fetch_one(pool)
        .await?;
    let strokes = serde_json::from_str::<Vec<Stroke>>(&strokes_json).unwrap_or_default();

    let node_rows = sqlx::query(
        "SELECT id, board_id, type, x, y, width, height, zoom, data_json, created_at, updated_at \
         FROM nodes WHERE board_id = ? ORDER BY created_at",
    )
    .bind(&board.id)
    .fetch_all(pool)
    .await?;
    let nodes = node_rows
        .into_iter()
        .map(|row| {
            let data_json: String = row.try_get("data_json")?;
            Ok(CanvasNode {
                id: row.try_get("id")?,
                board_id: row.try_get("board_id")?,
                node_type: row.try_get("type")?,
                position: Position {
                    x: row.try_get("x")?,
                    y: row.try_get("y")?,
                },
                size: match (row.try_get("width")?, row.try_get("height")?) {
                    (Some(width), Some(height)) => Some(Size { width, height }),
                    _ => None,
                },
                zoom: row.try_get("zoom")?,
                data: serde_json::from_str(&data_json)
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let edge_rows = sqlx::query(
        "SELECT id, board_id, source_node_id, target_node_id, type, label, created_at, updated_at \
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
                source_node_id: row.try_get("source_node_id")?,
                target_node_id: row.try_get("target_node_id")?,
                edge_type: row.try_get("type")?,
                label: row.try_get("label")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    Ok(BoardDocument {
        board,
        nodes,
        edges,
        strokes,
    })
}

pub struct SaveBoardRequest<'a> {
    pub expected_updated_at: &'a str,
    pub nodes: &'a [CanvasNode],
    pub edges: &'a [CanvasEdge],
    pub strokes: &'a [Stroke],
    pub viewport: Viewport,
}

pub async fn save_board(
    pool: &SqlitePool,
    workspace_id: &str,
    board_id: &str,
    request: SaveBoardRequest<'_>,
) -> AppResult<BoardDocument> {
    let board = get_board(pool, workspace_id, board_id).await?;
    validate_document(&board.id, request.nodes, request.edges)?;
    validate_strokes(request.strokes)?;
    validate_viewport(&request.viewport)?;

    let strokes_json = serde_json::to_string(request.strokes)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let viewport_json = serde_json::to_string(&request.viewport)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;

    let mut transaction = pool.begin().await?;
    let next_updated_at = Utc::now().to_rfc3339();
    let updated = sqlx::query(
        "UPDATE boards SET updated_at = ?, viewport_json = ?, strokes_json = ? WHERE id = ? AND updated_at = ?",
    )
    .bind(&next_updated_at)
    .bind(&viewport_json)
    .bind(&strokes_json)
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
            "INSERT INTO nodes (id, board_id, type, x, y, width, height, zoom, data_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&node.id)
        .bind(&node.board_id)
        .bind(&node.node_type)
        .bind(node.position.x)
        .bind(node.position.y)
        .bind(node.size.as_ref().map(|size| size.width))
        .bind(node.size.as_ref().map(|size| size.height))
        .bind(&node.zoom)
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
            "INSERT INTO edges (id, board_id, source_node_id, target_node_id, type, label, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&edge.id)
        .bind(&edge.board_id)
        .bind(&edge.source_node_id)
        .bind(&edge.target_node_id)
        .bind(&edge.edge_type)
        .bind(&edge.label)
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

pub async fn get_terminal_session(
    pool: &SqlitePool,
    session_id: &str,
) -> AppResult<crate::model::TerminalSession> {
    sqlx::query_as::<_, crate::model::TerminalSession>(
        "SELECT id, workspace_id, cwd, shell, command, kind, owner_node_id, adapter, status, exit_code, created_at, ended_at \
         FROM terminal_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Terminal session was not found".into()))
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

fn validate_strokes(strokes: &[Stroke]) -> AppResult<()> {
    if strokes.len() > MAX_STROKES {
        return Err(AppError::BadRequest("Board has too many strokes".into()));
    }
    for stroke in strokes {
        let valid = Uuid::parse_str(&stroke.id).is_ok()
            && !stroke.color.is_empty()
            && stroke.color.len() <= 32
            && stroke.width.is_finite()
            && stroke.width > 0.0
            && stroke.width <= 64.0
            && !stroke.points.is_empty()
            && stroke.points.len() <= MAX_STROKE_POINTS
            && stroke
                .points
                .iter()
                .all(|point| point.x.is_finite() && point.y.is_finite());
        if !valid {
            return Err(AppError::BadRequest(
                "Board contains an invalid stroke".into(),
            ));
        }
    }
    Ok(())
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
    for node in nodes {
        let kind = node.data.get("kind").and_then(Value::as_str);
        let title = node.data.get("title").and_then(Value::as_str);
        let status = node.data.get("status").and_then(Value::as_str);
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
            });
        let valid_common = title.is_some_and(|title| !title.is_empty() && title.len() <= 160)
            && node
                .data
                .get("subtitle")
                .is_none_or(|value| value.as_str().is_some_and(|value| value.len() <= 160))
            && status.is_some_and(|status| NODE_STATUSES.contains(&status));
        if node.board_id != board_id
            || !NODE_TYPES.contains(&node.node_type.as_str())
            || !NODE_ZOOMS.contains(&node.zoom.as_str())
            || kind != Some(&node.node_type)
            || !valid_identity
            || !valid_geometry
            || !valid_common
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
            && Uuid::parse_str(&edge.source_node_id).is_ok()
            && Uuid::parse_str(&edge.target_node_id).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&edge.created_at).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&edge.updated_at).is_ok();
        if edge.board_id != board_id
            || !EDGE_TYPES.contains(&edge.edge_type.as_str())
            || !node_ids.contains(edge.source_node_id.as_str())
            || !node_ids.contains(edge.target_node_id.as_str())
            || !valid_identity
            || edge.label.as_ref().is_some_and(|label| label.len() > 80)
        {
            return Err(AppError::BadRequest(
                "Board contains an invalid or dangling edge".into(),
            ));
        }
    }
    Ok(())
}

pub fn valid_node_data(node: &CanvasNode) -> bool {
    let data = &node.data;
    match node.node_type.as_str() {
        "task" => {
            bounded_string_field(data, "description", 20_000)
                && array_field(data, "checklist", |item| {
                    string_field(item, "id")
                        && bounded_string_field(item, "text", 2_000)
                        && item.get("done").is_some_and(Value::is_boolean)
                })
        }
        "agent" => {
            string_field(data, "projectPath")
                && data
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.len() <= 1_024)
                && data
                    .get("adapter")
                    .and_then(Value::as_str)
                    .is_some_and(|adapter| {
                        [
                            "claude", "codex", "gemini", "opencode", "pi", "omp", "custom",
                        ]
                        .contains(&adapter)
                    })
                && string_array_field(data, "args")
                && optional_uuid_field(data, "sessionId")
                && array_field(data, "contextChips", |chip| {
                    string_field(chip, "id")
                        && chip
                            .get("kind")
                            .and_then(Value::as_str)
                            .is_some_and(|kind| CONTEXT_CHIP_KINDS.contains(&kind))
                        && bounded_string_field(chip, "label", 160)
                        && chip
                            .get("value")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value.len() <= 20_000)
                })
        }
        "terminal" => {
            string_field(data, "cwd")
                && string_field(data, "shell")
                && optional_uuid_field(data, "sessionId")
                && data
                    .get("command")
                    .is_none_or(|value| value.is_null() || value.is_string())
                && data
                    .get("lastExitCode")
                    .is_none_or(|value| value.is_null() || value.as_i64().is_some())
        }
        "diff" => {
            string_field(data, "repoPath")
                && optional_uuid_field(data, "sourceAgentNodeId")
                && data.get("files").is_some_and(|value| {
                    value.as_array().is_some_and(|files| {
                        files.iter().all(|file| {
                            string_field(file, "path")
                                && file
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .is_some_and(|status| DIFF_FILE_STATUSES.contains(&status))
                                && file.get("additions").and_then(Value::as_u64).is_some()
                                && file.get("deletions").and_then(Value::as_u64).is_some()
                                && file.get("patch").is_some_and(Value::is_string)
                                && file
                                    .get("state")
                                    .and_then(Value::as_str)
                                    .is_some_and(|state| DIFF_FILE_STATES.contains(&state))
                        })
                    })
                })
        }
        "file" => {
            string_field(data, "path")
                && string_field(data, "mimeType")
                && data.get("size").and_then(Value::as_u64).is_some()
                && data.get("readonly").is_some_and(Value::is_boolean)
                && data
                    .get("syncPolicy")
                    .and_then(Value::as_str)
                    .is_some_and(|policy| {
                        ["local_only", "metadata_only", "full_sync"].contains(&policy)
                    })
                && data
                    .get("language")
                    .is_none_or(|value| value.is_null() || value.is_string())
        }
        "context" => {
            string_field(data, "path")
                && string_array_field(data, "includePatterns")
                && string_array_field(data, "excludePatterns")
        }
        "note" => bounded_string_field(data, "content", 20_000),
        "browser" => {
            // A freshly created browser node has no address yet.
            bounded_string_field(data, "url", 4_000)
                && data.get("history").is_some_and(|value| {
                    value.as_array().is_some_and(|history| {
                        history.len() <= MAX_BROWSER_HISTORY && history.iter().all(Value::is_string)
                    })
                })
                && data
                    .get("historyIndex")
                    .and_then(Value::as_i64)
                    .is_some_and(|index| index >= -1 && index < MAX_BROWSER_HISTORY as i64)
        }
        "image" => {
            data.get("src")
                .and_then(Value::as_str)
                .is_some_and(|src| src.starts_with("data:") && src.len() <= MAX_IMAGE_SOURCE_BYTES)
                && string_field(data, "mimeType")
                && positive_optional_number(data, "width")
                && positive_optional_number(data, "height")
                && data
                    .get("sourcePath")
                    .is_none_or(|value| value.is_null() || value.is_string())
        }
        "log" => {
            bounded_string_field(data, "content", 100_000)
                && data
                    .get("level")
                    .and_then(Value::as_str)
                    .is_some_and(|level| ["info", "warning", "error"].contains(&level))
                && data.get("entries").is_none_or(|value| {
                    value.is_null()
                        || value.as_array().is_some_and(|entries| {
                            entries.len() <= 2_000
                                && entries.iter().all(|entry| {
                                    string_field(entry, "at")
                                        && entry.get("source").and_then(Value::as_str).is_some_and(
                                            |source| {
                                                ["agent", "terminal", "gateway", "system"]
                                                    .contains(&source)
                                            },
                                        )
                                        && bounded_string_field(entry, "text", 20_000)
                                })
                        })
                })
        }
        _ => false,
    }
}

fn array_field(data: &Value, name: &str, predicate: impl Fn(&Value) -> bool) -> bool {
    data.get(name).is_some_and(|value| {
        value
            .as_array()
            .is_some_and(|items| items.len() <= 1_000 && items.iter().all(predicate))
    })
}

fn bounded_string_field(data: &Value, name: &str, max: usize) -> bool {
    data.get(name)
        .and_then(Value::as_str)
        .is_some_and(|value| value.len() <= max)
}

fn positive_optional_number(data: &Value, name: &str) -> bool {
    data.get(name).is_none_or(|value| {
        value.is_null() || value.as_f64().is_some_and(|value| value.is_finite())
    })
}

fn string_array_field(data: &Value, name: &str) -> bool {
    data.get(name).is_some_and(|value| {
        value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
    })
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
        .is_some_and(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::model::Point;

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
            None,
        )
        .await
        .unwrap();
        (pool, directory, workspace)
    }

    async fn default_board(pool: &SqlitePool, workspace_id: &str) -> Board {
        list_boards(pool, workspace_id)
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    fn agent_node(board_id: &str) -> CanvasNode {
        let now = Utc::now().to_rfc3339();
        CanvasNode {
            id: Uuid::now_v7().to_string(),
            board_id: board_id.to_owned(),
            node_type: "agent".into(),
            position: Position { x: 0.0, y: 0.0 },
            size: Some(Size {
                width: 430.0,
                height: 600.0,
            }),
            zoom: "normal".into(),
            data: serde_json::json!({
                "kind": "agent",
                "title": "Agent",
                "status": "idle",
                "adapter": "custom",
                "projectPath": ".",
                "command": "tool",
                "args": [],
                "contextChips": []
            }),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn authorizing_the_same_root_reopens_the_existing_workspace() {
        let (pool, directory, first) = fixture("idempotent-workspace").await;
        let root = directory.path().to_str().unwrap();
        let reopened = create_workspace(&pool, "Ignored replacement", root, None, None, None)
            .await
            .unwrap();

        assert_eq!(reopened.id, first.id);
        assert_eq!(reopened.name, "fixture");
        assert_eq!(list_workspaces(&pool).await.unwrap().len(), 1);
        let boards = list_boards(&pool, &first.id).await.unwrap();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].name, "Default");
        assert_eq!(boards[0].sort_order, 0);
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
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(second.color, "#ABCDEF");
        assert!(second.gateway_enabled);
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
                gateway_enabled: Some(true),
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "fixture");
        assert_eq!(updated.color, "#123456");
        assert!(updated.gateway_enabled);
        assert!(matches!(
            update_workspace(
                &pool,
                &workspace.id,
                WorkspacePatch {
                    name: None,
                    color: Some("red".into()),
                    permissions: None,
                    gateway_enabled: None,
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
        assert!(matches!(
            get_board(&pool, &workspace.id, &extra.id).await,
            Err(AppError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn rejects_node_data_that_shared_schema_would_reject() {
        let (pool, _directory, workspace) = fixture("contract").await;
        let board = default_board(&pool, &workspace.id).await;
        let mut invalid = agent_node(&board.id);
        invalid.data["args"] = serde_json::json!([1]);

        assert!(matches!(
            save_board(
                &pool,
                &workspace.id,
                &board.id,
                SaveBoardRequest {
                    expected_updated_at: &board.updated_at,
                    nodes: &[invalid],
                    edges: &[],
                    strokes: &[],
                    viewport: Viewport::default(),
                },
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn rejects_legacy_node_types_statuses_and_edge_types() {
        let (pool, _directory, workspace) = fixture("legacy-rejected").await;
        let board = default_board(&pool, &workspace.id).await;
        let now = Utc::now().to_rfc3339();
        let mut folder = agent_node(&board.id);
        folder.node_type = "folder".into();
        folder.data = serde_json::json!({
            "kind": "folder",
            "title": "Folder",
            "status": "idle",
            "path": ".",
            "includePatterns": [],
            "excludePatterns": []
        });
        assert!(matches!(
            validate_document(&board.id, &[folder], &[]),
            Err(AppError::BadRequest(_))
        ));

        let mut failed = agent_node(&board.id);
        failed.data["status"] = serde_json::json!("failed");
        assert!(matches!(
            validate_document(&board.id, &[failed], &[]),
            Err(AppError::BadRequest(_))
        ));

        let source = agent_node(&board.id);
        let target = agent_node(&board.id);
        let edge = CanvasEdge {
            id: Uuid::now_v7().to_string(),
            board_id: board.id.clone(),
            source_node_id: source.id.clone(),
            target_node_id: target.id.clone(),
            edge_type: "depends_on".into(),
            label: None,
            created_at: now.clone(),
            updated_at: now,
        };
        assert!(matches!(
            validate_document(&board.id, &[source, target], &[edge]),
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn accepts_every_v2_node_kind() {
        let (pool, _directory, workspace) = fixture("v2-kinds").await;
        let board = default_board(&pool, &workspace.id).await;
        let now = Utc::now().to_rfc3339();
        let payloads = [
            serde_json::json!({"kind":"task","title":"Task","status":"idle","description":"do","checklist":[{"id":"a","text":"step","done":false}]}),
            serde_json::json!({"kind":"agent","title":"Agent","status":"running","adapter":"claude","projectPath":".","command":"npx","args":["-y"],"contextChips":[{"id":"c1","kind":"file","label":"App","value":"src/App.tsx"}]}),
            serde_json::json!({"kind":"terminal","title":"Terminal","status":"disconnected","cwd":".","shell":"/bin/zsh","command":"ls","lastExitCode":0}),
            serde_json::json!({"kind":"diff","title":"Diff","status":"review","repoPath":".","files":[{"path":"a.ts","status":"M","additions":1,"deletions":2,"patch":"@@","state":"pending"}]}),
            serde_json::json!({"kind":"file","title":"File","status":"linked","path":"a.ts","mimeType":"text/plain","size":10,"readonly":true,"syncPolicy":"local_only","language":"ts"}),
            serde_json::json!({"kind":"context","title":"Context","status":"idle","path":"src","includePatterns":[],"excludePatterns":["*.log"]}),
            serde_json::json!({"kind":"note","title":"Note","status":"idle","content":"hello"}),
            serde_json::json!({"kind":"browser","title":"Browser","status":"connecting","url":"https://example.com","history":["https://example.com"],"historyIndex":0}),
            serde_json::json!({"kind":"image","title":"Image","status":"done","src":"data:image/png;base64,AAAA","mimeType":"image/png","width":10,"height":10}),
            serde_json::json!({"kind":"log","title":"Log","status":"modified","content":"line","level":"info","entries":[{"at":now,"source":"agent","text":"hi"}]}),
        ];
        let nodes = payloads
            .into_iter()
            .map(|data| {
                let mut node = agent_node(&board.id);
                node.node_type = data["kind"].as_str().unwrap().to_owned();
                node.zoom = "mini".into();
                node.data = data;
                node
            })
            .collect::<Vec<_>>();
        let stroke = Stroke {
            id: Uuid::now_v7().to_string(),
            color: "#5B5BD6".into(),
            width: 3.0,
            points: vec![Point { x: 0.0, y: 0.0 }, Point { x: 5.0, y: 6.0 }],
        };
        let saved = save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &nodes,
                edges: &[],
                strokes: std::slice::from_ref(&stroke),
                viewport: Viewport {
                    x: 12.0,
                    y: -8.0,
                    zoom: 0.75,
                },
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.nodes.len(), 10);
        assert_eq!(saved.strokes.len(), 1);
        assert_eq!(saved.board.viewport.zoom, 0.75);
        assert!(saved.nodes.iter().all(|node| node.zoom == "mini"));
    }

    #[tokio::test]
    async fn rejects_oversized_image_sources_and_invalid_strokes() {
        let (pool, _directory, workspace) = fixture("guards").await;
        let board = default_board(&pool, &workspace.id).await;
        let mut image = agent_node(&board.id);
        image.node_type = "image".into();
        image.data = serde_json::json!({
            "kind": "image",
            "title": "Huge",
            "status": "idle",
            "src": format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024)),
            "mimeType": "image/png"
        });
        assert!(matches!(
            validate_document(&board.id, &[image], &[]),
            Err(AppError::BadRequest(_))
        ));

        let stroke = Stroke {
            id: "not-a-uuid".into(),
            color: "#5B5BD6".into(),
            width: 3.0,
            points: vec![Point { x: 0.0, y: 0.0 }],
        };
        assert!(matches!(
            save_board(
                &pool,
                &workspace.id,
                &board.id,
                SaveBoardRequest {
                    expected_updated_at: &board.updated_at,
                    nodes: &[],
                    edges: &[],
                    strokes: &[stroke],
                    viewport: Viewport::default(),
                },
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
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
                strokes: &[],
                viewport: Viewport::default(),
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
                    strokes: &[],
                    viewport: Viewport::default(),
                },
            )
            .await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn saves_an_incomplete_custom_agent_configuration() {
        let (pool, _directory, workspace) = fixture("custom-agent").await;
        let board = default_board(&pool, &workspace.id).await;
        let mut node = agent_node(&board.id);
        node.data["command"] = serde_json::json!("");
        save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[node],
                edges: &[],
                strokes: &[],
                viewport: Viewport::default(),
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn migrates_legacy_canvas_rows_into_boards() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("legacy.db").display()
        );
        // Run only the pre-v2 migrations, seed legacy rows, then let `connect`
        // apply 0003 on top of them.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations ( \
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
        let migrator = sqlx::migrate!("./migrations");
        for migration in migrator.iter().take(2) {
            sqlx::raw_sql(migration.sql.clone())
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time) \
                 VALUES (?, ?, CURRENT_TIMESTAMP, TRUE, ?, 0)",
            )
            .bind(migration.version)
            .bind(migration.description.as_ref())
            .bind(migration.checksum.as_ref())
            .execute(&pool)
            .await
            .unwrap();
        }
        let now = Utc::now().to_rfc3339();
        let workspace_id = Uuid::now_v7().to_string();
        let canvas_id = Uuid::now_v7().to_string();
        let folder_id = Uuid::now_v7().to_string();
        let agent_id = Uuid::now_v7().to_string();
        let edge_id = Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, 'legacy', '/legacy', ?, ?)")
            .bind(&workspace_id).bind(&now).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO canvases (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, 'Main canvas', ?, ?)")
            .bind(&canvas_id).bind(&workspace_id).bind(&now).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO nodes (id, canvas_id, type, x, y, data_json, created_at, updated_at) VALUES (?, ?, 'folder', 0, 0, ?, ?, ?)")
            .bind(&folder_id)
            .bind(&canvas_id)
            .bind(r#"{"kind":"folder","title":"Legacy folder","status":"failed","path":"src","includePatterns":[],"excludePatterns":[]}"#)
            .bind(&now).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO nodes (id, canvas_id, type, x, y, data_json, created_at, updated_at) VALUES (?, ?, 'agent', 10, 10, ?, ?, ?)")
            .bind(&agent_id)
            .bind(&canvas_id)
            .bind(r#"{"kind":"agent","title":"Legacy agent","status":"idle","adapter":"custom","projectPath":".","command":"tool","args":[]}"#)
            .bind(&now).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO edges (id, canvas_id, source_node_id, target_node_id, type, permissions_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'context', '{\"read\":true}', ?, ?)")
            .bind(&edge_id).bind(&canvas_id).bind(&folder_id).bind(&agent_id).bind(&now).bind(&now).execute(&pool).await.unwrap();
        pool.close().await;

        let pool = connect(&database_url).await.unwrap();
        let boards = list_boards(&pool, &workspace_id).await.unwrap();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].id, canvas_id);
        assert_eq!(boards[0].name, "Default");
        assert_eq!(boards[0].sort_order, 0);

        let document = load_board(&pool, &workspace_id, &canvas_id).await.unwrap();
        let folder = document
            .nodes
            .iter()
            .find(|node| node.id == folder_id)
            .unwrap();
        assert_eq!(folder.node_type, "context");
        assert_eq!(folder.data["kind"], "context");
        assert_eq!(folder.data["status"], "error");
        assert_eq!(folder.zoom, "normal");
        let agent = document
            .nodes
            .iter()
            .find(|node| node.id == agent_id)
            .unwrap();
        assert_eq!(agent.data["contextChips"], serde_json::json!([]));
        assert_eq!(document.edges[0].edge_type, "ref");
        assert_eq!(document.edges[0].board_id, canvas_id);
        assert!(document.strokes.is_empty());

        let workspace = get_workspace(&pool, &workspace_id).await.unwrap();
        assert_eq!(workspace.color, DEFAULT_WORKSPACE_COLOR);
        assert!(workspace.permissions.read);
        assert!(!workspace.permissions.execute);
        assert!(!workspace.gateway_enabled);
        assert_eq!(workspace.last_opened_at, now);

        // The migrated document must be accepted by the v2 validator.
        validate_document(&canvas_id, &document.nodes, &document.edges).unwrap();
    }
}

#[cfg(test)]
mod default_node_payload_tests {
    use super::valid_node_data;
    use crate::model::{CanvasNode, Position};

    fn node(node_type: &str, data: serde_json::Value) -> CanvasNode {
        CanvasNode {
            id: "n".into(),
            board_id: "b".into(),
            node_type: node_type.into(),
            position: Position { x: 0.0, y: 0.0 },
            size: None,
            zoom: "normal".into(),
            data,
            created_at: "2026-09-02T00:00:00+00:00".into(),
            updated_at: "2026-09-02T00:00:00+00:00".into(),
        }
    }

    /// Mirrors `apps/web/src/nodes/defaults.ts`: every palette default must
    /// be saveable before the user types anything.
    #[test]
    fn palette_defaults_are_valid() {
        let base = |extra: serde_json::Value| {
            let mut value = serde_json::json!({ "title": "t", "status": "idle" });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value
        };
        let cases = [
            (
                "task",
                serde_json::json!({ "kind": "task", "description": "", "checklist": [] }),
            ),
            (
                "agent",
                serde_json::json!({ "kind": "agent", "adapter": "custom", "projectPath": "/p", "command": "", "args": [], "contextChips": [] }),
            ),
            (
                "terminal",
                serde_json::json!({ "kind": "terminal", "cwd": "/p", "shell": "/bin/zsh" }),
            ),
            (
                "diff",
                serde_json::json!({ "kind": "diff", "repoPath": ".", "files": [] }),
            ),
            (
                "file",
                serde_json::json!({ "kind": "file", "path": ".", "mimeType": "text/plain", "size": 0, "readonly": false, "syncPolicy": "local_only" }),
            ),
            (
                "context",
                serde_json::json!({ "kind": "context", "path": ".", "includePatterns": [], "excludePatterns": [".git"] }),
            ),
            ("note", serde_json::json!({ "kind": "note", "content": "" })),
            (
                "browser",
                serde_json::json!({ "kind": "browser", "url": "", "history": [], "historyIndex": -1 }),
            ),
            (
                "image",
                serde_json::json!({ "kind": "image", "src": "data:,", "mimeType": "image/png" }),
            ),
            (
                "log",
                serde_json::json!({ "kind": "log", "content": "", "level": "info" }),
            ),
        ];
        for (node_type, data) in cases {
            assert!(
                valid_node_data(&node(node_type, base(data))),
                "{node_type} default rejected"
            );
        }
    }
}
