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

mod apply;
mod canonical;
mod columns;
mod links;
mod read;

use armadra_protocol::v1::{
    AgentStatus, Approval, ContextLinks, Delivery, ExportIssue, Handoff, MailboxMessage,
    ReverseExportRecord, reverse_export_record::Entity,
};

use super::records;
use crate::error::AppResult;

pub use self::apply::apply_records;
pub use self::canonical::{
    canonical_approval, canonical_delivery, canonical_handoff, canonical_links, canonical_message,
    canonical_status, content_digest,
};
pub use self::read::{records_for, worker_states};

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
