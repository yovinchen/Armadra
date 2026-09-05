//! Agent-to-agent messages — plan §5.7.
//!
//! One agent asks us to type something into another agent's terminal. That is a
//! remote code execution primitive dressed as a courtesy, so the request passes
//! seven gates before a byte is written, and the *application* builds the frame:
//! the sender supplies a body and nothing else.
//!
//! ```text
//! identity → scope → workspace switch → flow control → idle gate → pane gate → deliver
//! ```
//!
//! Each gate has its own outcome so a refusal is diagnosable from the reply
//! alone, and every outcome carries `retryable` so the calling agent knows
//! whether waiting would help.

use std::time::Duration;

use chrono::Utc;
use serde_json::{Value, json};
use sqlx::Row;

use crate::{AppState, db, events::WorkspaceEvent, terminal::backend::ForegroundInfo};

use super::{
    Args, Caller, CollabState, NodeRef, Refusal, board_log, collab, collapse_newlines,
    delivery_queue::{self, Queued},
    expected_processes, load_node, load_session, nonce, strip_control,
};

mod delivery;
mod queue;
mod target;

use self::delivery::*;

#[cfg(test)]
pub use self::delivery::{check_flow_for_test, note_delivery_for_test};
pub use self::delivery::{deliver, messaging_enabled, pane_runs_agent};
pub use self::queue::flush_for;
pub use self::target::{match_node, run};

pub const PAIR_INTERVAL_SECONDS: i64 = 10;
/// A sender may write to at most this many distinct targets per turn.
pub const TARGETS_PER_TURN: usize = 4;
/// How long we wait for the target to react before calling the write `stalled`.
pub const RECEIPT_WINDOW: Duration = Duration::from_secs(8);
/// Longest body we will paste.
pub const MAX_BODY_CHARS: usize = 4_000;
/// Length of the frame nonce.
const NONCE_LENGTH: usize = 12;

/* --------------------------------- outcomes ------------------------------- */

/// The discriminated union of plan §5.7, plus its `retryable` map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    Queued,
    Stalled,
    Expired,
    RateLimited,
    QueueFull,
    TargetBusy,
    TargetStatusUnverified,
    TargetStatusStale,
    TargetNotAgentPane,
    TargetGone,
    NotPermitted,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Queued => "queued",
            Self::Stalled => "stalled",
            Self::Expired => "expired",
            Self::RateLimited => "rateLimited",
            Self::QueueFull => "queueFull",
            Self::TargetBusy => "targetBusy",
            Self::TargetStatusUnverified => "targetStatusUnverified",
            Self::TargetStatusStale => "targetStatusStale",
            Self::TargetNotAgentPane => "targetNotAgentPane",
            Self::TargetGone => "targetGone",
            Self::NotPermitted => "notPermitted",
        }
    }

    /// Would trying again later plausibly work?
    pub fn retryable(self) -> bool {
        match self {
            // Nothing to retry.
            Self::Delivered | Self::Queued => false,
            // The target's own state is what blocked it, and that changes.
            Self::Stalled
            | Self::Expired
            | Self::RateLimited
            | Self::QueueFull
            | Self::TargetBusy
            | Self::TargetStatusStale
            | Self::TargetNotAgentPane => true,
            // Configuration or authorization: retrying changes nothing.
            Self::TargetStatusUnverified | Self::TargetGone | Self::NotPermitted => false,
        }
    }

    pub fn is_ok(self) -> bool {
        matches!(self, Self::Delivered | Self::Queued)
    }
}

/// What a verb answers with. Rendered as JSON, or as `message` alone when the
/// caller asked for prose.
#[derive(Debug, Clone)]
pub struct Report {
    pub outcome: Outcome,
    pub message: String,
    pub trace_id: Option<String>,
    pub receipt: Option<String>,
    /// The gate that produced this outcome, when the outcome alone is ambiguous
    /// (`notPermitted` covers four different refusals).
    pub reason: Option<&'static str>,
    pub traced: Option<&'static str>,
}

impl Report {
    fn refused(outcome: Outcome, reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            outcome,
            message: message.into(),
            trace_id: None,
            receipt: None,
            reason: Some(reason),
            traced: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "ok": self.outcome.is_ok(),
            "outcome": self.outcome.as_str(),
            "retryable": self.outcome.retryable(),
            "message": self.message,
        });
        if let Some(trace_id) = &self.trace_id {
            value["traceId"] = json!(trace_id);
        }
        if let Some(receipt) = &self.receipt {
            value["receipt"] = json!(receipt);
        }
        if let Some(reason) = self.reason {
            value["reason"] = json!(reason);
        }
        if let Some(traced) = self.traced {
            value["traced"] = json!(traced);
        }
        value
    }
}

/* --------------------------------- envelope ------------------------------- */

/// The five-line frame of plan §5.7. The sender never sees the nonce and never
/// supplies a header field, so it cannot forge a frame around its own body: the
/// header fields are newline-collapsed and the body loses its ESC bytes.
pub fn envelope(from_title: &str, from_id: &str, body: &str) -> String {
    let nonce = nonce(NONCE_LENGTH);
    frame(&nonce, from_title, from_id, body)
}

pub fn frame(nonce: &str, from_title: &str, from_id: &str, body: &str) -> String {
    let title = collapse_newlines(from_title);
    let id = collapse_newlines(from_id);
    let body = strip_control(body);
    format!(
        "--- ARMADRA MESSAGE {nonce} ---\nfrom: {title} ({id})\nreply-to: {id}\n{}\n--- END ARMADRA MESSAGE {nonce} ---",
        body.trim_end()
    )
}

/// The fixed `notify` body. The sender cannot inject instructions through it.
pub fn notify_body(source_title: &str) -> String {
    format!(
        "{} 已完成一轮工作，可读取其上下文。",
        collapse_newlines(source_title)
    )
}

fn internal(error: crate::error::AppError) -> Refusal {
    Refusal {
        status: axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        message: format!("消息投递失败：{error}"),
    }
}
