//! The `agent_approvals` table: recording a pending permission request and
//! the user's answer to it.

use chrono::Utc;
use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::{
    error::{AppError, AppResult},
    model::AgentApproval,
};

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
