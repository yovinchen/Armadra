//! opencode plugin payloads.
//!
//! opencode has no hook configuration: a plugin subscribes to one `event` bus
//! and receives `{ type | event, properties }`. That means there is no
//! "before the turn starts" signal — the closest thing is a `message.updated`
//! whose message has `role: "user"`, which is why the new-turn detection here
//! looks inside `properties` instead of at the topic alone.
//!
//! Topics are matched by prefix (`tool.`) where the bus is known to add
//! variants, and exactly elsewhere, so a future `tool.execute.retry` still
//! reads as `working` while an unrelated topic stays ignored.

use serde_json::Value;

use super::{AgentEvent, BLOCKED, DONE, EventKind, WORKING, text, truncate};

pub fn normalize(node_id: &str, agent_id: &str, payload: &Value) -> Option<AgentEvent> {
    // The plugin forwards the bus event verbatim; opencode has used both `type`
    // and `event` for the topic across versions.
    let topic = text(payload, "event", "type")
        .or_else(|| text(payload, "type", "event"))
        .filter(|topic| !topic.is_empty())?;
    let properties = payload
        .get("properties")
        .filter(|value| value.is_object())
        .unwrap_or(&Value::Null);

    let mut event = match topic.as_str() {
        "session.idle" => AgentEvent::state(node_id, agent_id, DONE),
        "session.error" => {
            let mut event = AgentEvent::state(node_id, agent_id, DONE);
            event.errored = Some(true);
            event.last_message = text(properties, "error", "error");
            event
        }
        "message.updated" | "message.part.updated" => {
            // Only the user's own message opens a turn; the assistant's stream
            // updates the same topic dozens of times per turn.
            if !is_user_message(properties) {
                return None;
            }
            let mut event = AgentEvent::state(node_id, agent_id, WORKING);
            event.new_turn = Some(true);
            event
        }
        "permission.asked" | "permission.updated" | "permission.replied" => {
            let mut event = AgentEvent::state(node_id, agent_id, BLOCKED);
            event.pending_id = permission_id(properties);
            event.ask_kind =
                text(properties, "type", "kind").or_else(|| Some("permission".to_owned()));
            event.last_message = text(properties, "title", "title");
            event
        }
        "session.deleted" => {
            let mut event = AgentEvent::new(node_id, agent_id, EventKind::Session);
            event.session_phase = Some("end");
            event
        }
        topic if topic.starts_with("tool.") => AgentEvent::state(node_id, agent_id, WORKING),
        _ => return None,
    };

    event.session_id = session_id(properties);
    Some(event)
}

/// `message.updated` nests the message under `info` in current opencode, and
/// used to inline it; both shapes are read.
fn is_user_message(properties: &Value) -> bool {
    let role = properties
        .get("info")
        .and_then(|info| info.get("role"))
        .or_else(|| properties.get("role"))
        .and_then(Value::as_str);
    role.is_some_and(|role| role.eq_ignore_ascii_case("user"))
}

fn session_id(properties: &Value) -> Option<String> {
    properties
        .get("info")
        .and_then(|info| text(info, "sessionID", "sessionId"))
        .or_else(|| text(properties, "sessionID", "sessionId"))
        .or_else(|| text(properties, "session_id", "sessionID"))
        .map(|id| truncate(&id, 200))
}

fn permission_id(properties: &Value) -> Option<String> {
    text(properties, "id", "permissionID")
        .or_else(|| text(properties, "permissionID", "permissionId"))
        .map(|id| truncate(&id, 200))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<AgentEvent> {
        normalize("node-a", "opencode", &payload)
    }

    #[test]
    fn a_user_message_opens_a_turn_and_idle_closes_it() {
        let user = run(json!({
            "event": "message.updated",
            "properties": { "info": { "role": "user", "sessionID": "oc-1" } }
        }))
        .unwrap();
        assert_eq!(user.state, Some(WORKING));
        assert_eq!(user.new_turn, Some(true));
        assert_eq!(user.session_id.as_deref(), Some("oc-1"));

        // The assistant's own stream must not restart the turn.
        assert!(
            run(json!({
                "event": "message.updated",
                "properties": { "info": { "role": "assistant" } }
            }))
            .is_none()
        );

        let idle = run(json!({
            "event": "session.idle",
            "properties": { "sessionID": "oc-1" }
        }))
        .unwrap();
        assert_eq!(idle.state, Some(DONE));
        assert!(
            idle.idle.is_none(),
            "session.idle is authoritative, not a rescue"
        );
    }

    #[test]
    fn tool_topics_are_matched_by_prefix() {
        for topic in [
            "tool.execute.before",
            "tool.execute.after",
            "tool.registered",
        ] {
            let event = run(json!({ "event": topic, "properties": {} })).unwrap();
            assert_eq!(event.state, Some(WORKING), "{topic}");
            assert!(event.new_turn.is_none());
        }
    }

    #[test]
    fn permissions_block_and_carry_their_id() {
        for topic in ["permission.asked", "permission.updated"] {
            let event = run(json!({
                "event": topic,
                "properties": { "id": "perm-9", "type": "bash", "title": "run tests" }
            }))
            .unwrap();
            assert_eq!(event.state, Some(BLOCKED), "{topic}");
            assert_eq!(event.pending_id.as_deref(), Some("perm-9"));
            assert_eq!(event.ask_kind.as_deref(), Some("bash"));
            assert_eq!(event.last_message.as_deref(), Some("run tests"));
        }
    }

    #[test]
    fn the_topic_may_arrive_as_type_and_errors_are_flagged() {
        let event = run(json!({ "type": "session.idle", "properties": {} })).unwrap();
        assert_eq!(event.state, Some(DONE));

        let failed = run(json!({
            "type": "session.error",
            "properties": { "error": "provider refused" }
        }))
        .unwrap();
        assert_eq!(failed.errored, Some(true));
        assert_eq!(failed.last_message.as_deref(), Some("provider refused"));
    }

    #[test]
    fn unknown_topics_and_non_json_stdin_are_ignored() {
        assert!(run(json!({ "event": "storage.write", "properties": {} })).is_none());
        assert!(run(json!({ "event": "" })).is_none());
        assert!(run(json!({ "raw": "opencode printed a banner" })).is_none());
        assert!(run(json!([1, 2, 3])).is_none());
    }
}
