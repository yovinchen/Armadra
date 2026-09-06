//! Provider payload → one normalized `AgentEvent` (plan §5.4).
//!
//! Every CLI reports something different: Claude and Codex send a flat object
//! keyed by `hook_event_name`, Gemini sends the same shape with its own event
//! vocabulary, opencode sends a bus topic with a `properties` bag. The reducer
//! must not know any of that, so each provider gets a module here whose only
//! job is to answer one question: *what does this payload say about the node's
//! state?*
//!
//! Unknown events are not errors. A CLI is free to add hooks we never
//! subscribed to, and a client one revision ahead will send them; `None` means
//! "nothing to say", and the caller answers 204.

pub mod claude;
pub mod codex;
pub mod copilot;
pub mod gemini;
pub mod opencode;
pub mod pi;

use serde::Serialize;
use serde_json::Value;

/// Mirrors `agentEventKindSchema` in packages/shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    State,
    Session,
    SubagentStart,
    SubagentEnd,
}

impl EventKind {
    pub fn is_subagent(self) -> bool {
        matches!(self, Self::SubagentStart | Self::SubagentEnd)
    }
}

/// Mirrors `agentStateSchema`.
pub const WORKING: &str = "working";
pub const WAITING: &str = "waiting";
pub const BLOCKED: &str = "blocked";
pub const DONE: &str = "done";

/// Runtime twin of `agentEventSchema` (packages/shared/src/domain.ts). Field
/// names and omission rules match it exactly: absent optionals are omitted, not
/// serialized as `null`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub node_id: String,
    pub agent_id: String,
    pub kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<&'static str>,
    /// Which channel this report arrived on (协作通道 §3.2). Set by the ingest
    /// route from the provider, never parsed out of the payload: an extension
    /// and a command Hook post identical bodies, so a payload that could name
    /// its own source could name the strongest one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_turn: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errored: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub awaiting_input: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_phase: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_revision: Option<i64>,
    /// Not part of the shared schema: where the CLI keeps this session's
    /// transcript. Phase 3's context-link verbs need it and only the hook knows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// A synthetic end the user has nothing to read — today, a terminal that
    /// exited. The terminal's own exit badge already says what happened, so
    /// raising the unread badge on top of it would be noise.
    ///
    /// Never serialized: this is a reducer control, not part of the shared
    /// `AgentEvent`, and no hook client can set it.
    #[serde(skip)]
    pub silent: bool,
    /// A session start that the prompt already in flight created, rather than
    /// one that precedes any work. Copilot CLI opens the session *from* the
    /// first prompt and echoes that prompt back as `initialPrompt`, so its
    /// `sessionStart` lands after the turn it belongs to has begun.
    ///
    /// Never serialized, for the same reason as `silent`.
    #[serde(skip)]
    pub session_opened_by_prompt: bool,
}

impl AgentEvent {
    pub fn new(node_id: &str, agent_id: &str, kind: EventKind) -> Self {
        Self {
            node_id: node_id.to_owned(),
            agent_id: agent_id.to_owned(),
            kind,
            state: None,
            state_source: None,
            new_turn: None,
            interrupted: None,
            errored: None,
            idle: None,
            awaiting_input: None,
            pending_id: None,
            ask_kind: None,
            session_id: None,
            session_phase: None,
            last_message: None,
            tool_use_id: None,
            subagent_type: None,
            task_label: None,
            duration_ms: None,
            tokens: None,
            tool_uses: None,
            result: None,
            verified: None,
            client_revision: None,
            transcript_path: None,
            silent: false,
            session_opened_by_prompt: false,
        }
    }

    pub fn state(node_id: &str, agent_id: &str, state: &'static str) -> Self {
        Self {
            state: Some(state),
            ..Self::new(node_id, agent_id, EventKind::State)
        }
    }
}

/// Dispatch on the provider the hook was installed for. `custom:*` CLIs are
/// assumed to speak the Claude Code hook shape, which is the de-facto format
/// third-party wrappers copy; if they do not, nothing matches and the report is
/// ignored rather than mis-attributed.
///
/// Prefer `normalize_as` when the caller knows which built-in agent a custom
/// entry was configured against.
pub fn normalize(agent_id: &str, node_id: &str, payload: &Value) -> Option<AgentEvent> {
    normalize_as(agent_id, agent_id, node_id, payload)
}

/// `provider` picks the parser, `agent_id` is what the event is attributed to.
///
/// The two differ for a custom agent: its hooks are the base agent's — the
/// installed hook line literally runs `armadra-hook <base>` — but the node, the
/// session row and the status badge are keyed by the custom id.
pub fn normalize_as(
    provider: &str,
    agent_id: &str,
    node_id: &str,
    payload: &Value,
) -> Option<AgentEvent> {
    match provider {
        "codex" => codex::normalize(node_id, agent_id, payload),
        "copilot" => copilot::normalize(node_id, agent_id, payload),
        "gemini" => gemini::normalize(node_id, agent_id, payload),
        "opencode" => opencode::normalize(node_id, agent_id, payload),
        // One parser for both: OMP is a fork of Pi's extension API and the
        // vocabularies differ by an alias, not by a shape.
        "pi" | "omp" => pi::normalize(node_id, agent_id, payload),
        _ => claude::normalize(node_id, agent_id, payload),
    }
}

/* ------------------------- shared payload accessors ------------------------ */

/// Field lookup that tolerates both snake_case and camelCase. The CLIs are not
/// consistent with each other and some are not consistent with themselves
/// across versions; a report is worth more than a purity argument.
pub(super) fn field<'a>(payload: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    payload
        .get(snake)
        .or_else(|| payload.get(camel))
        .filter(|value| !value.is_null())
}

pub(super) fn text(payload: &Value, snake: &str, camel: &str) -> Option<String> {
    field(payload, snake, camel)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate(value, 20_000))
}

pub(super) fn number(payload: &Value, snake: &str, camel: &str) -> Option<u64> {
    field(payload, snake, camel).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|number| *number >= 0.0)
                .map(|n| n as u64)
        })
    })
}

pub(super) fn flag(payload: &Value, snake: &str, camel: &str) -> Option<bool> {
    field(payload, snake, camel).and_then(Value::as_bool)
}

/// The shared schema caps `lastMessage` / `result` at 20_000 characters; a
/// transcript tail can be far longer than that, so it is cut on a character
/// boundary before it ever reaches SQLite or a WebSocket frame.
pub(super) fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    value.chars().take(limit).collect()
}

/// Common to Claude, Codex and Gemini: the transcript and session identity ride
/// along on every event, whatever the event says.
pub(super) fn apply_common(event: &mut AgentEvent, payload: &Value) {
    if event.session_id.is_none() {
        event.session_id = text(payload, "session_id", "sessionId").map(|id| truncate(&id, 200));
    }
    if event.transcript_path.is_none() {
        event.transcript_path = text(payload, "transcript_path", "transcriptPath");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_event_serializes_with_the_shared_field_names() {
        let mut event = AgentEvent::state("node-a", "claude", DONE);
        event.errored = Some(true);
        event.session_id = Some("s-1".into());
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["nodeId"], "node-a");
        assert_eq!(json["agentId"], "claude");
        assert_eq!(json["kind"], "state");
        assert_eq!(json["state"], "done");
        assert_eq!(json["errored"], true);
        assert_eq!(json["sessionId"], "s-1");
        // Absent optionals are omitted, never null.
        assert!(json.get("newTurn").is_none());
        assert!(json.get("pendingId").is_none());
        assert!(json.get("interrupted").is_none());

        let subagent = AgentEvent::new("node-a", "claude", EventKind::SubagentStart);
        assert_eq!(
            serde_json::to_value(&subagent).unwrap()["kind"],
            "subagent-start"
        );
        assert_eq!(
            serde_json::to_value(AgentEvent::new("n", "claude", EventKind::SubagentEnd)).unwrap()["kind"],
            "subagent-end"
        );
    }

    #[test]
    fn accessors_tolerate_both_casings_and_reject_blanks() {
        let payload = json!({
            "session_id": "  s-1  ",
            "toolUseId": "t-1",
            "empty": "   ",
            "duration": 120,
            "async": true,
            "nulled": null,
        });
        assert_eq!(
            text(&payload, "session_id", "sessionId").as_deref(),
            Some("s-1")
        );
        assert_eq!(
            text(&payload, "tool_use_id", "toolUseId").as_deref(),
            Some("t-1")
        );
        assert!(text(&payload, "empty", "empty").is_none());
        assert!(text(&payload, "nulled", "nulled").is_none());
        assert!(text(&payload, "missing", "missing").is_none());
        assert_eq!(number(&payload, "duration", "duration"), Some(120));
        assert_eq!(flag(&payload, "async", "async"), Some(true));
    }

    #[test]
    fn long_messages_are_cut_on_a_character_boundary() {
        let long = "汉".repeat(20_050);
        assert_eq!(truncate(&long, 20_000).chars().count(), 20_000);
        assert_eq!(truncate("short", 20_000), "short");
    }

    #[test]
    fn an_unknown_provider_falls_back_to_the_claude_shape() {
        let event = normalize(
            "custom:wrapper",
            "node-a",
            &json!({ "hook_event_name": "Stop" }),
        )
        .unwrap();
        assert_eq!(event.state, Some(DONE));
        assert_eq!(event.agent_id, "custom:wrapper");
        assert!(normalize("custom:wrapper", "node-a", &json!({ "nope": 1 })).is_none());
    }

    #[test]
    fn a_custom_agent_is_parsed_as_its_base_and_attributed_to_itself() {
        // Gemini's vocabulary, not Claude's: the fallback parser would find
        // nothing here, so this only passes if the base picked the parser.
        let event = normalize_as(
            "gemini",
            "custom:wrapper",
            "node-a",
            &json!({ "hook_event_name": "AfterAgent" }),
        )
        .unwrap();
        assert_eq!(event.agent_id, "custom:wrapper");
        assert_eq!(event.state, Some(DONE));
        assert!(
            normalize(
                "custom:wrapper",
                "node-a",
                &json!({ "hook_event_name": "AfterAgent" })
            )
            .is_none()
        );
    }
}
