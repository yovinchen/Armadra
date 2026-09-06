//! The session domain on the private Worker channel
//! (Go Host 业务所有权迁移 §2.6, §2.9, `WorkerRequest.action` 27).
//!
//! Two kinds of question arrive here and they are answered from two different
//! places, which is the whole shape of this module.
//!
//! **The read** — what does this Runtime's own `terminal_sessions` table say? —
//! is answered from the database this Worker opened. It is asked while
//! verifying a switch and again while handing the domain back, and it is only
//! worth asking because the answer comes from the rows rather than from the
//! request that stored them. A Worker that echoed the request would make every
//! handback pass.
//!
//! **The execution** — start this run, signal that one, tell me what you
//! actually hold — cannot be answered here at all. This Worker is not the
//! process that owns the PTYs; the resident Runtime is, and a file descriptor
//! does not travel between them. So those go over exactly the door the hook
//! client already uses: the Runtime's private `hook-endpoint.env` in the same
//! data directory, its socket and its app bearer. Nothing new is listened on,
//! no new credential is minted, and the Host never learns the Runtime's address
//! or token.
//!
//! Nothing here decides anything. A generation, an exit code and a backend
//! reference come back exactly as the Runtime reported them, because the side
//! that created the pane is the only side that knows them.

use std::{path::PathBuf, time::Duration};

use armadra_hook::{
    endpoint::Endpoint,
    http::{Request, send_with_timeout},
};
use armadra_protocol::v1::{
    CaptureSessionRunRequest, CapturedSessionRun, GetSessionContextUsageRequest,
    GetSessionContextUsageResponse, ReclaimSessionRunsRequest, SessionAttachState, SessionKind,
    SessionLaunch, SessionStatus, SessionWorkerRequest, SessionWorkerResponse,
    SignalSessionRunRequest, StartSessionRunRequest, SuggestSessionTitleRequest,
    SuggestSessionTitleResponse, TerminationIntent, WorkerSessionState, WorkerSessionStates,
    WorkerSessionUpcall, WorkerSessionUpcallKind, session_worker_request, session_worker_response,
    worker_upcall,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{
    error::{AppError, AppResult},
    ownership,
};

/// Advertised when this Worker actually opened the Runtime's database, so a
/// controller never plans a handback verification this process would have to
/// refuse.
pub const CAPABILITY: &str = "session.worker.v1";

/// Starting a program, or asking tmux what panes exist, can mean shelling out.
/// The hook's own 1.5s budget is for the hot path of every CLI event; a session
/// command is allowed to wait.
const BUDGET: Duration = Duration::from_secs(12);

/// The schema version of the opaque context-usage snapshot. Bumping it is how a
/// later batch changes the body without a Host having to guess which one it is
/// looking at.
const USAGE_SCHEMA: u32 = 1;

/// The bridge to the resident Runtime — the process that owns the PTYs.
///
/// It re-reads that Runtime's endpoint file on every call, because the Runtime
/// may restart on a different address underneath this Worker. It is also a
/// consumer of the upward channel: a run that started or ended is something the
/// Host wants to know without polling.
pub struct Bridge {
    data_dir: PathBuf,
    upcalls: Option<super::channel::Upcaller>,
}

impl Bridge {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            upcalls: None,
        }
    }

    pub fn with_upcalls(mut self, upcalls: Option<super::channel::Upcaller>) -> Self {
        self.upcalls = upcalls;
        self
    }

    fn endpoint(&self) -> AppResult<Endpoint> {
        Endpoint::load(&self.data_dir.join("hook-endpoint.env")).map_err(|_| {
            // No path, no token, no OS error reaches the Host: it only needs to
            // know that this Worker cannot reach a Runtime right now, which is
            // a state a client draws as "the machine is not reachable" rather
            // than as a failed session.
            AppError::Conflict("No local Runtime endpoint is available".into())
        })
    }

    async fn call(&self, path: &'static str, body: Value) -> AppResult<Value> {
        let endpoint = self.endpoint()?;
        let token = endpoint.hook_token.clone().unwrap_or_default();
        let payload = serde_json::to_vec(&body)
            .map_err(|_| AppError::Internal("Could not encode a session request".into()))?;
        let response = tokio::task::spawn_blocking(move || {
            let request = Request::post_json(
                path,
                vec![("X-Armadra-Hook-Token".to_string(), token)],
                payload,
            );
            send_with_timeout(&endpoint, &request, BUDGET)
        })
        .await
        .map_err(|_| AppError::Internal("Session bridge task failed".into()))?
        .map_err(|_| AppError::Conflict("The local Runtime did not answer".into()))?;
        if !response.is_success() {
            // Status and route only, on stderr, where the Host keeps it as an
            // opaque diagnostic. The Runtime's own prose stays with the
            // Runtime, and no body ever reaches the Host.
            tracing::warn!(
                status = response.status,
                path,
                "the Runtime refused a session request"
            );
            return Err(match response.status {
                400 => AppError::BadRequest("Runtime refused the session request".into()),
                403 => AppError::Forbidden("Runtime refused the session bearer".into()),
                404 => AppError::NotFound("Runtime has no such session".into()),
                // A stale generation arrives as a conflict, which is exactly
                // what it is: the caller decided against a pane that has been
                // replaced, and the answer is to reload rather than to retry.
                409 => AppError::Conflict("Runtime session generation changed".into()),
                _ => AppError::Internal("Runtime session request failed".into()),
            });
        }
        serde_json::from_str(&response.body)
            .map_err(|_| AppError::Internal("Runtime session answer was unreadable".into()))
    }

    /// Reports one already-observed run event upward.
    ///
    /// It is a *copy* of something that has already been answered, emitted
    /// after the fact, and a failure to queue one never changes what the Host
    /// was told about the run itself. A report that cannot be queued is a lost
    /// report, not a lost process.
    async fn report(&self, kind: WorkerSessionUpcallKind, state: &WorkerSessionState) {
        let Some(upcalls) = self.upcalls.as_ref() else {
            return;
        };
        let event = worker_upcall::Event::Session(WorkerSessionUpcall {
            session_id: state.session_id.clone(),
            workspace_id: state.workspace_id.clone(),
            session_key: state.session_key.clone(),
            generation: state.generation,
            worker_instance_id: state.worker_instance_id.clone(),
            backend_ref: state.backend_ref.clone(),
            exit_code: state.exit_code,
            attach_count: 0,
            attach_state: state.attach_state,
            kind: kind as i32,
            reason_code: state.reason_code.clone(),
            observed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
        });
        if let Err(error) = upcalls.send(event).await {
            tracing::warn!(%error, "a session upcall could not be queued");
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").into()
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// One session as the resident Runtime describes it.
///
/// An unrecognised status is UNSPECIFIED rather than RUNNING or EXITED: a
/// Runtime this Worker cannot understand must not be read either as permission
/// to attach or as evidence that something ended.
fn state(answer: &Value) -> WorkerSessionState {
    let status = match text(answer, "status").as_str() {
        "running" => SessionStatus::Running,
        "exited" | "terminated" | "failed" => SessionStatus::Exited,
        _ => SessionStatus::Unspecified,
    };
    let attach = match text(answer, "attachState").as_str() {
        "live" => SessionAttachState::Attached,
        "exited" => SessionAttachState::Exited,
        _ => SessionAttachState::Detached,
    };
    let kind = match text(answer, "kind").as_str() {
        "agent" => SessionKind::Agent,
        "command" => SessionKind::Command,
        _ => SessionKind::Terminal,
    };
    let intent = match text(answer, "terminationIntent").as_str() {
        "recycle" => TerminationIntent::Recycle,
        "process" | "session" | "interrupt" => TerminationIntent::User,
        _ => TerminationIntent::None,
    };
    WorkerSessionState {
        session_id: text(answer, "sessionId"),
        workspace_id: text(answer, "workspaceId"),
        session_key: text(answer, "sessionKey"),
        owner_node_id: text(answer, "ownerNodeId"),
        backend_kind: text(answer, "backend"),
        backend_ref: text(answer, "backendRef"),
        generation: number(answer, "generation"),
        exit_code: answer
            .get("exitCode")
            .and_then(Value::as_i64)
            .map(|value| value as i32),
        worker_instance_id: text(answer, "workerInstanceId"),
        kind: kind as i32,
        status: status as i32,
        attach_state: attach as i32,
        termination_intent: intent as i32,
        launch: None,
        reason_code: text(answer, "reasonCode"),
        created_at_unix_ms: answer
            .get("createdAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        ended_at_unix_ms: answer
            .get("endedAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        last_output_at_unix_ms: answer
            .get("lastOutputAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    }
}

/// The frozen launch as the resident Runtime is asked to run it. Only names
/// travel for the environment: a value here would be a credential this Worker's
/// database had briefly held.
fn launch_body(launch: &SessionLaunch) -> Value {
    let mut body = json!({
        "cwd": launch.working_directory,
        "shell": launch.shell,
        "command": launch.command,
        "args": launch.args,
        "sshHostId": launch.ssh_target_id,
        "envRefs": launch.env_refs,
    });
    if let Some(agent) = launch.agent.as_ref() {
        body["agent"] = json!({
            "id": agent.agent_id,
            "permissionMode": agent.permission_mode,
            "modelId": agent.model_id,
            "accountId": agent.account_id,
        });
    }
    body
}

/// Answers one frame. `pool` is this Worker's own reading of the database and
/// `bridge` is the door to the process that owns the PTYs; a Worker with
/// neither refuses rather than answering emptily.
pub async fn handle(
    pool: Option<&SqlitePool>,
    bridge: Option<&Bridge>,
    request: SessionWorkerRequest,
) -> AppResult<SessionWorkerResponse> {
    use session_worker_request::Action;
    use session_worker_response::Result as Answer;
    let unsupported = || AppError::Conflict("No local Runtime is reachable for sessions".into());
    match request.action {
        // The read. It is answered from the rows, never from a live process:
        // this is the answer a switch and a handback are verified against, and
        // one assembled from anywhere else would make the comparison worthless.
        Some(Action::ListSessions(_)) => {
            let Some(pool) = pool else {
                return Err(AppError::Conflict(
                    "Write ownership is not configured".into(),
                ));
            };
            Ok(SessionWorkerResponse {
                result: Some(Answer::Sessions(WorkerSessionStates {
                    worker_instance_id: String::new(),
                    sessions: ownership::session::worker_states(pool).await?,
                })),
            })
        }
        Some(Action::StartRun(input)) => {
            let bridge = bridge.ok_or_else(unsupported)?;
            let started = start_run(bridge, &input).await?;
            bridge
                .report(WorkerSessionUpcallKind::RunStarted, &started)
                .await;
            Ok(SessionWorkerResponse {
                result: Some(Answer::Run(started)),
            })
        }
        Some(Action::SignalRun(input)) => {
            let bridge = bridge.ok_or_else(unsupported)?;
            let after = signal_run(bridge, &input).await?;
            // A recycle produced a pane; everything else ended one. The two are
            // different reports because a client draws them differently.
            let kind = if input.mode == "recycle" {
                WorkerSessionUpcallKind::RunStarted
            } else if after.status == SessionStatus::Exited as i32 {
                WorkerSessionUpcallKind::RunExited
            } else {
                WorkerSessionUpcallKind::AttachCountChanged
            };
            bridge.report(kind, &after).await;
            Ok(SessionWorkerResponse {
                result: Some(Answer::Run(after)),
            })
        }
        Some(Action::ReclaimRuns(input)) => {
            let bridge = bridge.ok_or_else(unsupported)?;
            Ok(SessionWorkerResponse {
                result: Some(Answer::Sessions(reclaim(bridge, &input).await?)),
            })
        }
        Some(Action::CaptureRun(input)) => {
            let bridge = bridge.ok_or_else(unsupported)?;
            Ok(SessionWorkerResponse {
                result: Some(Answer::Capture(capture(bridge, &input).await?)),
            })
        }
        Some(Action::SuggestTitle(input)) => {
            let bridge = bridge.ok_or_else(unsupported)?;
            Ok(SessionWorkerResponse {
                result: Some(Answer::Title(suggest_title(bridge, &input).await?)),
            })
        }
        Some(Action::ContextUsage(input)) => {
            let bridge = bridge.ok_or_else(unsupported)?;
            Ok(SessionWorkerResponse {
                result: Some(Answer::ContextUsage(context_usage(bridge, &input).await?)),
            })
        }
        // An action a newer Host introduced is refused rather than answered
        // with an empty result, which the Host would compare against its own
        // record and read as agreement.
        None => Err(AppError::BadRequest(
            "Session worker action is missing".into(),
        )),
    }
}

async fn start_run(
    bridge: &Bridge,
    input: &StartSessionRunRequest,
) -> AppResult<WorkerSessionState> {
    let launch = input.launch.clone().unwrap_or_default();
    let mut body = launch_body(&launch);
    body["sessionId"] = json!(input.session_id);
    body["workspaceId"] = json!(input.workspace_id);
    body["sessionKey"] = json!(input.session_key);
    body["nodeId"] = json!(input.owner_node_id);
    body["kind"] = json!(match SessionKind::try_from(input.kind) {
        Ok(SessionKind::Agent) => "agent",
        Ok(SessionKind::Command) => "command",
        _ => "terminal",
    });
    let answer = bridge.call("/automation/session-start", body).await?;
    let mut started = state(&answer);
    // The Host asked about this session; an answer about another one is a
    // Runtime this Worker cannot reconcile, not a run to record.
    if started.session_id != input.session_id {
        return Err(AppError::Internal(
            "The Runtime started a different session".into(),
        ));
    }
    if started.generation == 0 {
        return Err(AppError::Internal(
            "The Runtime reported a run with no generation".into(),
        ));
    }
    started.launch = Some(launch);
    Ok(started)
}

async fn signal_run(
    bridge: &Bridge,
    input: &SignalSessionRunRequest,
) -> AppResult<WorkerSessionState> {
    let answer = bridge
        .call(
            "/automation/session-signal",
            json!({
                "sessionId": input.session_id,
                "generation": input.generation,
                "mode": input.mode,
            }),
        )
        .await?;
    let after = state(&answer);
    if after.session_id != input.session_id {
        return Err(AppError::Internal(
            "The Runtime signalled a different session".into(),
        ));
    }
    Ok(after)
}

/// Asks the resident Runtime what it actually holds.
///
/// The answer is the truth about processes; this Worker only names the sessions
/// the Host asked about and passes the reply through. A session the Runtime does
/// not list is simply absent, and the Host — not this Worker — decides whether
/// that means EXITED or LOST, because only the Host knows whether anybody was
/// in a position to watch.
async fn reclaim(
    bridge: &Bridge,
    input: &ReclaimSessionRunsRequest,
) -> AppResult<WorkerSessionStates> {
    let answer = bridge
        .call(
            "/automation/session-reclaim",
            json!({ "sessionIds": input.session_ids }),
        )
        .await?;
    let mut states = WorkerSessionStates {
        worker_instance_id: text(&answer, "workerInstanceId"),
        sessions: Vec::new(),
    };
    let Some(listed) = answer.get("sessions").and_then(Value::as_array) else {
        return Err(AppError::Internal(
            "The Runtime reported no session listing".into(),
        ));
    };
    for entry in listed {
        let reported = state(entry);
        if reported.session_id.is_empty() {
            return Err(AppError::Internal(
                "The Runtime listed a session with no identifier".into(),
            ));
        }
        states.sessions.push(reported);
    }
    Ok(states)
}

async fn capture(
    bridge: &Bridge,
    input: &CaptureSessionRunRequest,
) -> AppResult<CapturedSessionRun> {
    let answer = bridge
        .call(
            "/automation/session-capture",
            json!({
                "sessionId": input.session_id,
                "lines": input.lines,
                "escapes": input.escapes,
            }),
        )
        .await?;
    Ok(CapturedSessionRun {
        session_id: input.session_id.clone(),
        data: text(&answer, "data"),
    })
}

async fn suggest_title(
    bridge: &Bridge,
    input: &SuggestSessionTitleRequest,
) -> AppResult<SuggestSessionTitleResponse> {
    let answer = bridge
        .call(
            "/automation/session-title",
            json!({ "sessionId": input.session_id }),
        )
        .await?;
    Ok(SuggestSessionTitleResponse {
        title: text(&answer, "title"),
        source: text(&answer, "source"),
    })
}

async fn context_usage(
    bridge: &Bridge,
    input: &GetSessionContextUsageRequest,
) -> AppResult<GetSessionContextUsageResponse> {
    let answer = bridge
        .call(
            "/automation/session-context-usage",
            json!({ "sessionId": input.session_id, "refresh": input.refresh }),
        )
        .await?;
    // The snapshot stays opaque with its own digest and schema version: the
    // context-usage shape belongs to the agent domain, which has not settled
    // one, and expanding it here would freeze it before that batch decides it.
    let usage = serde_json::to_vec(&answer)
        .map_err(|_| AppError::Internal("The context usage snapshot is not encodable".into()))?;
    Ok(GetSessionContextUsageResponse {
        usage_sha256: Sha256::digest(&usage).to_vec(),
        usage,
        schema_version: USAGE_SCHEMA,
        observed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    })
}
