//! Pi and Oh My Pi extension payloads — 协作通道 §3.3.
//!
//! One module for both: OMP is a fork of Pi's extension API and the overlap is
//! nearly total, so the difference is an alias table rather than a second
//! parser. The generated extension posts the flat `hookEventName` shape the
//! other adapters use, which is why `apply_common` works here unchanged.
//!
//! Two mappings deserve their own sentence:
//!
//!   * **settling.** `agent_settled` (Pi) and `session_stop` (OMP 18.x) are the
//!     only events that mean "the CLI is genuinely idle" rather than "between
//!     two of its own steps", so they are the ones that carry `idle`.
//!     `agent_end` closes the turn but does not claim idleness — Pi can start
//!     another loop straight after it, and OMP even says so with
//!     `willContinue`.
//!   * **compaction.** `session_compact`, `auto_compaction_end` and
//!     `model_select` say nothing about what the node is doing; they are
//!     subscribed so the extension can push a fresh `getContextUsage()`
//!     reading, which travels on the separate `armadraContextUsage` payload.
//!     Here they are deliberately `None`: reporting `working` for a background
//!     compaction would drag an idle node out of the state the idle gate reads.
//!
//! `tool_call` is observed and never blocked. Pi lets a handler stop a tool,
//! but Armadra's permission semantics are "the CLI is asking"; §3.5 forbids
//! manufacturing a dialog the CLI never opened.

use serde_json::Value;

use super::{AgentEvent, BLOCKED, DONE, EventKind, WORKING, apply_common, flag, text};

pub fn normalize(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let hook = text(payload, "hook_event_name", "hookEventName")?;
    let mut event = match hook.as_str() {
        "session_start" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("start");
            event
        }
        "session_shutdown" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("end");
            event
        }
        "before_agent_start" => {
            let mut event = AgentEvent::state(node_id, agent_id, WORKING);
            event.new_turn = Some(true);
            event.last_message = text(payload, "prompt", "prompt");
            event
        }
        // `input` is not subscribed by the installer — the prompt already
        // arrives with `before_agent_start` — but a user who registers it by
        // hand should not put the node into an unknown state.
        "agent_start"
        | "turn_start"
        | "turn_end"
        | "tool_call"
        | "tool_result"
        | "tool_execution_start"
        | "tool_execution_update"
        | "tool_execution_end"
        | "auto_retry_start"
        | "input" => AgentEvent::state(node_id, agent_id, WORKING),
        "agent_end" => {
            let mut event = AgentEvent::state(node_id, agent_id, DONE);
            // OMP schedules its own continuation and says so; the turn is not
            // over for the user, so it must not enter the done holdoff.
            if flag(payload, "will_continue", "willContinue") == Some(true) {
                return Some(AgentEvent::state(node_id, agent_id, WORKING));
            }
            event.last_message = text(payload, "stop_reason", "stopReason");
            event
        }
        "agent_settled" | "session_stop" => {
            let mut event = AgentEvent::state(node_id, agent_id, DONE);
            event.idle = Some(true);
            event
        }
        // Not subscribed (§3.5 keeps the adapter observational), but mapped so
        // a hand-added handler reads as a wait rather than as nothing.
        "tool_approval_requested" => {
            let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
            event.ask_kind = text(payload, "tool_name", "toolName");
            event
        }
        "tool_approval_resolved" => AgentEvent::state(node_id, agent_id, WORKING),
        // Context-only events: see the module note.
        "session_compact"
        | "session_before_compact"
        | "session.compacting"
        | "auto_compaction_start"
        | "auto_compaction_end"
        | "model_select" => return None,
        _ => return None,
    };

    if event.ask_kind.is_none() {
        event.ask_kind = text(payload, "tool_name", "toolName");
    }
    apply_common(&mut event, payload);
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<AgentEvent> {
        normalize("node-a", "pi", &payload)
    }

    #[test]
    fn the_agent_loop_brackets_a_turn() {
        let start = run(json!({
            "hookEventName": "session_start",
            "provider": "pi",
            "sessionId": "pi-1",
            "transcriptPath": "/home/dev/.pi/agent/sessions/--repo--/1_2.jsonl",
            "cwd": "/repo"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::Session);
        assert_eq!(start.session_phase, Some("start"));
        assert_eq!(start.session_id.as_deref(), Some("pi-1"));
        assert_eq!(
            start.transcript_path.as_deref(),
            Some("/home/dev/.pi/agent/sessions/--repo--/1_2.jsonl")
        );

        let before = run(json!({ "hookEventName": "before_agent_start", "prompt": "go" })).unwrap();
        assert_eq!(before.state, Some(WORKING));
        assert_eq!(before.new_turn, Some(true));
        assert_eq!(before.last_message.as_deref(), Some("go"));

        for hook in ["agent_start", "turn_start", "turn_end", "tool_result"] {
            let event = run(json!({ "hookEventName": hook })).unwrap();
            assert_eq!(event.state, Some(WORKING), "{hook}");
            assert!(event.new_turn.is_none(), "{hook}");
        }

        let end = run(json!({ "hookEventName": "agent_end" })).unwrap();
        assert_eq!(end.state, Some(DONE));
        assert!(end.idle.is_none(), "agent_end is not evidence of idleness");

        assert_eq!(
            run(json!({ "hookEventName": "session_shutdown" }))
                .unwrap()
                .session_phase,
            Some("end")
        );
    }

    #[test]
    fn only_the_settle_events_claim_idleness() {
        for hook in ["agent_settled", "session_stop"] {
            let settled = run(json!({ "hookEventName": hook, "sessionId": "pi-1" })).unwrap();
            assert_eq!(settled.state, Some(DONE), "{hook}");
            assert_eq!(settled.idle, Some(true), "{hook}");
            assert_eq!(settled.session_id.as_deref(), Some("pi-1"));
        }
        for hook in ["agent_end", "turn_end", "session_start"] {
            assert!(
                run(json!({ "hookEventName": hook }))
                    .unwrap()
                    .idle
                    .is_none(),
                "{hook}"
            );
        }
    }

    #[test]
    fn a_scheduled_continuation_keeps_the_turn_open() {
        let event = run(json!({ "hookEventName": "agent_end", "willContinue": true })).unwrap();
        assert_eq!(event.state, Some(WORKING));
        assert!(event.idle.is_none());
    }

    #[test]
    fn tools_are_observed_and_named_but_never_blocked() {
        let call = run(json!({ "hookEventName": "tool_call", "toolName": "bash" })).unwrap();
        assert_eq!(call.state, Some(WORKING));
        assert_eq!(call.ask_kind.as_deref(), Some("bash"));
        assert!(call.pending_id.is_none());

        // An approval the user wired up by hand is a wait, not a decision we make.
        let asked = run(json!({ "hookEventName": "tool_approval_requested", "toolName": "write" }))
            .unwrap();
        assert_eq!(asked.state, Some(BLOCKED));
        assert_eq!(asked.ask_kind.as_deref(), Some("write"));
        assert_eq!(
            run(json!({ "hookEventName": "tool_approval_resolved" }))
                .unwrap()
                .state,
            Some(WORKING)
        );
    }

    #[test]
    fn compaction_and_model_events_say_nothing_about_the_state() {
        for hook in [
            "session_compact",
            "session_before_compact",
            "session.compacting",
            "auto_compaction_start",
            "auto_compaction_end",
            "model_select",
        ] {
            assert!(run(json!({ "hookEventName": hook })).is_none(), "{hook}");
        }
    }

    #[test]
    fn unknown_events_and_non_json_stdin_are_ignored() {
        assert!(run(json!({ "hookEventName": "resources_discover" })).is_none());
        assert!(run(json!({ "hookEventName": "" })).is_none());
        assert!(run(json!({ "raw": "pi printed a banner" })).is_none());
        assert!(run(json!([1, 2, 3])).is_none());
    }

    #[test]
    fn the_same_parser_serves_omp_and_attributes_to_its_own_id() {
        let event = normalize(
            "node-a",
            "omp",
            &json!({ "hookEventName": "session_stop", "sessionId": "omp-9" }),
        )
        .unwrap();
        assert_eq!(event.agent_id, "omp");
        assert_eq!(event.idle, Some(true));
    }
}
