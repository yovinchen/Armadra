//! The agent domain's rows, in both directions
//! (Go Host 业务所有权迁移 §2.7, §2.12, §3.3 agent row).
//!
//! Six tables move together and none of them can move alone: an approval whose
//! node has no status is one no board can draw, and a handoff whose message is
//! gone is a bundle nobody can read. So this module reads all six as the
//! contract's messages, and writes all six back.
//!
//! What it does *not* move is everything the execution host is: the Hook
//! endpoint and its token, the pending-approval file, the transcript on disk,
//! `hook_installs`, `conversations`. Those stay here whoever owns the records,
//! and the switch never touches them.
//!
//! # What the canonical form clears, and why
//!
//! The digest both sides hash covers only what this database can hold. Four
//! things are dropped, and each is a fact about the Host's record rather than
//! about an agent:
//!
//!   * `revision` — the Host storage kernel's CAS number; there is no column.
//!   * `generation` on a status and an approval — `agent_status` and
//!     `agent_approvals` name a session but never a generation, because this
//!     Runtime *was* the execution host and its rows could not be about a pane
//!     that had been replaced underneath them.
//!   * `request_sha256` and `bundle_sha256` — the Host computes those itself
//!     over bodies this side stores as text. Comparing them would compare an
//!     artefact of the projection rather than the question or the bundle.
//!   * `reason_code` on a status and a delivery, and `attempts` on a handoff —
//!     the first two have no column here at all, and the third lives in
//!     `agent_handoff_outbox`, which the Host folded into one row.
//!
//! Including any of them would make the comparison that decides whether a
//! rollback landed permanently false.

use armadra_protocol::v1::{
    AgentState, AgentStatus, ApplyReverseExportRequest, Approval, ApprovalState, ContextLink,
    ContextLinkDirection, ContextLinks, Delivery, DeliveryOutcome, ExportIssue, ExportTable,
    Handoff, HandoffState, MailboxMessage, ReverseExportFile, ReverseExportRecord,
    ReverseImportReport, SessionAddress, WorkerAgentState, reverse_export_record::Entity,
};
use sqlx::{Row, SqlitePool};

use super::records::{self, corrupt, digest, encode_records};
use crate::error::AppResult;

/// The domain name in the package index and on the Worker channel.
pub const DOMAIN: &str = super::domains::OwnershipDomain::Agent.as_str();

/// The tables an agent reverse import writes.
pub const TOUCHED_TABLES: [&str; 6] = [
    "agent_status",
    "agent_approvals",
    "agent_mailbox",
    "agent_deliveries",
    "agent_handoffs",
    "context_links",
];

fn text(row: &sqlx::sqlite::SqliteRow, name: &str) -> AppResult<String> {
    Ok(row.try_get::<Option<String>, _>(name)?.unwrap_or_default())
}

fn millis(row: &sqlx::sqlite::SqliteRow, name: &str) -> AppResult<i64> {
    let stored: Option<String> = row.try_get(name)?;
    match stored.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(0),
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|parsed| parsed.timestamp_millis())
            .map_err(|_| corrupt("a stored agent timestamp cannot be read")),
    }
}

/// The reduced state as the contract spells it. A word this build does not know
/// is refused rather than folded into IDLE: a node recorded idle on no evidence
/// is a person coming back to find nothing was waiting when something was.
fn state_of(value: &str) -> AppResult<AgentState> {
    match value {
        "" | "idle" => Ok(AgentState::Idle),
        "working" => Ok(AgentState::Working),
        "waiting" => Ok(AgentState::Waiting),
        "blocked" => Ok(AgentState::Blocked),
        "done" => Ok(AgentState::Done),
        _ => Err(corrupt("a stored agent status names an unknown state")),
    }
}

/// The column a state becomes on the way back.
fn state_column(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "working",
        AgentState::Waiting => "waiting",
        AgentState::Blocked => "blocked",
        AgentState::Done => "done",
        _ => "idle",
    }
}

fn outcome_of(value: &str) -> DeliveryOutcome {
    match value {
        "submitted" | "delivered" => DeliveryOutcome::Submitted,
        "notWritten" | "not_written" | "refused" => DeliveryOutcome::NotWritten,
        _ => DeliveryOutcome::Unknown,
    }
}

fn outcome_column(outcome: DeliveryOutcome) -> &'static str {
    match outcome {
        DeliveryOutcome::Submitted => "submitted",
        DeliveryOutcome::NotWritten => "notWritten",
        _ => "unknown",
    }
}

/// The merged handoff state as one word this table can hold.
///
/// The Host merged `agent_handoffs.state` with the outbox's; the two halves are
/// separated again here, because that is the shape these tables have. A state
/// the outbox owns writes `prepared` into the handoff row and the real word
/// into the outbox, which is exactly how the Runtime wrote it before.
fn handoff_columns(state: HandoffState) -> (&'static str, &'static str) {
    match state {
        HandoffState::Queued => ("prepared", "pending"),
        HandoffState::Dispatching => ("prepared", "dispatching"),
        HandoffState::Delivered => ("delivered", "delivered"),
        HandoffState::Acknowledged => ("acknowledged", "delivered"),
        HandoffState::Cancelled => ("cancelled", ""),
        HandoffState::Failed => ("failed", "failed"),
        HandoffState::UnknownOutcome => ("unknownOutcome", "unknownOutcome"),
        _ => ("prepared", ""),
    }
}

fn state_from_columns(handoff: &str, outbox: &str) -> HandoffState {
    match outbox {
        "dispatching" => HandoffState::Dispatching,
        "delivered" if handoff == "acknowledged" => HandoffState::Acknowledged,
        "delivered" => HandoffState::Delivered,
        "failed" => HandoffState::Failed,
        "unknownOutcome" => HandoffState::UnknownOutcome,
        "pending" if handoff == "prepared" => HandoffState::Queued,
        _ => match handoff {
            "queued" | "accepted" => HandoffState::Queued,
            "delivered" => HandoffState::Delivered,
            "acknowledged" => HandoffState::Acknowledged,
            "cancelled" => HandoffState::Cancelled,
            "failed" => HandoffState::Failed,
            "unknownOutcome" => HandoffState::UnknownOutcome,
            _ => HandoffState::Prepared,
        },
    }
}

/// Everything the agent domain holds, read once.
#[derive(Debug, Default)]
pub struct AgentRecords {
    pub statuses: Vec<AgentStatus>,
    pub approvals: Vec<Approval>,
    pub messages: Vec<MailboxMessage>,
    pub deliveries: Vec<Delivery>,
    pub handoffs: Vec<Handoff>,
    pub links: Vec<ContextLinks>,
}

impl AgentRecords {
    pub fn len(&self) -> usize {
        self.statuses.len()
            + self.approvals.len()
            + self.messages.len()
            + self.deliveries.len()
            + self.handoffs.len()
            + self.links.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The package's own sequence, in the order the Host writes it. The order
    /// is part of the contract: a digest over the same records in a different
    /// order is a different digest.
    pub fn records(&self) -> Vec<ReverseExportRecord> {
        let mut out = Vec::with_capacity(self.len());
        for status in &self.statuses {
            out.push(ReverseExportRecord {
                entity: Some(Entity::AgentStatus(status.clone())),
            });
        }
        for approval in &self.approvals {
            out.push(ReverseExportRecord {
                entity: Some(Entity::Approval(approval.clone())),
            });
        }
        for message in &self.messages {
            out.push(ReverseExportRecord {
                entity: Some(Entity::MailboxMessage(message.clone())),
            });
        }
        for delivery in &self.deliveries {
            out.push(ReverseExportRecord {
                entity: Some(Entity::Delivery(delivery.clone())),
            });
        }
        for handoff in &self.handoffs {
            out.push(ReverseExportRecord {
                entity: Some(Entity::Handoff(handoff.clone())),
            });
        }
        for links in &self.links {
            out.push(ReverseExportRecord {
                entity: Some(Entity::ContextLinks(links.clone())),
            });
        }
        out
    }
}

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

/// One entry of the stored `links_json`.
#[derive(serde::Deserialize, serde::Serialize)]
struct StoredLink {
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(default)]
    direction: String,
    #[serde(default)]
    kind: String,
}

fn decode_links(raw: &str) -> AppResult<Vec<ContextLink>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let stored: Vec<StoredLink> = serde_json::from_str(raw)
        .map_err(|_| corrupt("a stored context link list cannot be read"))?;
    let mut links = stored
        .into_iter()
        .filter(|entry| !entry.node_id.is_empty())
        .map(|entry| ContextLink {
            target_node_id: entry.node_id,
            direction: if entry.direction == "incoming" {
                ContextLinkDirection::Incoming as i32
            } else {
                ContextLinkDirection::Outgoing as i32
            },
            kind: entry.kind,
        })
        .collect::<Vec<_>>();
    // One order, always: two readings of one board have to produce one digest.
    links.sort_by(|left, right| {
        (left.target_node_id.as_str(), left.direction)
            .cmp(&(right.target_node_id.as_str(), right.direction))
    });
    Ok(links)
}

fn encode_links(links: &[ContextLink]) -> String {
    let stored = links
        .iter()
        .map(|link| StoredLink {
            node_id: link.target_node_id.clone(),
            direction: if link.direction == ContextLinkDirection::Incoming as i32 {
                "incoming".into()
            } else {
                "outgoing".into()
            },
            kind: link.kind.clone(),
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&stored).unwrap_or_else(|_| "[]".into())
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

/* ------------------------------------------------------------- canonical */

pub fn canonical_status(status: &AgentStatus) -> AgentStatus {
    AgentStatus {
        generation: 0,
        reason_code: String::new(),
        updated_at_unix_ms: 0,
        revision: 0,
        ..status.clone()
    }
}

pub fn canonical_approval(approval: &Approval) -> Approval {
    Approval {
        session_id: String::new(),
        generation: 0,
        request_sha256: Vec::new(),
        reason_code: String::new(),
        revision: 0,
        ..approval.clone()
    }
}

pub fn canonical_message(message: &MailboxMessage) -> MailboxMessage {
    MailboxMessage {
        revision: 0,
        ..message.clone()
    }
}

pub fn canonical_delivery(delivery: &Delivery) -> Delivery {
    Delivery {
        reason_code: String::new(),
        revision: 0,
        ..delivery.clone()
    }
}

pub fn canonical_handoff(handoff: &Handoff) -> Handoff {
    Handoff {
        bundle_sha256: Vec::new(),
        updated_at_unix_ms: 0,
        revision: 0,
        ..handoff.clone()
    }
}

pub fn canonical_links(links: &ContextLinks) -> ContextLinks {
    ContextLinks {
        updated_at_unix_ms: 0,
        revision: 0,
        ..links.clone()
    }
}

/// The digest of one workspace's entity file in canonical form.
pub fn content_digest(records: &[ReverseExportRecord]) -> Vec<u8> {
    let canonical = records
        .iter()
        .map(|record| ReverseExportRecord {
            entity: match &record.entity {
                Some(Entity::AgentStatus(value)) => {
                    Some(Entity::AgentStatus(canonical_status(value)))
                }
                Some(Entity::Approval(value)) => Some(Entity::Approval(canonical_approval(value))),
                Some(Entity::MailboxMessage(value)) => {
                    Some(Entity::MailboxMessage(canonical_message(value)))
                }
                Some(Entity::Delivery(value)) => Some(Entity::Delivery(canonical_delivery(value))),
                Some(Entity::Handoff(value)) => Some(Entity::Handoff(canonical_handoff(value))),
                Some(Entity::ContextLinks(value)) => {
                    Some(Entity::ContextLinks(canonical_links(value)))
                }
                other => other.clone(),
            },
        })
        .collect::<Vec<_>>();
    digest(&encode_records(&canonical))
}

/// Splits one package file into the six kinds it holds. A record that is not an
/// agent record refuses the package rather than being skipped: a reader that
/// dropped what it did not understand would apply half a rollback.
pub fn from_records(records: Vec<ReverseExportRecord>) -> AppResult<AgentRecords> {
    let mut result = AgentRecords::default();
    for record in records {
        match record.entity {
            Some(Entity::AgentStatus(value)) => result.statuses.push(value),
            Some(Entity::Approval(value)) => result.approvals.push(value),
            Some(Entity::MailboxMessage(value)) => result.messages.push(value),
            Some(Entity::Delivery(value)) => result.deliveries.push(value),
            Some(Entity::Handoff(value)) => result.handoffs.push(value),
            Some(Entity::ContextLinks(value)) => result.links.push(value),
            Some(_) => {
                return Err(records::unsupported(
                    "an agent package carries an entity that is not an agent record",
                ));
            }
            None => {
                return Err(records::unsupported(
                    "an entity record names no known entity",
                ));
            }
        }
    }
    Ok(result)
}

/// Applies one package's agent records inside the caller's transaction and
/// reports what the rows say afterwards.
///
/// The read-back is the point. A report assembled from the records that were
/// about to be written would prove only that this process can hash its own
/// buffer; the digests below come from a fresh read of the rows.
///
/// A record the Host created while it held the domain has no row here. It is
/// reported as an error issue rather than inserted, for the reason the session
/// import gives: these rows reference `workspaces` and `nodes` rows the canvas
/// domain owns and rolls back after this one, and inventing them would leave
/// that rollback with records nobody exported.
pub async fn apply_records(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    request: &ApplyReverseExportRequest,
    files: &[(String, String, AgentRecords)],
) -> AppResult<(ReverseImportReport, Vec<ExportIssue>)> {
    let mut written = 0u64;
    let mut issues = Vec::new();
    for (name, _workspace_id, records) in files {
        for status in &records.statuses {
            let affected = sqlx::query(
                "UPDATE agent_status SET workspace_id = ?, agent_id = ?, state = ?, unread = ?, \
                 session_id = ?, verified = ?, restored = ?, transcript_path = ?, \
                 last_event_at = ?, session_phase = ?, errored = ?, interrupted = ?, \
                 updated_at = ? WHERE node_id = ?",
            )
            .bind(&status.workspace_id)
            .bind(&status.agent_id)
            .bind(state_column(
                AgentState::try_from(status.state).unwrap_or(AgentState::Idle),
            ))
            .bind(status.unread as i64)
            .bind(none_if_empty(&status.session_id))
            .bind(i64::from(status.verified))
            .bind(i64::from(status.restored))
            .bind(none_if_empty(&String::from_utf8_lossy(
                &status.transcript_ref,
            )))
            .bind(records::optional_timestamp(status.last_event_at_unix_ms)?)
            .bind(none_if_empty(&status.session_phase))
            .bind(status.errored.map(i64::from))
            .bind(status.interrupted.map(i64::from))
            .bind(records::timestamp(status.updated_at_unix_ms.max(1))?)
            .bind(&status.node_id)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if affected == 0 {
                issues.push(missing(name, "agent_status", &status.node_id));
                continue;
            }
            written += affected;
        }
        for approval in &records.approvals {
            let answered = approval.state == ApprovalState::Answered as i32;
            let affected = sqlx::query(
                "UPDATE agent_approvals SET node_id = ?, workspace_id = ?, answer = ?, \
                 answered_by = ?, answered_at = ? WHERE id = ?",
            )
            .bind(&approval.node_id)
            .bind(&approval.workspace_id)
            .bind(if answered {
                none_if_empty(&approval.decision)
            } else {
                None
            })
            .bind(if answered {
                none_if_empty(&approval.answered_by)
            } else {
                None
            })
            .bind(if answered {
                records::optional_timestamp(approval.answered_at_unix_ms)?
            } else {
                None
            })
            .bind(&approval.approval_id)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if affected == 0 {
                issues.push(missing(name, "agent_approvals", &approval.approval_id));
                continue;
            }
            written += affected;
        }
        for message in &records.messages {
            let affected = sqlx::query(
                "UPDATE agent_mailbox SET body = ?, expires_at = ?, acknowledged_at = ? \
                 WHERE id = ?",
            )
            .bind(&message.body)
            .bind(message.expires_at_unix_ms)
            .bind(if message.acknowledged_at_unix_ms > 0 {
                Some(message.acknowledged_at_unix_ms)
            } else {
                None
            })
            .bind(&message.message_id)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if affected == 0 {
                issues.push(missing(name, "agent_mailbox", &message.message_id));
                continue;
            }
            written += affected;
        }
        for delivery in &records.deliveries {
            let affected = sqlx::query(
                "UPDATE agent_deliveries SET outcome = ?, receipt = ?, body_chars = ? \
                 WHERE trace_id = ?",
            )
            .bind(outcome_column(
                DeliveryOutcome::try_from(delivery.outcome).unwrap_or(DeliveryOutcome::Unknown),
            ))
            .bind(none_if_empty(&delivery.receipt))
            .bind(i64::from(delivery.body_chars))
            .bind(&delivery.trace_id)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if affected == 0 {
                issues.push(missing(name, "agent_deliveries", &delivery.trace_id));
                continue;
            }
            written += affected;
        }
        for handoff in &records.handoffs {
            // The bundle and both endpoints are absent from this statement, and
            // that is not an omission: `freeze_agent_handoff_bundle` aborts an
            // update that touches them. A rollback restores what moved, and the
            // frozen half never moved.
            let (state, outbox) = handoff_columns(
                HandoffState::try_from(handoff.state).unwrap_or(HandoffState::Prepared),
            );
            let affected = sqlx::query(
                "UPDATE agent_handoffs SET state = ?, mailbox_id = ?, trace_id = ?, \
                 error_code = ?, accepted_at = ?, updated_at = ? WHERE id = ?",
            )
            .bind(state)
            .bind(none_if_empty(&handoff.mailbox_id))
            .bind(none_if_empty(&handoff.trace_id))
            .bind(none_if_empty(&handoff.error_code))
            .bind(records::optional_timestamp(handoff.accepted_at_unix_ms)?)
            .bind(records::timestamp(handoff.updated_at_unix_ms.max(1))?)
            .bind(&handoff.handoff_id)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if affected == 0 {
                issues.push(missing(name, "agent_handoffs", &handoff.handoff_id));
                continue;
            }
            written += affected;
            if outbox.is_empty() {
                sqlx::query("DELETE FROM agent_handoff_outbox WHERE handoff_id = ?")
                    .bind(&handoff.handoff_id)
                    .execute(&mut **transaction)
                    .await?;
                continue;
            }
            sqlx::query(
                "INSERT INTO agent_handoff_outbox(handoff_id, state, attempts, created_at) \
                 VALUES(?, ?, ?, ?) ON CONFLICT(handoff_id) DO UPDATE SET state = excluded.state, \
                 attempts = excluded.attempts",
            )
            .bind(&handoff.handoff_id)
            .bind(outbox)
            .bind(i64::from(handoff.attempts))
            .bind(records::timestamp(handoff.created_at_unix_ms.max(1))?)
            .execute(&mut **transaction)
            .await?;
        }
        for links in &records.links {
            // A context link row is a projection, so it is upserted rather than
            // required to exist: the Host may have derived one for a node this
            // side never had a row for, and the canvas edge that produced it is
            // this database's own.
            sqlx::query(
                "INSERT INTO context_links(node_id, workspace_id, links_json, updated_at) \
                 VALUES(?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET \
                 workspace_id = excluded.workspace_id, links_json = excluded.links_json, \
                 updated_at = excluded.updated_at",
            )
            .bind(&links.node_id)
            .bind(&links.workspace_id)
            .bind(encode_links(&links.links))
            .bind(records::timestamp(links.updated_at_unix_ms.max(1))?)
            .execute(&mut **transaction)
            .await?;
            written += 1;
        }
    }

    // Read the rows back, per workspace, exactly as a fresh export would.
    let mut reexported = Vec::with_capacity(files.len());
    for (name, workspace_id, _) in files {
        let stored = records_for(transaction, workspace_id).await?;
        let records = stored.records();
        reexported.push(ReverseExportFile {
            name: name.clone(),
            workspace_id: workspace_id.clone(),
            bytes: 0,
            sha256: Vec::new(),
            content_sha256: content_digest(&records),
            entity_count: records.len() as u64,
        });
    }
    let report = ReverseImportReport {
        import_id: request.import_id.clone(),
        domain: DOMAIN.into(),
        epoch: 0,
        index_sha256: Vec::new(),
        entity_count: reexported.iter().map(|file| file.entity_count).sum(),
        replayed: false,
        reexported,
        tables: TOUCHED_TABLES
            .iter()
            .map(|table| ExportTable {
                name: (*table).into(),
                row_count: written,
                readable: true,
                schema_sha256: Vec::new(),
            })
            .collect(),
        issues: Vec::new(),
        applied_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    };
    Ok((report, issues))
}

fn missing(file: &str, table: &str, identifier: &str) -> ExportIssue {
    ExportIssue {
        code: "reverse.missing_agent_record".into(),
        severity: "error".into(),
        entity: format!("{table}/{identifier}"),
        detail: format!("{file} names a {table} row this database does not have"),
    }
}

fn none_if_empty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}
