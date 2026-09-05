//! Scheduled prompt delivery into an Agent terminal — automation design §4/§5.
//!
//! The Host owns the schedule and the Rust command Worker owns non-interactive
//! processes, but neither owns a PTY. This module is the Runtime's side of that
//! gap: a private, same-user surface mounted on the hook router, reachable only
//! with the app bearer that lives in `hook-endpoint.env`. It is never exposed to
//! a browser, and it carries no CORS.
//!
//! Three properties are the whole point:
//!
//!   * **One prompt is written at most once.** Every delivery is journalled
//!     under its operation id *before* the frame reaches the terminal, so a
//!     repeat of the same operation is answered from the journal instead of
//!     pasting again. A row that never got its outcome written reads back as
//!     unknown — the one state that is never retried.
//!   * **Delivery is not completion.** `submitted` means bytes reached the
//!     input buffer. A turn only becomes `completed` when the session reports
//!     an idle turn whose input revision is still the one our own paste
//!     produced; if anybody typed in between, the delivery is unattributable
//!     rather than successful.
//!   * **Nothing here starts a process during a write.** A cold start happens
//!     in the target probe, where the run is claimed and its authorization has
//!     just been re-checked, and it reports the target as busy until the Agent
//!     has actually booted.

#[cfg(test)]
#[path = "automation_tests.rs"]
mod tests;

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::{Json, extract::State, http::HeaderMap};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AppState, collab, db,
    error::{AppError, AppResult},
    terminal::{GuardedPasteOutcome, PromptTurn, SpawnRequest},
};

/// A prompt larger than this is refused rather than truncated: half an
/// instruction is worse than none.
const MAX_PROMPT_BYTES: usize = 32_768;
/// How long a node is left alone after a cold start before another one may be
/// attempted. A shell that dies on start must not become a spawn loop.
const COLD_START_COOLDOWN: Duration = Duration::from_secs(60);

/* --------------------------------- wire ---------------------------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    pub agent_id: String,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub permission_mode: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub account_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetRequest {
    /// Optional on a probe: the node's own workspace is the authority, and the
    /// Host holds only the target at that point. When present it must match.
    #[serde(default)]
    pub workspace_id: String,
    pub node_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub generation: u64,
    pub expected: LaunchSpec,
    /// Present only when the plan authorized launching a frozen definition.
    #[serde(default)]
    pub cold_start: Option<LaunchSpec>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    /// `ready` / `busy` / `absent` / `unsupported`.
    pub state: &'static str,
    pub session_id: String,
    pub generation: u64,
    pub reason_code: String,
}

impl TargetStatus {
    fn new(state: &'static str, reason: &str) -> Self {
        Self {
            state,
            session_id: String::new(),
            generation: 0,
            reason_code: reason.to_owned(),
        }
    }
    fn on(state: &'static str, reason: &str, session: &str, generation: u64) -> Self {
        Self {
            state,
            session_id: session.to_owned(),
            generation,
            reason_code: reason.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptRequest {
    pub operation_id: String,
    /// Hex digest the caller correlates its own run with. Stored so a replay
    /// carrying a different request can never reuse this operation's receipt.
    pub request_digest: String,
    pub workspace_id: String,
    pub node_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub generation: u64,
    pub prompt: String,
    pub expected: LaunchSpec,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LookupRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub operation_id: String,
    pub request_digest: String,
    /// `notWritten` / `submitted` / `completed` / `abandoned` / `unknown`.
    pub phase: String,
    pub sequence: u64,
    /// Stable per phase: the caller compares receipts byte for byte, so this
    /// is the recorded observation time and never "now".
    pub observed_at_unix_ms: i64,
    pub reason_code: String,
    pub session_id: String,
    pub generation: u64,
    pub cold_started: bool,
    pub no_effect_proven: bool,
}

/* ------------------------------- journal --------------------------------- */

#[derive(Debug, Clone)]
struct Delivery {
    operation_id: String,
    request_digest: String,
    node_id: String,
    session_id: String,
    generation: u64,
    phase: String,
    sequence: u64,
    reason_code: String,
    cold_started: bool,
    input_revision: Option<u64>,
    updated_at: String,
}

fn millis(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|value| value.timestamp_millis())
        .unwrap_or(0)
}

impl Delivery {
    fn receipt(&self) -> Receipt {
        // A row still recorded as `writing` is the crash window: the frame may
        // or may not have reached the terminal, so it reports unknown and is
        // never resent. `no_effect_proven` belongs to `notWritten` alone.
        let phase = if self.phase == "writing" {
            "unknown"
        } else {
            self.phase.as_str()
        };
        Receipt {
            operation_id: self.operation_id.clone(),
            request_digest: self.request_digest.clone(),
            phase: phase.to_owned(),
            sequence: self.sequence,
            observed_at_unix_ms: millis(&self.updated_at),
            reason_code: if self.phase == "writing" {
                "WRITE_INTERRUPTED".into()
            } else {
                self.reason_code.clone()
            },
            session_id: self.session_id.clone(),
            generation: self.generation,
            cold_started: self.cold_started,
            no_effect_proven: phase == "notWritten",
        }
    }
}

fn decode(row: &sqlx::sqlite::SqliteRow) -> AppResult<Delivery> {
    use sqlx::Row;
    let generation: i64 = row.try_get("generation")?;
    let revision: Option<i64> = row.try_get("input_revision")?;
    let sequence: i64 = row.try_get("sequence")?;
    Ok(Delivery {
        operation_id: row.try_get("operation_id")?,
        request_digest: row.try_get("request_digest")?,
        node_id: row.try_get("node_id")?,
        session_id: row.try_get("session_id")?,
        generation: generation.max(0) as u64,
        phase: row.try_get("phase")?,
        sequence: sequence.max(1) as u64,
        reason_code: row.try_get("reason_code")?,
        cold_started: row.try_get::<i64, _>("cold_started")? != 0,
        input_revision: revision.map(|value| value.max(0) as u64),
        updated_at: row.try_get("updated_at")?,
    })
}

async fn load(state: &AppState, operation_id: &str) -> AppResult<Option<Delivery>> {
    let row = sqlx::query("SELECT * FROM agent_prompt_deliveries WHERE operation_id=?")
        .bind(operation_id)
        .fetch_optional(&state.pool)
        .await?;
    row.as_ref().map(decode).transpose()
}

/// Moves a delivery to its next phase. The identity columns are frozen by a
/// database trigger, so only the outcome can ever change here.
async fn settle(
    state: &AppState,
    delivery: &Delivery,
    phase: &str,
    reason: &str,
    sequence: u64,
) -> AppResult<Delivery> {
    let at = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE agent_prompt_deliveries SET phase=?,reason_code=?,sequence=?,updated_at=? \
         WHERE operation_id=? AND sequence<=?",
    )
    .bind(phase)
    .bind(reason)
    .bind(sequence as i64)
    .bind(&at)
    .bind(&delivery.operation_id)
    .bind(sequence as i64)
    .execute(&state.pool)
    .await?;
    load(state, &delivery.operation_id)
        .await?
        .ok_or_else(|| AppError::Internal("Prompt delivery record disappeared".into()))
}

/* ------------------------------- identity -------------------------------- */

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200
}

/// The workspace must still permit execution. A permission that was narrowed
/// after a plan was activated stops the delivery here, not at the terminal.
async fn workspace(state: &AppState, workspace_id: &str) -> AppResult<crate::model::Workspace> {
    let workspace = db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.read || !workspace.permissions.write || !workspace.permissions.execute
    {
        return Err(AppError::Forbidden(
            "Workspace read, write and execute permissions are required for scheduled delivery"
                .into(),
        ));
    }
    Ok(workspace)
}

/// Why this node cannot be a scheduled prompt target, if it cannot. A `Some`
/// here is always an unsupported condition: waiting will not repair it.
async fn refusal(
    state: &AppState,
    node: &collab::NodeRef,
    expected: &LaunchSpec,
) -> Option<String> {
    if node.node_type != "terminal" {
        return Some("NOT_A_TERMINAL_NODE".into());
    }
    let Some(agent) = node.agent_id.as_deref() else {
        return Some("NOT_AN_AGENT_NODE".into());
    };
    if agent != expected.agent_id {
        return Some("AGENT_IDENTITY_CHANGED".into());
    }
    if !expected.account_id.is_empty() && expected.account_id != "default" {
        return Some("ACCOUNT_UNSUPPORTED".into());
    }
    if node.data.get("ssh").is_some_and(|value| !value.is_null()) {
        return Some("REMOTE_EXECUTION_HOST".into());
    }
    // Idleness is read from the hook stream. Without hooks there is no evidence
    // a turn ever finished, so there is no honest moment to write.
    if !crate::context_usage::has_capability(&state.settings, agent, "hooks") {
        return Some("IDLE_HOOK_UNAVAILABLE".into());
    }
    None
}

async fn node_for(state: &AppState, workspace_id: &str, node_id: &str) -> Option<collab::NodeRef> {
    collab::load_node(&state.pool, node_id)
        .await
        .ok()
        .flatten()
        .filter(|node| node.workspace_id == workspace_id)
}

/* ------------------------------ cold start -------------------------------- */

fn cooldown() -> &'static Mutex<HashMap<String, Instant>> {
    static GATE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Sessions this Runtime started on a plan's behalf, so a run history can say
/// why a new process exists. In memory only: after a restart the honest answer
/// is that we no longer know, and the receipt says so by omission.
fn cold_started() -> &'static Mutex<std::collections::HashSet<String>> {
    static SET: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn claim_cold_start(node_id: &str) -> bool {
    let Ok(mut gate) = cooldown().lock() else {
        return false;
    };
    let now = Instant::now();
    gate.retain(|_, at| now.duration_since(*at) < COLD_START_COOLDOWN);
    if gate.contains_key(node_id) {
        return false;
    }
    gate.insert(node_id.to_owned(), now);
    true
}

/// The program a frozen definition runs. It is resolved here, from this
/// Runtime's own registry and settings — the stored plan only names an agent
/// id, so it can never turn into "run this binary".
fn resolve_program(state: &AppState, agent_id: &str) -> Option<String> {
    let command = match state.settings.custom_agent(agent_id) {
        Some(custom) => custom.launch_cmd,
        None => crate::agent::definition(agent_id)?.launch_cmd.to_owned(),
    };
    crate::agent::resolve_command(&command)
        .and_then(|path| path.to_str().map(str::to_owned))
        .or(Some(command).filter(|value| !value.is_empty()))
}

/// POSIX single-quoting, matching how the web app assembles the same line.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Starts the frozen definition on `node` and returns the new session. The
/// launch line is `program + frozen argv`, nothing else: the plan cannot add a
/// shell operator, because every argument is quoted before it is written.
async fn cold_start(
    state: &AppState,
    node: &collab::NodeRef,
    root_path: &str,
    spec: &LaunchSpec,
) -> Result<(String, u64), String> {
    if spec.agent_id != node.agent_id.as_deref().unwrap_or_default() {
        return Err("AGENT_IDENTITY_CHANGED".into());
    }
    let Some(program) = resolve_program(state, &spec.agent_id) else {
        return Err("LAUNCH_PROGRAM_UNRESOLVED".into());
    };
    if spec.args.len() > 64 || spec.args.iter().any(|arg| arg.len() > 4096) {
        return Err("LAUNCH_ARGUMENTS_REFUSED".into());
    }
    let requested = if spec.working_directory.is_empty() {
        ".".to_owned()
    } else {
        spec.working_directory.clone()
    };
    let Ok(cwd) = crate::security::resolve_in_root(root_path, &requested) else {
        return Err("WORKING_DIRECTORY_REFUSED".into());
    };
    if !claim_cold_start(&node.id) {
        return Err("COLD_START_COOLING_DOWN".into());
    }
    let env = crate::api::agent_session_environment(state, &node.id, &spec.agent_id);
    let session = state
        .terminals
        .spawn(SpawnRequest {
            workspace_id: node.workspace_id.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            shell: None,
            command: None,
            args: vec![],
            kind: "terminal".into(),
            owner_node_id: Some(node.id.clone()),
            agent_id: Some(spec.agent_id.clone()),
            env,
        })
        .await
        .map_err(|_| "COLD_START_SPAWN_FAILED".to_owned())?;
    let mut line = quote(&program);
    for arg in &spec.args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line.push('\r');
    if state
        .terminals
        .write(&session.id, session.generation.max(0) as u64, &line)
        .await
        .is_err()
    {
        return Err("COLD_START_LAUNCH_UNWRITTEN".into());
    }
    if let Ok(mut started) = cold_started().lock() {
        started.insert(session.id.clone());
    }
    // The canvas node has to learn which session it now owns, or the next page
    // that mounts it would start a second one. A conflict is reported, not
    // retried: the delivery itself is unaffected.
    let bound = bind_session(state, node, &session.id).await;
    if !bound {
        tracing::warn!(node = %node.id, "cold start could not record the session on its node");
    }
    Ok((session.id, session.generation.max(0) as u64))
}

async fn bind_session(state: &AppState, node: &collab::NodeRef, session_id: &str) -> bool {
    let Ok(mut document) = db::load_board(&state.pool, &node.workspace_id, &node.board_id).await
    else {
        return false;
    };
    let Some(target) = document
        .nodes
        .iter_mut()
        .find(|candidate| candidate.id == node.id)
    else {
        return false;
    };
    let Value::Object(data) = &mut target.data else {
        return false;
    };
    data.insert("sessionId".into(), Value::String(session_id.to_owned()));
    data.insert("lastExitCode".into(), Value::Null);
    let saved = db::save_board(
        &state.pool,
        &node.workspace_id,
        &node.board_id,
        db::SaveBoardRequest {
            expected_updated_at: &document.board.updated_at,
            nodes: &document.nodes,
            edges: &document.edges,
            viewport: document.board.viewport,
            whiteboard: None,
        },
    )
    .await;
    match saved {
        Ok(saved) => {
            state.events.publish(
                &node.workspace_id,
                crate::events::WorkspaceEvent::BoardChanged {
                    board_id: saved.board.id.clone(),
                    updated_at: saved.board.updated_at.clone(),
                },
            );
            true
        }
        Err(_) => false,
    }
}

/* -------------------------------- verbs ----------------------------------- */

/// Whether the node can be written to now, launching the frozen definition
/// first when the plan authorized one and no session is live.
pub async fn target(state: &AppState, request: TargetRequest) -> AppResult<TargetStatus> {
    if !valid_id(&request.node_id) || !valid_id(&request.expected.agent_id) {
        return Err(AppError::BadRequest("Invalid delivery target".into()));
    }
    let Some(node) = collab::load_node(&state.pool, &request.node_id)
        .await?
        .filter(|node| {
            request.workspace_id.is_empty() || node.workspace_id == request.workspace_id
        })
    else {
        return Ok(TargetStatus::new("unsupported", "NODE_MISSING"));
    };
    // Permissions come from the node's own workspace, which is the authority
    // over what may run there — never from whatever the caller named.
    let workspace = workspace(state, &node.workspace_id).await?;
    if let Some(reason) = refusal(state, &node, &request.expected).await {
        return Ok(TargetStatus::new("unsupported", &reason));
    }
    let live = state.terminals.current_node_session(&node.id).await;
    let Some((session_id, generation)) = live else {
        let Some(spec) = request.cold_start.as_ref() else {
            return Ok(TargetStatus::new("absent", "SESSION_ABSENT"));
        };
        return Ok(
            match cold_start(state, &node, &workspace.root_path, spec).await {
                // A freshly launched Agent has not finished booting, let alone a
                // turn. Reporting it busy keeps the write on the ready path only.
                Ok((session_id, generation)) => {
                    TargetStatus::on("busy", "COLD_START_LAUNCHED", &session_id, generation)
                }
                Err(reason) if reason == "COLD_START_COOLING_DOWN" => {
                    TargetStatus::new("busy", &reason)
                }
                Err(reason) => TargetStatus::new("unsupported", &reason),
            },
        );
    };
    if !state
        .terminals
        .handoff_idle(&node.id, &session_id, generation)
        .await
    {
        return Ok(TargetStatus::on(
            "busy",
            "TARGET_NOT_IDLE",
            &session_id,
            generation,
        ));
    }
    let expected =
        collab::expected_processes(&state.settings.base_agent(&request.expected.agent_id));
    let foreground = state.terminals.foreground(&session_id).await;
    if !foreground.is_ok_and(|info| collab::messaging::pane_runs_agent(&info, &expected)) {
        return Ok(TargetStatus::on(
            "busy",
            "TARGET_NOT_AGENT_PANE",
            &session_id,
            generation,
        ));
    }
    Ok(TargetStatus::on("ready", "", &session_id, generation))
}

/// Writes one framed prompt. Idempotent by operation id: a repeat is answered
/// from the journal, never pasted again.
pub async fn deliver(state: &AppState, request: PromptRequest) -> AppResult<Receipt> {
    if !valid_id(&request.operation_id)
        || !valid_id(&request.request_digest)
        || !valid_id(&request.workspace_id)
        || !valid_id(&request.node_id)
        || !valid_id(&request.expected.agent_id)
    {
        return Err(AppError::BadRequest("Invalid delivery request".into()));
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > MAX_PROMPT_BYTES {
        return Err(AppError::BadRequest(
            "Scheduled prompt is empty or too large".into(),
        ));
    }
    if let Some(existing) = load(state, &request.operation_id).await? {
        if existing.request_digest != request.request_digest {
            return Err(AppError::Conflict(
                "This operation id already delivered a different request".into(),
            ));
        }
        return advance(state, existing).await;
    }
    workspace(state, &request.workspace_id).await?;
    let Some(node) = node_for(state, &request.workspace_id, &request.node_id).await else {
        return record_refusal(state, &request, "", 0, "NODE_MISSING").await;
    };
    if let Some(reason) = refusal(state, &node, &request.expected).await {
        return record_refusal(state, &request, "", 0, &reason).await;
    }
    let Some((session_id, generation)) = state.terminals.current_node_session(&node.id).await
    else {
        // A delivery never starts a process. That is the target probe's job.
        return record_refusal(state, &request, "", 0, "SESSION_ABSENT").await;
    };
    let cold = cold_started()
        .lock()
        .map(|started| started.contains(&session_id))
        .unwrap_or(false);
    // Written before the frame reaches the terminal. If this process dies now,
    // the row reads back as unknown rather than as a delivery that never was.
    let at = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_prompt_deliveries(operation_id,request_digest,workspace_id,node_id,\
         session_id,generation,phase,sequence,reason_code,cold_started,prompt_chars,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,'writing',1,'',?,?,?,?)",
    )
    .bind(&request.operation_id)
    .bind(&request.request_digest)
    .bind(&request.workspace_id)
    .bind(&node.id)
    .bind(&session_id)
    .bind(generation as i64)
    .bind(i64::from(cold))
    .bind(request.prompt.chars().count() as i64)
    .bind(&at)
    .bind(&at)
    .execute(&state.pool)
    .await?;
    let mut claimed = load(state, &request.operation_id)
        .await?
        .ok_or_else(|| AppError::Internal("Prompt delivery record disappeared".into()))?;
    let expected =
        collab::expected_processes(&state.settings.base_agent(&request.expected.agent_id));
    let (outcome, revision) = state
        .terminals
        .guarded_paste(
            &node.id,
            &session_id,
            generation,
            &expected,
            &request.prompt,
        )
        .await;
    match outcome {
        GuardedPasteOutcome::Submitted => {
            sqlx::query("UPDATE agent_prompt_deliveries SET input_revision=? WHERE operation_id=?")
                .bind(revision.map(|value| value as i64))
                .bind(&request.operation_id)
                .execute(&state.pool)
                .await?;
            claimed.input_revision = revision;
            settle(state, &claimed, "submitted", "", 1)
                .await
                .map(|delivery| delivery.receipt())
        }
        GuardedPasteOutcome::NotWritten(reason) => {
            settle(state, &claimed, "notWritten", &code(reason), 1)
                .await
                .map(|delivery| delivery.receipt())
        }
        GuardedPasteOutcome::Unknown => settle(state, &claimed, "unknown", "WRITE_UNCERTAIN", 1)
            .await
            .map(|delivery| delivery.receipt()),
    }
}

/// Reads a delivery back, advancing a submitted one to whatever the terminal
/// can now prove about its turn.
pub async fn lookup(state: &AppState, operation_id: &str) -> AppResult<Receipt> {
    let delivery = load(state, operation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("No such prompt delivery".into()))?;
    advance(state, delivery).await
}

async fn advance(state: &AppState, delivery: Delivery) -> AppResult<Receipt> {
    if delivery.phase != "submitted" {
        return Ok(delivery.receipt());
    }
    let Some(revision) = delivery.input_revision else {
        // Submitted without a revision to compare against: nothing later can be
        // attributed to it, and nothing may be resent.
        return settle(state, &delivery, "unknown", "UNATTRIBUTED", 2)
            .await
            .map(|delivery| delivery.receipt());
    };
    let turn = state
        .terminals
        .prompt_turn_settled(
            &delivery.node_id,
            &delivery.session_id,
            delivery.generation,
            revision,
        )
        .await;
    match turn {
        PromptTurn::Pending => Ok(delivery.receipt()),
        PromptTurn::Completed => settle(state, &delivery, "completed", "TURN_COMPLETED", 2)
            .await
            .map(|delivery| delivery.receipt()),
        PromptTurn::SessionGone => settle(state, &delivery, "abandoned", "SESSION_ENDED", 2)
            .await
            .map(|delivery| delivery.receipt()),
        PromptTurn::Unattributable => settle(state, &delivery, "unknown", "UNATTRIBUTED", 2)
            .await
            .map(|delivery| delivery.receipt()),
    }
}

async fn record_refusal(
    state: &AppState,
    request: &PromptRequest,
    session_id: &str,
    generation: u64,
    reason: &str,
) -> AppResult<Receipt> {
    let at = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_prompt_deliveries(operation_id,request_digest,workspace_id,node_id,\
         session_id,generation,phase,sequence,reason_code,cold_started,prompt_chars,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,'notWritten',1,?,0,?,?,?)",
    )
    .bind(&request.operation_id)
    .bind(&request.request_digest)
    .bind(&request.workspace_id)
    .bind(&request.node_id)
    .bind(session_id)
    .bind(generation as i64)
    .bind(reason)
    .bind(request.prompt.chars().count() as i64)
    .bind(&at)
    .bind(&at)
    .execute(&state.pool)
    .await?;
    load(state, &request.operation_id)
        .await?
        .map(|delivery| delivery.receipt())
        .ok_or_else(|| AppError::Internal("Prompt delivery record disappeared".into()))
}

/// The gate's own refusal words as stable machine tokens. The caller records
/// them verbatim in a run history, so they never become prose.
fn code(reason: &str) -> String {
    match reason {
        "runtimeStopping" => "RUNTIME_STOPPING",
        "targetUnavailable" => "SESSION_ABSENT",
        "targetBusy" => "TARGET_NOT_IDLE",
        "targetChanged" => "SESSION_REPLACED",
        "targetNotAgentPane" => "TARGET_NOT_AGENT_PANE",
        _ => "TARGET_REFUSED",
    }
    .to_owned()
}

/* -------------------------------- routes ---------------------------------- */

pub async fn target_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TargetRequest>,
) -> AppResult<Json<TargetStatus>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    target(&state, request).await.map(Json)
}

pub async fn deliver_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PromptRequest>,
) -> AppResult<Json<Receipt>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    deliver(&state, request).await.map(Json)
}

pub async fn lookup_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<LookupRequest>,
) -> AppResult<Json<Receipt>> {
    crate::hook::ingest::require_bearer(&state, &headers)?;
    lookup(&state, &request.operation_id).await.map(Json)
}
