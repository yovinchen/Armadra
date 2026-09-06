//! Applying one package's agent records inside the caller's transaction, then
//! reading the rows back so the report describes the database and not a buffer.

use armadra_protocol::v1::{
    AgentState, ApplyReverseExportRequest, ApprovalState, DeliveryOutcome, ExportIssue,
    ExportTable, HandoffState, ReverseExportFile, ReverseImportReport,
};

use crate::error::AppResult;

use super::super::{records, sweep};
use super::canonical::content_digest;
use super::columns::{handoff_columns, outcome_column, state_column};
use super::links::encode_links;
use super::read::records_for;
use super::{AgentRecords, DOMAIN, TOUCHED_TABLES, missing, none_if_empty};

/// Applies one package's agent records inside the caller's transaction and
/// reports what the rows say afterwards.
///
/// The read-back is the point. A report assembled from the records that were
/// about to be written would prove only that this process can hash its own
/// buffer; the digests below come from a fresh read of the rows.
///
/// A record the Host created while it held the domain is *inserted*, not
/// refused. That is what §2.12 asks for — the package is the domain's whole
/// content, and a rollback that dropped everything the Host recorded would not
/// be a rollback — and it is safe here in a way it is not for a session: these
/// rows reference `workspaces` and `nodes`, and both of those exist already.
/// The canvas domain rolls back after this one, but its rollback rewrites
/// columns rather than removing nodes, so nothing this insert names disappears.
///
/// A row whose node really is gone is the one case left, and the database says
/// so: the foreign key fails, and it is reported as an issue that blocks the
/// handback rather than silently dropped.
pub async fn apply_records(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    request: &ApplyReverseExportRequest,
    files: &[(String, String, AgentRecords)],
) -> AppResult<(ReverseImportReport, Vec<ExportIssue>)> {
    let mut written = 0u64;
    let mut issues = Vec::new();
    for (name, _workspace_id, records) in files {
        for status in &records.statuses {
            let stored = sqlx::query(
                "INSERT INTO agent_status(node_id, workspace_id, agent_id, state, unread, \
                 session_id, verified, restored, transcript_path, last_event_at, session_phase, \
                 errored, interrupted, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, \
                 agent_id = excluded.agent_id, state = excluded.state, unread = excluded.unread, \
                 session_id = excluded.session_id, verified = excluded.verified, \
                 restored = excluded.restored, transcript_path = excluded.transcript_path, \
                 last_event_at = excluded.last_event_at, session_phase = excluded.session_phase, \
                 errored = excluded.errored, interrupted = excluded.interrupted, \
                 updated_at = excluded.updated_at",
            )
            .bind(&status.node_id)
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
            .execute(&mut **transaction)
            .await;
            match stored {
                Ok(result) => written += result.rows_affected(),
                Err(_) => {
                    issues.push(missing(name, "agent_status", &status.node_id));
                    continue;
                }
            }
        }
        for approval in &records.approvals {
            let answered = approval.state == ApprovalState::Answered as i32;
            // `request_json` and `created_at` are the question as it was asked;
            // they are written once, by the insert, and never rewritten. A
            // rollback that could restate the question would leave an audit
            // entry saying somebody allowed something they were never shown.
            let stored = sqlx::query(
                "INSERT INTO agent_approvals(id, node_id, workspace_id, request_json, answer, \
                 answered_by, created_at, answered_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, \
                 workspace_id = excluded.workspace_id, answer = excluded.answer, \
                 answered_by = excluded.answered_by, answered_at = excluded.answered_at",
            )
            .bind(&approval.approval_id)
            .bind(&approval.node_id)
            .bind(&approval.workspace_id)
            .bind(String::from_utf8_lossy(&approval.request).into_owned())
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
            .bind(records::timestamp(approval.created_at_unix_ms.max(1))?)
            .bind(if answered {
                records::optional_timestamp(approval.answered_at_unix_ms)?
            } else {
                None
            })
            .execute(&mut **transaction)
            .await;
            match stored {
                Ok(result) => written += result.rows_affected(),
                Err(_) => {
                    issues.push(missing(name, "agent_approvals", &approval.approval_id));
                    continue;
                }
            }
        }
        for message in &records.messages {
            // `sequence` is the inbox's own order and is restored explicitly:
            // letting the autoincrement pick a new one would reorder somebody's
            // inbox on a rollback, which is two messages read in the wrong order.
            let stored = sqlx::query(
                "INSERT INTO agent_mailbox(sequence, id, workspace_id, source_node_id, \
                 target_node_id, message_key, body, created_at, expires_at, acknowledged_at) \
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET \
                 body = excluded.body, expires_at = excluded.expires_at, \
                 acknowledged_at = excluded.acknowledged_at",
            )
            .bind(message.sequence as i64)
            .bind(&message.message_id)
            .bind(&message.workspace_id)
            .bind(&message.source_node_id)
            .bind(&message.target_node_id)
            .bind(&message.message_key)
            .bind(&message.body)
            .bind(message.created_at_unix_ms)
            .bind(message.expires_at_unix_ms)
            .bind(if message.acknowledged_at_unix_ms > 0 {
                Some(message.acknowledged_at_unix_ms)
            } else {
                None
            })
            .execute(&mut **transaction)
            .await;
            match stored {
                Ok(result) => written += result.rows_affected(),
                Err(_) => {
                    issues.push(missing(name, "agent_mailbox", &message.message_id));
                    continue;
                }
            }
        }
        for delivery in &records.deliveries {
            let stored = sqlx::query(
                "INSERT INTO agent_deliveries(trace_id, workspace_id, source_node_id, \
                 target_node_id, outcome, receipt, body_chars, created_at) \
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trace_id) DO UPDATE SET \
                 outcome = excluded.outcome, receipt = excluded.receipt, \
                 body_chars = excluded.body_chars",
            )
            .bind(&delivery.trace_id)
            .bind(&delivery.workspace_id)
            .bind(&delivery.source_node_id)
            .bind(&delivery.target_node_id)
            .bind(outcome_column(
                DeliveryOutcome::try_from(delivery.outcome).unwrap_or(DeliveryOutcome::Unknown),
            ))
            .bind(none_if_empty(&delivery.receipt))
            .bind(i64::from(delivery.body_chars))
            .bind(records::timestamp(delivery.created_at_unix_ms.max(1))?)
            .execute(&mut **transaction)
            .await;
            match stored {
                Ok(result) => written += result.rows_affected(),
                Err(_) => {
                    issues.push(missing(name, "agent_deliveries", &delivery.trace_id));
                    continue;
                }
            }
        }
        for handoff in &records.handoffs {
            // The frozen half is in the INSERT and absent from the DO UPDATE,
            // and that is not an omission: `freeze_agent_handoff_bundle` aborts
            // an update that touches it. A rollback restores a handoff that was
            // prepared here, and never rewrites one that already exists.
            let (state, outbox) = handoff_columns(
                HandoffState::try_from(handoff.state).unwrap_or(HandoffState::Prepared),
            );
            let source = handoff.source.clone().unwrap_or_default();
            let target = handoff.target.clone().unwrap_or_default();
            let stored = sqlx::query(
                "INSERT INTO agent_handoffs(id, workspace_id, source_node_id, source_session_id, \
                 source_generation, target_node_id, target_session_id, target_generation, \
                 bundle_json, bundle_digest, state, mailbox_id, trace_id, error_code, created_at, \
                 accepted_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET state = excluded.state, \
                 mailbox_id = excluded.mailbox_id, trace_id = excluded.trace_id, \
                 error_code = excluded.error_code, accepted_at = excluded.accepted_at, \
                 updated_at = excluded.updated_at",
            )
            .bind(&handoff.handoff_id)
            .bind(&handoff.workspace_id)
            .bind(&handoff.source_node_id)
            .bind(&source.session_id)
            .bind(source.generation as i64)
            .bind(&handoff.target_node_id)
            .bind(&target.session_id)
            .bind(target.generation as i64)
            .bind(String::from_utf8_lossy(&handoff.bundle).into_owned())
            // The column is this Runtime's own digest of the stored text, and
            // `handoff::decode` re-checks it on every read. Writing the Host's
            // bytes back verbatim would leave a row that refuses to be read.
            .bind(crate::handoff::digest(handoff.bundle.as_slice()))
            .bind(state)
            .bind(none_if_empty(&handoff.mailbox_id))
            .bind(none_if_empty(&handoff.trace_id))
            .bind(none_if_empty(&handoff.error_code))
            .bind(records::timestamp(handoff.created_at_unix_ms.max(1))?)
            .bind(records::optional_timestamp(handoff.accepted_at_unix_ms)?)
            .bind(records::timestamp(handoff.updated_at_unix_ms.max(1))?)
            .execute(&mut **transaction)
            .await;
            match stored {
                Ok(result) => written += result.rows_affected(),
                Err(_) => {
                    issues.push(missing(name, "agent_handoffs", &handoff.handoff_id));
                    continue;
                }
            }
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

    // The package is the domain's whole content (§2.12), so whatever it no
    // longer names is gone from the Host and has to go from here too. Without
    // this a rollback was additive in one direction only: a status the Host
    // deleted came back, and an approval somebody withdrew was open again.
    //
    // `agent_handoff_outbox` is swept through its parent rather than directly:
    // it has no workspace column, and an entry whose handoff is gone is work
    // nothing can finish.
    for (_, workspace_id, records) in files {
        for kept in [
            sweep::Kept {
                table: "agent_status",
                id_column: "node_id",
                ids: records
                    .statuses
                    .iter()
                    .map(|status| status.node_id.clone())
                    .collect(),
            },
            sweep::Kept {
                table: "agent_approvals",
                id_column: "id",
                ids: records
                    .approvals
                    .iter()
                    .map(|approval| approval.approval_id.clone())
                    .collect(),
            },
            sweep::Kept {
                table: "agent_mailbox",
                id_column: "id",
                ids: records
                    .messages
                    .iter()
                    .map(|message| message.message_id.clone())
                    .collect(),
            },
            sweep::Kept {
                table: "agent_deliveries",
                id_column: "trace_id",
                ids: records
                    .deliveries
                    .iter()
                    .map(|delivery| delivery.trace_id.clone())
                    .collect(),
            },
            sweep::Kept {
                table: "agent_handoffs",
                id_column: "id",
                ids: records
                    .handoffs
                    .iter()
                    .map(|handoff| handoff.handoff_id.clone())
                    .collect(),
            },
            sweep::Kept {
                table: "context_links",
                id_column: "node_id",
                ids: records
                    .links
                    .iter()
                    .map(|links| links.node_id.clone())
                    .collect(),
            },
        ] {
            sweep::delete_absent(transaction, workspace_id, &kept).await?;
        }
        sqlx::query(
            "DELETE FROM agent_handoff_outbox WHERE handoff_id NOT IN (SELECT id FROM agent_handoffs)",
        )
        .execute(&mut **transaction)
        .await?;
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
