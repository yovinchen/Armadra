//! Gemini CLI hook payloads.
//!
//! Gemini shares the base input schema with Claude (`session_id`,
//! `transcript_path`, `cwd`, `hook_event_name`, `timestamp`) but has its own
//! event names: the agent loop is bracketed by `BeforeAgent` / `AfterAgent`
//! rather than `UserPromptSubmit` / `Stop`.
//!
//! `AfterModel` is deliberately not subscribed by the installer — it fires per
//! streamed chunk — but it is mapped here anyway as plain `working`, because a
//! user who added it by hand should not put the node into an unknown state.
//!
//! Permission is *only* reported through `Notification` with
//! `notification_type: "ToolPermission"`; Gemini's docs are explicit that this
//! hook is observability-only, so the node is `blocked` and the answer has to
//! come from the terminal itself (plan §5.5 stage two).

use serde_json::Value;

use super::{AgentEvent, BLOCKED, DONE, EventKind, WORKING, apply_common, flag, text};

const TOOL_PERMISSION: &str = "toolpermission";

pub fn normalize(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let hook = text(payload, "hook_event_name", "hookEventName")?;
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
        "BeforeAgent" => {
            let mut event = AgentEvent::state(node_id, agent_id, WORKING);
            event.new_turn = Some(true);
            event.last_message = text(payload, "prompt", "prompt");
            event
        }
        "AfterAgent" => {
            let mut event = AgentEvent::state(node_id, agent_id, DONE);
            // `continue: false` from an earlier hook halts the loop; Gemini
            // reports the reason on the way out.
            if flag(payload, "continue", "continue") == Some(false) {
                event.interrupted = Some(true);
            }
            if text(payload, "error", "error").is_some() {
                event.errored = Some(true);
            }
            event.last_message = text(payload, "stopReason", "stop_reason")
                .or_else(|| text(payload, "last_agent_message", "lastAgentMessage"));
            event
        }
        "BeforeTool" | "AfterTool" | "BeforeModel" | "AfterModel" | "BeforeToolSelection" => {
            AgentEvent::state(node_id, agent_id, WORKING)
        }
        "Notification" => notification(node_id, agent_id, payload)?,
        _ => return None,
    };

    if event.ask_kind.is_none() {
        event.ask_kind = text(payload, "tool_name", "toolName");
    }
    apply_common(&mut event, payload);
    Some(event)
}

fn notification(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let kind = text(payload, "notification_type", "notificationType").unwrap_or_default();
    let message = text(payload, "message", "message");
    if !kind.to_ascii_lowercase().contains(TOOL_PERMISSION) {
        // The only documented type today. Anything else is advisory noise.
        return None;
    }
    let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
    event.ask_kind = payload
        .get("details")
        .and_then(|details| text(details, "tool_name", "toolName"))
        .or_else(|| Some("ToolPermission".to_owned()));
    event.last_message = message;
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<AgentEvent> {
        normalize("node-a", "gemini", &payload)
    }

    #[test]
    fn the_agent_loop_brackets_a_turn() {
        let start = run(json!({
            "hook_event_name": "SessionStart",
            "session_id": "g-1",
            "transcript_path": "/tmp/g.json",
            "cwd": "/repo",
            "timestamp": "2026-09-04T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::Session);
        assert_eq!(start.session_phase, Some("start"));
        assert_eq!(start.session_id.as_deref(), Some("g-1"));
        assert_eq!(start.transcript_path.as_deref(), Some("/tmp/g.json"));

        let before = run(json!({ "hook_event_name": "BeforeAgent", "prompt": "go" })).unwrap();
        assert_eq!(before.state, Some(WORKING));
        assert_eq!(before.new_turn, Some(true));
        assert_eq!(before.last_message.as_deref(), Some("go"));

        for hook in ["BeforeTool", "AfterTool"] {
            let event =
                run(json!({ "hook_event_name": hook, "tool_name": "run_shell_command" })).unwrap();
            assert_eq!(event.state, Some(WORKING), "{hook}");
            assert!(event.new_turn.is_none());
        }

        let after = run(json!({ "hook_event_name": "AfterAgent" })).unwrap();
        assert_eq!(after.state, Some(DONE));
        assert!(after.errored.is_none());
        assert!(after.interrupted.is_none());

        assert_eq!(
            run(json!({ "hook_event_name": "SessionEnd", "reason": "exit" }))
                .unwrap()
                .session_phase,
            Some("end")
        );
    }

    #[test]
    fn a_halted_or_failed_loop_is_flagged() {
        let halted = run(json!({
            "hook_event_name": "AfterAgent",
            "continue": false,
            "stopReason": "policy stop"
        }))
        .unwrap();
        assert_eq!(halted.state, Some(DONE));
        assert_eq!(halted.interrupted, Some(true));
        assert_eq!(halted.last_message.as_deref(), Some("policy stop"));

        let failed = run(json!({ "hook_event_name": "AfterAgent", "error": "quota" })).unwrap();
        assert_eq!(failed.errored, Some(true));
    }

    #[test]
    fn only_tool_permission_notifications_block() {
        let blocked = run(json!({
            "hook_event_name": "Notification",
            "notification_type": "ToolPermission",
            "message": "Allow write_file?",
            "details": { "tool_name": "write_file" }
        }))
        .unwrap();
        assert_eq!(blocked.state, Some(BLOCKED));
        assert_eq!(blocked.ask_kind.as_deref(), Some("write_file"));
        assert_eq!(blocked.last_message.as_deref(), Some("Allow write_file?"));

        assert!(
            run(json!({
                "hook_event_name": "Notification",
                "notification_type": "Info",
                "message": "hello"
            }))
            .is_none()
        );
    }

    #[test]
    fn unknown_events_are_ignored() {
        assert!(run(json!({ "hook_event_name": "PreCompress" })).is_none());
        assert!(run(json!({ "raw": "not json at all" })).is_none());
    }
}
