//! `/api/data` — the local data page: database info, backups and the
//! retired kanban archives.

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
    response::Response,
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    index, paths,
};

/* ----------------------------------- 数据 --------------------------------- */

/// `GET /api/data/info` — what the 数据 settings page shows (plan §24.1).
///
/// Paths and sizes only: nothing here needs the database to be quiescent, so
/// the handler never takes a write lock and is safe to poll.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    /// `<data_dir>` — the folder the "reveal in Finder" button opens.
    pub data_dir: String,
    /// `canvas.db` on disk. `0` when the file is missing (in-memory tests).
    pub db_bytes: u64,
    /// Rows in the conversations index.
    pub conversations: i64,
    /// `logs.retentionDays`; `0` = keep forever.
    pub board_log_retention_days: u64,
}

pub async fn data_info(State(state): State<AppState>) -> AppResult<Json<DataInfo>> {
    let database = paths::database_file();
    Ok(Json(DataInfo {
        data_dir: paths::data_dir().display().to_string(),
        db_bytes: std::fs::metadata(&database)
            .map(|meta| meta.len())
            .unwrap_or(0),
        conversations: index::count(&state.pool).await?,
        board_log_retention_days: state.settings.log_retention_days(),
    }))
}

use crate::sqlite_snapshot::snapshot_database;
pub use crate::sqlite_snapshot::{SnapshotInfo as DataBackup, backup_target};

/// `POST /api/data/backup` — a consistent snapshot of the connected main DB.
///
/// VACUUM INTO reads committed WAL data without copying/checkpointing the live
/// file. It preserves logical content, not physical layout or implicit rowids.
/// See https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause.
pub async fn data_backup(State(state): State<AppState>) -> AppResult<Json<DataBackup>> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    // Dropping an HTTP request must not cancel SQLx's worker while removing its
    // output underneath it. This task owns the connection and completes cleanup.
    Ok(Json(
        tokio::spawn(async move { snapshot_database(&state.pool, &stamp).await }).await??,
    ))
}

#[derive(Deserialize)]
pub struct LegacyArchiveQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

// These share the local Data-management boundary with data_backup, not an
// individual workspace's read permission. A future Host bridge must require
// separate data-management authority before exposing historical records.
pub async fn legacy_kanban_archives(
    State(state): State<AppState>,
    Query(query): Query<LegacyArchiveQuery>,
) -> AppResult<Json<crate::model::LegacyKanbanArchivePage>> {
    Ok(Json(
        db::list_legacy_kanban_archives(
            &state.pool,
            query.cursor.as_deref(),
            query.limit.unwrap_or(50),
        )
        .await?,
    ))
}

pub async fn legacy_kanban_archive(
    State(state): State<AppState>,
    AxumPath(canvas_id): AxumPath<String>,
) -> AppResult<Json<crate::model::LegacyKanbanArchive>> {
    Ok(Json(
        db::get_legacy_kanban_archive(&state.pool, &canvas_id).await?,
    ))
}

pub async fn export_legacy_kanban_archive(
    State(state): State<AppState>,
    AxumPath(canvas_id): AxumPath<String>,
) -> AppResult<Response> {
    let archive = db::get_legacy_kanban_archive(&state.pool, &canvas_id).await?;
    let body = serde_json::to_vec(&crate::model::LegacyKanbanArchiveExport {
        format_version: 1,
        archive,
    })
    .map_err(|_| AppError::Internal("Could not encode historical archive".into()))?;
    Response::builder()
        .header("Content-Type", "application/json; charset=utf-8")
        .header(
            "Content-Disposition",
            "attachment; filename=\"legacy-kanban-archive.json\"",
        )
        .header("Cache-Control", "no-store")
        .body(axum::body::Body::from(body))
        .map_err(|_| AppError::Internal("Could not export historical archive".into()))
}
