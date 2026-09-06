//! GitHub Copilot CLI hook payloads — 协作通道 §3.3.
//!
//! Copilot is the one provider whose payload does **not** name its own event.
//! Claude, Codex and Gemini all send `hook_event_name`; Copilot sends a bare
//! object — `{sessionId, timestamp, cwd, …}` plus whatever that event adds —
//! and the event name exists only as the key in the hooks file. Verified
//! against Copilot CLI 1.0.83 on 2026-09-06 by installing a probe hook on every
//! event and dumping stdin: `sessionStart` arrived as
//!
//! ```json
//! {"sessionId":"…","timestamp":1788699265758,"cwd":"…","source":"new","initialPrompt":"…"}
//! ```
//!
//! with no event name anywhere. So the event is recovered from its shape, and
//! the shape test is written to be *specific*: each rule names a field pair
//! only one event carries, and the ambiguous pairs are ordered so the narrower
//! event wins (`subagentStop` before `agentStop` — both carry `stopReason`).
//!
//! An explicit name is still believed when one is present: the `notification`
//! payload documents a `hook_event_name`, and a future version that adds it to
//! the rest should be taken at its word rather than re-derived. Both the
//! camelCase names and the VS Code-compatible PascalCase aliases are accepted,
//! because both fire — the same probe run showed one invocation per event under
//! each spelling.
//!
//! Two events are deliberately not translated:
//!
//!   * **`notification`** is the one the design marks 本机核实 (§3.3). Neither
//!     the non-interactive probe nor an interactive PTY run produced one, so
//!     nothing here knows what its `notification_type` values mean. §3.3 says
//!     ignore what is not verified, and that is what this does: a notification
//!     changes no state at all rather than guessing `waiting`.
//!   * **`preCompact`** would bump a compaction epoch, and Copilot declares no
//!     `contextUsage` for it to reset (§4). Claude's `PreCompact` is dropped
//!     for the same reason.
//!
//! `preToolUse` never appears here because it is never subscribed: it is
//! Copilot's only blocking event and a non-zero exit denies the tool (§6).

use serde_json::Value;

use super::{AgentEvent, DONE, EventKind, WORKING, apply_common, field, flag, text};

pub fn normalize(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    let mut event = match event_name(payload)? {
        "sessionStart" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("start");
            // 1.0.83 creates the session *from* the first prompt: this arrives
            // roughly 20 ms after that prompt's `userPromptSubmitted`, with the
            // prompt echoed back. Told apart from a start that precedes any
            // work, the reducer can leave the turn already in flight alone
            // instead of resetting the `working` it just wrote (§5.4 rule 4).
            event.session_opened_by_prompt =
                text(payload, "initial_prompt", "initialPrompt").is_some();
            event
        }
        "sessionEnd" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("end");
            event
        }
        "userPromptSubmitted" => {
            let mut event = AgentEvent::state(node_id, agent_id, WORKING);
            event.new_turn = Some(true);
            event.last_message = text(payload, "prompt", "prompt");
            event
        }
        // Both tool events say the same thing about the node: the turn is still
        // running. A failed tool is not a failed turn — Copilot recovers from
        // one routinely — so `postToolUseFailure` does not set `errored`.
        "postToolUse" | "postToolUseFailure" => AgentEvent::state(node_id, agent_id, WORKING),
        "agentStop" => AgentEvent::state(node_id, agent_id, DONE),
        "subagentStart" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::SubagentStart);
            event.subagent_type = text(payload, "agent_name", "agentName");
            event.task_label = text(payload, "agent_description", "agentDescription")
                .or_else(|| text(payload, "agent_display_name", "agentDisplayName"))
                .map(|label| super::truncate(&label, 400));
            event
        }
        "subagentStop" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::SubagentEnd);
            event.subagent_type = text(payload, "agent_type", "agentType")
                .or_else(|| text(payload, "agent_name", "agentName"));
            event.result = text(payload, "response", "response");
            event.tool_use_id = text(payload, "agent_id", "agentId");
            event
        }
        "errorOccurred" => error_occurred(node_id, agent_id, payload)?,
        // See the module note.
        "notification" | "preCompact" => return None,
        _ => return None,
    };
    apply_common(&mut event, payload);
    Some(event)
}

/// Copilot reports recoverable errors it goes on to retry — a model call that
/// timed out, a tool that threw — and `agentStop` still ends the turn
/// afterwards. Only an unrecoverable one is a turn ending badly, so only that
/// one is reported; anything else would race the `agentStop` that is coming.
fn error_occurred(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    if flag(payload, "recoverable", "recoverable") != Some(false) {
        return None;
    }
    let mut event = AgentEvent::state(node_id, agent_id, DONE);
    event.errored = Some(true);
    event.last_message = field(payload, "error", "error")
        .and_then(|error| text(error, "message", "message"))
        .or_else(|| text(payload, "error", "error"));
    Some(event)
}

/// The event this payload came from, as the camelCase name the hooks file uses.
///
/// An explicit name wins; otherwise the shape decides. Every shape rule below
/// keys on a field the docs list for exactly one event, and the order resolves
/// the two overlaps: `subagentStop` and `agentStop` both carry `stopReason`,
/// and `postToolUseFailure` and `errorOccurred` both carry `error` (a string in
/// one, an object in the other).
fn event_name(payload: &Value) -> Option<&'static str> {
    if !payload.is_object() {
        return None;
    }
    if let Some(named) = text(payload, "hook_event_name", "hookEventName")
        && let Some(canonical) = canonical_name(&named)
    {
        return Some(canonical);
    }
    let has = |key: &str| field(payload, key, key).is_some();

    if has("agentId") && has("response") {
        return Some("subagentStop");
    }
    if has("agentName") {
        return Some("subagentStart");
    }
    if has("toolName") {
        return Some(if has("error") {
            "postToolUseFailure"
        } else {
            "postToolUse"
        });
    }
    if has("errorContext") || field(payload, "error", "error").is_some_and(Value::is_object) {
        return Some("errorOccurred");
    }
    if has("trigger") && has("customInstructions") {
        return Some("preCompact");
    }
    if has("notification_type") || has("notificationType") {
        return Some("notification");
    }
    if has("stopReason") || has("stop_hook_active") {
        return Some("agentStop");
    }
    if has("prompt") {
        return Some("userPromptSubmitted");
    }
    // Last, because they are the least distinctive fields Copilot sends: a
    // session's `source` and its `reason` are single words that another event
    // could plausibly grow later.
    if has("source") {
        return Some("sessionStart");
    }
    if has("reason") {
        return Some("sessionEnd");
    }
    None
}

/// camelCase name, or the VS Code-compatible PascalCase alias, to the one
/// spelling the rest of this module uses.
fn canonical_name(named: &str) -> Option<&'static str> {
    Some(match named {
        "sessionStart" | "SessionStart" => "sessionStart",
        "sessionEnd" | "SessionEnd" => "sessionEnd",
        "userPromptSubmitted" | "UserPromptSubmit" => "userPromptSubmitted",
        "postToolUse" | "PostToolUse" => "postToolUse",
        "postToolUseFailure" | "PostToolUseFailure" => "postToolUseFailure",
        "agentStop" | "Stop" => "agentStop",
        "subagentStart" | "SubagentStart" => "subagentStart",
        "subagentStop" | "SubagentStop" => "subagentStop",
        "errorOccurred" | "ErrorOccurred" => "errorOccurred",
        "preCompact" | "PreCompact" => "preCompact",
        "notification" | "Notification" => "notification",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<AgentEvent> {
        normalize("node-a", "copilot", &payload)
    }

    /// The payloads in this test are the ones Copilot CLI 1.0.83 actually sent
    /// during the probe run described in the module note, field for field.
    #[test]
    fn a_recorded_turn_runs_from_prompt_to_stop() {
        let start = run(json!({
            "sessionId": "94d20c9c-212a-4352-bd1e-5e783ccba452",
            "timestamp": 1_788_699_265_758u64,
            "cwd": "/repo",
            "source": "new",
            "initialPrompt": "echo hello"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::Session);
        assert_eq!(start.session_phase, Some("start"));
        assert_eq!(
            start.session_id.as_deref(),
            Some("94d20c9c-212a-4352-bd1e-5e783ccba452")
        );
        assert!(start.state.is_none());
        // This start arrived 46 ms *after* the prompt below, because that
        // prompt is what created the session. The reducer needs to know that
        // to keep the turn already running (§5.4 rule 4).
        assert!(start.session_opened_by_prompt);

        let prompt = run(json!({
            "sessionId": "s-1",
            "timestamp": 1_788_699_265_712u64,
            "cwd": "/repo",
            "prompt": "echo hello"
        }))
        .unwrap();
        assert_eq!(prompt.state, Some(WORKING));
        assert_eq!(prompt.new_turn, Some(true));
        assert_eq!(prompt.last_message.as_deref(), Some("echo hello"));

        let tool = run(json!({
            "sessionId": "s-1",
            "cwd": "/repo",
            "toolName": "bash",
            "toolArgs": { "command": "echo hello-from-probe" },
            "toolResult": { "resultType": "success", "textResultForLlm": "hello-from-probe\n" }
        }))
        .unwrap();
        assert_eq!(tool.state, Some(WORKING));
        assert!(tool.new_turn.is_none());

        let failure = run(json!({
            "sessionId": "s-1",
            "cwd": "/repo",
            "toolName": "bash",
            "toolArgs": {},
            "error": "exit status 1"
        }))
        .unwrap();
        assert_eq!(failure.state, Some(WORKING));
        // A tool that failed is not a turn that failed.
        assert!(failure.errored.is_none());

        let stop = run(json!({
            "sessionId": "s-1",
            "cwd": "/repo",
            "transcriptPath": "/home/dev/.copilot/session-state/s-1/events.jsonl",
            "stopReason": "end_turn",
            "stop_hook_active": false
        }))
        .unwrap();
        assert_eq!(stop.state, Some(DONE));
        assert!(stop.errored.is_none());
        assert_eq!(
            stop.transcript_path.as_deref(),
            Some("/home/dev/.copilot/session-state/s-1/events.jsonl")
        );

        let end = run(json!({
            "sessionId": "s-1",
            "cwd": "/repo",
            "reason": "complete"
        }))
        .unwrap();
        assert_eq!(end.kind, EventKind::Session);
        assert_eq!(end.session_phase, Some("end"));
        assert!(!end.session_opened_by_prompt);
    }

    /// A session the user opened before typing anything carries no
    /// `initialPrompt`, and it is the one that must still reset the row.
    #[test]
    fn a_start_without_an_initial_prompt_is_not_marked_as_opened_by_one() {
        let start = run(json!({
            "sessionId": "s-1",
            "timestamp": 1_788_699_265_758u64,
            "cwd": "/repo",
            "source": "new"
        }))
        .unwrap();
        assert_eq!(start.session_phase, Some("start"));
        assert!(!start.session_opened_by_prompt);

        // An empty string is not a prompt either: `text` drops it, and a start
        // that opened nothing must not claim a turn.
        let blank =
            run(json!({ "sessionId": "s-1", "source": "resume", "initialPrompt": "" })).unwrap();
        assert!(!blank.session_opened_by_prompt);
    }

    #[test]
    fn subagent_events_carry_identity_without_touching_the_parent_state() {
        let start = run(json!({
            "sessionId": "s-1",
            "transcriptPath": "/tmp/events.jsonl",
            "agentName": "explorer",
            "agentDisplayName": "Explorer",
            "agentDescription": "find the bug"
        }))
        .unwrap();
        assert_eq!(start.kind, EventKind::SubagentStart);
        assert_eq!(start.subagent_type.as_deref(), Some("explorer"));
        assert_eq!(start.task_label.as_deref(), Some("find the bug"));
        assert!(start.state.is_none());

        let stop = run(json!({
            "sessionId": "s-1",
            "transcriptPath": "/tmp/events.jsonl",
            "agentId": "a-9",
            "agentType": "explore",
            "agentName": "explorer",
            "response": "found it",
            "stopReason": "end_turn"
        }))
        .unwrap();
        assert_eq!(stop.kind, EventKind::SubagentEnd);
        assert_eq!(stop.tool_use_id.as_deref(), Some("a-9"));
        assert_eq!(stop.subagent_type.as_deref(), Some("explore"));
        assert_eq!(stop.result.as_deref(), Some("found it"));
        assert!(stop.state.is_none());
    }

    /// `subagentStop` and `agentStop` both say `stopReason: "end_turn"`. Read
    /// in the wrong order a finished subagent would end the parent's turn.
    #[test]
    fn a_subagent_stop_is_never_read_as_the_parent_stopping() {
        let event = run(json!({
            "sessionId": "s-1",
            "agentId": "a-9",
            "agentName": "explorer",
            "response": "found it",
            "stopReason": "end_turn"
        }))
        .unwrap();
        assert_eq!(event.kind, EventKind::SubagentEnd);
        assert!(event.state.is_none());
    }

    #[test]
    fn only_an_unrecoverable_error_ends_the_turn() {
        let recoverable = json!({
            "sessionId": "s-1",
            "cwd": "/repo",
            "error": { "message": "socket hang up", "name": "FetchError" },
            "errorContext": "model_call",
            "recoverable": true
        });
        // The `agentStop` that follows is what ends this turn.
        assert!(run(recoverable).is_none());

        let fatal = run(json!({
            "sessionId": "s-1",
            "cwd": "/repo",
            "error": { "message": "no credentials", "name": "AuthError" },
            "errorContext": "system",
            "recoverable": false
        }))
        .unwrap();
        assert_eq!(fatal.state, Some(DONE));
        assert_eq!(fatal.errored, Some(true));
        assert_eq!(fatal.last_message.as_deref(), Some("no credentials"));
    }

    /// §3.3 marks the `notification` payload 本机核实 and neither probe run on
    /// this machine produced one, so it stays unmapped. Guessing `waiting`
    /// would park a node that is in fact working.
    #[test]
    fn an_unverified_notification_changes_nothing() {
        assert!(
            run(json!({
                "sessionId": "s-1",
                "cwd": "/repo",
                "hook_event_name": "Notification",
                "message": "Copilot needs permission to run bash",
                "notification_type": "permission_prompt"
            }))
            .is_none()
        );
        // And with no compaction epoch to bump, neither does preCompact.
        assert!(
            run(json!({
                "sessionId": "s-1",
                "transcriptPath": "/tmp/events.jsonl",
                "trigger": "auto",
                "customInstructions": ""
            }))
            .is_none()
        );
    }

    #[test]
    fn an_explicit_event_name_wins_over_the_shape() {
        // Shape alone would read this as a session start.
        let named = run(json!({
            "hookEventName": "userPromptSubmitted",
            "sessionId": "s-1",
            "source": "new",
            "prompt": "go"
        }))
        .unwrap();
        assert_eq!(named.state, Some(WORKING));
        assert_eq!(named.new_turn, Some(true));

        // The VS Code-compatible aliases fire under the same installer, so both
        // spellings have to land on the same event.
        let pascal = run(json!({ "hook_event_name": "Stop", "sessionId": "s-1" })).unwrap();
        assert_eq!(pascal.state, Some(DONE));

        // A name we do not know falls back to the shape rather than to nothing.
        let unknown = run(json!({ "hook_event_name": "SomethingNew", "prompt": "go" })).unwrap();
        assert_eq!(unknown.state, Some(WORKING));
    }

    #[test]
    fn payloads_that_say_nothing_are_ignored() {
        assert!(run(json!({ "sessionId": "s-1", "cwd": "/repo" })).is_none());
        assert!(run(json!({ "nothing": true })).is_none());
        assert!(run(json!("a bare string")).is_none());
        assert!(run(json!([])).is_none());
        // `preToolUse` is never installed (§6); if one arrived anyway it would
        // carry no result and must not be read as a finished tool call.
        let pre_tool = run(json!({
            "sessionId": "s-1",
            "toolName": "bash",
            "toolArgs": { "command": "rm -rf /" }
        }))
        .unwrap();
        assert_eq!(pre_tool.state, Some(WORKING));
    }
}
