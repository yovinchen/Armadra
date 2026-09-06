//! The words the agent tables store, and the contract enums they map to in
//! both directions. Column readers for a row live here too.

use armadra_protocol::v1::{AgentState, DeliveryOutcome, HandoffState};
use sqlx::Row;

use super::super::records::corrupt;
use crate::error::AppResult;

pub(super) fn text(row: &sqlx::sqlite::SqliteRow, name: &str) -> AppResult<String> {
    Ok(row.try_get::<Option<String>, _>(name)?.unwrap_or_default())
}

pub(super) fn millis(row: &sqlx::sqlite::SqliteRow, name: &str) -> AppResult<i64> {
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
pub(super) fn state_of(value: &str) -> AppResult<AgentState> {
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
pub(super) fn state_column(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "working",
        AgentState::Waiting => "waiting",
        AgentState::Blocked => "blocked",
        AgentState::Done => "done",
        _ => "idle",
    }
}

pub(super) fn outcome_of(value: &str) -> DeliveryOutcome {
    match value {
        "submitted" | "delivered" => DeliveryOutcome::Submitted,
        "notWritten" | "not_written" | "refused" => DeliveryOutcome::NotWritten,
        _ => DeliveryOutcome::Unknown,
    }
}

pub(super) fn outcome_column(outcome: DeliveryOutcome) -> &'static str {
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
pub(super) fn handoff_columns(state: HandoffState) -> (&'static str, &'static str) {
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

pub(super) fn state_from_columns(handoff: &str, outbox: &str) -> HandoffState {
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
