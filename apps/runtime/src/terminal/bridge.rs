//! The session domain's execution door (Go Host 业务所有权迁移 §2.6, §2.9).
//!
//! Once the Host owns the session domain it decides whether a terminal should
//! exist; this Runtime still runs it, because a PTY, a tmux server handle and a
//! replay log cannot live in another process. The Host's Worker is a third
//! process again, so these routes are how it reaches the one that actually
//! holds the panes.
//!
//! They are mounted on the same private surface the hook client already uses —
//! the Unix socket published in `hook-endpoint.env`, behind the same app bearer
//! — for the reason `automation` uses it: this Runtime already has exactly one
//! authenticated door for a local peer, and a second one would need its own
//! pairing, its own rotation and its own reachability story. A browser cannot
//! reach it at all.
//!
//! Nothing here decides anything either. Every route is a verb the Host already
//! decided on, applied to the manager that owns the process, and the answer is
//! what the manager reports: a generation it allocated, an exit code it saw, a
//! listing of the panes it actually holds. The one refusal that belongs here is
//! the generation check, because only this side knows which pane is current.

use std::sync::OnceLock;

use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    security::resolve_in_root,
    terminal::{SpawnRequest, TerminateMode},
};

/// One session as the Host's Worker reads it. The field names are the Runtime's
/// own camelCase JSON, and the values are the Runtime's own vocabulary — the
/// Worker maps them onto the contract's enums, which keeps the mapping in one
/// place rather than in both.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    session_id: String,
    workspace_id: String,
    session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_node_id: Option<String>,
    backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_ref: Option<String>,
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    kind: String,
    status: String,
    attach_state: String,
    termination_intent: String,
    created_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_output_at_unix_ms: Option<i64>,
}

/// This Runtime process's own incarnation, generated once and stable for its
/// life. A new one is precisely why a reclaim cannot assume a run it remembers
/// is still the same run: a restarted Runtime creates new panes under the same
/// logical keys, and the Host has to be able to tell that apart from a Runtime
/// that merely reconnected.
fn instance_id() -> &'static str {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

fn milliseconds(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.timestamp_millis())
        .unwrap_or(0)
}

async fn describe(state: &AppState, session_id: &str) -> AppResult<SessionState> {
    let session = db::get_terminal_session(&state.pool, session_id).await?;
    let backend_ref = db::terminal_backend_ref(&state.pool, session_id)
        .await
        .ok()
        .flatten();
    let intent: Option<String> =
        sqlx::query_scalar("SELECT termination_intent FROM terminal_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    Ok(SessionState {
        session_id: session.id,
        workspace_id: session.workspace_id,
        session_key: session.session_key,
        owner_node_id: session.owner_node_id,
        backend: session.backend,
        backend_ref,
        generation: session.generation.max(0) as u64,
        exit_code: session.exit_code,
        kind: session.kind,
        status: session.status,
        attach_state: session.attach_state,
        termination_intent: intent.unwrap_or_else(|| "none".into()),
        created_at_unix_ms: milliseconds(&session.created_at),
        ended_at_unix_ms: session.ended_at.as_deref().map(milliseconds),
        last_output_at_unix_ms: session.last_output_at.as_deref().map(milliseconds),
    })
}

/* ---------------------------------------------------------------- starting */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    session_id: String,
    workspace_id: String,
    #[serde(default)]
    session_key: String,
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    kind: String,
    cwd: String,
    #[serde(default)]
    shell: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    ssh_host_id: String,
    #[serde(default)]
    agent: Option<StartAgent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgent {
    id: String,
    #[serde(default)]
    permission_mode: Option<String>,
}

/// `POST /automation/session-start` — run the launch the Host froze.
///
/// The launch arrives whole because the Host owns it now; this Runtime does not
/// re-derive it from settings. The one thing that is still resolved here is the
/// SSH argv, and deliberately: it is built from the stored host on this machine,
/// never from anything that travelled, so a request can never dictate a command
/// line.
pub async fn start_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StartRequest>,
) -> AppResult<Json<SessionState>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    if request.session_id.is_empty() {
        return Err(AppError::BadRequest("A session id is required".into()));
    }
    // An existing session with this identifier is already running; the Host
    // asked to start one, and starting a second process for the same record is
    // exactly what the whole domain exists to prevent.
    if let Ok(existing) = db::get_terminal_session(&state.pool, &request.session_id).await
        && existing.status == "running"
    {
        return Ok(Json(describe(&state, &request.session_id).await?));
    }
    let workspace = db::get_workspace(&state.pool, &request.workspace_id).await?;
    let cwd = resolve_in_root(&workspace.root_path, &request.cwd)?;

    let mut env = Vec::new();
    if let Some(agent) = request.agent.as_ref() {
        if !db::valid_agent_id(&agent.id) {
            return Err(AppError::BadRequest("Unknown agent id".into()));
        }
        if let Some(mode) = agent.permission_mode.as_deref()
            && !db::PERMISSION_MODES.contains(&mode)
        {
            return Err(AppError::BadRequest("Unknown permission mode".into()));
        }
        if request.node_id.is_empty() {
            // Without a node there is nothing to attribute hook reports to.
            return Err(AppError::BadRequest(
                "An agent session requires the owning node".into(),
            ));
        }
        if let Err(error) = state.hooks.issue_node_token(&request.node_id) {
            tracing::warn!(%error, node = %request.node_id, "hook reports for this node will be unverified");
        }
        env = crate::api::agent_session_environment(&state, &request.node_id, &agent.id);
    }

    let (command, args) = if request.ssh_host_id.is_empty() {
        let command = (!request.command.is_empty()).then(|| request.command.clone());
        (command, request.args.clone())
    } else {
        let host = state
            .settings
            .ssh_host(&request.ssh_host_id)
            .ok_or_else(|| AppError::BadRequest("Unknown SSH host".into()))?;
        let mut argv = crate::terminal::ssh::ssh_argv(&host);
        let program = argv.remove(0);
        (Some(program), argv)
    };

    let session = state
        .terminals
        .spawn_as(
            &request.session_id,
            &request.session_key,
            SpawnRequest {
                workspace_id: request.workspace_id.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                shell: (!request.shell.is_empty()).then(|| request.shell.clone()),
                command,
                args,
                kind: if request.kind.is_empty() {
                    "terminal".into()
                } else {
                    request.kind.clone()
                },
                owner_node_id: (!request.node_id.is_empty()).then(|| request.node_id.clone()),
                agent_id: request.agent.as_ref().map(|agent| agent.id.clone()),
                env,
            },
        )
        .await?;
    Ok(Json(describe(&state, &session.id).await?))
}

/* --------------------------------------------------------------- signalling */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalRequest {
    session_id: String,
    #[serde(default)]
    generation: u64,
    mode: String,
}

/// `POST /automation/session-signal` — interrupt, end, destroy or recycle.
///
/// The generation check is the reason this route exists rather than the Host
/// simply calling the REST surface: only this side knows which pane is current,
/// and "stop what I am looking at" must never become "stop whatever is there
/// now". A stale generation is a conflict the caller resolves by reloading.
pub async fn signal_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SignalRequest>,
) -> AppResult<Json<SessionState>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    let session = db::get_terminal_session(&state.pool, &request.session_id).await?;
    if request.generation != 0 && request.generation != session.generation.max(0) as u64 {
        return Err(AppError::Conflict(
            "That generation has been replaced".into(),
        ));
    }
    match request.mode.as_str() {
        "recycle" => {
            state.terminals.recycle(&request.session_id).await?;
        }
        "interrupt" | "process" | "session" => {
            let mode = match request.mode.as_str() {
                "interrupt" => TerminateMode::Interrupt,
                "session" => TerminateMode::Session,
                _ => TerminateMode::Process,
            };
            match state.terminals.terminate(&request.session_id, mode).await {
                Ok(()) => {}
                // A session that already finished is not an error for the
                // caller: it asked for the process to stop, and it has.
                Err(AppError::NotFound(_)) if session.status != "running" => {}
                Err(error) => return Err(error),
            }
        }
        _ => return Err(AppError::BadRequest("Unknown session signal".into())),
    }
    Ok(Json(describe(&state, &request.session_id).await?))
}

/* ---------------------------------------------------------------- reclaim */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimRequest {
    #[serde(default)]
    session_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimResponse {
    worker_instance_id: String,
    sessions: Vec<SessionState>,
}

/// `POST /automation/session-reclaim` — what this machine actually holds.
///
/// A session is listed when this Runtime still has a live process for it. One
/// the caller named and this list omits is *not* reported as ended here: this
/// side only says what it can see, and whether an absence means EXITED or LOST
/// depends on whether anybody was in a position to watch — which is the Host's
/// question, not this one's.
pub async fn reclaim_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ReclaimRequest>,
) -> AppResult<Json<ReclaimResponse>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    let mut sessions = Vec::new();
    for session_id in &request.session_ids {
        if !state.terminals.is_alive(session_id).await {
            continue;
        }
        if let Ok(described) = describe(&state, session_id).await {
            sessions.push(described);
        }
    }
    Ok(Json(ReclaimResponse {
        // This Runtime's own incarnation. A new one is why a reclaim cannot
        // assume a run it remembers is still the same run.
        worker_instance_id: instance_id().to_owned(),
        sessions,
    }))
}

/* ------------------------------------------------- capture, title and usage */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    session_id: String,
    #[serde(default)]
    lines: u32,
    #[serde(default)]
    escapes: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    data: String,
}

pub async fn capture_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CaptureRequest>,
) -> AppResult<Json<CaptureResponse>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    db::get_terminal_session(&state.pool, &request.session_id).await?;
    let lines = if request.lines == 0 {
        200
    } else {
        request.lines.min(10_000)
    };
    let capture = state
        .terminals
        .capture(&request.session_id, lines, request.escapes)
        .await?;
    Ok(Json(CaptureResponse { data: capture.data }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    session_id: String,
    #[serde(default)]
    refresh: bool,
}

/// `POST /automation/session-title` — the suggestion, from the transcript or
/// the live pane. Both are on this machine, which is the whole reason the Host
/// forwards rather than computing one.
pub async fn title_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SessionRef>,
) -> AppResult<Json<serde_json::Value>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    let session = db::get_terminal_session(&state.pool, &request.session_id).await?;
    let _ = request.refresh;
    // The transcript is the better source, because it is what the agent
    // actually said rather than what its shell happened to echo.
    if let Some(node) = session.owner_node_id.clone()
        && let Ok(Json(suggested)) =
            crate::api::suggest_agent_title(State(state.clone()), axum::extract::Path(node)).await
        && !suggested.title.is_empty()
    {
        return Ok(Json(serde_json::json!({
            "title": suggested.title, "source": suggested.source,
        })));
    }
    // Otherwise the pane itself, and an empty answer when even that says
    // nothing — an invented title is worse than none.
    let title = state
        .terminals
        .capture(&request.session_id, 40, false)
        .await
        .ok()
        .and_then(|capture| crate::index::command_from_capture(&capture.data));
    Ok(Json(match title {
        Some(title) => serde_json::json!({ "title": title, "source": "terminal" }),
        None => serde_json::json!({ "title": "", "source": "" }),
    }))
}

/// `POST /automation/session-context-usage` — the Worker's own cache.
pub async fn context_usage_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SessionRef>,
) -> AppResult<Json<serde_json::Value>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    let session = db::get_terminal_session(&state.pool, &request.session_id).await?;
    let Some(node) = session.owner_node_id.clone() else {
        // A session with no node has no agent, so there is no context to
        // account for. Answering with an empty object says that; answering with
        // zeros would say the agent had used nothing.
        return Ok(Json(serde_json::json!({})));
    };
    // The query names the run, not a refresh flag: a usage snapshot belongs to
    // one generation of one session, and asking about a node without saying
    // which run would answer about whichever pane happens to be current.
    let _ = request.refresh;
    let snapshot = crate::context_usage::get_snapshot(
        &state,
        &session.workspace_id,
        &node,
        &crate::context_usage::ContextQuery {
            session_id: session.id.clone(),
            generation: session.generation.max(0) as u64,
            model_id: None,
        },
    )
    .await?;
    Ok(Json(serde_json::to_value(snapshot).map_err(|_| {
        AppError::Internal("The context usage snapshot is not encodable".into())
    })?))
}

/* -------------------------------------------------------------- approvals */

/// What the Host asks this process to tell a blocked CLI.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAnswer {
    approval_id: String,
    decision: String,
    /// The principal the Host recorded. It travels for the diagnostic and is
    /// not re-recorded here: the Host's row is the audit entry, and a second
    /// copy written by this side could disagree with it.
    #[serde(default)]
    answered_by: String,
}

/// `POST /automation/agent-approval` — put an answer in front of a CLI that
/// stopped (Go Host 业务所有权迁移 §2.7).
///
/// The Host has already recorded the decision, under CAS, before this arrives.
/// What is left is the half only this process can do: write the pending file
/// the CLI is blocked on reading, or type into its pane. The answer says which
/// of the two happened, because "the file was written" and "nobody could be
/// told" are the difference between an agent that continues and one that does
/// not — and the Host draws them differently.
///
/// A second answer is refused by `collab::approvals::answer` itself, which is
/// where that rule belongs: this route is a door, not a second decision.
pub async fn approval_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ApprovalAnswer>,
) -> AppResult<Json<serde_json::Value>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    let _ = &request.answered_by;
    let (approval, route) =
        crate::collab::approvals::answer(&state, &request.approval_id, &request.decision).await?;
    Ok(Json(serde_json::json!({
        "approvalId": approval.id,
        "route": route,
    })))
}
