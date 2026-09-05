//! The retired kanban archive: read-only access to the rows the board
//! retirement moved out of `boards.kanban_json`.

use sqlx::{Row, SqlitePool};

use crate::error::{AppError, AppResult};

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
