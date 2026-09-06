//! Reading the agent domain out of this database: one workspace's records as
//! the contract sees them, and what the Runtime believes about its agents now.

use armadra_protocol::v1::{
    AgentStatus, Approval, ApprovalState, ContextLinks, Delivery, Handoff, MailboxMessage,
    SessionAddress, WorkerAgentState,
};
use sqlx::{Row, SqlitePool};

use crate::error::AppResult;

use super::AgentRecords;
use super::columns::{millis, outcome_of, state_from_columns, state_of, text};
use super::links::decode_links;

/// Reads one workspace's agent records as the contract sees them.
pub async fn records_for(
    connection: &mut sqlx::SqliteConnection,
    workspace_id: &str,
) -> AppResult<AgentRecords> {
    let mut result = AgentRecords::default();
    for row in sqlx::query(
        "SELECT node_id, workspace_id, agent_id, state, unread, session_id, verified, restored, \
         transcript_path, last_event_at, session_phase, errored, interrupted, updated_at \
         FROM agent_status WHERE workspace_id = ? ORDER BY node_id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        result.statuses.push(AgentStatus {
            node_id: row.try_get("node_id")?,
            workspace_id: row.try_get("workspace_id")?,
            session_id: text(&row, "session_id")?,
            generation: 0,
            agent_id: text(&row, "agent_id")?,
            unread: row.try_get::<Option<i64>, _>("unread")?.unwrap_or(0).max(0) as u32,
            verified: row.try_get::<Option<i64>, _>("verified")?.unwrap_or(0) != 0,
            restored: row.try_get::<Option<i64>, _>("restored")?.unwrap_or(0) != 0,
            errored: row
                .try_get::<Option<i64>, _>("errored")?
                .map(|value| value != 0),
            interrupted: row
                .try_get::<Option<i64>, _>("interrupted")?
                .map(|value| value != 0),
            transcript_ref: text(&row, "transcript_path")?.into_bytes(),
            state: state_of(&text(&row, "state")?)? as i32,
            session_phase: text(&row, "session_phase")?,
            reason_code: String::new(),
            last_event_at_unix_ms: millis(&row, "last_event_at")?,
            updated_at_unix_ms: millis(&row, "updated_at")?,
            revision: 0,
            deleted: false,
        });
    }
    for row in sqlx::query(
        "SELECT id, node_id, workspace_id, request_json, answer, answered_by, created_at, answered_at \
         FROM agent_approvals WHERE workspace_id = ? ORDER BY id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        let decision = text(&row, "answer")?;
        let answered = millis(&row, "answered_at")?;
        let state = if decision.is_empty() || answered <= 0 {
            ApprovalState::Pending
        } else {
            ApprovalState::Answered
        };
        result.approvals.push(Approval {
            approval_id: row.try_get("id")?,
            node_id: text(&row, "node_id")?,
            workspace_id: row.try_get("workspace_id")?,
            session_id: String::new(),
            generation: 0,
            request: text(&row, "request_json")?.into_bytes(),
            request_sha256: Vec::new(),
            decision: if state == ApprovalState::Answered {
                decision
            } else {
                String::new()
            },
            answered_by: text(&row, "answered_by")?,
            state: state as i32,
            reason_code: String::new(),
            created_at_unix_ms: millis(&row, "created_at")?,
            answered_at_unix_ms: if state == ApprovalState::Answered {
                answered
            } else {
                0
            },
            revision: 0,
        });
    }
    for row in sqlx::query(
        "SELECT sequence, id, workspace_id, source_node_id, target_node_id, message_key, body, \
         created_at, expires_at, acknowledged_at FROM agent_mailbox WHERE workspace_id = ? \
         ORDER BY sequence",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        result.messages.push(MailboxMessage {
            message_id: row.try_get("id")?,
            workspace_id: row.try_get("workspace_id")?,
            source_node_id: text(&row, "source_node_id")?,
            target_node_id: text(&row, "target_node_id")?,
            message_key: text(&row, "message_key")?,
            body: text(&row, "body")?,
            sequence: row.try_get::<i64, _>("sequence")?.max(0) as u64,
            created_at_unix_ms: row.try_get::<Option<i64>, _>("created_at")?.unwrap_or(0),
            expires_at_unix_ms: row.try_get::<Option<i64>, _>("expires_at")?.unwrap_or(0),
            acknowledged_at_unix_ms: row
                .try_get::<Option<i64>, _>("acknowledged_at")?
                .unwrap_or(0),
            revision: 0,
            deleted: false,
        });
    }
    for row in sqlx::query(
        "SELECT trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt, \
         body_chars, created_at FROM agent_deliveries WHERE workspace_id = ? ORDER BY trace_id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        result.deliveries.push(Delivery {
            trace_id: row.try_get("trace_id")?,
            workspace_id: row.try_get("workspace_id")?,
            source_node_id: text(&row, "source_node_id")?,
            target_node_id: text(&row, "target_node_id")?,
            receipt: text(&row, "receipt")?,
            body_chars: row
                .try_get::<Option<i64>, _>("body_chars")?
                .unwrap_or(0)
                .max(0) as u32,
            outcome: outcome_of(&text(&row, "outcome")?) as i32,
            reason_code: String::new(),
            created_at_unix_ms: millis(&row, "created_at")?,
            revision: 0,
        });
    }
    for row in sqlx::query(
        "SELECT h.id, h.workspace_id, h.source_node_id, h.source_session_id, h.source_generation, \
         h.target_node_id, h.target_session_id, h.target_generation, h.bundle_json, h.state, \
         h.mailbox_id, h.trace_id, h.error_code, h.created_at, h.accepted_at, h.updated_at, \
         COALESCE(o.state, '') AS outbox_state, COALESCE(o.attempts, 0) AS attempts \
         FROM agent_handoffs h LEFT JOIN agent_handoff_outbox o ON o.handoff_id = h.id \
         WHERE h.workspace_id = ? ORDER BY h.id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        result.handoffs.push(Handoff {
            handoff_id: row.try_get("id")?,
            workspace_id: row.try_get("workspace_id")?,
            source_node_id: text(&row, "source_node_id")?,
            target_node_id: text(&row, "target_node_id")?,
            source: Some(SessionAddress {
                session_id: text(&row, "source_session_id")?,
                generation: row
                    .try_get::<Option<i64>, _>("source_generation")?
                    .unwrap_or(0)
                    .max(0) as u64,
            }),
            target: Some(SessionAddress {
                session_id: text(&row, "target_session_id")?,
                generation: row
                    .try_get::<Option<i64>, _>("target_generation")?
                    .unwrap_or(0)
                    .max(0) as u64,
            }),
            bundle: text(&row, "bundle_json")?.into_bytes(),
            bundle_sha256: Vec::new(),
            mailbox_id: text(&row, "mailbox_id")?,
            trace_id: text(&row, "trace_id")?,
            attempts: row.try_get::<i64, _>("attempts")?.max(0) as u32,
            state: state_from_columns(&text(&row, "state")?, &text(&row, "outbox_state")?) as i32,
            error_code: text(&row, "error_code")?,
            created_at_unix_ms: millis(&row, "created_at")?,
            accepted_at_unix_ms: millis(&row, "accepted_at")?,
            updated_at_unix_ms: millis(&row, "updated_at")?,
            revision: 0,
        });
    }
    for row in sqlx::query(
        "SELECT node_id, workspace_id, links_json, updated_at FROM context_links \
         WHERE workspace_id = ? ORDER BY node_id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        result.links.push(ContextLinks {
            node_id: row.try_get("node_id")?,
            workspace_id: row.try_get("workspace_id")?,
            links: decode_links(&text(&row, "links_json")?)?,
            updated_at_unix_ms: millis(&row, "updated_at")?,
            revision: 0,
        });
    }
    Ok(result)
}
/// Reads what this Runtime believes about its agents right now.
///
/// These are observations, not records: nothing here carries a revision,
/// because this Runtime stores no CAS token for a domain it no longer owns, and
/// a value there would be one the Host could mistake for agreement.
pub async fn worker_states(pool: &SqlitePool) -> AppResult<(Vec<WorkerAgentState>, Vec<Approval>)> {
    let mut agents = Vec::new();
    let mut approvals = Vec::new();
    let workspaces: Vec<String> = sqlx::query_scalar("SELECT id FROM workspaces ORDER BY id")
        .fetch_all(pool)
        .await?;
    let mut connection = pool.acquire().await?;
    for workspace_id in workspaces {
        let records = records_for(&mut connection, &workspace_id).await?;
        for status in records.statuses {
            agents.push(WorkerAgentState {
                node_id: status.node_id,
                workspace_id: status.workspace_id,
                session_id: status.session_id,
                generation: status.generation,
                agent_id: status.agent_id,
                unread: status.unread,
                verified: status.verified,
                restored: status.restored,
                errored: status.errored,
                interrupted: status.interrupted,
                transcript_ref: status.transcript_ref,
                state: status.state,
                session_phase: status.session_phase,
                last_event_at_unix_ms: status.last_event_at_unix_ms,
                updated_at_unix_ms: status.updated_at_unix_ms,
            });
        }
        // Only the questions still open. An answered approval is history, and a
        // Host recording it as newly appeared would show a question nobody is
        // waiting on.
        approvals.extend(
            records
                .approvals
                .into_iter()
                .filter(|approval| approval.state == ApprovalState::Pending as i32),
        );
    }
    Ok((agents, approvals))
}
