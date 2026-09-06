//! The `workspaces` table: creation (local and remote), listing, patching,
//! deletion and the colour validation they share.

use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::{
        BoardBrief, DEFAULT_BOARD_NAME, DEFAULT_WORKSPACE_COLOR, Viewport, Workspace,
        WorkspacePermissions, WorkspaceSummary,
    },
};

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
        execution_host_id: row.try_get("execution_host_id")?,
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
        execution_host_id: String::new(),
        last_opened_at: now.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// A workspace whose files live on an SSH execution host (H02). The root is a
/// path on *that* host: nothing here touches the local filesystem, and the
/// canonical form is frozen by the remote Worker's own root registration.
///
/// `root_path` is globally unique, so a remote root that spells the same path
/// as an existing row on another host is a conflict rather than a silent
/// hand-back of that other workspace: they are different places.
pub async fn create_remote_workspace(
    pool: &SqlitePool,
    name: &str,
    execution_host_id: &str,
    root_path: &str,
    permissions: Option<&WorkspacePermissions>,
) -> AppResult<Workspace> {
    if execution_host_id.is_empty() {
        return Err(AppError::BadRequest(
            "A remote workspace requires an execution host".into(),
        ));
    }
    let id = Uuid::now_v7().to_string();
    let board_id = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    let color = normalize_color(None)?;
    let permissions = permissions.cloned().unwrap_or_default();
    let permissions_json = serde_json::to_string(&permissions)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let mut transaction = pool.begin().await?;
    let result = sqlx::query(
        "INSERT INTO workspaces (id, name, root_path, color, permissions_json, execution_host_id, last_opened_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_path) DO NOTHING",
    )
    .bind(&id)
    .bind(name)
    .bind(root_path)
    .bind(&color)
    .bind(&permissions_json)
    .bind(execution_host_id)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        transaction.rollback().await?;
        let existing = get_workspace_by_root(pool, root_path).await?;
        return if existing.execution_host_id == execution_host_id {
            Ok(existing)
        } else {
            Err(AppError::Conflict(
                "Another workspace already uses this path on a different execution host".into(),
            ))
        };
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
        execution_host_id: execution_host_id.to_owned(),
        last_opened_at: now.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn list_workspaces(pool: &SqlitePool) -> AppResult<Vec<WorkspaceSummary>> {
    let rows = sqlx::query(
        "SELECT id, name, root_path, color, permissions_json, execution_host_id, \
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
        "SELECT id, name, root_path, color, permissions_json, execution_host_id, \
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
        "SELECT id, name, root_path, color, permissions_json, execution_host_id, \
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

/// Point a workspace at a different execution host and root.
///
/// Deliberately separate from [`update_workspace`]: name, colour and
/// permissions are preferences, while this changes *which machine the project
/// is on*. Everything that decides whether it is allowed — the fingerprint
/// comparison and the blocker list — happens in `remote::switch` before this
/// is reached, so a caller that reaches here has already proved the case.
pub async fn rebind_workspace_execution(
    pool: &SqlitePool,
    id: &str,
    execution_host_id: &str,
    root_path: &str,
) -> AppResult<Workspace> {
    if root_path.trim().is_empty() {
        return Err(AppError::BadRequest("Workspace root is required".into()));
    }
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE workspaces SET execution_host_id = ?, root_path = ?, updated_at = ? WHERE id = ?",
    )
    .bind(execution_host_id)
    .bind(root_path)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Workspace was not found".into()));
    }
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

pub(super) fn is_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}
