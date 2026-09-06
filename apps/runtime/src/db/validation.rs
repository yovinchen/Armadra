//! Document validation: viewport, node and edge shapes, the per-type node
//! payloads and the bounds every annotation has to stay inside.

use serde_json::Value;
use uuid::Uuid;

use super::workspaces::is_hex_color;
use super::{
    AGENT_ACTIVITY_SOURCES, AUTOMATION_SCHEDULE_KINDS, BUILTIN_AGENT_IDS, DIFF_SCOPES, EDGE_KINDS,
    MAX_WHITEBOARD_BYTES, NATIVE_RECURRENCE_DIALECTS, NODE_TYPES, PERMISSION_MODES,
};
use crate::{
    error::{AppError, AppResult},
    model::{CanvasEdge, CanvasNode, Viewport},
};

const MAX_STICKY_CONTENT: usize = 20_000;

/* Node annotation bounds, mirrored in packages/shared. */
const MAX_NODE_LABELS: usize = 8;
const MAX_NODE_LABEL_CHARS: usize = 24;
const MAX_NODE_NOTE_CHARS: usize = 4_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub(super) fn validate_viewport(viewport: &Viewport) -> AppResult<()> {
    let valid = viewport.x.is_finite()
        && viewport.y.is_finite()
        && viewport.zoom.is_finite()
        && viewport.zoom > 0.0
        && viewport.zoom <= 16.0;
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest("Board viewport is invalid".into()))
    }
}

pub fn validate_document(
    board_id: &str,
    nodes: &[CanvasNode],
    edges: &[CanvasEdge],
) -> AppResult<()> {
    let node_ids = nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let group_ids = nodes
        .iter()
        .filter(|node| node.node_type == "group")
        .map(|node| node.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    for node in nodes {
        let kind = node.data.get("kind").and_then(Value::as_str);
        let valid_identity = Uuid::parse_str(&node.id).is_ok()
            && Uuid::parse_str(&node.board_id).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&node.created_at).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&node.updated_at).is_ok();
        let valid_geometry = node.position.x.is_finite()
            && node.position.y.is_finite()
            && node.size.as_ref().is_none_or(|size| {
                size.width.is_finite()
                    && size.height.is_finite()
                    && size.width > 0.0
                    && size.height > 0.0
            })
            && node
                .expanded_height
                .is_none_or(|height| height.is_finite() && height > 0.0);
        let valid_header = !node.title.is_empty()
            && node.title.chars().count() <= 160
            && is_hex_color(&node.color);
        // Labels are a filter, not a field: eight short chips at most, none of
        // them blank. The note is prose and only has an upper bound.
        let valid_annotations = node.labels.len() <= MAX_NODE_LABELS
            && node.labels.iter().all(|label| {
                let label = label.trim();
                !label.is_empty() && label.chars().count() <= MAX_NODE_LABEL_CHARS
            })
            && node.note.chars().count() <= MAX_NODE_NOTE_CHARS;
        // A child may only live inside a group that is part of the same save.
        let valid_parent = node.parent_id.as_deref().is_none_or(|parent| {
            parent != node.id && group_ids.contains(parent) && Uuid::parse_str(parent).is_ok()
        });
        if node.board_id != board_id
            || !NODE_TYPES.contains(&node.node_type.as_str())
            || kind != Some(&node.node_type)
            || !valid_identity
            || !valid_geometry
            || !valid_header
            || !valid_annotations
            || !valid_parent
            || !valid_node_data(node)
        {
            return Err(AppError::BadRequest(
                "Board contains an invalid node".into(),
            ));
        }
    }
    for edge in edges {
        let valid_identity = Uuid::parse_str(&edge.id).is_ok()
            && Uuid::parse_str(&edge.board_id).is_ok()
            && Uuid::parse_str(&edge.source).is_ok()
            && Uuid::parse_str(&edge.target).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&edge.created_at).is_ok()
            && chrono::DateTime::parse_from_rfc3339(&edge.updated_at).is_ok();
        if edge.board_id != board_id
            || !EDGE_KINDS.contains(&edge.kind.as_str())
            || !node_ids.contains(edge.source.as_str())
            || !node_ids.contains(edge.target.as_str())
            || !valid_identity
        {
            return Err(AppError::BadRequest(
                "Board contains an invalid or dangling edge".into(),
            ));
        }
    }
    Ok(())
}

/// The snapshot is opaque, so the only thing worth checking is its size: an
/// unbounded blob would be written straight into the row on every autosave.
pub fn validate_whiteboard(snapshot: &str) -> AppResult<()> {
    if snapshot.len() > MAX_WHITEBOARD_BYTES {
        return Err(AppError::BadRequest(
            "Whiteboard snapshot is too large".into(),
        ));
    }
    Ok(())
}

pub fn valid_node_data(node: &CanvasNode) -> bool {
    let data = &node.data;
    match node.node_type.as_str() {
        "terminal" => {
            optional_bounded_string(data, "cwd", 4_000)
                && optional_bounded_string(data, "shell", 1_024)
                && optional_uuid_field(data, "sessionId")
                && data
                    .get("lastExitCode")
                    .is_none_or(|value| value.is_null() || value.as_i64().is_some())
                && data
                    .get("agent")
                    .is_none_or(|value| value.is_null() || valid_agent_block(value))
        }
        "sticky" => bounded_string_field(data, "content", MAX_STICKY_CONTENT),
        // The label is `node.title` and the tint is `node.color`; the payload
        // carries nothing else.
        "group" => true,
        "editor" => {
            string_field(data, "path")
                && optional_bounded_string(data, "language", 40)
                && data
                    .get("readonly")
                    .is_none_or(|value| value.is_null() || value.is_boolean())
        }
        "diff" => {
            string_field(data, "repoPath")
                && data
                    .get("scope")
                    .and_then(Value::as_str)
                    .is_some_and(|scope| DIFF_SCOPES.contains(&scope))
                && data.get("paths").is_none_or(|value| {
                    value.is_null()
                        || value.as_array().is_some_and(|paths| {
                            paths.len() <= 1_000 && paths.iter().all(Value::is_string)
                        })
                })
        }
        "files" => string_field(data, "path"),
        "browser" => bounded_string_field(data, "url", 4_000),
        // The node only references a Host-owned plan; the schedule, state and
        // results are read from the Host, never persisted onto the board.
        "automation" => {
            string_field(data, "planId")
                && string_field(data, "planWorkspaceId")
                && string_field(data, "executionHostId")
                && data.get("scheduleKind").is_none_or(|value| {
                    value.is_null()
                        || value
                            .as_str()
                            .is_some_and(|kind| AUTOMATION_SCHEDULE_KINDS.contains(&kind))
                })
                && optional_bounded_string(data, "timezone", 64)
        }
        // A read-only observation card. Identity is the observed session's, so
        // a title collision can never merge two different native jobs.
        "agentActivity" => {
            data.get("sourceNodeId")
                .and_then(Value::as_str)
                .is_some_and(|value| Uuid::parse_str(value).is_ok())
                && data.get("source").is_none_or(|value| {
                    value.is_null()
                        || value
                            .as_str()
                            .is_some_and(|source| AGENT_ACTIVITY_SOURCES.contains(&source))
                })
                && optional_bounded_string(data, "sessionId", 200)
                && optional_bounded_string(data, "executionHostId", 200)
                && optional_bounded_string(data, "nativeJobId", 200)
                && data.get("generation").is_none_or(|value| {
                    value.is_null() || value.as_u64().is_some_and(|v| v < (1 << 53))
                })
                && data
                    .get("nativeRecurrence")
                    .is_none_or(|value| value.is_null() || valid_native_recurrence(value))
        }
        _ => false,
    }
}

/// `data.nativeRecurrence` on an activity card.
///
/// The rule is bounded and stored **verbatim**: it is evidence of what the
/// machine was told to do, and normalizing it here would quietly drop the parts
/// that make one untranslatable. Only the dialect is constrained, because that
/// is what tells the panel which parser to try.
fn valid_native_recurrence(value: &Value) -> bool {
    value
        .get("dialect")
        .and_then(Value::as_str)
        .is_some_and(|dialect| NATIVE_RECURRENCE_DIALECTS.contains(&dialect))
        && value
            .get("rule")
            .and_then(Value::as_str)
            .is_some_and(|rule| !rule.is_empty() && rule.chars().count() <= 2_000)
        && optional_bounded_string(value, "timezone", 64)
}

/// `data.agent` on a terminal node — plan §5.1.
fn valid_agent_block(agent: &Value) -> bool {
    let valid_id = agent
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(valid_agent_id);
    let valid_permission = agent.get("permissionMode").is_none_or(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|mode| PERMISSION_MODES.contains(&mode))
    });
    let valid_pending = agent.get("pendingLaunch").is_none_or(|value| {
        value.is_null()
            || (bounded_string_field(value, "command", 4_000)
                && value.get("after").is_none_or(|after| {
                    after.as_array().is_some_and(|ids| {
                        ids.len() <= 32
                            && ids
                                .iter()
                                .all(|id| id.as_str().is_some_and(|id| Uuid::parse_str(id).is_ok()))
                    })
                }))
    });
    // `account` mirrors AccountRef / CredentialBinding (S02). It is reserved:
    // stored when a client sends it, never interpreted here, and no secret may
    // hide in it — `credentialRef` is a name in a credential store.
    let valid_account = agent.get("account").is_none_or(|value| {
        value.is_null()
            || (value
                .get("accountId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && id.len() <= 120)
                && optional_bounded_string(value, "providerId", 120)
                && optional_bounded_string(value, "label", 200)
                && optional_bounded_string(value, "credentialRef", 200))
    });
    valid_id
        && valid_permission
        && valid_pending
        && valid_account
        && optional_bounded_string(agent, "accountId", 120)
        && optional_bounded_string(agent, "model", 120)
        && optional_bounded_string(agent, "sessionId", 200)
        && optional_bounded_string(agent, "initialCommand", 4_000)
}

/// Built-in ids plus `custom:<id>` for user-defined CLIs.
pub fn valid_agent_id(value: &str) -> bool {
    if BUILTIN_AGENT_IDS.contains(&value) {
        return true;
    }
    match value.strip_prefix("custom:") {
        Some(suffix) => {
            !suffix.is_empty()
                && suffix.len() <= 64
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".:_-".contains(c))
        }
        None => false,
    }
}

fn bounded_string_field(data: &Value, name: &str, max: usize) -> bool {
    data.get(name)
        .and_then(Value::as_str)
        .is_some_and(|value| value.len() <= max)
}

fn optional_bounded_string(data: &Value, name: &str, max: usize) -> bool {
    data.get(name)
        .is_none_or(|value| value.is_null() || value.as_str().is_some_and(|v| v.len() <= max))
}

fn optional_uuid_field(data: &Value, name: &str) -> bool {
    data.get(name).is_none_or(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|value| Uuid::parse_str(value).is_ok())
    })
}

fn string_field(data: &Value, name: &str) -> bool {
    data.get(name)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && value.len() <= 4_000)
}
