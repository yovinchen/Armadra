//! `POST /hook/{agentId}` — the one route every CLI's hooks reach.
//!
//! The contract is deliberately blunt, because the caller is a fire-and-forget
//! client with a 1.5s deadline that must never slow a turn down:
//!
//!   * **204** on anything we accepted, including a payload we did not
//!     understand and a node we have never heard of. A hook that got a 4xx
//!     would print an error into the user's terminal for no benefit.
//!   * **403** only for the two cases that mean something is wrong with the
//!     caller rather than the payload: a bad app bearer, and a node token that
//!     was minted with our key id but the wrong MAC.
//!   * **400** only for a body we cannot parse at all.
//!
//! Everything else — an unknown event, a `{"raw": "..."}` wrapper around
//! non-JSON stdin, an event for a node with no workspace — is silently dropped.

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    AppState,
    collab::{self, ControlRequest},
    db::{self, AgentStatusPatch},
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    hook::{
        auth::{Verdict, valid_node_id},
        normalize::{self, AgentEvent},
        reduce::{self, Current},
    },
    model::AgentStatus,
};

pub const HOOK_TOKEN_HEADER: &str = "x-armadra-hook-token";
pub const NODE_TOKEN_HEADER: &str = "x-armadra-node-token";
pub const CLIENT_REVISION_HEADER: &str = "x-armadra-hook-client";

/// The envelope the `armadra-hook` client posts. `payload` is whatever the CLI
/// wrote to the client's stdin, untouched.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRequest {
    pub node_id: String,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub pending_id: Option<String>,
    /// Set on the *second* post of a permission round trip: the client has
    /// already printed this decision back to the CLI (plan §5.5).
    #[serde(default)]
    pub answered: Option<String>,
    #[serde(default)]
    pub terminal_binding: Option<HookTerminalBinding>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookTerminalBinding {
    pub session_id: String,
    pub generation: u64,
    pub source_revision: String,
}

/// `GET /verify` — the client's cheap "is this endpoint still mine?" probe.
pub async fn verify(State(state): State<AppState>, headers: HeaderMap) -> AppResult<StatusCode> {
    require_bearer(&state, &headers)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn ingest(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<HookRequest>,
) -> AppResult<StatusCode> {
    require_bearer(&state, &headers)?;

    if !valid_node_id(&request.node_id) {
        // Not a 400: a malformed id is a broken client, and a broken client
        // must not make the CLI print anything.
        tracing::debug!(node_id = %request.node_id, "hook report with an unusable node id");
        return Ok(StatusCode::NO_CONTENT);
    }
    let verdict = state
        .hooks
        .verdict(&request.node_id, header(&headers, NODE_TOKEN_HEADER));
    if verdict == Verdict::Forged {
        return Err(AppError::Forbidden(
            "The node token was minted by this runtime but does not match the node".into(),
        ));
    }

    let Some(owner) = db::find_node_owner(&state.pool, &request.node_id).await? else {
        // A node the canvas never created, or one that has been deleted. The
        // CLI is still running; there is simply nothing to attribute this to.
        tracing::debug!(node_id = %request.node_id, "hook report for an unknown node");
        return Ok(StatusCode::NO_CONTENT);
    };
    // The path names the provider whose hook fired; the session's own agent id
    // is the fallback for a client invoked without one.
    let provider = if db::valid_agent_id(&agent_id) {
        agent_id
    } else {
        owner
            .agent_id
            .clone()
            .unwrap_or_else(|| "claude".to_owned())
    };
    // A custom agent has no hooks of its own: the installed hook line runs
    // `armadra-hook <base>`, so the path says `claude` while the node is
    // `custom:…`. The node wins for attribution and its configured base picks
    // the parser (plan §24.1).
    let (agent_id, provider) = match owner.agent_id.as_deref() {
        Some(node_agent) if node_agent.starts_with("custom:") => {
            (node_agent.to_owned(), state.settings.base_agent(node_agent))
        }
        _ => (provider.clone(), provider),
    };
    let observation_binding = if let Some(binding) = request.terminal_binding.as_ref() {
        let valid = verdict.is_verified()
            && binding
                .source_revision
                .parse::<u64>()
                .is_ok_and(|revision| revision > 0)
            && state
                .terminals
                .is_current_node_session(&request.node_id, &binding.session_id, binding.generation)
                .await;
        let session = db::get_terminal_session(&state.pool, &binding.session_id)
            .await
            .ok();
        if !valid
            || !session.is_some_and(|session| {
                session.agent_id.as_deref() == Some(agent_id.as_str())
                    && session.owner_node_id.as_deref() == Some(&request.node_id)
            })
        {
            return Ok(StatusCode::NO_CONTENT);
        }
        Some(binding)
    } else {
        None
    };

    if let Some(report) = request.payload.get("armadraContextUsage") {
        if verdict.is_verified() {
            let _ =
                crate::context_usage::ingest(&state, &request.node_id, &provider, report).await?;
        }
        return Ok(StatusCode::NO_CONTENT);
    }
    if !crate::context_usage::has_capability(&state.settings, &agent_id, "hooks") {
        return Ok(StatusCode::NO_CONTENT);
    }

    let Some(mut event) =
        normalize::normalize_as(&provider, &agent_id, &request.node_id, &request.payload)
    else {
        tracing::trace!(%agent_id, node_id = %request.node_id, "hook payload carried no state");
        return Ok(StatusCode::NO_CONTENT);
    };
    event.verified = Some(verdict.is_verified());
    event.client_revision = header(&headers, CLIENT_REVISION_HEADER).and_then(|v| v.parse().ok());
    // The envelope's pendingId is authoritative: only the client knows which
    // file it wrote the request to.
    if let Some(pending_id) = request.pending_id.as_deref().filter(|id| !id.is_empty()) {
        event.pending_id = Some(pending_id.to_owned());
    }

    if let Some(decision) = request.answered.as_deref() {
        record_answer(&state, &event, decision).await;
    }

    let observation = crate::terminal::AgentReport {
        revision: observation_binding
            .and_then(|binding| binding.source_revision.parse().ok())
            .unwrap_or(0),
        provider_session_id: event.session_id.clone(),
        transcript_path: event.transcript_path.clone(),
        idle: event.state == Some("done") && !event.kind.is_subagent(),
    };
    let parent_event = !event.kind.is_subagent();
    let status = apply(
        &state,
        &owner.workspace_id,
        &agent_id,
        event,
        &request.payload,
    )
    .await?;
    if parent_event
        && status.is_some()
        && let Some(binding) = observation_binding
    {
        state
            .terminals
            .observe_agent(
                &request.node_id,
                &binding.session_id,
                binding.generation,
                observation,
            )
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Reduce → persist → publish. Split out so the sweep can reuse it.
pub async fn apply(
    state: &AppState,
    workspace_id: &str,
    agent_id: &str,
    event: AgentEvent,
    raw_payload: &Value,
) -> AppResult<Option<AgentStatus>> {
    if event.kind.is_subagent() {
        if !crate::context_usage::has_capability(&state.settings, agent_id, "subagent") {
            return Ok(None);
        }
        // A subagent card is transient canvas state: published, never stored.
        state.events.publish(
            workspace_id,
            WorkspaceEvent::AgentSubagent {
                event: serde_json::to_value(&event).unwrap_or(Value::Null),
            },
        );
        return Ok(None);
    }

    let existing = db::get_agent_status(&state.pool, &event.node_id).await?;
    let current = existing
        .as_ref()
        .map_or_else(Current::default, |status| Current {
            state: status.state.clone(),
            unread: status.unread,
            session_id: status.session_id.clone(),
            pending_id: status.pending_id.clone(),
            transcript_path: status.transcript_path.clone(),
            session_phase: status.session_phase.clone(),
            errored: status.errored,
            interrupted: status.interrupted,
            restored: status.restored,
        });

    let now = chrono::Utc::now();
    let Some(next) = state.hooks.with_memory(&event.node_id, |memory| {
        reduce::reduce(now, &current, memory, &event)
    }) else {
        return Ok(None);
    };

    let approval = (next.state.as_deref() == Some("blocked"))
        .then(|| next.pending_id.clone())
        .flatten();
    let mut status = db::upsert_agent_status(
        &state.pool,
        AgentStatusPatch {
            node_id: event.node_id.clone(),
            workspace_id: workspace_id.to_owned(),
            agent_id: agent_id.to_owned(),
            state: next.state.clone(),
            unread: next.unread,
            session_id: next.session_id.clone(),
            pending_id: next.pending_id.clone(),
            verified: event.verified.unwrap_or(false),
            transcript_path: next.transcript_path.clone(),
            session_phase: next.session_phase.clone(),
            errored: next.errored,
            interrupted: next.interrupted,
            last_event_at: Some(now.to_rfc3339()),
        },
    )
    .await?;
    // Not a column: the message travels with the published copy only.
    status.last_message = next.last_message.clone();

    if let Some(pending_id) = approval {
        // The raw hook payload is the audit record — it is what the CLI asked,
        // in the CLI's own words.
        match db::insert_approval(
            &state.pool,
            &pending_id,
            &event.node_id,
            workspace_id,
            raw_payload,
        )
        .await
        {
            Ok(approval) => {
                state.events.publish(
                    workspace_id,
                    WorkspaceEvent::AgentApproval {
                        node_id: event.node_id.clone(),
                        pending_id,
                        request: serde_json::to_value(&approval).unwrap_or(Value::Null),
                    },
                );
            }
            Err(error) => tracing::warn!(%error, "could not record the pending approval"),
        }
    }

    state.events.publish(
        workspace_id,
        WorkspaceEvent::AgentStatus {
            status: status.clone(),
        },
    );

    // Plan §5.7. A new turn resets the sender's per-turn fan-out budget, and a
    // node that just went idle drains whatever was queued for it — on its own
    // task, because the hook client is waiting on this response with a 1.5s
    // deadline and a flush can take seconds.
    if event.new_turn == Some(true) {
        crate::collab::note_new_turn(state, &event.node_id);
    }
    if next.state.as_deref() == Some("done") {
        let state = state.clone();
        let node_id = event.node_id.clone();
        tokio::spawn(async move {
            crate::collab::messaging::flush_for(&state, &node_id).await;
        });
    }
    Ok(Some(status))
}

/// The client already answered the CLI; we only close the audit record. A
/// double answer is expected (the user's own POST got there first) and is not
/// an error worth surfacing.
async fn record_answer(state: &AppState, event: &AgentEvent, decision: &str) {
    let Some(pending_id) = event.pending_id.as_deref() else {
        return;
    };
    match db::answer_approval(&state.pool, pending_id, decision, Some("hook")).await {
        Ok(_) | Err(AppError::Conflict(_)) | Err(AppError::NotFound(_)) => {}
        Err(error) => tracing::warn!(%error, "could not record the hook's approval answer"),
    }
}

fn require_bearer(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if state
        .hooks
        .bearer_matches(header(headers, HOOK_TOKEN_HEADER))
    {
        return Ok(());
    }
    Err(AppError::Forbidden("The hook token is not valid".into()))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/* ------------------------- the Phase 3 collaboration routes ---------------- */

/// `POST /context-link/{verb}` — plan §5.6. Answers `text/plain` prose, because
/// the client prints the body verbatim into the calling agent's stdout.
pub async fn context_link(
    State(state): State<AppState>,
    Path(verb): Path<String>,
    headers: HeaderMap,
    body: Option<Json<ControlRequest>>,
) -> axum::response::Response {
    if let Err(refusal) = require_bearer(&state, &headers) {
        return collab::text_reply(StatusCode::FORBIDDEN, format!("{refusal}\n"));
    }
    let Json(request) = body.unwrap_or_default();
    let caller = match collab::resolve_caller(&state, &headers, &request.node_id).await {
        Ok(caller) => caller,
        Err(refusal) => {
            return collab::text_reply(refusal.status, format!("{}\n", refusal.message));
        }
    };
    let args = collab::Args(&request.args);
    collab::context_link::reply(collab::context_link::run(&state, &caller, &verb, &args).await)
}

/// `POST /control/{verb}` — plan §5.8. JSON by default; prose when the caller
/// asked for `text/plain`.
pub async fn control(
    State(state): State<AppState>,
    Path(verb): Path<String>,
    headers: HeaderMap,
    body: Option<Json<ControlRequest>>,
) -> axum::response::Response {
    let text = collab::wants_text(&headers);
    if let Err(refusal) = require_bearer(&state, &headers) {
        return control_error(text, StatusCode::FORBIDDEN, refusal.to_string());
    }
    let Json(request) = body.unwrap_or_default();
    let caller = match collab::resolve_caller(&state, &headers, &request.node_id).await {
        Ok(caller) => caller,
        Err(refusal) => return control_error(text, refusal.status, refusal.message),
    };
    let args = collab::Args(&request.args);
    match collab::control::run(&state, &caller, &verb, &args).await {
        Ok(outcome) if text => collab::text_reply(StatusCode::OK, format!("{}\n", outcome.message)),
        Ok(outcome) => (StatusCode::OK, Json(outcome.to_json())).into_response(),
        Err(refusal) => control_error(text, refusal.status, refusal.message),
    }
}

fn control_error(text: bool, status: StatusCode, message: String) -> axum::response::Response {
    if text {
        return collab::text_reply(status, format!("{message}\n"));
    }
    (
        status,
        Json(serde_json::json!({ "ok": false, "error": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::normalize::EventKind;
    use axum::http::HeaderValue;

    #[test]
    fn headers_are_read_case_insensitively_and_tolerate_junk() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Armadra-Hook-Client", HeaderValue::from_static("3"));
        headers.insert(NODE_TOKEN_HEADER, HeaderValue::from_static("kid.mac"));
        assert_eq!(header(&headers, CLIENT_REVISION_HEADER), Some("3"));
        assert_eq!(header(&headers, NODE_TOKEN_HEADER), Some("kid.mac"));
        assert_eq!(header(&headers, HOOK_TOKEN_HEADER), None);
        headers.insert(
            HOOK_TOKEN_HEADER,
            HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap(),
        );
        assert_eq!(header(&headers, HOOK_TOKEN_HEADER), None);
    }

    #[test]
    fn the_envelope_matches_the_client_contract() {
        let request: HookRequest = serde_json::from_str(
            r#"{"answered":"allow","nodeId":"n-1","payload":{"hook_event_name":"Stop"},"pendingId":"p-1","version":1}"#,
        )
        .unwrap();
        assert_eq!(request.node_id, "n-1");
        assert_eq!(request.version, 1);
        assert_eq!(request.pending_id.as_deref(), Some("p-1"));
        assert_eq!(request.answered.as_deref(), Some("allow"));
        assert_eq!(request.payload["hook_event_name"], "Stop");

        // Only nodeId is required; the client omits what it has nothing to say about.
        let minimal: HookRequest = serde_json::from_str(r#"{"nodeId":"n-1"}"#).unwrap();
        assert!(minimal.payload.is_null());
        assert!(minimal.pending_id.is_none());

        // Non-JSON stdin arrives wrapped, and must normalize to nothing.
        let raw: HookRequest =
            serde_json::from_str(r#"{"nodeId":"n-1","payload":{"raw":"hi","truncated":true}}"#)
                .unwrap();
        assert!(normalize::normalize("claude", "n-1", &raw.payload).is_none());
    }

    #[test]
    fn a_subagent_event_is_recognised_before_any_database_work() {
        let event = AgentEvent::new("n-1", "claude", EventKind::SubagentStart);
        assert!(event.kind.is_subagent());
        assert!(
            !AgentEvent::state("n-1", "claude", "working")
                .kind
                .is_subagent()
        );
    }
}
