//! The `boards` table: listing, naming, creating, reordering and deleting a
//! workspace's boards.

use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use super::workspaces::get_workspace;
use crate::{
    error::{AppError, AppResult},
    model::{Board, Viewport},
};

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
