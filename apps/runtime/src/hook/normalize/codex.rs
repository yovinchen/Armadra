//! Codex hook payloads.
//!
//! Codex's hook vocabulary is the Claude family with three differences that
//! matter here:
//!
//!   * subagents are identified by `agent_id`, not by the `tool_use_id` of the
//!     Task tool, because Codex spawns them as real agents rather than as a
//!     tool call;
//!   * `request_user_input` is a first-class way to ask the human a question —
//!     it arrives either as a tool name or as a notification type, and both
//!     mean `waiting`, not `working`;
//!   * Codex has no `StopFailure`; a failed turn is a `Stop` carrying an error.

use serde_json::Value;

use super::{
    AgentEvent, BLOCKED, DONE, EventKind, WAITING, WORKING, apply_common, field, flag, number, text,
};

/// Both the tool name and the notification type Codex uses to ask a question.
const REQUEST_USER_INPUT: &str = "request_user_input";

pub fn normalize(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let hook = text(payload, "hook_event_name", "hookEventName")?;
    let tool_name = text(payload, "tool_name", "toolName");
    let asks_user = tool_name
        .as_deref()
        .is_some_and(|name| name.contains(REQUEST_USER_INPUT));

    let mut event = match hook.as_str() {
        "SessionStart" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("start");
            event
        }
        "SessionEnd" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("end");
            event
        }
        "UserPromptSubmit" => {
            let mut event = AgentEvent::state(node_id, agent_id, WORKING);
            event.new_turn = Some(true);
            event.last_message = text(payload, "prompt", "prompt");
            event
        }
        "PreToolUse" | "PostToolUse" => {
            if asks_user {
                let mut event = AgentEvent::state(node_id, agent_id, WAITING);
                event.awaiting_input = Some(true);
                event.ask_kind = tool_name.clone();
                event
            } else {
                AgentEvent::state(node_id, agent_id, WORKING)
            }
        }
        "PermissionRequest" => {
            let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
            event.ask_kind = tool_name.clone().or_else(|| Some("permission".to_owned()));
            event
        }
        "Notification" => notification(node_id, agent_id, payload)?,
        "Stop" | "Interrupt" => {
            let mut event = AgentEvent::state(node_id, agent_id, DONE);
            if hook == "Interrupt" || flag(payload, "interrupted", "interrupted") == Some(true) {
                event.interrupted = Some(true);
            }
            if errored(payload) {
                event.errored = Some(true);
            }
            event
        }
        "SubagentStart" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::SubagentStart);
            event.subagent_type = text(payload, "subagent_type", "subagentType")
                .or_else(|| text(payload, "model", "model"));
            event.task_label = text(payload, "task", "task")
                .or_else(|| text(payload, "prompt", "prompt"))
                .map(|label| super::truncate(&label, 400));
            event
        }
        "SubagentStop" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::SubagentEnd);
            event.subagent_type = text(payload, "subagent_type", "subagentType");
            event.duration_ms = number(payload, "duration_ms", "durationMs");
            event.tokens = number(payload, "total_tokens", "totalTokens")
                .or_else(|| number(payload, "tokens", "tokens"));
            event.tool_uses = number(payload, "tool_use_count", "toolUseCount")
                .or_else(|| number(payload, "tool_uses", "toolUses"));
            event.result = text(payload, "result", "result")
                .or_else(|| text(payload, "last_agent_message", "lastAgentMessage"));
            event
        }
        _ => return None,
    };

    // A Codex subagent is its own agent, so its id is the stable handle the
    // canvas keys temporary cards on. Fall back to the tool call for hosts that
    // report the Claude way.
    event.tool_use_id =
        text(payload, "agent_id", "agentId").or_else(|| text(payload, "tool_use_id", "toolUseId"));
    if event.last_message.is_none() {
        event.last_message = text(payload, "last_agent_message", "lastAgentMessage")
            .or_else(|| text(payload, "last_assistant_message", "lastAssistantMessage"));
    }
    apply_common(&mut event, payload);
    Some(event)
}

fn errored(payload: &Value) -> bool {
    if flag(payload, "errored", "errored") == Some(true) {
        return true;
    }
    field(payload, "error", "error").is_some_and(|value| !value.is_null())
}

fn notification(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let kind = text(payload, "notification_type", "notificationType")
        .or_else(|| text(payload, "type", "type"))
        .unwrap_or_default();
    let message = text(payload, "message", "message").unwrap_or_default();
    let lowered = format!("{kind} {message}").to_ascii_lowercase();

    if lowered.contains(REQUEST_USER_INPUT) || lowered.contains("request user input") {
        let mut event = AgentEvent::state(node_id, agent_id, WAITING);
        event.awaiting_input = Some(true);
        event.ask_kind = Some(REQUEST_USER_INPUT.to_owned());
        event.last_message = (!message.is_empty()).then_some(message);
        return Some(event);
    }
    if lowered.contains("permission") || lowered.contains("approve") {
        let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
        event.ask_kind = text(payload, "tool_name", "toolName").or(Some("permission".to_owned()));
        event.last_message = (!message.is_empty()).then_some(message);
        return Some(event);
    }
    if lowered.contains("idle") || lowered.contains("waiting for your input") {
        let mut event = AgentEvent::state(node_id, agent_id, DONE);
        event.idle = Some(true);
        event.last_message = (!message.is_empty()).then_some(message);
        return Some(event);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<AgentEvent> {
        normalize("node-a", "codex", &payload)
    }

    #[test]
    fn the_claude_family_events_map_the_same_way() {
        assert_eq!(
            run(json!({ "hook_event_name": "SessionStart", "session_id": "s-1" }))
                .unwrap()
                .session_phase,
            Some("start")
        );
        let prompt = run(json!({ "hook_event_name": "UserPromptSubmit" })).unwrap();
        assert_eq!(prompt.state, Some(WORKING));
        assert_eq!(prompt.new_turn, Some(true));
        assert_eq!(
            run(json!({ "hook_event_name": "PreToolUse", "tool_name": "shell" }))
                .unwrap()
                .state,
            Some(WORKING)
        );
        assert_eq!(
            run(json!({ "hook_event_name": "PostToolUse" }))
                .unwrap()
                .state,
            Some(WORKING)
        );
        assert_eq!(
            run(json!({ "hook_event_name": "Stop" })).unwrap().state,
            Some(DONE)
        );
        assert_eq!(
            run(json!({ "hook_event_name": "SessionEnd" }))
                .unwrap()
                .session_phase,
            Some("end")
        );
    }

    #[test]
    fn request_user_input_is_waiting_from_either_direction() {
        let by_tool = run(json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "experimental_request_user_input"
        }))
        .unwrap();
        assert_eq!(by_tool.state, Some(WAITING));
        assert_eq!(by_tool.awaiting_input, Some(true));

        let by_notification = run(json!({
            "hook_event_name": "Notification",
            "notification_type": "request_user_input",
            "message": "Which branch?"
        }))
        .unwrap();
        assert_eq!(by_notification.state, Some(WAITING));
        assert_eq!(by_notification.awaiting_input, Some(true));
        assert_eq!(
            by_notification.last_message.as_deref(),
            Some("Which branch?")
        );
    }

    #[test]
    fn permission_requests_block_and_a_failed_turn_is_flagged() {
        assert_eq!(
            run(json!({ "hook_event_name": "PermissionRequest", "tool_name": "shell" }))
                .unwrap()
                .state,
            Some(BLOCKED)
        );
        assert_eq!(
            run(json!({ "hook_event_name": "Notification", "message": "Codex needs permission" }))
                .unwrap()
                .state,
            Some(BLOCKED)
        );
        let failed = run(json!({ "hook_event_name": "Stop", "error": "boom" })).unwrap();
        assert_eq!(failed.state, Some(DONE));
        assert_eq!(failed.errored, Some(true));
        let interrupted = run(json!({ "hook_event_name": "Interrupt" })).unwrap();
        assert_eq!(interrupted.state, Some(DONE));
        assert_eq!(interrupted.interrupted, Some(true));
    }

    #[test]
    fn subagents_are_keyed_by_agent_id() {
        let start = run(json!({
            "hook_event_name": "SubagentStart",
            "agent_id": "ag-7",
            "task": "review the diff"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::SubagentStart);
        assert_eq!(start.tool_use_id.as_deref(), Some("ag-7"));
        assert_eq!(start.task_label.as_deref(), Some("review the diff"));
        assert!(start.state.is_none());

        let stop = run(json!({
            "hook_event_name": "SubagentStop",
            "agent_id": "ag-7",
            "duration_ms": 900,
            "tokens": 42
        }))
        .unwrap();
        assert_eq!(stop.kind, EventKind::SubagentEnd);
        assert_eq!(stop.tool_use_id.as_deref(), Some("ag-7"));
        assert_eq!(stop.duration_ms, Some(900));
        assert_eq!(stop.tokens, Some(42));
    }

    #[test]
    fn unknown_events_and_noise_notifications_are_ignored() {
        assert!(run(json!({ "hook_event_name": "PreCompact" })).is_none());
        assert!(run(json!({ "hook_event_name": "Notification", "message": "hi" })).is_none());
        assert!(run(json!({})).is_none());
    }
}
