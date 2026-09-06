//! The `agent_deliveries` table: messages handed to a node and the log the
//! sender reads back.
//!
//! **Deprecated as a collaboration record.** `canvas send / reply / notify` —
//! the verbs that typed a peer's message into a terminal — are gone, and the
//! collaboration layer no longer inserts here: a peer's message lives in
//! `agent_mailbox` until its recipient reads it. Published migrations are not
//! rewritten, so the table and this module stay: the ownership domain still
//! imports and exports the rows a Host wrote, `GET /api/workspaces/{id}/
//! deliveries` still reads the history back, and old rows keep meaning what
//! they meant. Nothing new is written by the Runtime itself.

use chrono::Utc;
use sqlx::{Row, SqlitePool};

use crate::{
    error::{AppError, AppResult},
    model::AgentDelivery,
};

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
