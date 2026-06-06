use std::{collections::HashMap, path::Path};

use axum::{
    Json,
    extract::{
        Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    acp::{AcpClientMessage, AcpEvent, AcpSpawnRequest, AcpSubscription},
    agent::{AdapterId, ContextItem, build_context_prompt, list_adapters},
    db::{self, SaveBoardRequest, WorkspacePatch},
    error::{AppError, AppResult},
    files, git,
    model::{
        Board, BoardDocument, CanvasEdge, CanvasNode, Stroke, TerminalSession, Viewport, Workspace,
        WorkspacePermissions, WorkspaceSummary,
    },
    pty::{ClientMessage, PtyEvent, PtySubscription, SpawnRequest},
    security::{canonical_directory, resolve_in_root},
};

/// Reserved gateway port. The gateway is not implemented yet, so no listener is
/// ever opened; the port is only reported so the UI can show it.
pub const GATEWAY_PORT: u16 = 7420;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    version: &'static str,
}

pub async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    name: String,
    root_path: String,
    color: Option<String>,
    permissions: Option<WorkspacePermissions>,
    gateway_enabled: Option<bool>,
}

fn valid_workspace_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::BadRequest("Workspace name is invalid".into()));
    }
    Ok(name)
}

pub async fn create_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&request.name)?;
    let root = canonical_directory(&request.root_path)?;
    Ok(Json(
        db::create_workspace(
            &state.pool,
            name,
            &root.to_string_lossy(),
            request.color.as_deref(),
            request.permissions.as_ref(),
            request.gateway_enabled,
        )
        .await?,
    ))
}

pub async fn list_workspaces(
    State(state): State<AppState>,
) -> AppResult<Json<Vec<WorkspaceSummary>>> {
    Ok(Json(db::list_workspaces(&state.pool).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceRequest {
    name: Option<String>,
    color: Option<String>,
    permissions: Option<WorkspacePermissions>,
    gateway_enabled: Option<bool>,
}

pub async fn update_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<UpdateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    Ok(Json(
        db::update_workspace(
            &state.pool,
            &workspace_id,
            WorkspacePatch {
                name: request.name,
                color: request.color,
                permissions: request.permissions,
                gateway_enabled: request.gateway_enabled,
            },
        )
        .await?,
    ))
}

pub async fn open_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Workspace>> {
    Ok(Json(
        db::touch_workspace_opened(&state.pool, &workspace_id).await?,
    ))
}

pub async fn list_boards(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Vec<Board>>> {
    Ok(Json(db::list_boards(&state.pool, &workspace_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBoardRequest {
    name: String,
}

pub async fn create_board(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<CreateBoardRequest>,
) -> AppResult<Json<Board>> {
    Ok(Json(
        db::create_board(&state.pool, &workspace_id, &request.name).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBoardRequest {
    name: Option<String>,
    sort_order: Option<i64>,
}

pub async fn update_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
    Json(request): Json<UpdateBoardRequest>,
) -> AppResult<Json<Board>> {
    Ok(Json(
        db::update_board(
            &state.pool,
            &workspace_id,
            &board_id,
            request.name,
            request.sort_order,
        )
        .await?,
    ))
}

pub async fn delete_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
) -> AppResult<axum::http::StatusCode> {
    db::delete_board(&state.pool, &workspace_id, &board_id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn load_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
) -> AppResult<Json<BoardDocument>> {
    Ok(Json(
        db::load_board(&state.pool, &workspace_id, &board_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBoardDocumentRequest {
    expected_updated_at: String,
    nodes: Vec<CanvasNode>,
    edges: Vec<CanvasEdge>,
    strokes: Vec<Stroke>,
    viewport: Viewport,
}

pub async fn save_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
    Json(request): Json<SaveBoardDocumentRequest>,
) -> AppResult<Json<BoardDocument>> {
    Ok(Json(
        db::save_board(
            &state.pool,
            &workspace_id,
            &board_id,
            SaveBoardRequest {
                expected_updated_at: &request.expected_updated_at,
                nodes: &request.nodes,
                edges: &request.edges,
                strokes: &request.strokes,
                viewport: request.viewport,
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct RequestedPath {
    #[serde(default = "default_path")]
    path: String,
}

fn default_path() -> String {
    ".".into()
}

pub async fn list_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<files::FileList>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(files::list_directory(
        Path::new(&workspace.root_path),
        &query.path,
    )?))
}

pub async fn read_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<files::FileContent>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(files::read_text_file(
        Path::new(&workspace.root_path),
        &query.path,
    )?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalRequest {
    workspace_id: String,
    cwd: String,
    shell: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

pub async fn create_terminal(
    State(state): State<AppState>,
    Json(request): Json<CreateTerminalRequest>,
) -> AppResult<Json<TerminalSession>> {
    let workspace = db::get_workspace(&state.pool, &request.workspace_id).await?;
    let cwd = resolve_in_root(&workspace.root_path, &request.cwd)?;
    let session = state
        .pty
        .spawn(SpawnRequest {
            workspace_id: request.workspace_id,
            cwd: cwd.to_string_lossy().into_owned(),
            shell: request.shell,
            command: request.command,
            args: request.args,
            kind: "terminal".into(),
            owner_node_id: None,
            adapter: None,
        })
        .await?;
    Ok(Json(session))
}

pub async fn terminal_socket(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    validate_websocket_origin(&headers)?;
    let subscription = state.pty.subscribe(&session_id).await?;
    Ok(
        ws.on_upgrade(move |socket| {
            handle_terminal_socket(state, session_id, subscription, socket)
        }),
    )
}

async fn handle_terminal_socket(
    state: AppState,
    session_id: String,
    mut subscription: PtySubscription,
    socket: WebSocket,
) {
    let (mut sender, mut receiver) = socket.split();
    for data in subscription.replay.drain(..) {
        let payload = serde_json::json!({ "type": "output", "data": data }).to_string();
        if sender.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }
    if let Some(event) = subscription.current_status.take() {
        let payload = match event {
            PtyEvent::Output { data } => serde_json::json!({ "type": "output", "data": data }),
            PtyEvent::Status { status, exit_code } => {
                serde_json::json!({ "type": "status", "status": status, "exitCode": exit_code })
            }
        }
        .to_string();
        if sender.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            result = subscription.receiver.recv() => match result {
                Ok(event) => {
                    let payload = match event {
                        PtyEvent::Output { data } => serde_json::json!({ "type": "output", "data": data }),
                        PtyEvent::Status { status, exit_code } => serde_json::json!({ "type": "status", "status": status, "exitCode": exit_code }),
                    }.to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    let payload = serde_json::json!({ "type": "warning", "message": format!("Terminal output skipped {count} buffered chunks") }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            message = receiver.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<ClientMessage>(&text) {
                        let result = match message {
                            ClientMessage::Input { data } => state.pty.write(&session_id, &data).await,
                            ClientMessage::Resize { cols, rows } => state.pty.resize(&session_id, cols, rows).await,
                            ClientMessage::Terminate => state.pty.terminate(&session_id).await,
                        };
                        if result.is_err() { break; }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

pub async fn adapters() -> Json<Vec<crate::agent::AdapterInfo>> {
    Json(list_adapters())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRequest {
    #[allow(dead_code)]
    agent_node_id: String,
    items: Vec<ContextItem>,
}

#[derive(Serialize)]
pub struct ContextResponse {
    prompt: String,
}

pub async fn context_preview(
    Json(request): Json<ContextRequest>,
) -> AppResult<Json<ContextResponse>> {
    validate_context_items(&request.items)?;
    Ok(Json(ContextResponse {
        prompt: build_context_prompt(&request.items),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentRequest {
    workspace_id: String,
    #[allow(dead_code)]
    agent_node_id: String,
    adapter: AdapterId,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    items: Vec<ContextItem>,
    #[allow(dead_code)]
    session_id: Option<String>,
}

#[derive(Serialize)]
pub struct RunAgentResponse {
    session: TerminalSession,
    prompt: String,
}

pub async fn run_agent(
    State(state): State<AppState>,
    Json(request): Json<RunAgentRequest>,
) -> AppResult<Json<RunAgentResponse>> {
    validate_context_items(&request.items)?;
    if request.session_id.is_some() {
        return Err(AppError::BadRequest(
            "ACP prompts start a new owned session; terminal session reuse is not allowed".into(),
        ));
    }
    let prompt = build_context_prompt(&request.items);
    let workspace = db::get_workspace(&state.pool, &request.workspace_id).await?;
    let cwd = resolve_in_root(&workspace.root_path, &request.cwd)?;
    let command = if matches!(request.adapter, AdapterId::Custom) {
        request
            .command
            .filter(|command| !command.trim().is_empty())
            .unwrap_or_default()
    } else {
        request.adapter.command().to_owned()
    };
    if command.is_empty() {
        return Err(AppError::BadRequest(
            "Custom ACP agents require an explicit command".into(),
        ));
    }
    let args = if request.args.is_empty() && !matches!(request.adapter, AdapterId::Custom) {
        request
            .adapter
            .args()
            .iter()
            .map(|arg| (*arg).to_owned())
            .collect()
    } else {
        request.args
    };
    let session = state
        .acp
        .spawn(AcpSpawnRequest {
            workspace_id: request.workspace_id,
            cwd: cwd.to_string_lossy().into_owned(),
            command,
            args,
            agent_node_id: request.agent_node_id,
            adapter: request.adapter.id().into(),
            prompt: prompt.clone(),
        })
        .await?;
    Ok(Json(RunAgentResponse { session, prompt }))
}

pub async fn agent_socket(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    validate_websocket_origin(&headers)?;
    let subscription = state.acp.subscribe(&session_id).await?;
    Ok(ws.on_upgrade(move |socket| handle_agent_socket(state, session_id, subscription, socket)))
}

async fn handle_agent_socket(
    state: AppState,
    session_id: String,
    mut subscription: AcpSubscription,
    socket: WebSocket,
) {
    let (mut sender, mut receiver) = socket.split();
    for event in subscription.replay.drain(..) {
        if sender
            .send(Message::Text(
                serde_json::to_string(&event).unwrap_or_default().into(),
            ))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        tokio::select! {
            event = subscription.receiver.recv() => match event {
                Ok(event) => {
                    if sender.send(Message::Text(serde_json::to_string(&event).unwrap_or_default().into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    let warning = AcpEvent::Status { status: "warning".into(), message: Some(format!("Skipped {count} ACP updates")) };
                    if sender.send(Message::Text(serde_json::to_string(&warning).unwrap_or_default().into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            message = receiver.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<AcpClientMessage>(&text) {
                        Ok(AcpClientMessage::Cancel) => { let _ = state.acp.cancel(&session_id).await; }
                        Ok(AcpClientMessage::PermissionResponse { request_id, option_id }) => {
                            let _ = state.acp.resolve_permission(&session_id, &request_id, option_id).await;
                        }
                        Err(_) => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

fn validate_context_items(items: &[ContextItem]) -> AppResult<()> {
    const MAX_ITEMS: usize = 100;
    const MAX_ITEM_LENGTH: usize = 20_000;
    const MAX_TOTAL_LENGTH: usize = 100_000;
    let valid_kinds = ["task", "file", "context", "log", "note", "browser", "text"];
    let total = items
        .iter()
        .map(|item| item.title.len() + item.value.len())
        .sum::<usize>();
    if items.len() > MAX_ITEMS
        || total > MAX_TOTAL_LENGTH
        || items.iter().any(|item| {
            uuid::Uuid::parse_str(&item.node_id).is_err()
                || !valid_kinds.contains(&item.kind.as_str())
                || item.title.is_empty()
                || item.title.len() > 160
                || item.value.len() > MAX_ITEM_LENGTH
        })
    {
        return Err(AppError::BadRequest(
            "Context bundle exceeds the allowed size or contains invalid items".into(),
        ));
    }
    Ok(())
}

fn validate_websocket_origin(headers: &HeaderMap) -> AppResult<()> {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Forbidden("WebSocket Origin is required".into()))?;
    if origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:")
        || origin == "tauri://localhost"
        || origin == "https://tauri.localhost"
    {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "WebSocket Origin is not allowed".into(),
        ))
    }
}

pub async fn git_diff(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<git::GitDiff>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(git::read_diff(
        Path::new(&workspace.root_path),
        &query.path,
    )?))
}

pub async fn git_status(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<git::GitStatus>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(git::read_status(Path::new(&workspace.root_path))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsRequest {
    paths: Vec<String>,
}

pub async fn git_stage(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<Json<git::StageResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(git::stage_paths(
        Path::new(&workspace.root_path),
        &request.paths,
    )?))
}

pub async fn git_revert(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<Json<git::RevertResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(git::revert_paths(
        Path::new(&workspace.root_path),
        &request.paths,
    )?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    enabled: bool,
    port: u16,
    addresses: Vec<String>,
    devices: Vec<serde_json::Value>,
    implemented: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayQuery {
    workspace_id: Option<String>,
}

/// Reports the reserved gateway configuration. No listener is opened and no
/// device is ever fabricated; `implemented` stays `false` for this milestone.
pub async fn gateway(
    State(state): State<AppState>,
    Query(query): Query<GatewayQuery>,
) -> AppResult<Json<GatewayStatus>> {
    let enabled = match query.workspace_id.as_deref() {
        Some(workspace_id) => {
            db::get_workspace(&state.pool, workspace_id)
                .await?
                .gateway_enabled
        }
        None => false,
    };
    Ok(Json(GatewayStatus {
        enabled,
        port: GATEWAY_PORT,
        addresses: vec!["127.0.0.1".to_owned()],
        devices: vec![],
        implemented: false,
    }))
}

pub async fn get_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<TerminalSession>> {
    let mut session = db::get_terminal_session(&state.pool, &session_id).await?;
    session.pid = state.pty.pid(&session_id).await;
    Ok(Json(session))
}

/// Terminates a PTY-backed terminal or cancels an ACP agent session.
pub async fn terminate_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<TerminalSession>> {
    let session = db::get_terminal_session(&state.pool, &session_id).await?;
    let outcome = if session.kind == "agent" {
        state.acp.cancel(&session_id).await
    } else {
        state.pty.terminate(&session_id).await
    };
    match outcome {
        Ok(()) => {}
        // A session that already finished is not an error for the caller.
        Err(AppError::NotFound(_)) if session.status != "running" => {}
        Err(error) => return Err(error),
    }
    let mut session = db::get_terminal_session(&state.pool, &session_id).await?;
    session.pid = state.pty.pid(&session_id).await;
    Ok(Json(session))
}

pub fn parse_query_map(query: &HashMap<String, String>, key: &str) -> String {
    query.get(key).cloned().unwrap_or_else(default_path)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::{db, pty::PtyManager};

    #[test]
    fn websocket_origin_is_limited_to_local_app_origins() {
        let mut local = HeaderMap::new();
        local.insert(
            axum::http::header::ORIGIN,
            "http://127.0.0.1:1420".parse().unwrap(),
        );
        assert!(validate_websocket_origin(&local).is_ok());

        let mut remote = HeaderMap::new();
        remote.insert(
            axum::http::header::ORIGIN,
            "https://evil.example".parse().unwrap(),
        );
        assert!(matches!(
            validate_websocket_origin(&remote),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            validate_websocket_origin(&HeaderMap::new()),
            Err(AppError::Forbidden(_))
        ));
    }

    use axum::{
        Router,
        body::Body,
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    async fn call(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    async fn router_fixture(name: &str) -> (Router, tempfile::TempDir) {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join(format!("{name}.db")).display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        (crate::router(pool), directory)
    }

    #[tokio::test]
    async fn workspace_and_board_routes_follow_the_v2_contract() {
        let (router, directory) = router_fixture("api-v2").await;
        let root = directory.path().to_string_lossy().into_owned();

        let (status, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": root, "color": "#123456" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(workspace["color"], "#123456");
        assert_eq!(workspace["permissions"]["read"], true);
        assert_eq!(workspace["permissions"]["execute"], false);
        assert_eq!(workspace["gatewayEnabled"], false);
        assert!(workspace["lastOpenedAt"].is_string());
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();

        let (status, summaries) = call(&router, "GET", "/api/workspaces", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(summaries[0]["id"], workspace_id.as_str());
        assert_eq!(summaries[0]["boards"][0]["name"], "Default");
        assert_eq!(summaries[0]["boards"][0]["nodeCount"], 0);

        let (status, patched) = call(
            &router,
            "PATCH",
            &format!("/api/workspaces/{workspace_id}"),
            Some(json!({ "gatewayEnabled": true, "permissions": { "read": true, "write": false, "execute": true } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["gatewayEnabled"], true);
        assert_eq!(patched["permissions"]["write"], false);
        assert_eq!(patched["name"], "Canvas");

        let (status, opened) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/open"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(opened["lastOpenedAt"].is_string());

        let (status, gateway) = call(
            &router,
            "GET",
            &format!("/api/gateway?workspaceId={workspace_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            gateway,
            json!({
                "enabled": true,
                "port": 7420,
                "addresses": ["127.0.0.1"],
                "devices": [],
                "implemented": false
            })
        );

        let (status, boards) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/boards"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(boards.as_array().unwrap().len(), 1);
        let default_board_id = boards[0]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            boards[0]["viewport"],
            json!({ "x": 0.0, "y": 0.0, "zoom": 1.0 })
        );

        let (status, created) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/boards"),
            Some(json!({ "name": "Review" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(created["sortOrder"], 1);
        let extra_board_id = created["id"].as_str().unwrap().to_owned();

        let (status, renamed) = call(
            &router,
            "PATCH",
            &format!("/api/workspaces/{workspace_id}/boards/{extra_board_id}"),
            Some(json!({ "name": "已审阅", "sortOrder": 5 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(renamed["name"], "已审阅");
        assert_eq!(renamed["sortOrder"], 5);

        let (status, _) = call(
            &router,
            "DELETE",
            &format!("/api/workspaces/{workspace_id}/boards/{extra_board_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, body) = call(
            &router,
            "DELETE",
            &format!("/api/workspaces/{workspace_id}/boards/{default_board_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "conflict");
    }

    #[tokio::test]
    async fn board_documents_round_trip_and_guard_stale_revisions() {
        let (router, directory) = router_fixture("api-document").await;
        let root = directory.path().to_string_lossy().into_owned();
        let (_, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": root })),
        )
        .await;
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();
        let (_, boards) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/boards"),
            None,
        )
        .await;
        let board_id = boards[0]["id"].as_str().unwrap().to_owned();
        let document_uri = format!("/api/workspaces/{workspace_id}/boards/{board_id}/document");

        let (status, document) = call(&router, "GET", &document_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(document["board"]["id"], board_id.as_str());
        assert_eq!(document["nodes"], json!([]));
        assert_eq!(document["edges"], json!([]));
        assert_eq!(document["strokes"], json!([]));
        let expected_updated_at = document["board"]["updatedAt"].as_str().unwrap().to_owned();

        let now = chrono::Utc::now().to_rfc3339();
        let node_id = uuid::Uuid::now_v7().to_string();
        let body = json!({
            "expectedUpdatedAt": expected_updated_at,
            "nodes": [{
                "id": node_id,
                "boardId": board_id,
                "type": "note",
                "position": { "x": 10.0, "y": 20.0 },
                "size": { "width": 260.0, "height": 180.0 },
                "zoom": "focus",
                "data": { "kind": "note", "title": "便签", "status": "idle", "content": "hello" },
                "createdAt": now,
                "updatedAt": now
            }],
            "edges": [],
            "strokes": [{
                "id": uuid::Uuid::now_v7().to_string(),
                "color": "#5B5BD6",
                "width": 3.0,
                "points": [{ "x": 0.0, "y": 0.0 }, { "x": 4.0, "y": 5.0 }]
            }],
            "viewport": { "x": -12.0, "y": 8.0, "zoom": 0.5 }
        });
        let (status, saved) = call(&router, "PUT", &document_uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["nodes"][0]["boardId"], board_id.as_str());
        assert_eq!(saved["nodes"][0]["zoom"], "focus");
        assert_eq!(saved["strokes"][0]["width"], 3.0);
        assert_eq!(saved["board"]["viewport"]["zoom"], 0.5);
        assert!(saved.get("viewport").is_none());

        let (status, conflict) = call(&router, "PUT", &document_uri, Some(body)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(conflict["code"], "conflict");

        let (status, summaries) = call(&router, "GET", "/api/workspaces", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(summaries[0]["boards"][0]["nodeCount"], 1);
    }

    #[tokio::test]
    async fn git_and_adapter_routes_expose_the_v2_shapes() {
        let (router, directory) = router_fixture("api-git").await;
        let root = directory.path().to_string_lossy().into_owned();
        let (_, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": root })),
        )
        .await;
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();

        let (status, git_status) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/git/status"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(git_status["repository"], false);
        assert_eq!(git_status["branch"], Value::Null);
        assert_eq!(git_status["changedCount"], 0);
        // `ahead`/`behind` are optional keys, never `null`.
        assert!(git_status.get("ahead").is_none());
        assert!(git_status.get("behind").is_none());

        let (status, staged) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/git/stage"),
            Some(json!({ "paths": ["nothing.txt"] })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(staged["code"], "bad_request");

        let (status, adapters) = call(&router, "GET", "/api/agents", None).await;
        assert_eq!(status, StatusCode::OK);
        for adapter in adapters.as_array().unwrap() {
            assert!(adapter.get("resolvedPath").is_some());
            assert!(adapter["resolvedPath"].is_string() || adapter["resolvedPath"].is_null());
        }

        let (status, missing) = call(&router, "GET", "/api/terminals/does-not-exist", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(missing["code"], "not_found");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_sessions_report_their_pid_and_can_be_terminated() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("api-terminal.db").display()
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
        let pty = PtyManager::new(pool.clone());
        let router = crate::router_with_state(AppState {
            acp: crate::acp::AcpManager::new(pool.clone()),
            pool,
            pty: pty.clone(),
        });
        let session = pty
            .spawn(SpawnRequest {
                workspace_id: workspace.id,
                cwd: workspace.root_path.clone(),
                shell: None,
                command: Some("/bin/sh".into()),
                args: vec!["-c".into(), "sleep 5".into()],
                kind: "terminal".into(),
                owner_node_id: None,
                adapter: None,
            })
            .await
            .unwrap();
        assert!(session.pid.is_some());

        let (status, fetched) = call(
            &router,
            "GET",
            &format!("/api/terminals/{}", session.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched["pid"], session.pid.unwrap());
        assert_eq!(fetched["status"], "running");

        let (status, terminated) = call(
            &router,
            "POST",
            &format!("/api/terminals/{}/terminate", session.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(terminated["status"], "terminated");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_prompt_cannot_be_injected_into_a_plain_terminal_session() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("ownership.db").display()
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
        let pty = PtyManager::new(pool.clone());
        let terminal = pty
            .spawn(SpawnRequest {
                workspace_id: workspace.id.clone(),
                cwd: workspace.root_path.clone(),
                shell: None,
                command: Some("/bin/sh".into()),
                args: vec![],
                kind: "terminal".into(),
                owner_node_id: None,
                adapter: None,
            })
            .await
            .unwrap();
        let state = AppState {
            acp: crate::acp::AcpManager::new(pool.clone()),
            pool,
            pty,
        };
        let result = run_agent(
            State(state.clone()),
            Json(RunAgentRequest {
                workspace_id: workspace.id,
                agent_node_id: uuid::Uuid::now_v7().to_string(),
                adapter: AdapterId::Custom,
                command: Some("/bin/sh".into()),
                args: vec![],
                cwd: ".".into(),
                items: vec![],
                session_id: Some(terminal.id.clone()),
            }),
        )
        .await;
        assert!(matches!(result, Err(AppError::BadRequest(_))));
        let _ = state.pty.terminate(&terminal.id).await;
    }
}
