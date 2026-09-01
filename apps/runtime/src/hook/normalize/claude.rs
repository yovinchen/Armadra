//! Claude Code hook payloads.
//!
//! Every payload is a flat object with `hook_event_name` plus the session
//! identity (`session_id`, `transcript_path`, `cwd`). The two events that need
//! interpretation rather than translation:
//!
//!   * **`Notification`** is overloaded. Claude uses it both for "I need
//!     permission to run this" and for "I have been idle for a while". The
//!     first is a real `blocked`; the second is only a *rescue* hint, because
//!     the `Stop` hook is the authoritative end of a turn and the idle notice
//!     can arrive long after it (plan §5.4).
//!   * **`PreToolUse` for `AskUserQuestion`** is a question, not work: the turn
//!     is still open but the CLI is waiting for a human. The reducer holds that
//!     until the answer arrives, so a `Stop` in between must not read as `done`.

use serde_json::Value;

use super::{
    AgentEvent, BLOCKED, DONE, EventKind, WAITING, WORKING, apply_common, field, flag, number, text,
};

/// Tools whose whole purpose is to ask the human something.
const QUESTION_TOOLS: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

pub fn normalize(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let hook = text(payload, "hook_event_name", "hookEventName")?;
    let tool_name = text(payload, "tool_name", "toolName");
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
        "PreToolUse" => {
            let asking = tool_name
                .as_deref()
                .is_some_and(|name| QUESTION_TOOLS.contains(&name));
            let mut event =
                AgentEvent::state(node_id, agent_id, if asking { WAITING } else { WORKING });
            if asking {
                event.awaiting_input = Some(true);
                event.ask_kind = tool_name.clone();
            }
            event
        }
        "PostToolUse" => AgentEvent::state(node_id, agent_id, WORKING),
        "PermissionRequest" => {
            let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
            event.ask_kind = tool_name.clone().or_else(|| Some("permission".to_owned()));
            event
        }
        "Notification" => notification(node_id, agent_id, payload)?,
        "Stop" => AgentEvent::state(node_id, agent_id, DONE),
        "StopFailure" => {
            let mut event = AgentEvent::state(node_id, agent_id, DONE);
            event.errored = Some(true);
            event
        }
        "SubagentStart" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::SubagentStart);
            event.subagent_type = text(payload, "subagent_type", "subagentType");
            event.task_label = text(payload, "description", "description")
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
            event.tool_uses = number(payload, "total_tool_use_count", "totalToolUseCount")
                .or_else(|| number(payload, "tool_uses", "toolUses"));
            event.result = text(payload, "result", "result")
                .or_else(|| text(payload, "last_assistant_message", "lastAssistantMessage"));
            event
        }
        _ => return None,
    };

    event.tool_use_id = text(payload, "tool_use_id", "toolUseId");
    if event.last_message.is_none() {
        event.last_message = text(payload, "last_assistant_message", "lastAssistantMessage");
    }
    // Claude sets `stop_hook_active` when a Stop hook already ran for this turn;
    // an explicit `interrupted` (Esc) is what actually ends a turn early.
    if flag(payload, "interrupted", "interrupted") == Some(true) {
        event.interrupted = Some(true);
    }
    apply_common(&mut event, payload);
    Some(event)
}

/// `Notification` carries a human sentence, not a machine field, so the
/// classification is deliberately narrow: anything we do not recognise is
/// dropped rather than guessed into a state change.
fn notification(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let message = text(payload, "message", "message").unwrap_or_default();
    let lowered = message.to_ascii_lowercase();
    let explicit_permission = field(payload, "notification_type", "notificationType")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("permission"));

    if explicit_permission || lowered.contains("permission") || lowered.contains("approve") {
        let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
        event.ask_kind = text(payload, "tool_name", "toolName").or(Some("permission".to_owned()));
        event.last_message = Some(message);
        return Some(event);
    }
    if lowered.contains("waiting for your input") || lowered.contains("idle") {
        // Rescue only: `Stop` remains the authority on turn ends. The reducer
        // applies this to a `working` node and to nothing else.
        let mut event = AgentEvent::state(node_id, agent_id, DONE);
        event.idle = Some(true);
        event.last_message = Some(message);
        return Some(event);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<AgentEvent> {
        normalize("node-a", "claude", &payload)
    }

    #[test]
    fn a_turn_runs_from_prompt_to_stop() {
        let start = run(json!({
            "hook_event_name": "SessionStart",
            "session_id": "s-1",
            "transcript_path": "/tmp/t.jsonl",
            "cwd": "/repo",
            "source": "startup"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::Session);
        assert_eq!(start.session_phase, Some("start"));
        assert_eq!(start.session_id.as_deref(), Some("s-1"));
        assert_eq!(start.transcript_path.as_deref(), Some("/tmp/t.jsonl"));
        assert!(start.state.is_none());

        let prompt = run(json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "s-1",
            "prompt": "ship it"
        }))
        .unwrap();
        assert_eq!(prompt.state, Some(WORKING));
        assert_eq!(prompt.new_turn, Some(true));
        assert_eq!(prompt.last_message.as_deref(), Some("ship it"));

        for hook in ["PreToolUse", "PostToolUse"] {
            let event = run(json!({
                "hook_event_name": hook,
                "tool_name": "Bash",
                "tool_use_id": "tu-1"
            }))
            .unwrap();
            assert_eq!(event.state, Some(WORKING), "{hook}");
            assert_eq!(event.tool_use_id.as_deref(), Some("tu-1"));
            assert!(event.new_turn.is_none());
        }

        let stop = run(json!({
            "hook_event_name": "Stop",
            "last_assistant_message": "done here"
        }))
        .unwrap();
        assert_eq!(stop.state, Some(DONE));
        assert_eq!(stop.last_message.as_deref(), Some("done here"));
        assert!(stop.errored.is_none());

        let failure = run(json!({ "hook_event_name": "StopFailure" })).unwrap();
        assert_eq!(failure.state, Some(DONE));
        assert_eq!(failure.errored, Some(true));

        let end = run(json!({ "hook_event_name": "SessionEnd", "reason": "exit" })).unwrap();
        assert_eq!(end.session_phase, Some("end"));
    }

    #[test]
    fn permission_requests_and_questions_are_different_states() {
        let permission = run(json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf /" }
        }))
        .unwrap();
        assert_eq!(permission.state, Some(BLOCKED));
        assert_eq!(permission.ask_kind.as_deref(), Some("Bash"));

        let question = run(json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion"
        }))
        .unwrap();
        assert_eq!(question.state, Some(WAITING));
        assert_eq!(question.awaiting_input, Some(true));
        assert_eq!(question.ask_kind.as_deref(), Some("AskUserQuestion"));
    }

    #[test]
    fn notifications_split_into_permission_idle_and_noise() {
        let permission = run(json!({
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash"
        }))
        .unwrap();
        assert_eq!(permission.state, Some(BLOCKED));
        assert!(permission.idle.is_none());

        let idle = run(json!({
            "hook_event_name": "Notification",
            "message": "Claude is waiting for your input"
        }))
        .unwrap();
        assert_eq!(idle.state, Some(DONE));
        assert_eq!(idle.idle, Some(true));

        // Anything else is not a state change; guessing would fight the Stop hook.
        assert!(
            run(json!({
                "hook_event_name": "Notification",
                "message": "Compacting conversation history"
            }))
            .is_none()
        );
    }

    #[test]
    fn subagent_events_carry_identity_and_totals() {
        let start = run(json!({
            "hook_event_name": "SubagentStart",
            "tool_use_id": "tu-9",
            "subagent_type": "Explore",
            "description": "find the bug"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::SubagentStart);
        assert_eq!(start.tool_use_id.as_deref(), Some("tu-9"));
        assert_eq!(start.subagent_type.as_deref(), Some("Explore"));
        assert_eq!(start.task_label.as_deref(), Some("find the bug"));
        assert!(start.state.is_none(), "subagents never carry a main state");

        let stop = run(json!({
            "hook_event_name": "SubagentStop",
            "tool_use_id": "tu-9",
            "duration_ms": 4200,
            "total_tokens": 8123,
            "total_tool_use_count": 7,
            "result": "found it"
        }))
        .unwrap();
        assert_eq!(stop.kind, EventKind::SubagentEnd);
        assert_eq!(stop.duration_ms, Some(4200));
        assert_eq!(stop.tokens, Some(8123));
        assert_eq!(stop.tool_uses, Some(7));
        assert_eq!(stop.result.as_deref(), Some("found it"));
        assert!(stop.state.is_none());
    }

    #[test]
    fn unknown_and_malformed_payloads_are_ignored() {
        assert!(run(json!({ "hook_event_name": "PreCompact" })).is_none());
        assert!(run(json!({ "hook_event_name": "" })).is_none());
        assert!(run(json!({ "nothing": true })).is_none());
        assert!(run(json!("a bare string")).is_none());
    }

    #[test]
    fn an_interrupted_turn_is_flagged() {
        let event = run(json!({ "hook_event_name": "Stop", "interrupted": true })).unwrap();
        assert_eq!(event.interrupted, Some(true));
        assert_eq!(event.state, Some(DONE));
    }
}
