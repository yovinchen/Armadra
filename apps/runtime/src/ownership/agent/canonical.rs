//! The canonical form both sides hash. Everything dropped here is a fact about
//! a record rather than about an agent; see the module documentation.

use armadra_protocol::v1::{
    AgentStatus, Approval, ContextLinks, Delivery, Handoff, MailboxMessage, ReverseExportRecord,
    reverse_export_record::Entity,
};

use super::super::records::{digest, encode_records};

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
        // `attempts` lives in `agent_handoff_outbox`, and a handoff that
        // reached a terminal state has no outbox row left to hold it. Comparing
        // it would make the round trip permanently false for exactly the
        // handoffs that finished.
        attempts: 0,
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
