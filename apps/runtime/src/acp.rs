use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TextContent,
};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::{
    sync::{RwLock, broadcast, oneshot},
    task::AbortHandle,
};
use uuid::Uuid;

use crate::{
    agent::agent_path,
    error::{AppError, AppResult},
    model::TerminalSession,
};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpEvent {
    Status {
        status: String,
        message: Option<String>,
    },
    Update {
        update: Value,
    },
    Permission {
        #[serde(rename = "requestId")]
        request_id: String,
        request: Value,
    },
    PermissionResolved {
        #[serde(rename = "requestId")]
        request_id: String,
        resolution: String,
    },
}

struct AcpHandle {
    events: broadcast::Sender<AcpEvent>,
    replay: Mutex<VecDeque<AcpEvent>>,
    task: Mutex<Option<AbortHandle>>,
    permissions: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
}

#[derive(Clone)]
pub struct AcpManager {
    sessions: Arc<RwLock<HashMap<String, Arc<AcpHandle>>>>,
    pool: SqlitePool,
}

pub struct AcpSpawnRequest {
    pub workspace_id: String,
    pub agent_node_id: String,
    pub adapter: String,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub prompt: String,
}

pub struct AcpSubscription {
    pub receiver: broadcast::Receiver<AcpEvent>,
    pub replay: Vec<AcpEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpClientMessage {
    Cancel,
    PermissionResponse {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "optionId")]
        option_id: Option<String>,
    },
}

impl AcpManager {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pool,
        }
    }

    pub async fn spawn(&self, request: AcpSpawnRequest) -> AppResult<TerminalSession> {
        let id = Uuid::now_v7().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind, owner_node_id, adapter, status, created_at) VALUES (?, ?, ?, 'acp', ?, 'agent', ?, ?, 'running', ?)")
            .bind(&id)
            .bind(&request.workspace_id)
            .bind(&request.cwd)
            .bind(&request.command)
            .bind(&request.agent_node_id)
            .bind(&request.adapter)
            .bind(&now)
            .execute(&self.pool)
            .await?;

        let (events, _) = broadcast::channel(256);
        let handle = Arc::new(AcpHandle {
            events,
            replay: Mutex::new(VecDeque::with_capacity(256)),
            task: Mutex::new(None),
            permissions: Mutex::new(HashMap::new()),
        });
        self.sessions
            .write()
            .await
            .insert(id.clone(), handle.clone());
        emit(
            &handle,
            AcpEvent::Status {
                status: "connecting".into(),
                message: Some("Negotiating ACP v1".into()),
            },
        );

        let session = TerminalSession {
            id: id.clone(),
            workspace_id: request.workspace_id.clone(),
            cwd: request.cwd.clone(),
            shell: "acp".into(),
            command: Some(request.command.clone()),
            kind: "agent".into(),
            owner_node_id: Some(request.agent_node_id.clone()),
            adapter: Some(request.adapter.clone()),
            status: "running".into(),
            exit_code: None,
            pid: None,
            created_at: now,
            ended_at: None,
        };

        let pool = self.pool.clone();
        let session_id = id.clone();
        let task_handle = handle.clone();
        let task = tokio::spawn(async move {
            let result = run_acp(request, task_handle.clone()).await;
            let (status, message) = match result {
                Ok(stop_reason) => ("exited", Some(stop_reason)),
                Err(error) => ("failed", Some(error)),
            };
            let ended_at = Utc::now().to_rfc3339();
            let _ = sqlx::query("UPDATE terminal_sessions SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'")
                .bind(status)
                .bind(ended_at)
                .bind(&session_id)
                .execute(&pool)
                .await;
            emit(
                &task_handle,
                AcpEvent::Status {
                    status: status.into(),
                    message,
                },
            );
        });
        if let Ok(mut slot) = handle.task.lock() {
            *slot = Some(task.abort_handle());
        }

        Ok(session)
    }

    pub async fn subscribe(&self, session_id: &str) -> AppResult<AcpSubscription> {
        let sessions = self.sessions.read().await;
        let handle = sessions.get(session_id).ok_or_else(|| {
            AppError::NotFound("ACP session was not found or Runtime restarted".into())
        })?;
        Ok(AcpSubscription {
            receiver: handle.events.subscribe(),
            replay: handle
                .replay
                .lock()
                .map(|items| items.iter().cloned().collect())
                .unwrap_or_default(),
        })
    }

    pub async fn cancel(&self, session_id: &str) -> AppResult<()> {
        let sessions = self.sessions.read().await;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound("ACP session was not found".into()))?;
        if let Ok(mut task) = handle.task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
        if let Ok(mut permissions) = handle.permissions.lock() {
            for (_, responder) in permissions.drain() {
                let _ = responder.send(None);
            }
        }
        let ended_at = Utc::now().to_rfc3339();
        sqlx::query("UPDATE terminal_sessions SET status = 'terminated', ended_at = ? WHERE id = ? AND status = 'running'")
            .bind(ended_at)
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        emit(
            handle,
            AcpEvent::Status {
                status: "terminated".into(),
                message: Some("Cancelled by user".into()),
            },
        );
        Ok(())
    }

    pub async fn resolve_permission(
        &self,
        session_id: &str,
        request_id: &str,
        option_id: Option<String>,
    ) -> AppResult<()> {
        let sessions = self.sessions.read().await;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound("ACP session was not found".into()))?;
        let responder = handle
            .permissions
            .lock()
            .ok()
            .and_then(|mut permissions| permissions.remove(request_id))
            .ok_or_else(|| {
                AppError::NotFound("ACP permission request is no longer pending".into())
            })?;
        responder
            .send(option_id)
            .map_err(|_| AppError::Conflict("ACP permission request already completed".into()))
    }
}

async fn run_acp(request: AcpSpawnRequest, handle: Arc<AcpHandle>) -> Result<String, String> {
    let agent = AcpAgent::new(
        AcpAgentConfig::new(request.command)
            .args(request.args)
            .env("PATH", agent_path().to_string_lossy().into_owned()),
    );
    let notification_handle = handle.clone();
    let permission_handle = handle.clone();
    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                let update = serde_json::to_value(notification.update)
                    .unwrap_or_else(|_| serde_json::json!({ "kind": "unknown" }));
                if let Some(update) = normalize_update(update) {
                    emit(&notification_handle, AcpEvent::Update { update });
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let value = normalize_permission_request(
                    serde_json::to_value(&request)
                        .unwrap_or_else(|_| serde_json::json!({ "kind": "permission" })),
                );
                let request_id = Uuid::now_v7().to_string();
                let (decision_tx, decision_rx) = oneshot::channel();
                if let Ok(mut permissions) = permission_handle.permissions.lock() {
                    permissions.insert(request_id.clone(), decision_tx);
                }
                emit(
                    &permission_handle,
                    AcpEvent::Permission {
                        request_id: request_id.clone(),
                        request: value,
                    },
                );
                let decision = tokio::time::timeout(Duration::from_secs(600), decision_rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten();
                if let Ok(mut permissions) = permission_handle.permissions.lock() {
                    permissions.remove(&request_id);
                }
                let outcome = decision
                    .map(|id| {
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id))
                    })
                    .unwrap_or(RequestPermissionOutcome::Cancelled);
                let resolution = match &outcome {
                    RequestPermissionOutcome::Selected(selected) => {
                        format!("selected:{}", selected.option_id)
                    }
                    RequestPermissionOutcome::Cancelled => "cancelled".into(),
                    _ => "resolved".into(),
                };
                emit(
                    &permission_handle,
                    AcpEvent::PermissionResolved {
                        request_id,
                        resolution,
                    },
                );
                responder.respond(RequestPermissionResponse::new(outcome))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            emit(
                &handle,
                AcpEvent::Status {
                    status: "running".into(),
                    message: Some("ACP v1 connected".into()),
                },
            );
            let session = connection
                .send_request(NewSessionRequest::new(PathBuf::from(request.cwd)))
                .block_task()
                .await?;
            let response = connection
                .send_request(PromptRequest::new(
                    session.session_id,
                    vec![ContentBlock::Text(TextContent::new(request.prompt))],
                ))
                .block_task()
                .await?;
            Ok(format!("{:?}", response.stop_reason))
        })
        .await
        .map_err(|error| error.to_string())
}

/// Normalize an ACP `session/update` notification into the structured shapes the
/// canvas renders (plan §3). Returns `None` for protocol noise the UI ignores.
fn normalize_update(update: Value) -> Option<Value> {
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    match kind {
        "agent_message_chunk" => text_update(&update, "message"),
        "user_message_chunk" => text_update(&update, "user"),
        "agent_thought_chunk" => text_update(&update, "thinking"),
        "tool_call" | "tool_call_update" => Some(normalize_tool_call(&update)),
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            let content = entry
                                .get("content")
                                .and_then(Value::as_str)
                                .filter(|content| !content.is_empty())?;
                            Some(serde_json::json!({
                                "content": content,
                                "status": entry.get("status").and_then(Value::as_str).unwrap_or("pending"),
                            }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (!entries.is_empty()).then(|| serde_json::json!({ "kind": "plan", "entries": entries }))
        }
        _ => normalize_usage(&update),
    }
}

fn text_update(update: &Value, kind: &str) -> Option<Value> {
    let text = content_text(update.get("content")?)?;
    (!text.is_empty()).then(|| serde_json::json!({ "kind": kind, "text": text }))
}

fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let text = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(_) => content
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn nested<'a>(update: &'a Value, names: &[&str]) -> Option<&'a Value> {
    for name in names {
        if let Some(value) = update.get(name).filter(|value| !value.is_null()) {
            return Some(value);
        }
        for container in ["toolCall", "tool_call"] {
            if let Some(value) = update
                .get(container)
                .and_then(|call| call.get(name))
                .filter(|value| !value.is_null())
            {
                return Some(value);
            }
        }
    }
    None
}

fn normalize_tool_call(update: &Value) -> Value {
    let tool_call_id = nested(update, &["toolCallId", "tool_call_id", "id"])
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let title = nested(update, &["title"])
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let status = nested(update, &["status"])
        .and_then(Value::as_str)
        .unwrap_or("pending")
        .to_owned();
    let tool_kind = nested(update, &["kind", "toolKind", "tool_kind"])
        .and_then(Value::as_str)
        .map(str::to_owned);
    serde_json::json!({
        "kind": "tool",
        "toolCallId": tool_call_id,
        "title": title,
        "status": status,
        "toolKind": tool_kind,
        "detail": tool_call_detail(update),
    })
}

fn tool_call_detail(update: &Value) -> Option<String> {
    const MAX_DETAIL: usize = 240;
    let locations = nested(update, &["locations"])
        .and_then(Value::as_array)
        .map(|locations| {
            locations
                .iter()
                .filter_map(|location| location.get("path").and_then(Value::as_str))
                .take(3)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|detail| !detail.is_empty());
    let raw_input = nested(update, &["rawInput", "raw_input"]).map(|value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    });
    let content = nested(update, &["content"]).and_then(|content| match content {
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                content_text(block.get("content").unwrap_or(block))
                    .or_else(|| block.get("text").and_then(Value::as_str).map(str::to_owned))
            })
            .next(),
        other => content_text(other),
    });
    let detail = locations.or(raw_input).or(content)?;
    let detail = detail.trim();
    if detail.is_empty() {
        return None;
    }
    Some(truncate(detail, MAX_DETAIL))
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn normalize_usage(update: &Value) -> Option<Value> {
    let usage = ["usage", "tokenUsage", "token_usage"]
        .iter()
        .find_map(|name| update.get(*name))
        .unwrap_or(update);
    let input = [
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
    ]
    .iter()
    .find_map(|name| usage.get(*name).and_then(Value::as_i64));
    let output = [
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
    ]
    .iter()
    .find_map(|name| usage.get(*name).and_then(Value::as_i64));
    if input.is_none() && output.is_none() {
        return None;
    }
    Some(serde_json::json!({
        "kind": "usage",
        "inputTokens": input.unwrap_or(0),
        "outputTokens": output.unwrap_or(0),
    }))
}

/// Permission requests are forwarded verbatim; this only guarantees the
/// `toolCall` key exists when the agent used the snake_case spelling so the web
/// client can read `toolCall.title` / `.kind` / `.rawInput` unconditionally.
fn normalize_permission_request(mut request: Value) -> Value {
    if let Some(object) = request.as_object_mut()
        && !object.contains_key("toolCall")
        && let Some(tool_call) = object.get("tool_call").cloned()
    {
        object.insert("toolCall".to_owned(), tool_call);
    }
    request
}

fn emit(handle: &AcpHandle, event: AcpEvent) {
    if let Ok(mut replay) = handle.replay.lock() {
        if replay.len() == 256 {
            replay.pop_front();
        }
        replay.push_back(event.clone());
    }
    let _ = handle.events.send(event);
}

#[cfg(all(test, unix))]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::db;

    #[test]
    fn websocket_permission_fields_use_browser_camel_case() {
        let event = AcpEvent::Permission {
            request_id: "request-1".into(),
            request: serde_json::json!({}),
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["requestId"], "request-1");
        let message: AcpClientMessage = serde_json::from_value(serde_json::json!({
            "type": "permission_response",
            "requestId": "request-1",
            "optionId": "allow_once"
        }))
        .unwrap();
        assert!(
            matches!(message, AcpClientMessage::PermissionResponse { request_id, option_id: Some(option_id) } if request_id == "request-1" && option_id == "allow_once")
        );
    }

    #[test]
    fn normalizes_message_chunks_and_ignores_protocol_noise() {
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" }
            })),
            Some(serde_json::json!({ "kind": "message", "text": "hello" }))
        );
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "user_message_chunk",
                "content": [{ "type": "text", "text": "修复白屏" }]
            })),
            Some(serde_json::json!({ "kind": "user", "text": "修复白屏" }))
        );
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "reasoning" }
            })),
            Some(serde_json::json!({ "kind": "thinking", "text": "reasoning" }))
        );
        assert!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "available_commands_update",
                "availableCommands": []
            }))
            .is_none()
        );
        assert!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "" }
            }))
            .is_none()
        );
    }

    #[test]
    fn normalizes_tool_calls_with_identity_status_and_detail() {
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "读取文件",
                "kind": "read",
                "status": "in_progress",
                "locations": [{ "path": "src/App.tsx" }]
            })),
            Some(serde_json::json!({
                "kind": "tool",
                "toolCallId": "call-1",
                "title": "读取文件",
                "status": "in_progress",
                "toolKind": "read",
                "detail": "src/App.tsx"
            }))
        );
        // Updates that only carry a status still report the call identity, and a
        // missing status falls back to `pending`.
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCall": { "toolCallId": "call-1", "title": "读取文件", "rawInput": { "path": "a.ts" } }
            })),
            Some(serde_json::json!({
                "kind": "tool",
                "toolCallId": "call-1",
                "title": "读取文件",
                "status": "pending",
                "toolKind": null,
                "detail": "{\"path\":\"a.ts\"}"
            }))
        );
    }

    #[test]
    fn normalizes_plan_and_usage_updates() {
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "plan",
                "entries": [
                    { "content": "读取现状", "status": "completed", "priority": "high" },
                    { "content": "修改代码" }
                ]
            })),
            Some(serde_json::json!({
                "kind": "plan",
                "entries": [
                    { "content": "读取现状", "status": "completed" },
                    { "content": "修改代码", "status": "pending" }
                ]
            }))
        );
        assert_eq!(
            normalize_update(serde_json::json!({
                "sessionUpdate": "usage",
                "usage": { "inputTokens": 120, "outputTokens": 34 }
            })),
            Some(serde_json::json!({ "kind": "usage", "inputTokens": 120, "outputTokens": 34 }))
        );
        assert!(
            normalize_update(serde_json::json!({ "sessionUpdate": "usage", "usage": {} }))
                .is_none()
        );
    }

    #[test]
    fn permission_requests_expose_tool_call_details() {
        let request = normalize_permission_request(serde_json::json!({
            "tool_call": { "title": "写入文件", "kind": "edit", "rawInput": { "path": "a.ts" } },
            "options": []
        }));
        assert_eq!(request["toolCall"]["title"], "写入文件");
        assert_eq!(request["toolCall"]["kind"], "edit");
        assert_eq!(request["toolCall"]["rawInput"]["path"], "a.ts");

        let already_camel = normalize_permission_request(serde_json::json!({
            "toolCall": { "title": "执行命令" }
        }));
        assert_eq!(already_camel["toolCall"]["title"], "执行命令");
    }

    #[tokio::test]
    async fn invalid_acp_process_reports_a_failed_session() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("acp.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let workspace = db::create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let manager = AcpManager::new(pool.clone());
        let session = manager
            .spawn(AcpSpawnRequest {
                workspace_id: workspace.id,
                agent_node_id: Uuid::now_v7().to_string(),
                adapter: "custom".into(),
                cwd: workspace.root_path,
                command: "/usr/bin/false".into(),
                args: vec![],
                prompt: "test".into(),
            })
            .await
            .unwrap();
        let mut subscription = manager.subscribe(&session.id).await.unwrap();
        let failed = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if matches!(subscription.receiver.recv().await, Ok(AcpEvent::Status { status, .. }) if status == "failed") {
                    break;
                }
            }
        })
        .await;
        assert!(failed.is_ok());
        let status: String =
            sqlx::query_scalar("SELECT status FROM terminal_sessions WHERE id = ?")
                .bind(session.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "failed");
    }

    async fn live_agent_round_trip(command: &str, args: &[&str], adapter: &str, expected: &str) {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("live-acp.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let workspace = db::create_workspace(
            &pool,
            "live-acp",
            directory.path().to_str().unwrap(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let manager = AcpManager::new(pool);
        let session = manager
            .spawn(AcpSpawnRequest {
                workspace_id: workspace.id,
                agent_node_id: Uuid::now_v7().to_string(),
                adapter: adapter.into(),
                cwd: workspace.root_path,
                command: command.into(),
                args: args.iter().map(|arg| (*arg).into()).collect(),
                prompt: format!(
                    "Do not call tools or inspect files. Reply with exactly {expected} and nothing else."
                ),
            })
            .await
            .unwrap();
        let mut subscription = manager.subscribe(&session.id).await.unwrap();
        let mut transcript = String::new();
        let finished = tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                match subscription.receiver.recv().await.unwrap() {
                    AcpEvent::Update { update } => {
                        if let Some(text) = update.get("text").and_then(Value::as_str) {
                            transcript.push_str(text);
                        }
                    }
                    AcpEvent::Status { status, message } if status == "failed" => {
                        panic!("{adapter} ACP failed: {message:?}")
                    }
                    AcpEvent::Status { status, .. } if status == "exited" => break,
                    AcpEvent::Permission { .. } => {
                        panic!("{adapter} unexpectedly requested a tool permission")
                    }
                    _ => {}
                }
            }
        })
        .await;
        assert!(finished.is_ok(), "{adapter} ACP timed out");
        assert!(
            transcript.contains(expected),
            "{adapter} ACP transcript did not contain {expected}: {transcript}"
        );
    }

    #[tokio::test]
    #[ignore = "requires the user's configured OMP model credentials"]
    async fn live_omp_acp_round_trip() {
        live_agent_round_trip("omp", &["acp"], "omp", "ACP_OMP_OK").await;
    }

    #[tokio::test]
    #[ignore = "requires network plus the user's configured Pi model credentials"]
    async fn live_pi_acp_bridge_round_trip() {
        live_agent_round_trip("npx", &["-y", "pi-acp@0.0.33"], "pi", "ACP_PI_OK").await;
    }
}
