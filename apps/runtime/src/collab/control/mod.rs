//! `POST /control/{verb}` — an agent drives the canvas (plan §5.8).
//!
//! Every mutating verb goes through the ordinary board document: load, edit,
//! save with the same CAS the web app uses, then publish `board.changed` so the
//! canvas reloads. The agent never touches the front end, and the front end
//! never has to trust the agent — it re-reads the board it already knows how to
//! read.
//!
//! `list` is the only verb a `legacy` caller may run. Everything that changes
//! something requires a node token this runtime minted.

use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    AppState, db,
    events::WorkspaceEvent,
    model::{BoardDocument, CanvasEdge, CanvasNode, ContextLink, Position, Size},
};

use super::{
    Args, Caller, NODE_PALETTE, PLACEMENT_GAP, Refusal, Refused, addressing, collapse_newlines,
    default_size, mailbox,
};

mod board;
mod close;
mod edits;
mod nodes;

use self::board::*;
use self::close::*;
use self::edits::*;
use self::nodes::*;

pub use self::board::launch_command;
pub use self::close::{CONFIRM_TIMEOUT_SECS, answer_confirm};

pub const VERBS: &[&str] = &[
    "help",
    "post",
    "inbox",
    "ack",
    "handoff-read",
    "list",
    "open-terminal",
    "open-agent",
    "sticky",
    "link",
    "rename",
    "color",
    "close",
];

/// Verbs a caller with no node token may run: the read-only one.
const LEGACY_VERBS: &[&str] = &["list", "help"];

/// What a control verb answers with.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub message: String,
    pub result: Option<Value>,
    pub warning: Option<String>,
    /// A verb whose own reply shape *is* the answer (the mailbox protocol, a
    /// handoff bundle). Rendered as the whole body rather than nested under
    /// `result`, so the agent reads `protocol` and `id` without unwrapping.
    pub raw: Option<Value>,
}

impl Outcome {
    fn with_result(message: impl Into<String>, result: Value) -> Self {
        Self {
            message: message.into(),
            result: Some(result),
            warning: None,
            raw: None,
        }
    }

    fn raw(body: Value, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            result: None,
            warning: None,
            raw: Some(body),
        }
    }

    fn warn(mut self, warning: impl Into<String>) -> Self {
        self.warning = Some(warning.into());
        self
    }

    pub fn to_json(&self) -> Value {
        if let Some(raw) = &self.raw {
            return raw.clone();
        }
        let mut value = json!({ "ok": true, "message": self.message });
        if let Some(result) = &self.result {
            value["result"] = result.clone();
        }
        if let Some(warning) = &self.warning {
            value["warning"] = json!(warning);
        }
        value
    }
}

/// One control verb. `Err` carries the status, the machine-readable code and
/// the sentence to print.
pub async fn run(
    state: &AppState,
    caller: &Caller,
    verb: &str,
    args: &Args<'_>,
) -> Result<Outcome, Refused> {
    if verb == "link"
        && caller.node.agent_id.as_deref().is_some_and(|agent| {
            agent.starts_with("custom:")
                && !crate::context_usage::has_capability(&state.settings, agent, "contextLink")
        })
    {
        return Err(
            Refusal::forbidden("Node context links are disabled for this custom Agent").into(),
        );
    }
    if !VERBS.contains(&verb) {
        return Err(Refusal::bad_request(format!(
            "未知的画布动词 `{verb}`，可用：{}。",
            VERBS.join(" / ")
        ))
        .into());
    }
    if !LEGACY_VERBS.contains(&verb) {
        caller.require_verified(verb)?;
    }
    match verb {
        "handoff-read" => {
            let id = args
                .text("id")
                .ok_or_else(|| Refusal::bad_request("handoff-read requires --id"))?;
            let session = args
                .text("sessionId")
                .ok_or_else(|| Refusal::forbidden("Current session binding is required"))?;
            let generation = args
                .count(&["generation"])
                .filter(|value| *value >= 0)
                .ok_or_else(|| Refusal::forbidden("Current generation binding is required"))?
                as u64;
            let value = crate::handoff::read_for_caller(state, caller, id, session, generation)
                .await
                .map_err(|error| Refusal::forbidden(error.to_string()))?;
            Ok(Outcome::raw(value, "Frozen peer context"))
        }
        "help" => Ok(Outcome::with_result(
            mailbox::HELP,
            json!({ "protocol": "armadra.mailbox.v1" }),
        )),
        "post" | "inbox" | "ack" => {
            let result = mailbox::run(state, caller, verb, args).await?;
            Ok(Outcome::raw(result.clone(), result.to_string()))
        }
        "list" => list(state, caller).await.map_err(Refused::from),
        "open-terminal" => open_terminal(state, caller, args)
            .await
            .map_err(Refused::from),
        "open-agent" => open_agent(state, caller, args).await.map_err(Refused::from),
        "sticky" => sticky(state, caller, args).await.map_err(Refused::from),
        "link" => link(state, caller, args).await.map_err(Refused::from),
        "rename" => rename(state, caller, args).await.map_err(Refused::from),
        "color" => color(state, caller, args).await.map_err(Refused::from),
        "close" => close(state, caller, args).await.map_err(Refused::from),
        _ => unreachable!("verb was checked above"),
    }
}

fn internal(error: crate::error::AppError) -> Refusal {
    match error {
        crate::error::AppError::BadRequest(message) => Refusal::bad_request(message),
        crate::error::AppError::NotFound(message) => Refusal::not_found(message),
        crate::error::AppError::Forbidden(message) => Refusal::forbidden(message),
        other => Refusal {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("画布操作失败：{other}"),
        },
    }
}
