//! The agent domain on the private Worker channel
//! (Go Host 业务所有权迁移 §2.7, §2.9, `WorkerRequest.action` 28).
//!
//! Three kinds of question arrive here and they are answered from three
//! different places, which is the whole shape of this module.
//!
//! **The read** — what do this Runtime's own agent tables say? — is answered
//! from the database this Worker opened. It is asked while verifying a switch
//! and again while handing the domain back, and it is only worth asking because
//! the answer comes from the rows rather than from the request that stored
//! them: a Worker that echoed the request would make every handback pass.
//!
//! **The drain** is answered from the same rows, and it is the departure from
//! §2.7 worth stating plainly. The design has the Worker *push* Hook turns
//! upward. The process a Hook actually reaches is the resident Runtime, and
//! that process binds no upward channel — only a Worker the Host itself started
//! does, and the Host does not start the resident Runtime. So the Host asks
//! instead, with a cursor, and this module answers from what the resident
//! Runtime has already written down. The Runtime keeps reducing Hook events
//! into `agent_status` whichever side owns the records, exactly as §1.3 assigns
//! it: 归一化与 reduce stay on the machine that saw the event.
//!
//! **The execution** — write this answer into the file a CLI is blocked on —
//! cannot be answered here at all. This Worker is not the process holding the
//! pending directory or the PTY; the resident Runtime is. So it goes over the
//! door the hook client already uses, exactly as the session domain's does.
//!
//! Nothing here decides anything. A state, an approval and a receipt come back
//! as the resident Runtime reported them.

use std::{path::PathBuf, time::Duration};

use armadra_hook::{
    endpoint::Endpoint,
    http::{Request, send_with_timeout},
};
use armadra_protocol::Message as _;
use armadra_protocol::v1::{
    AgentDeliveryReceipt, AgentStatus, AgentWorkerRequest, AgentWorkerResponse, Approval,
    CaptureAgentScreenRequest, CapturedAgentScreen, DeliverApprovalAnswerRequest, DeliveryOutcome,
    DrainAgentEventsRequest, DrainedAgentEvents, HookEvent, HookEventKind, HookInstallState,
    ReadTranscriptRequest, TranscriptExcerpt, WorkerAgentStates, agent_worker_request,
    agent_worker_response,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{
    error::{AppError, AppResult},
    hook::install,
    ownership,
};

/// Advertised when this Worker actually opened the Runtime's database, so a
/// controller never plans a handback verification this process would have to
/// refuse.
pub const CAPABILITY: &str = "agent.worker.v1";

/// Answering an approval is the one thing here a human is waiting on: a CLI has
/// stopped, and everything after this is somebody staring at a spinner. The
/// budget is generous compared with the hook's own 1.5s hot path and still well
/// inside the §6.2 claim that a CLI continues within a second and a half.
const BUDGET: Duration = Duration::from_secs(8);

/// The schema version of the normalized status a Hook event carries.
const STATUS_SCHEMA: u32 = 1;

/// How many records one drain answers with when the Host does not say. The Host
/// loops while `has_more` is set, so this bounds one frame rather than the
/// backlog.
const DEFAULT_BATCH: u32 = 256;
const MAX_BATCH: u32 = 1024;

/// The bridge to the resident Runtime — the process that holds the pending
/// directory and the panes.
///
/// It re-reads that Runtime's endpoint file on every call, because the Runtime
/// may restart on a different address underneath this Worker.
pub struct Bridge {
    data_dir: PathBuf,
}

impl Bridge {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn endpoint(&self) -> AppResult<Endpoint> {
        Endpoint::load(&self.data_dir.join("hook-endpoint.env")).map_err(|_| {
            // No path, no token, no OS error reaches the Host: it only needs to
            // know that this Worker cannot reach a Runtime right now.
            AppError::Conflict("No local Runtime endpoint is available".into())
        })
    }

    async fn call(&self, path: &'static str, body: Value) -> AppResult<Value> {
        let endpoint = self.endpoint()?;
        let token = endpoint.hook_token.clone().unwrap_or_default();
        let payload = serde_json::to_vec(&body)
            .map_err(|_| AppError::Internal("Could not encode an agent request".into()))?;
        let response = tokio::task::spawn_blocking(move || {
            let request = Request::post_json(
                path,
                vec![("X-Armadra-Hook-Token".to_string(), token)],
                payload,
            );
            send_with_timeout(&endpoint, &request, BUDGET)
        })
        .await
        .map_err(|_| AppError::Internal("Agent bridge task failed".into()))?
        .map_err(|_| AppError::Conflict("The local Runtime did not answer".into()))?;
        if !response.is_success() {
            // Status and route only, on stderr, where the Host keeps it as an
            // opaque diagnostic. The Runtime's own prose stays with the
            // Runtime, and no body ever reaches the Host.
            tracing::warn!(
                status = response.status,
                path,
                "the Runtime refused an agent request"
            );
            return Err(match response.status {
                400 => AppError::BadRequest("Runtime refused the agent request".into()),
                403 => AppError::Forbidden("Runtime refused the agent bearer".into()),
                404 => AppError::NotFound("Runtime has no such agent record".into()),
                409 => AppError::Conflict("Runtime refused a second answer".into()),
                _ => AppError::Internal("Runtime agent request failed".into()),
            });
        }
        serde_json::from_str(&response.body)
            .map_err(|_| AppError::Internal("Runtime agent answer was unreadable".into()))
    }

    /// Writes one answer into the file the CLI is blocked on.
    async fn deliver_approval(
        &self,
        request: &DeliverApprovalAnswerRequest,
    ) -> AppResult<AgentDeliveryReceipt> {
        let answer = self
            .call(
                "/automation/agent-approval",
                json!({
                    "approvalId": request.approval_id,
                    "decision": request.decision,
                    "answeredBy": request.answered_by,
                }),
            )
            .await?;
        // `route` is the Runtime's own word for how the CLI was told: a file it
        // read, keys typed into its pane, or nothing at all. Only the first two
        // are proof that something arrived.
        let route = answer
            .get("route")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let outcome = match route {
            "file" | "keys" => DeliveryOutcome::Submitted,
            "none" => DeliveryOutcome::NotWritten,
            _ => DeliveryOutcome::Unknown,
        };
        Ok(AgentDeliveryReceipt {
            trace_id: request.approval_id.clone(),
            receipt: route.to_string(),
            body_chars: request.decision.chars().count() as u32,
            outcome: outcome as i32,
            reason_code: if outcome == DeliveryOutcome::NotWritten {
                "agent.approval.no_route".into()
            } else {
                String::new()
            },
            observed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
        })
    }

    /// A screenful of the node's pane, from the process that holds the PTY.
    ///
    /// The agent frame does not grow its own capture: this is the session
    /// domain's `/automation/session-capture`, asked for by node rather than
    /// by session id. Two implementations of "what is on that screen" would be
    /// two answers to disagree about.
    async fn capture_screen(
        &self,
        request: &CaptureAgentScreenRequest,
    ) -> AppResult<CapturedAgentScreen> {
        let session_id = require(&request.session_id, "a session id")?;
        let answer = self
            .call(
                "/automation/session-capture",
                json!({
                    "sessionId": session_id,
                    "lines": request.lines,
                    // Escapes are for a terminal that will render them. What
                    // travels here is read by a person and by a model, so the
                    // pane goes up as plain text.
                    "escapes": false,
                }),
            )
            .await?;
        Ok(CapturedAgentScreen {
            node_id: request.node_id.clone(),
            data: answer
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }
}

/// The tail of a node's transcript, rendered as one prose line per message.
///
/// Which sessions have one is a fact about the CLI, not a policy:
///
///   * a provider that **reports its own transcript path** through the Hook
///     (Claude Code, and any custom agent wrapping one) is read at that path;
///   * **Codex** and **Gemini CLI** write structured session files under their
///     own home, found by session id;
///   * everything else is refused with the reason, because there is nothing to
///     read rather than nothing to say. OpenCode keeps its history in a private
///     store only its own CLI exports; Pi and Oh My Pi report a live context
///     window instead of a file; Copilot's `events.jsonl` is an internal event
///     log, not a conversation this renderer can turn into messages.
///
/// A refusal is the point. An empty excerpt would be indistinguishable from a
/// session that has said nothing yet, and the Host would draw a blank pane as
/// though it were the truth.
async fn transcript(
    pool: &SqlitePool,
    request: &ReadTranscriptRequest,
) -> AppResult<TranscriptExcerpt> {
    let node_id = require(&request.node_id, "a node id")?;
    let status = crate::db::get_agent_status(pool, node_id).await?;
    // The status row names the agent that has been reporting; a node that has
    // never reported still has the agent its session was created with.
    let provider = match status.as_ref() {
        Some(status) => status.agent_id.clone(),
        None => crate::db::find_node_owner(pool, node_id)
            .await?
            .and_then(|owner| owner.agent_id)
            .unwrap_or_default(),
    };
    // The Host's own copy of the reference wins: it is the one the record it is
    // reconciling was written from. The row is the fallback for a Host that
    // asked without one.
    let path = String::from_utf8(request.transcript_ref.clone())
        .ok()
        .filter(|path| !path.is_empty())
        .or_else(|| {
            status
                .as_ref()
                .and_then(|status| status.transcript_path.clone())
        });
    let session_id = Some(request.session_id.clone())
        .filter(|id| !id.is_empty())
        .or_else(|| status.as_ref().and_then(|status| status.session_id.clone()));
    let located =
        crate::collab::transcript::locate(&provider, path.as_deref(), session_id.as_deref())
            .ok_or_else(|| {
                AppError::Unsupported(format!(
                    "No transcript this execution host can read for {}",
                    if provider.is_empty() {
                        "this node"
                    } else {
                        provider.as_str()
                    }
                ))
            })?;
    let budget = match request.max_bytes {
        0 => crate::collab::transcript::MAX_TAIL_BYTES,
        bytes => u64::from(bytes).min(crate::collab::transcript::MAX_TAIL_BYTES),
    };
    let text = crate::collab::transcript::read_tail(&located.path, budget)
        .map_err(|_| AppError::NotFound("The transcript could not be read".into()))?;
    let lines = crate::collab::transcript::render(&text);
    if lines.is_empty() {
        return Err(AppError::Unsupported(format!(
            "The file {provider} reports is not a conversation this reader renders"
        )));
    }
    let rendered = lines.join("\n");
    let truncated = rendered.len() > crate::collab::transcript::MAX_RENDERED_BYTES;
    let content = if truncated {
        // On a character boundary, so the bytes that travel are still text.
        let mut end = crate::collab::transcript::MAX_RENDERED_BYTES;
        while end > 0 && !rendered.is_char_boundary(end) {
            end -= 1;
        }
        rendered[..end].to_string()
    } else {
        rendered
    };
    let content = content.into_bytes();
    Ok(TranscriptExcerpt {
        node_id: node_id.to_string(),
        content_sha256: Sha256::digest(&content).to_vec(),
        content,
        truncated,
        observed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    })
}

fn require<'a>(value: &'a str, what: &str) -> AppResult<&'a str> {
    if value.is_empty() {
        return Err(AppError::BadRequest(format!(
            "The agent request needs {what}"
        )));
    }
    Ok(value)
}

pub async fn handle(
    pool: Option<&SqlitePool>,
    bridge: Option<&Bridge>,
    request: AgentWorkerRequest,
) -> AppResult<AgentWorkerResponse> {
    match request.action {
        Some(agent_worker_request::Action::ListAgents(_)) => {
            let (agents, approvals) = ownership::agent::worker_states(database(pool)?).await?;
            Ok(answer(agent_worker_response::Result::Agents(
                WorkerAgentStates {
                    worker_instance_id: String::new(),
                    agents,
                    approvals,
                },
            )))
        }
        Some(agent_worker_request::Action::DrainEvents(input)) => {
            let drained = drain(database(pool)?, &input).await?;
            Ok(answer(agent_worker_response::Result::Events(drained)))
        }
        Some(agent_worker_request::Action::DeliverApproval(input)) => {
            let receipt = door(bridge)?.deliver_approval(&input).await?;
            Ok(answer(agent_worker_response::Result::Delivery(receipt)))
        }
        // Putting a bundle or a message in front of an agent means writing into
        // a live pane through the delivery gate, which this batch has not wired
        // up. NOT_WRITTEN is the honest answer and the safe one: it is
        // affirmative proof that nothing reached the terminal, so the Host
        // records the handoff as FAILED — which a person may retry — rather
        // than as an outcome nobody can attribute.
        Some(agent_worker_request::Action::DeliverHandoff(input)) => {
            Ok(answer(agent_worker_response::Result::Delivery(
                unsupported_delivery(input.handoff_id, "agent.delivery.pane_unsupported"),
            )))
        }
        Some(agent_worker_request::Action::DeliverMessage(input)) => {
            Ok(answer(agent_worker_response::Result::Delivery(
                unsupported_delivery(input.trace_id, "agent.delivery.pane_unsupported"),
            )))
        }
        Some(agent_worker_request::Action::InstallHooks(input)) => {
            let client = install::resolve_client_binary()?;
            Ok(answer(agent_worker_response::Result::Hooks(state(
                install::install(&input.agent_id, &client)?,
            ))))
        }
        Some(agent_worker_request::Action::UninstallHooks(input)) => Ok(answer(
            agent_worker_response::Result::Hooks(state(install::uninstall(&input.agent_id)?)),
        )),
        Some(agent_worker_request::Action::ReadTranscript(input)) => Ok(answer(
            agent_worker_response::Result::Transcript(transcript(database(pool)?, &input).await?),
        )),
        Some(agent_worker_request::Action::CaptureScreen(input)) => Ok(answer(
            agent_worker_response::Result::Screen(door(bridge)?.capture_screen(&input).await?),
        )),
        // An action a newer Host introduced is refused rather than answered
        // with an empty result, which the Host would read as agreement.
        None => Err(AppError::BadRequest(
            "Agent worker action is missing".into(),
        )),
    }
}

fn answer(result: agent_worker_response::Result) -> AgentWorkerResponse {
    AgentWorkerResponse {
        result: Some(result),
    }
}

fn database(pool: Option<&SqlitePool>) -> AppResult<&SqlitePool> {
    pool.ok_or_else(|| {
        AppError::BadRequest("This Worker was not given the Runtime's database".into())
    })
}

fn door(bridge: Option<&Bridge>) -> AppResult<&Bridge> {
    bridge.ok_or_else(|| AppError::Conflict("This Worker has no local Runtime to reach".into()))
}

fn unsupported_delivery(trace_id: String, reason: &str) -> AgentDeliveryReceipt {
    AgentDeliveryReceipt {
        trace_id,
        receipt: String::new(),
        body_chars: 0,
        outcome: DeliveryOutcome::NotWritten as i32,
        reason_code: reason.into(),
        observed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    }
}

fn state(report: install::InstallReport) -> HookInstallState {
    HookInstallState {
        agent_id: report.agent_id,
        installed: report.installed,
        client_revision: report.client_revision.max(0) as u32,
        config_path: report.config_path,
        reason_code: report.warning.unwrap_or_default(),
        installed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    }
}

/// Answers what has changed on this machine since the Host's cursor.
///
/// The cursor is a millisecond stamp rather than a counter, because these
/// tables have no counter: `agent_status.updated_at`, `agent_approvals`'
/// `created_at` and `agent_deliveries.created_at` are what the resident Runtime
/// writes, and inventing a sequence would mean a second bookkeeping table for a
/// domain that is being handed away.
///
/// One consequence is worth stating: a batch boundary that falls inside a
/// single millisecond drops the rows on the far side of it until they change
/// again. The batch is 256 records and a millisecond holding more than that
/// would be a machine reducing a thousand turns a second; the honest statement
/// is that this is a bound, not an impossibility, and every record the Host
/// takes is idempotent by identifier so a re-read costs nothing.
async fn drain(
    pool: &SqlitePool,
    request: &DrainAgentEventsRequest,
) -> AppResult<DrainedAgentEvents> {
    let limit = match request.limit {
        0 => DEFAULT_BATCH,
        value => value.min(MAX_BATCH),
    };
    let after = request.after_sequence.min(i64::MAX as u64) as i64;
    let mut result = DrainedAgentEvents {
        next_sequence: request.after_sequence,
        has_more: false,
        events: Vec::new(),
        approvals: Vec::new(),
        deliveries: Vec::new(),
    };
    let mut highest = after;
    let workspaces: Vec<String> = sqlx::query_scalar("SELECT id FROM workspaces ORDER BY id")
        .fetch_all(pool)
        .await?;
    let mut connection = pool.acquire().await?;
    for workspace_id in workspaces {
        let records = ownership::agent::records_for(&mut connection, &workspace_id).await?;
        for status in records.statuses {
            if status.updated_at_unix_ms <= after {
                continue;
            }
            highest = highest.max(status.updated_at_unix_ms);
            result.events.push(hook_event(&status));
        }
        for approval in records.approvals {
            if approval.created_at_unix_ms <= after {
                continue;
            }
            highest = highest.max(approval.created_at_unix_ms);
            result.approvals.push(approval);
        }
        for delivery in records.deliveries {
            if delivery.created_at_unix_ms <= after {
                continue;
            }
            highest = highest.max(delivery.created_at_unix_ms);
            result.deliveries.push(delivery);
        }
    }
    let total = result.events.len() + result.approvals.len() + result.deliveries.len();
    if total > limit as usize {
        result.has_more = true;
    }
    if highest > after {
        result.next_sequence = highest as u64;
    }
    Ok(result)
}

/// One status turned into the normalized Hook event the Host records.
///
/// The payload is the reduced status itself, in the contract's own encoding,
/// because that is what "normalized" means here: the raw body a CLI wrote never
/// leaves this machine, and what travels is what this Runtime made of it. The
/// digest is what lets the Host refuse a body that was truncated in flight.
pub fn hook_event(status: &AgentStatus) -> HookEvent {
    let payload = status.encode_to_vec();
    let digest = Sha256::digest(&payload).to_vec();
    HookEvent {
        // Stable by construction: the same status at the same moment is the
        // same event, so a re-read after an interrupted drain is one record.
        event_id: format!("{}/{}", status.node_id, status.updated_at_unix_ms),
        node_id: status.node_id.clone(),
        session_id: status.session_id.clone(),
        generation: status.generation,
        workspace_id: status.workspace_id.clone(),
        provider: status.agent_id.clone(),
        payload,
        payload_sha256: digest,
        schema_version: STATUS_SCHEMA,
        kind: HookEventKind::TurnEnd as i32,
        observed_at_unix_ms: status.last_event_at_unix_ms,
    }
}

/// Only the questions still open travel with a listing. An answered approval is
/// history, and a Host recording it as newly appeared would show a question
/// nobody is waiting on.
pub fn pending(approvals: Vec<Approval>) -> Vec<Approval> {
    approvals
        .into_iter()
        .filter(|approval| approval.state == armadra_protocol::v1::ApprovalState::Pending as i32)
        .collect()
}
