//! The Worker's half of scheduled prompt delivery.
//!
//! The Host's Worker is a separate process from the Runtime that owns the
//! PTYs, so it cannot write into an Agent terminal itself. It proxies instead,
//! over exactly the door the hook client already uses: the Runtime's private
//! `hook-endpoint.env` in the same data directory, its Unix socket (or the
//! loopback fallback it publishes there) and its app bearer. Nothing new is
//! listened on, no new credential is minted, and the Host never learns the
//! Runtime's address or token.
//!
//! Choosing this over "the Runtime exposes its own authenticated port to the
//! Host" is deliberate: the Host already owns one authenticated transport to
//! one executor, and a second one would need its own pairing, its own rotation
//! and its own reachability story. Everything here degrades to UNSUPPORTED
//! when no live Runtime is reachable, which is a state the Host already draws.
//!
//! Nothing is decided here. Identity, the delivery gate and the durable
//! journal all live with the Runtime, next to the write they describe; this
//! file only translates Protobuf into that surface's JSON and back.

use std::{path::PathBuf, time::Duration};

use armadra_hook::{
    endpoint::Endpoint,
    http::{Request, send_with_timeout},
};
use armadra_protocol::{Message, v1::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// The capability the Host checks before it routes an agent target to this
/// Worker. Absent when no state directory was configured.
pub const CAPABILITY: &str = "automation.agent-prompt.v1";

/// The shape of an agent upcall's opaque payload: an encoded
/// `AgentPromptReceipt`. Bumping it is how a later batch changes the body
/// without a Host having to guess which one it is looking at.
const AGENT_UPCALL_SCHEMA: u32 = 1;

/// A live pane has to be inspected before the Runtime can answer, which can
/// mean shelling out to `ps` or `tmux`. The hook's own 1.5s budget is for the
/// hot path of every CLI event; a scheduled delivery is allowed to wait.
const BUDGET: Duration = Duration::from_secs(8);

pub struct Bridge {
    data_dir: PathBuf,
    /// The upward half of the resident channel (business migration §2.9), when
    /// this Worker has a durable outbox. The bridge is the channel's first
    /// consumer, and deliberately a passive one: an upcall is a *copy* of the
    /// answer A02 already computed, emitted after it, and a failure to queue
    /// one never changes what the Host is told about the delivery itself.
    upcalls: Option<super::channel::Upcaller>,
}

impl Bridge {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            upcalls: None,
        }
    }

    /// Attaches the upward flow. Without it the bridge behaves exactly as it
    /// did before this batch.
    pub fn with_upcalls(mut self, upcalls: Option<super::channel::Upcaller>) -> Self {
        self.upcalls = upcalls;
        self
    }

    /// Reports one already-observed agent event upward.
    ///
    /// The payload is the Protobuf the Host would have received anyway, kept
    /// opaque with its own digest: the agent domain (B4) has no settled Host
    /// shape yet, and guessing one here would freeze it.
    async fn report(
        &self,
        kind: WorkerAgentUpcallKind,
        node_id: &str,
        session_id: &str,
        payload: Vec<u8>,
    ) {
        let Some(upcalls) = self.upcalls.as_ref() else {
            return;
        };
        // `generation` and `entity_id` belong to the agent domain's own record
        // half (§2.7) and are absent here: this report is about a prompt
        // delivery, not about a record, and filling them in would name an
        // entity the Host has never been told about.
        let event = worker_upcall::Event::Agent(WorkerAgentUpcall {
            generation: 0,
            entity_id: String::new(),
            workspace_id: String::new(),
            node_id: node_id.to_owned(),
            session_id: session_id.to_owned(),
            payload_sha256: Sha256::digest(&payload).to_vec(),
            payload,
            schema_version: AGENT_UPCALL_SCHEMA,
            kind: kind as i32,
            reason_code: String::new(),
            observed_at_unix_ms: chrono::Utc::now().timestamp_millis(),
        });
        if let Err(error) = upcalls.send(event).await {
            // The delivery itself already succeeded and has been answered. A
            // report that cannot be queued is a lost report, not a lost write,
            // and saying so is more useful than failing the caller.
            tracing::warn!(%error, "an agent upcall could not be queued");
        }
    }

    fn endpoint(&self) -> Result<Endpoint, AppError> {
        Endpoint::load(&self.data_dir.join("hook-endpoint.env")).map_err(|_| {
            // No path, no token, no OS error reaches the Host: it only needs to
            // know that this Worker cannot reach a Runtime right now.
            AppError::Conflict("No local Runtime endpoint is available".into())
        })
    }

    async fn call(&self, path: &'static str, body: Value) -> Result<Value, AppError> {
        let endpoint = self.endpoint()?;
        let token = endpoint.hook_token.clone().unwrap_or_default();
        let payload = serde_json::to_vec(&body)
            .map_err(|_| AppError::Internal("Could not encode a delivery request".into()))?;
        let response = tokio::task::spawn_blocking(move || {
            let request = Request::post_json(
                path,
                vec![("X-Armadra-Hook-Token".to_string(), token)],
                payload,
            );
            send_with_timeout(&endpoint, &request, BUDGET)
        })
        .await
        .map_err(|_| AppError::Internal("Delivery bridge task failed".into()))?
        .map_err(|_| AppError::Conflict("The local Runtime did not answer".into()))?;
        if !response.is_success() {
            // Status and route only, on stderr, where the Host keeps it as an
            // opaque diagnostic. The Runtime's own prose stays with the
            // Runtime, and no body ever reaches the Host.
            tracing::warn!(
                status = response.status,
                path,
                "the Runtime refused a delivery request"
            );
            return Err(match response.status {
                400 => AppError::BadRequest("Runtime refused the delivery request".into()),
                403 => AppError::Forbidden("Runtime refused the delivery bearer".into()),
                404 => AppError::NotFound("Runtime has no such delivery".into()),
                409 => AppError::Conflict("Runtime delivery state changed".into()),
                _ => AppError::Internal("Runtime delivery request failed".into()),
            });
        }
        serde_json::from_str(&response.body)
            .map_err(|_| AppError::Internal("Runtime delivery answer was unreadable".into()))
    }

    pub async fn handle(&self, request: AgentRequest) -> Result<AgentResponse, AppError> {
        use agent_request::Action;
        use agent_response::Result as Answer;
        match request
            .action
            .ok_or_else(|| AppError::BadRequest("Agent action is missing".into()))?
        {
            Action::Target(input) => {
                let expected = input
                    .expected
                    .as_ref()
                    .ok_or_else(|| AppError::BadRequest("Agent identity is required".into()))?;
                let mut body = json!({
                    "workspaceId": input.workspace_id,
                    "nodeId": input.node_id,
                    "sessionId": input.session_id,
                    "generation": input.generation,
                    "expected": spec(expected),
                });
                if let Some(cold) = input.cold_start.as_ref() {
                    body["coldStart"] = spec(cold);
                }
                let answer = self.call("/automation/agent-target", body).await?;
                Ok(AgentResponse {
                    result: Some(Answer::Target(target_status(&answer))),
                })
            }
            Action::Prompt(input) => {
                let expected = input
                    .expected
                    .as_ref()
                    .ok_or_else(|| AppError::BadRequest("Agent identity is required".into()))?;
                // The prompt is frozen bytes; anything that is not text was
                // never a prompt and must not be typed into a terminal.
                let prompt = String::from_utf8(input.prompt.clone())
                    .map_err(|_| AppError::BadRequest("Prompt is not valid UTF-8".into()))?;
                let body = json!({
                    "operationId": input.operation_id,
                    "requestDigest": hex(&input.request_sha256),
                    "workspaceId": input.workspace_id,
                    "nodeId": input.node_id,
                    "sessionId": input.session_id,
                    "generation": input.generation,
                    "prompt": prompt,
                    "expected": spec(expected),
                });
                let answer = self.call("/automation/agent-prompt", body).await?;
                let receipt = receipt(&answer, &input.operation_id, &input.request_sha256);
                // A turn was driven on that node, and the Host will want to
                // know without polling. Only a receipt that reached the pane
                // reports one: `notWritten` and `abandoned` describe a turn
                // that never happened, and `unknown` describes one nobody can
                // claim either way.
                if matches!(
                    AgentPromptPhase::try_from(receipt.phase),
                    Ok(AgentPromptPhase::Submitted | AgentPromptPhase::Completed)
                ) {
                    self.report(
                        WorkerAgentUpcallKind::HookTurn,
                        &input.node_id,
                        &receipt.session_id,
                        receipt.encode_to_vec(),
                    )
                    .await;
                }
                Ok(AgentResponse {
                    result: Some(Answer::Receipt(receipt)),
                })
            }
            Action::Lookup(input) => {
                let answer = self
                    .call(
                        "/automation/agent-prompt/lookup",
                        json!({ "operationId": input.operation_id }),
                    )
                    .await?;
                let digest = decode_hex(answer.get("requestDigest").and_then(Value::as_str));
                Ok(AgentResponse {
                    result: Some(Answer::Receipt(receipt(
                        &answer,
                        &input.operation_id,
                        &digest,
                    ))),
                })
            }
        }
    }
}

fn spec(value: &AgentLaunchSpec) -> Value {
    json!({
        "agentId": value.agent_id,
        "workingDirectory": value.working_directory,
        "args": value.args,
        "permissionMode": value.permission_mode,
        "modelId": value.model_id,
        "accountId": value.account_id,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut text, byte| {
        use std::fmt::Write;
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn decode_hex(value: Option<&str>) -> Vec<u8> {
    let Some(value) = value.filter(|text| text.len() % 2 == 0 && text.len() <= 128) else {
        return Vec::new();
    };
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|text| u8::from_str_radix(text, 16).ok())
        })
        .collect::<Option<Vec<u8>>>()
        .unwrap_or_default()
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").into()
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// An unrecognized state is UNKNOWN, never READY. A Runtime this Worker cannot
/// understand must not be read as permission to write into a terminal.
fn target_status(answer: &Value) -> AgentTargetStatus {
    let state = match text(answer, "state").as_str() {
        "ready" => AgentTargetState::Ready,
        "busy" => AgentTargetState::Busy,
        "absent" => AgentTargetState::Absent,
        "unsupported" => AgentTargetState::Unsupported,
        _ => AgentTargetState::Unknown,
    };
    AgentTargetStatus {
        state: state as i32,
        session_id: text(answer, "sessionId"),
        generation: number(answer, "generation"),
        reason_code: text(answer, "reasonCode"),
    }
}

/// An unrecognized phase is UNKNOWN with `no_effect_proven` cleared: only the
/// Runtime's own `notWritten` is proof that nothing was typed.
fn receipt(answer: &Value, operation_id: &str, digest: &[u8]) -> AgentPromptReceipt {
    let phase = match text(answer, "phase").as_str() {
        "notWritten" => AgentPromptPhase::NotWritten,
        "submitted" => AgentPromptPhase::Submitted,
        "completed" => AgentPromptPhase::Completed,
        "abandoned" => AgentPromptPhase::Abandoned,
        _ => AgentPromptPhase::Unknown,
    };
    AgentPromptReceipt {
        operation_id: operation_id.to_owned(),
        request_sha256: digest.to_vec(),
        phase: phase as i32,
        sequence: number(answer, "sequence").max(1),
        observed_at_unix_ms: answer
            .get("observedAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        reason_code: text(answer, "reasonCode"),
        session_id: text(answer, "sessionId"),
        generation: number(answer, "generation"),
        cold_started: answer
            .get("coldStarted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        no_effect_proven: phase == AgentPromptPhase::NotWritten
            && answer
                .get("noEffectProven")
                .and_then(Value::as_bool)
                .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_state_never_reads_as_ready() {
        for state in ["", "READY", "maybe", "Ready"] {
            let status = target_status(&json!({ "state": state }));
            assert_eq!(status.state, AgentTargetState::Unknown as i32);
        }
        assert_eq!(
            target_status(&json!({"state":"ready","generation":7})).state,
            AgentTargetState::Ready as i32
        );
    }

    #[test]
    fn only_a_not_written_phase_can_claim_no_effect() {
        let claimed = json!({"phase":"submitted","noEffectProven":true,"sequence":1});
        assert!(!receipt(&claimed, "operation-1", &[1; 32]).no_effect_proven);
        let proven = json!({"phase":"notWritten","noEffectProven":true,"sequence":1});
        assert!(receipt(&proven, "operation-1", &[1; 32]).no_effect_proven);
        let unproven = json!({"phase":"notWritten","sequence":1});
        assert!(!receipt(&unproven, "operation-1", &[1; 32]).no_effect_proven);
    }

    #[test]
    fn an_unknown_phase_is_unknown_and_keeps_the_operation_identity() {
        let answer = json!({"phase":"invented","sequence":0,"sessionId":"session-1"});
        let mapped = receipt(&answer, "operation-1", &[2; 32]);
        assert_eq!(mapped.phase, AgentPromptPhase::Unknown as i32);
        assert_eq!(mapped.operation_id, "operation-1");
        assert_eq!(mapped.request_sha256, vec![2; 32]);
        // A zero sequence would make the Host reject the receipt outright.
        assert_eq!(mapped.sequence, 1);
    }

    #[test]
    fn digests_round_trip_through_the_json_bridge() {
        let bytes: Vec<u8> = (0..32).collect();
        assert_eq!(decode_hex(Some(&hex(&bytes))), bytes);
        assert!(decode_hex(Some("odd")).is_empty());
        assert!(decode_hex(Some("zz")).is_empty());
        assert!(decode_hex(None).is_empty());
    }
}
