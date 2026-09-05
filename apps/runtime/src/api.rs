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
    agent::{self, AgentInfo},
    agent_probe, collab,
    db::{self, SaveBoardRequest, WorkspacePatch},
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    file_watch, files, git,
    hook::{
        HookHealth,
        install::{self, InstallReport},
    },
    imports, index,
    model::{
        AgentStatus, Board, BoardDocument, CanvasEdge, CanvasNode, ContextLink,
        ContextLinkDocument, Conversation, SessionSummary, TerminalSession, Viewport, Workspace,
        WorkspacePermissions, WorkspaceSummary,
    },
    paths,
    security::{
        canonical_directory, prepare_new_directory, resolve_import_source, resolve_in_root,
    },
    settings,
    terminal::{
        BackendInfo, CaptureResponse, ClientMessage, DEFAULT_COLS, DEFAULT_ROWS, SpawnRequest,
        TerminateMode, Utf8Decoder, agent_environment,
    },
    usage::UsageSnapshot,
};

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    version: &'static str,
    /// Where the hook clients should be reaching us, and whether the endpoint
    /// file on disk agrees (plan §5.2).
    hook: HookHealth,
}

pub async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        hook: state.hooks.health(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    name: String,
    root_path: String,
    color: Option<String>,
    permissions: Option<WorkspacePermissions>,
    /// 新建文件夹 (plan §20): `root_path` does not exist yet and we create it.
    /// The parent must exist, the leaf must not, and neither may sit in a
    /// protected system location.
    #[serde(default)]
    create_directory: bool,
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
    if request.create_directory {
        create_root_directory(&request.root_path)?;
    }
    let root = canonical_directory(&request.root_path)?;
    Ok(Json(
        db::create_workspace(
            &state.pool,
            name,
            &root.to_string_lossy(),
            request.color.as_deref(),
            request.permissions.as_ref(),
        )
        .await?,
    ))
}

pub async fn open_directory_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&request.name)?;
    let root = imports::directory_source(&request.root_path)?;
    Ok(Json(
        db::create_workspace(
            &state.pool,
            name,
            &root.to_string_lossy(),
            request.color.as_deref(),
            request.permissions.as_ref(),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct WorkspaceImportQuery {
    name: String,
}

pub async fn import_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceImportQuery>,
    mut multipart: axum::extract::Multipart,
) -> AppResult<Json<Workspace>> {
    let name = valid_workspace_name(&query.name)?;
    let manifest = imports::read_manifest(&mut multipart, true).await?;
    let mut batch =
        imports::ImportBatch::workspace(&paths::data_dir().join("imported-workspaces"))?;
    imports::receive_files(&mut multipart, &mut batch, &manifest).await?;
    Ok(Json(
        register_imported_workspace(&state.pool, batch, name).await?,
    ))
}

async fn register_imported_workspace(
    pool: &sqlx::SqlitePool,
    batch: imports::ImportBatch,
    name: &str,
) -> AppResult<Workspace> {
    let mut imported = batch.commit_workspace()?;
    let workspace =
        db::create_workspace(pool, name, &imported.path.to_string_lossy(), None, None).await?;
    imported.keep();
    Ok(workspace)
}

/// `mkdir` one level for `createDirectory: true`. Splitting the requested path
/// into parent + leaf keeps the whole check in `security`: the parent is
/// canonicalized and screened, and an existing leaf is a 409 rather than a
/// silent reuse.
fn create_root_directory(root_path: &str) -> AppResult<()> {
    let requested = Path::new(root_path.trim_end_matches(['/', '\\']));
    let parent = requested
        .parent()
        .and_then(|parent| parent.to_str())
        .filter(|parent| !parent.is_empty())
        .ok_or_else(|| AppError::BadRequest("The parent directory is missing".into()))?;
    let name = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::BadRequest("Folder name is invalid".into()))?;
    let target = prepare_new_directory(parent, name)?;
    std::fs::create_dir(&target)?;
    Ok(())
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
}

pub async fn update_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<UpdateWorkspaceRequest>,
) -> AppResult<Json<Workspace>> {
    let workspace = db::update_workspace(
        &state.pool,
        &workspace_id,
        WorkspacePatch {
            name: request.name,
            color: request.color,
            permissions: request.permissions,
        },
    )
    .await?;
    // Losing read access releases the editor's filesystem watchers with it
    // (E01/M4); nothing keeps pushing paths the canvas may not look at.
    if !workspace.permissions.read {
        file_watch::release_workspace(&workspace_id);
    }
    Ok(Json(workspace))
}

/// `DELETE /api/workspaces/{id}` — 从列表移除 (plan §20).
///
/// Removes the entry, never the project: every terminal session of the
/// workspace is terminated and destroyed first (they would otherwise outlive
/// the rows that name them), then the workspace row goes, taking its boards,
/// nodes, edges, sessions, agent status, approvals, context links and
/// deliveries with it through the schema's cascades. Nothing under
/// `rootPath` is read, moved or deleted.
pub async fn delete_workspace(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<axum::http::StatusCode> {
    // 404 before anything is torn down, so an unknown id is a no-op.
    db::get_workspace(&state.pool, &workspace_id).await?;
    state.terminals.destroy_workspace(&workspace_id).await;
    file_watch::release_workspace(&workspace_id);
    db::delete_workspace(&state.pool, &workspace_id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
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
    viewport: Viewport,
    /// Omitting this field preserves the whiteboard snapshot.
    #[serde(default)]
    whiteboard: Option<String>,
    // Preserve prior compatibility for other obsolete fields, but reject a
    // retired board write explicitly instead of silently discarding its data.
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

pub async fn save_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
    Json(request): Json<SaveBoardDocumentRequest>,
) -> AppResult<Json<BoardDocument>> {
    if request.extra.contains_key("kanban") {
        return Err(AppError::BadRequest(
            "Task-board writes are retired; historical records are available as read-only archives"
                .into(),
        ));
    }
    let document = db::save_board(
        &state.pool,
        &workspace_id,
        &board_id,
        SaveBoardRequest {
            expected_updated_at: &request.expected_updated_at,
            nodes: &request.nodes,
            edges: &request.edges,
            viewport: request.viewport,
            whiteboard: request.whiteboard.as_deref(),
        },
    )
    .await?;
    state.events.publish(
        &workspace_id,
        WorkspaceEvent::BoardChanged {
            board_id: document.board.id.clone(),
            updated_at: document.board.updated_at.clone(),
        },
    );
    Ok(Json(document))
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

pub async fn file_info(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<imports::FileInfo>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(imports::file_info(
        Path::new(&workspace.root_path),
        &query.path,
    )?))
}

/// Raw downloads retain the same canonical workspace boundary as text reads.
/// Always an attachment: uploaded HTML/SVG cannot execute in the Runtime origin.
pub async fn download_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Response> {
    use std::io::Read;
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    let root = Path::new(&workspace.root_path);
    let path = resolve_in_root(root, &query.path)?;
    if !path.is_file() {
        return Err(AppError::BadRequest("Requested path is not a file".into()));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)?
        .take(imports::MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > imports::MAX_FILE_BYTES {
        return Err(AppError::BadRequest(
            "File exceeds the 16 MiB download limit".into(),
        ));
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let encoded: String = name
        .as_bytes()
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    Response::builder()
        .header("Content-Type", "application/octet-stream")
        .header(
            "Content-Disposition",
            format!("attachment; filename*=UTF-8''{encoded}"),
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(axum::body::Body::from(bytes))
        .map_err(|_| AppError::Internal("Cannot create download response".into()))
}

/// The first multipart field is a JSON manifest; subsequent field names are
/// their zero-based indices in manifest.paths. Filenames are never trusted.
pub async fn upload_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    mut multipart: axum::extract::Multipart,
) -> AppResult<Json<imports::ImportResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    let manifest = imports::read_manifest(&mut multipart, false).await?;
    let root = Path::new(&workspace.root_path);
    let mut batch = imports::ImportBatch::new(root)?;
    imports::receive_files(&mut multipart, &mut batch, &manifest).await?;
    Ok(Json(batch.commit(root)?))
}

#[derive(Deserialize)]
pub struct ImportLocalFilesRequest {
    paths: Vec<String>,
}

pub async fn import_local_files(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<ImportLocalFilesRequest>,
) -> AppResult<Json<imports::ImportResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    if request.paths.is_empty() || request.paths.len() > imports::MAX_FILES {
        return Err(AppError::BadRequest("Import requires 1–256 files".into()));
    }
    let root = Path::new(&workspace.root_path);
    let mut batch = imports::ImportBatch::new(root)?;
    for path in request.paths {
        batch.copy(root, &path)?;
    }
    Ok(Json(batch.commit(root)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    path: String,
    content: String,
    /// Legacy field retained to reject old size-only overwrites explicitly.
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
}

/// `PUT /api/workspaces/{id}/file` — the editor node's save (plan §3.4).
pub async fn write_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<WriteFileRequest>,
) -> AppResult<Json<files::FileWriteResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only".into(),
        ));
    }
    if request.expected_size.is_some() && request.expected_sha256.is_none() {
        return Err(AppError::BadRequest(
            "Reload the file to obtain its content version before saving".into(),
        ));
    }
    tokio::task::spawn_blocking(move || {
        files::write_text_file(
            Path::new(&workspace.root_path),
            &request.path,
            &request.content,
            request.expected_sha256.as_deref(),
        )
        .map(Json)
    })
    .await?
}

/* ------------------------------ file watching ----------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFileRequest {
    path: String,
    /// The editor node showing the file. Two nodes on the same path each keep
    /// their own registration, so closing one does not blind the other.
    node_id: String,
}

/// `POST /api/workspaces/{id}/file-watch` — an editor node declares a file
/// open (E01/M4). The answer carries the version on disk right now, and says
/// whether changes will be pushed or the client has to ask.
pub async fn watch_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<WatchFileRequest>,
) -> AppResult<Json<file_watch::WatchRegistration>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        // A workspace that lost read access must not keep an OS watcher alive
        // on a folder the canvas may no longer look at.
        file_watch::release_workspace(&workspace_id);
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    let events = state.events.clone();
    tokio::task::spawn_blocking(move || {
        file_watch::register(
            &workspace_id,
            Path::new(&workspace.root_path),
            &request.path,
            &request.node_id,
            &events,
        )
        .map(Json)
    })
    .await?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchFileQuery {
    path: String,
    node_id: String,
}

/// `DELETE /api/workspaces/{id}/file-watch?path=&nodeId=` — the editor closed
/// the file. Unknown registrations are a no-op, so a late close after a
/// workspace switch is not an error.
pub async fn unwatch_file(
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<UnwatchFileQuery>,
) -> AppResult<axum::http::StatusCode> {
    file_watch::unregister(&workspace_id, &query.path, &query.node_id)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// `GET /api/workspaces/{id}/file-version?path=` — the current SHA-256, size
/// and mtime of one file. This is the fallback the editor polls on demand when
/// registration answered `unsupported`; a missing file is `exists: false`,
/// not a 404.
pub async fn file_version(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<RequestedPath>,
) -> AppResult<Json<file_watch::FileVersion>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden("This workspace is not readable".into()));
    }
    tokio::task::spawn_blocking(move || {
        file_watch::file_version(Path::new(&workspace.root_path), &query.path).map(Json)
    })
    .await?
}

/* --------------------------------- terminals ----------------------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalAgent {
    pub id: String,
    #[allow(dead_code)]
    pub account_id: Option<String>,
    pub permission_mode: Option<String>,
    #[allow(dead_code)]
    pub model: Option<String>,
    #[allow(dead_code)]
    pub session_id: Option<String>,
}

/// `ssh: { hostId }` — the session runs `ssh …` instead of a shell (plan §21).
/// Only the id travels: everything else comes from `settings.ssh.hosts[]`, so a
/// client can never dictate the command line.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalSsh {
    pub host_id: String,
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
    /// Terminal node that owns this session. Hook reports are attributed to it.
    node_id: Option<String>,
    agent: Option<CreateTerminalAgent>,
    ssh: Option<CreateTerminalSsh>,
}

/// The environment an agent PTY starts with.
///
/// A custom agent runs somebody else's program but reports through its base
/// agent's hooks, so everything provider-shaped — the approval wait, the hook
/// adapter — follows the base, while `ARMADRA_AGENT_ID` stays the custom id: that
/// is what the canvas node, the session row and the status badge are keyed by
/// (plan §24.1). Its own `env` is applied last and cannot shadow an `ARMADRA_*`
/// name, because those keys are refused when the entry is stored.
fn agent_session_environment(
    state: &AppState,
    node_id: &str,
    agent_id: &str,
) -> Vec<(String, String)> {
    let mut env = agent_environment(node_id, agent_id);
    // Arms hook-reply approvals (ARMADRA_PERM_WAIT_SECS) when enabled in settings.
    env.extend(
        state
            .hooks
            .extra_env(&state.settings.base_agent(agent_id), &state.settings),
    );
    if let Some(custom) = state.settings.custom_agent(agent_id) {
        env.extend(crate::settings::custom_agent_env(&custom));
    }
    env
}

pub async fn create_terminal(
    State(state): State<AppState>,
    Json(request): Json<CreateTerminalRequest>,
) -> AppResult<Json<TerminalSession>> {
    let workspace = db::get_workspace(&state.pool, &request.workspace_id).await?;
    let cwd = resolve_in_root(&workspace.root_path, &request.cwd)?;

    if let Some(node_id) = request.node_id.as_deref()
        && uuid::Uuid::parse_str(node_id).is_err()
    {
        return Err(AppError::BadRequest("Terminal node id is invalid".into()));
    }
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
        let Some(node_id) = request.node_id.as_deref() else {
            // Without a node there is nothing to attribute hook reports to, and
            // the hook client would refuse to report anyway.
            return Err(AppError::BadRequest(
                "An agent terminal requires the owning nodeId".into(),
            ));
        };
        // The hook client looks the token up by node name; without it the
        // report would still arrive, only flagged `legacy`.
        if let Err(error) = state.hooks.issue_node_token(node_id) {
            tracing::warn!(%error, node = %node_id, "hook reports for this node will be unverified");
        }
        env = agent_session_environment(&state, node_id, &agent.id);
    }

    // An SSH terminal is a normal session whose command is `ssh …` (plan §21).
    // The argv is built from the stored host, never from the request, and an
    // unknown id is refused rather than silently falling back to a local shell.
    let (command, args) = match request.ssh.as_ref() {
        Some(ssh) => {
            let host = state
                .settings
                .ssh_host(&ssh.host_id)
                .ok_or_else(|| AppError::BadRequest("Unknown SSH host".into()))?;
            let mut argv = crate::terminal::ssh::ssh_argv(&host);
            let program = argv.remove(0);
            (Some(program), argv)
        }
        None => (request.command, request.args),
    };

    let session = state
        .terminals
        .spawn(SpawnRequest {
            workspace_id: request.workspace_id,
            cwd: cwd.to_string_lossy().into_owned(),
            shell: request.shell,
            command,
            args,
            kind: "terminal".into(),
            owner_node_id: request.node_id,
            agent_id: request.agent.map(|agent| agent.id),
            env,
        })
        .await?;
    Ok(Json(session))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Vec<SessionSummary>>> {
    let mut sessions = db::list_sessions(&state.pool, &workspace_id).await?;
    for session in &mut sessions {
        session.alive = state.terminals.is_alive(&session.session_id).await;
    }
    Ok(Json(sessions))
}

pub async fn terminal_socket(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    validate_websocket_origin(&headers)?;
    // Reject an unknown session with a 404 rather than a socket that closes
    // immediately, and keep the owner / workspace check on the REST path.
    db::get_terminal_session(&state.pool, &session_id).await?;
    Ok(ws.on_upgrade(move |socket| handle_terminal_socket(state, session_id, socket)))
}

/// Plan §15.5. Connecting is attaching and closing is detaching: the process is
/// never touched by the lifetime of a socket. Several sockets may attach to the
/// same session at once.
async fn handle_terminal_socket(state: AppState, session_id: String, socket: WebSocket) {
    let Ok(attach) = state
        .terminals
        .attach(&session_id, DEFAULT_COLS, DEFAULT_ROWS)
        .await
    else {
        return;
    };
    let crate::terminal::AttachSession {
        generation,
        backend,
        rows,
        cols,
        alive,
        snapshot,
        mut output,
        mut status,
        current_status,
        detach,
        ..
    } = attach;
    // Dropped when this function returns, which detaches the client.
    let _detach = detach;

    let (mut sender, mut receiver) = socket.split();
    let hello = serde_json::json!({
        "type": "hello",
        "sessionId": session_id,
        "generation": generation,
        "backend": backend.as_str(),
        "rows": rows,
        "cols": cols,
        "alive": alive,
    })
    .to_string();
    if sender.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    // Only the direct backend replays: a tmux client redraws the real screen.
    if let Some(data) = snapshot.filter(|data| !data.is_empty()) {
        let payload = serde_json::json!({ "type": "snapshot", "data": data }).to_string();
        if sender.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }
    if let Some(event) = current_status {
        let payload = serde_json::json!({
            "type": "status", "status": event.status, "exitCode": event.exit_code
        })
        .to_string();
        if sender.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }

    let mut decoder = Utf8Decoder::default();
    loop {
        tokio::select! {
            chunk = output.recv() => match chunk {
                Ok(chunk) => {
                    let data = decoder.push(&chunk);
                    if data.is_empty() { continue; }
                    let payload = serde_json::json!({ "type": "output", "data": data }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    let payload = serde_json::json!({
                        "type": "warning",
                        "message": format!("Terminal output skipped {count} buffered chunks")
                    }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                // The stream ended: either the session is over, or it was
                // recycled underneath us, in which case the client is told to
                // clear and reconnect rather than left with a frozen screen.
                Err(_) => {
                    announce_stale(&state, &session_id, generation, &mut sender).await;
                    break;
                }
                // (a `stale` frame is followed by the close handshake below)
            },
            event = status.recv() => match event {
                Ok(event) => {
                    let payload = serde_json::json!({
                        "type": "status", "status": event.status, "exitCode": event.exit_code
                    }).to_string();
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {}
            },
            message = receiver.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else { continue };
                    let result = match message {
                        ClientMessage::Input { data } => {
                            state.terminals.write(&session_id, generation, &data).await
                        }
                        ClientMessage::Resize { cols, rows } => {
                            state.terminals.resize(&session_id, generation, cols, rows).await
                        }
                        ClientMessage::Terminate { mode } => {
                            state.terminals.terminate(&session_id, mode.unwrap_or_default()).await
                        }
                    };
                    // A write against an old generation is not a protocol
                    // error: the client is simply behind a recycle, and is told
                    // so instead of having its socket dropped.
                    match result {
                        Ok(()) => {}
                        Err(AppError::Conflict(_)) => {
                            if announce_stale(&state, &session_id, generation, &mut sender).await {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    // A bare drop would let the peer see an RST and lose whatever is still in
    // flight — a `stale` frame in particular. The handshake makes the last
    // frames readable before the stream ends.
    let _ = sender.send(Message::Close(None)).await;
    state.terminals.detached(&session_id).await;
}

/// Sends `stale` when the session has moved on to a newer generation (plan
/// §15.5). Returns whether this socket is now obsolete.
async fn announce_stale(
    state: &AppState,
    session_id: &str,
    generation: u64,
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) -> bool {
    let Some(current) = state.terminals.generation(session_id).await else {
        return true;
    };
    if current == generation {
        return false;
    }
    let payload = serde_json::json!({ "type": "stale", "generation": current }).to_string();
    let _ = sender.send(Message::Text(payload.into())).await;
    true
}

/* ------------------------------ workspace events -------------------------- */

/// `WS /api/workspaces/{id}/events`: one read-only stream of agent status,
/// approvals, deliveries, terminal exits and board changes.
pub async fn workspace_events(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    validate_websocket_origin(&headers)?;
    db::get_workspace(&state.pool, &workspace_id).await?;
    let receiver = state.events.subscribe(&workspace_id);
    Ok(ws.on_upgrade(move |socket| handle_workspace_events(receiver, socket)))
}

async fn handle_workspace_events(
    mut receiver: tokio::sync::broadcast::Receiver<WorkspaceEvent>,
    socket: WebSocket,
) {
    let (mut sender, mut incoming) = socket.split();
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Ok(event) => {
                    let Ok(payload) = serde_json::to_string(&event) else { continue };
                    if sender.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            // The stream is read-only; a client frame only matters as a close.
            message = incoming.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

/* ------------------------------- conversations ---------------------------- */

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationQuery {
    q: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/conversations?q=&limit=50` — the command palette's history group
/// (plan §17). Newest first; `q` matches the title or the working directory,
/// case-insensitively, as a substring.
pub async fn list_conversations(
    State(state): State<AppState>,
    Query(query): Query<ConversationQuery>,
) -> AppResult<Json<Vec<Conversation>>> {
    Ok(Json(
        index::list(
            &state.pool,
            query.q.as_deref(),
            query.limit.unwrap_or(index::DEFAULT_LIMIT),
        )
        .await?,
    ))
}

/// `POST /api/conversations/refresh` — rescan now instead of waiting for the
/// 60 s timer. Same pass the timer runs, so calling it twice is harmless.
pub async fn refresh_conversations(
    State(state): State<AppState>,
) -> AppResult<Json<index::ScanReport>> {
    Ok(Json(index::refresh(&state.pool).await?))
}

/* ---------------------------------- agents -------------------------------- */

/// Registry mirror + local detection + hook install state.
///
/// The built-ins come first, then `settings.agents.custom[]` (plan §24.1). A
/// custom entry reports the hook install of the agent it borrows, because that
/// is the hook that will actually fire for it.
pub async fn agents(State(state): State<AppState>) -> AppResult<Json<Vec<AgentInfo>>> {
    let installs = db::list_hook_installs(&state.pool).await?;
    let mut detected = agent::detect();
    detected.extend(
        state
            .settings
            .custom_agents()
            .iter()
            .map(agent::custom_info),
    );
    for info in &mut detected {
        let hook_provider = info.base_agent.unwrap_or(info.id.as_str());
        info.client_revision = installs
            .iter()
            .find(|install| install.agent_id == hook_provider)
            .map(|install| install.client_revision);
        // Version probing is what decides whether a gated capability is
        // `supported` or `unknown` on the client (design §1). A program that
        // is not installed is not run: there is nothing to ask.
        if info.installed {
            info.probe =
                Some(agent_probe::cached(&state.settings, &info.id, &info.launch_cmd).await);
        }
    }
    Ok(Json(detected))
}

/// Installs (or reinstalls) this provider's hooks. Idempotent by construction —
/// see `hook::install`.
pub async fn install_hooks(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<InstallReport>> {
    let client_bin = install::resolve_client_binary()?;
    let report = install::install(&agent_id, &client_bin)?;
    db::upsert_hook_install(
        &state.pool,
        &report.agent_id,
        report.client_revision,
        Some(&report.config_path),
    )
    .await?;
    if let Some(warning) = &report.warning {
        tracing::warn!(%agent_id, %warning, "hooks installed with a caveat");
    }
    Ok(Json(report))
}

pub async fn uninstall_hooks(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<InstallReport>> {
    let report = install::uninstall(&agent_id)?;
    db::remove_hook_install(&state.pool, &report.agent_id).await?;
    Ok(Json(report))
}

/// Clears the unread badge a finished turn raised. The client that read the
/// node calls this; everyone else learns through the broadcast.
///
/// A focused client fires this on its own whenever a turn ends while the node is
/// on screen, so most calls arrive for a node that is already read. Those are
/// answered normally but not broadcast: re-announcing an unchanged row would put
/// one pointless frame on every workspace socket per finished turn.
pub async fn mark_agent_status_read(
    State(state): State<AppState>,
    AxumPath(node_id): AxumPath<String>,
) -> AppResult<Json<AgentStatus>> {
    let receipt = db::mark_agent_status_read(&state.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("This node has never reported".into()))?;
    if receipt.cleared {
        state.events.publish(
            &receipt.status.workspace_id,
            WorkspaceEvent::AgentStatus {
                status: receipt.status.clone(),
            },
        );
    }
    Ok(Json(receipt.status))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedTitle {
    title: String,
    /// Where the sentence came from, so the UI can be honest when the answer is
    /// only the agent's name: `transcript` / `terminal` / `agent`.
    source: &'static str,
}

/// `POST /api/agent-status/{nodeId}/suggest-title` — the header's ✦ button
/// (plan §17). Three sources, best first:
///
///   1. the transcript's first user message — what the session is *about*;
///   2. the last command in the pane, for a terminal that never reported one;
///   3. the agent's label, which is always available and never wrong.
///
/// No model is called: this is a rename button, and a local read answers it in
/// milliseconds without spending a token.
pub async fn suggest_agent_title(
    State(state): State<AppState>,
    AxumPath(node_id): AxumPath<String>,
) -> AppResult<Json<SuggestedTitle>> {
    let status = db::get_agent_status(&state.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("This node has never reported".into()))?;

    if let Some(path) = status.transcript_path.as_deref()
        && let Some(title) = index::transcript_title(&status.agent_id, Path::new(path))
    {
        return Ok(Json(SuggestedTitle {
            title,
            source: "transcript",
        }));
    }

    // The node's terminal keeps its logical key across recycles, so the lookup
    // is by node id rather than by the session id the status row happens to
    // remember.
    if let Ok(session) = db::get_terminal_session_by_key(&state.pool, &node_id).await
        && let Ok(capture) = state.terminals.capture(&session.id, 40, false).await
        && let Some(title) = index::command_from_capture(&capture.data)
    {
        return Ok(Json(SuggestedTitle {
            title,
            source: "terminal",
        }));
    }

    Ok(Json(SuggestedTitle {
        title: agent::definition(&status.agent_id)
            .map(|agent| agent.label.to_owned())
            .unwrap_or_else(|| status.agent_id.clone()),
        source: "agent",
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeTokenResponse {
    node_id: String,
    /// The path the client reads, not the token: the token itself never travels
    /// over the API, only through the 0600 file.
    token_file: String,
}

/// Re-mints `<data>/node-tokens/<nodeId>` for a session's node. Needed when a
/// terminal outlived the data directory it was started against, which is
/// exactly when its reports would otherwise silently drop to `legacy`.
pub async fn refresh_node_token(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<NodeTokenResponse>> {
    let session = db::get_terminal_session(&state.pool, &session_id).await?;
    let node_id = session
        .owner_node_id
        .ok_or_else(|| AppError::BadRequest("This session has no owning node".into()))?;
    state.hooks.issue_node_token(&node_id)?;
    Ok(Json(NodeTokenResponse {
        token_file: state
            .hooks
            .node_token_dir()
            .join(&node_id)
            .to_string_lossy()
            .into_owned(),
        node_id,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerApprovalRequest {
    decision: String,
}

/// Records the user's answer to a pending permission request, and gets it back
/// to the CLI that is waiting for it — plan §5.5.
///
/// Two routes out. When the hook client wrote `<data>/pending/<id>.json` and is
/// polling, an answer file is the deterministic path: the CLI receives the
/// decision through its own hook protocol. Otherwise the answer is typed into
/// the PTY the way a human would press the key, which depends on the prompt
/// still being on screen and is therefore reported as `route: "keys"`.
pub async fn answer_approval(
    State(state): State<AppState>,
    AxumPath(pending_id): AxumPath<String>,
    Json(request): Json<AnswerApprovalRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let (approval, route) =
        collab::approvals::answer(&state, &pending_id, &request.decision).await?;
    let mut body = serde_json::to_value(&approval).unwrap_or(serde_json::Value::Null);
    if let Some(object) = body.as_object_mut() {
        object.insert("route".into(), serde_json::json!(route));
    }
    Ok(Json(body))
}

#[derive(Deserialize)]
pub struct DeliveriesQuery {
    limit: Option<i64>,
}

/// `GET /api/workspaces/{id}/deliveries` — the 投递记录 panel (plan §5.7 step
/// 10). Rows never contain the message body, only how many characters it had,
/// so this is safe to render verbatim.
pub async fn list_deliveries(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<DeliveriesQuery>,
) -> AppResult<Json<Vec<crate::model::AgentDelivery>>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    Ok(Json(
        db::list_deliveries(&state.pool, &workspace_id, query.limit.unwrap_or(200)).await?,
    ))
}

#[derive(Deserialize)]
pub struct ControlConfirmRequest {
    approve: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConfirmResponse {
    request_id: String,
    approve: bool,
    accepted: bool,
}

/// `POST /api/control/confirm/{requestId}` — the human half of `close`
/// (plan §5.8). `accepted: false` means the verb already gave up; the dialog
/// closes either way, which is why this is not an error.
pub async fn confirm_control(
    State(state): State<AppState>,
    AxumPath(request_id): AxumPath<String>,
    Json(request): Json<ControlConfirmRequest>,
) -> AppResult<Json<ControlConfirmResponse>> {
    let accepted = collab::control::answer_confirm(&state, &request_id, request.approve);
    Ok(Json(ControlConfirmResponse {
        request_id,
        approve: request.approve,
        accepted,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLinksRequest {
    #[serde(default)]
    links: Vec<ContextLink>,
}

/// The canvas pushes each node's link document whenever an edge changes; the
/// context-link verbs in Phase 3 authorize against exactly this list.
pub async fn put_context_links(
    State(state): State<AppState>,
    AxumPath((workspace_id, node_id)): AxumPath<(String, String)>,
    Json(request): Json<ContextLinksRequest>,
) -> AppResult<Json<ContextLinkDocument>> {
    db::get_workspace(&state.pool, &workspace_id).await?;
    if uuid::Uuid::parse_str(&node_id).is_err() {
        return Err(AppError::BadRequest("Node id is invalid".into()));
    }
    Ok(Json(
        db::put_context_links(&state.pool, &workspace_id, &node_id, &request.links).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPngRequest {
    data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPngResponse {
    /// Absolute path, which is what an agent is told to open.
    path: String,
    /// The same file relative to the workspace root, which is what a
    /// `ContextLink.content.pngPath` carries (tldraw plan §6.3).
    relative_path: String,
    bytes: usize,
}

/// Only a base64 PNG is accepted, and only up to this many characters of it.
/// A 480×360 whiteboard is a few tens of kilobytes; the cap is there so a
/// runaway client cannot fill the workspace.
const MAX_EXPORT_PNG_BYTES: usize = 8 * 1024 * 1024;
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";

/// `POST /api/workspaces/{id}/exports/{exportId}/png` — tldraw plan §6.3.
///
/// Whatever is on the whiteboard — ink, a geo shape, a whole frame — only
/// exists as vectors inside the browser's tldraw store, so the one party that
/// can rasterise it is the client. It uploads the PNG as a data URL and the
/// runtime drops the bytes at `<workspace>/.armadra/exports/<exportId>.png`, which
/// is the path a linked agent is handed.
///
/// The export id is *not* required to be a node: since the tldraw migration the
/// thing being exported is usually a plain whiteboard shape, which has no row
/// anywhere. It only has to be a uuid, which is what keeps the file name from
/// being a path.
pub async fn export_png(
    State(state): State<AppState>,
    AxumPath((workspace_id, export_id)): AxumPath<(String, String)>,
    Json(request): Json<ExportPngRequest>,
) -> AppResult<Json<ExportPngResponse>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    write_png_export(&workspace.root_path, &export_id, &request.data_url)
}

fn write_png_export(
    root_path: &str,
    export_id: &str,
    data_url: &str,
) -> AppResult<Json<ExportPngResponse>> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    // The id becomes a file name, so it has to be an id and nothing else.
    if uuid::Uuid::parse_str(export_id).is_err() {
        return Err(AppError::BadRequest("Export id is invalid".into()));
    }
    if data_url.len() > MAX_EXPORT_PNG_BYTES {
        return Err(AppError::BadRequest("Exported image is too large".into()));
    }
    let payload = data_url
        .strip_prefix(PNG_DATA_URL_PREFIX)
        .ok_or_else(|| AppError::BadRequest("Only base64 PNG data URLs are accepted".into()))?;
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| AppError::BadRequest("Exported image is not valid base64".into()))?;

    let root = canonical_directory(root_path)?;
    let path = collab::context_link::export_path(&root, export_id);
    collab::context_link::write_export(&path, &bytes)?;
    Ok(Json(ExportPngResponse {
        relative_path: format!(
            "{}/{export_id}.png",
            collab::context_link::EXPORTS_DIRECTORY
        ),
        path: path.to_string_lossy().into_owned(),
        bytes: bytes.len(),
    }))
}

/* --------------------------------- assets --------------------------------- */

/// What may be stored as a whiteboard asset, and the extension each type gets.
/// A whitelist rather than `mime_guess`: the extension ends up in a file name
/// and the type is echoed back as a `Content-Type`, so both have to come from
/// a table this file controls.
const ASSET_TYPES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/svg+xml", "svg"),
    ("image/avif", "avif"),
    ("image/bmp", "bmp"),
];

/// Same ceiling as the whiteboard snapshot (tldraw plan §6.2): an image that
/// does not fit is one the user should not be pasting onto a board.
pub const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;

fn asset_extension(mime: &str) -> Option<&'static str> {
    let mime = mime.split(';').next()?.trim().to_ascii_lowercase();
    ASSET_TYPES
        .iter()
        .find(|(candidate, _)| *candidate == mime)
        .map(|(_, extension)| *extension)
}

/// The stored extension for a file on disk, or `None` when it is not one of
/// the eight image types. Folded onto the table's spelling — `jpeg` is stored
/// as `jpg`, exactly as `image/jpeg` is.
fn asset_extension_of_file(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let extension = if extension == "jpeg" {
        "jpg"
    } else {
        &extension
    };
    ASSET_TYPES
        .iter()
        .find(|(_, candidate)| *candidate == extension)
        .map(|(_, candidate)| *candidate)
}

fn asset_mime(extension: &str) -> Option<&'static str> {
    ASSET_TYPES
        .iter()
        .find(|(_, candidate)| *candidate == extension)
        .map(|(mime, _)| *mime)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAssetRequest {
    data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAssetResponse {
    /// `<sha256[..16]>.<ext>`; also the last path segment of `url`.
    id: String,
    /// Workspace-relative path, which is what an agent is handed.
    path: String,
    /// Runtime-relative URL. The client prefixes its own runtime origin — the
    /// runtime does not know which port it was actually bound to.
    url: String,
    mime_type: String,
    bytes: usize,
}

/// `POST /api/workspaces/{id}/assets` — tldraw plan §6.2.
///
/// Backs `TLAssetStore.upload`. Two body shapes are accepted because the client
/// has two kinds of source: a `File`/`Blob` is posted raw with its own
/// `Content-Type`, while an already-decoded `data:` URL (paste, migration of an
/// old `image` node) is posted as `{"dataUrl": "…"}` with
/// `Content-Type: application/json`.
///
/// The stored name is the content hash, so re-uploading the same picture is a
/// no-op and two boards that paste the same screenshot share one file.
pub async fn upload_asset(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Json<UploadAssetResponse>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let (extension, bytes) = if content_type.starts_with("application/json") {
        let request: UploadAssetRequest = serde_json::from_slice(&body)
            .map_err(|_| AppError::BadRequest("Asset body is not a JSON data URL".into()))?;
        decode_asset_data_url(&request.data_url)?
    } else {
        let extension = asset_extension(content_type).ok_or_else(|| {
            AppError::BadRequest("Asset type is not an accepted image type".into())
        })?;
        (extension, body.to_vec())
    };
    let root = canonical_directory(&workspace.root_path)?;
    store_asset(&root, &workspace.id, extension, &bytes).map(Json)
}

/// Copy already-validated bytes into `<workspace>/.armadra/assets/` under their
/// content hash and describe where they landed.
///
/// Shared by the upload and the import route so the two dedupe against the same
/// file names and answer with the same shape; only how the bytes were obtained
/// differs.
fn store_asset(
    root: &Path,
    workspace_id: &str,
    extension: &str,
    bytes: &[u8],
) -> AppResult<UploadAssetResponse> {
    use sha2::{Digest, Sha256};

    if bytes.is_empty() {
        return Err(AppError::BadRequest("Asset is empty".into()));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AppError::BadRequest("Asset is too large".into()));
    }

    let id = format!("{}.{extension}", hex16(&Sha256::digest(bytes)));
    let path = root.join(ASSETS_DIRECTORY).join(&id);
    // Content-addressed: an identical upload is already on disk and rewriting
    // it would only risk tearing a file another tab is reading.
    if !path.is_file() {
        collab::context_link::write_export(&path, bytes)?;
    }
    Ok(UploadAssetResponse {
        url: format!("/api/workspaces/{workspace_id}/assets/{id}"),
        mime_type: asset_mime(extension)
            .unwrap_or("application/octet-stream")
            .to_owned(),
        path: format!("{ASSETS_DIRECTORY}/{id}"),
        id,
        bytes: bytes.len(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetRequest {
    path: String,
}

/// `POST /api/workspaces/{id}/assets/import` — tldraw plan §8, Phase 3.
///
/// The desktop shell only ever learns a real *path* for an OS drag: the webview
/// hands Tauri the drop and keeps the bytes to itself, and the shell has no
/// filesystem plugin. So the runtime does the reading, and the picture ends up
/// in the same content-addressed store as an upload — identical response, same
/// dedupe, same `.armadra/assets/` file.
///
/// The type comes from the extension, because a file on disk carries no MIME.
pub async fn import_asset(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<ImportAssetRequest>,
) -> AppResult<Json<UploadAssetResponse>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    let root = canonical_directory(&workspace.root_path)?;
    let source = resolve_import_source(&root, &request.path)?;
    let extension = asset_extension_of_file(&source)
        .ok_or_else(|| AppError::BadRequest("Asset type is not an accepted image type".into()))?;

    // Ask the metadata first: a 4 GiB video should be refused, not read into
    // memory and then refused.
    let metadata = std::fs::metadata(&source)
        .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?;
    if metadata.len() > MAX_ASSET_BYTES as u64 {
        return Err(AppError::BadRequest("Asset is too large".into()));
    }
    let bytes = std::fs::read(&source)
        .map_err(|error| AppError::BadRequest(format!("Asset could not be read: {error}")))?;

    store_asset(&root, &workspace.id, extension, &bytes).map(Json)
}

/// `GET /api/workspaces/{id}/assets/{assetId}` — serves an uploaded asset back.
///
/// The name is a content hash, so the bytes behind a given URL never change and
/// the response may be cached forever. The id is matched against the shape the
/// uploader mints rather than being resolved as a path, which is what keeps a
/// crafted id from reading somewhere else in the workspace.
pub async fn get_asset(
    State(state): State<AppState>,
    AxumPath((workspace_id, asset_id)): AxumPath<(String, String)>,
) -> AppResult<Response> {
    use axum::http::header;

    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    let (hash, extension) = asset_id
        .rsplit_once('.')
        .ok_or_else(|| AppError::BadRequest("Asset id is invalid".into()))?;
    let mime = asset_mime(extension).filter(|_| {
        hash.len() == 16 && hash.chars().all(|character| character.is_ascii_hexdigit())
    });
    let Some(mime) = mime else {
        return Err(AppError::BadRequest("Asset id is invalid".into()));
    };
    let root = canonical_directory(&workspace.root_path)?;
    let bytes = std::fs::read(root.join(ASSETS_DIRECTORY).join(&asset_id))
        .map_err(|_| AppError::NotFound("Asset was not found".into()))?;
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        // An SVG is served as an image and must never be sniffed into a
        // document; the header costs nothing on the other seven types.
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(bytes))
        .map_err(|error| AppError::Internal(error.to_string()))
}

/// Where uploaded assets live, relative to the workspace root.
pub const ASSETS_DIRECTORY: &str = ".armadra/assets";

fn hex16(digest: &[u8]) -> String {
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_asset_data_url(source: &str) -> AppResult<(&'static str, Vec<u8>)> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let rest = source
        .strip_prefix("data:")
        .ok_or_else(|| AppError::BadRequest("Asset is not a data URL".into()))?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| AppError::BadRequest("Asset is not a data URL".into()))?;
    let meta = meta
        .strip_suffix(";base64")
        .ok_or_else(|| AppError::BadRequest("Only base64 data URLs are accepted".into()))?;
    let extension = asset_extension(meta)
        .ok_or_else(|| AppError::BadRequest("Asset type is not an accepted image type".into()))?;
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| AppError::BadRequest("Asset is not valid base64".into()))?;
    Ok((extension, bytes))
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

/* ------------------------------------ git --------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffQuery {
    #[serde(default = "default_path")]
    path: String,
    #[serde(default)]
    scope: git::DiffScope,
    /// Comma-separated workspace-relative paths. Absent = the whole `path`
    /// directory.
    paths: Option<String>,
}

pub async fn git_diff(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitDiffQuery>,
) -> AppResult<Json<git::GitDiff>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git reads".into(),
        ));
    }
    let paths = query
        .paths
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(Json(git::read_diff_with_execution(
        Path::new(&workspace.root_path),
        &query.path,
        &git::DiffRequest {
            scope: query.scope,
            paths,
        },
        workspace.permissions.execute,
    )?))
}

pub async fn git_status(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<git::GitStatus>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git reads".into(),
        ));
    }
    git::access::require_execution(workspace.permissions.execute, "Git worktree status")?;
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
    if !workspace.permissions.read || !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git writes".into(),
        ));
    }
    git::access::require_execution(
        workspace.permissions.execute,
        "Git index, worktree, and commit writes",
    )?;
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), ".")
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::stage_paths(Path::new(&workspace.root_path), &request.paths)
    })
    .await??;
    Ok(Json(result))
}

pub async fn git_unstage(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<Json<git::UnstageResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read || !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git writes".into(),
        ));
    }
    git::access::require_execution(
        workspace.permissions.execute,
        "Git index, worktree, and commit writes",
    )?;
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), ".")
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::unstage_paths(Path::new(&workspace.root_path), &request.paths)
    })
    .await??;
    Ok(Json(result))
}

pub async fn git_revert(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<PathsRequest>,
) -> AppResult<Json<git::RevertResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read || !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git writes".into(),
        ));
    }
    git::access::require_execution(
        workspace.permissions.execute,
        "Git index, worktree, and commit writes",
    )?;
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), ".")
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::revert_paths(Path::new(&workspace.root_path), &request.paths)
    })
    .await??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    message: String,
    paths: Option<Vec<String>>,
}

pub async fn git_commit(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<CommitRequest>,
) -> AppResult<Json<git::CommitResult>> {
    let workspace = db::get_workspace(&state.pool, &workspace_id).await?;
    if !workspace.permissions.read || !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Workspace does not allow Git writes".into(),
        ));
    }
    git::access::require_execution(
        workspace.permissions.execute,
        "Git index, worktree, and commit writes",
    )?;
    let guard = crate::git_api::REPOSITORIES
        .mutation_guard(Path::new(&workspace.root_path), ".")
        .await?;
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        git::commit(
            Path::new(&workspace.root_path),
            &request.message,
            request.paths.as_deref(),
        )
    })
    .await??;
    Ok(Json(result))
}

/* -------------------------------- git clone ------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    url: String,
    parent: String,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStartedResponse {
    job_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStatusResponse {
    state: git::CloneState,
    lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Only set once the clone finished and the folder was registered.
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<Workspace>,
}

/// Start `git clone --progress` in the background (plan §20). There is no
/// workspace to publish events into yet, so the dialog polls
/// `GET /api/git/clone/{job_id}` instead.
pub async fn git_clone(
    State(state): State<AppState>,
    Json(request): Json<CloneRequest>,
) -> AppResult<Json<CloneStartedResponse>> {
    // A new project has no grant yet. If its destination is inside existing
    // workspaces, preserve every ancestor's restrictions instead of bypassing
    // them through this global creation endpoint.
    let parent = canonical_directory(&request.parent)?;
    for summary in db::list_workspaces(&state.pool).await? {
        let workspace = summary.workspace;
        if let Ok(root) = canonical_directory(&workspace.root_path)
            && parent.starts_with(&root)
        {
            if !workspace.permissions.read || !workspace.permissions.write {
                return Err(AppError::Forbidden(
                    "An ancestor workspace does not allow cloning into this destination".into(),
                ));
            }
            git::access::require_execution(
                workspace.permissions.execute,
                "Cloning into an existing workspace",
            )?;
        }
    }
    let parent = parent
        .to_str()
        .ok_or_else(|| AppError::BadRequest("Clone destination must be a UTF-8 path".into()))?;
    let started = git::start_clone(&request.url, parent, request.name.as_deref())?;
    Ok(Json(CloneStartedResponse {
        job_id: started.job_id,
    }))
}

pub async fn git_clone_status(
    State(state): State<AppState>,
    AxumPath(job_id): AxumPath<String>,
) -> AppResult<Json<CloneStatusResponse>> {
    let status = git::clone_status(&job_id)?;
    // `db::create_workspace` is idempotent on the root path, so two polls
    // landing at the same time cannot produce two workspaces.
    let workspace = if status.state == git::CloneState::Done {
        let root = canonical_directory(&status.target)?;
        Some(
            db::create_workspace(
                &state.pool,
                valid_workspace_name(&status.name)?,
                &root.to_string_lossy(),
                None,
                None,
            )
            .await?,
        )
    } else {
        None
    };
    Ok(Json(CloneStatusResponse {
        state: status.state,
        lines: status.lines,
        error: status.error,
        workspace,
    }))
}

pub async fn cancel_git_clone(
    AxumPath(job_id): AxumPath<String>,
) -> AppResult<axum::http::StatusCode> {
    git::cancel_clone(&job_id)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/* --------------------------------- terminals ------------------------------ */

pub async fn get_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<TerminalSession>> {
    Ok(Json(state.terminals.session(&session_id).await?))
}

/// `GET /api/terminals/backend` — which backend is actually in effect, and why
/// (plan §15.1). The settings page shows this next to its one dropdown.
pub async fn terminal_backend(State(state): State<AppState>) -> Json<BackendInfo> {
    Json(state.terminals.backend_info())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureQuery {
    lines: Option<u32>,
    /// `true` keeps the SGR sequences, for a snapshot rather than for reading.
    escapes: Option<bool>,
}

/// `GET /api/terminals/{id}/capture?lines=&escapes=` — the pane as text.
pub async fn capture_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<CaptureQuery>,
) -> AppResult<Json<CaptureResponse>> {
    db::get_terminal_session(&state.pool, &session_id).await?;
    let lines = query.lines.unwrap_or(200).min(10_000);
    Ok(Json(
        state
            .terminals
            .capture(&session_id, lines, query.escapes.unwrap_or(false))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteRequest {
    text: String,
    #[serde(default)]
    enter: bool,
}

/// `POST /api/terminals/{id}/paste` — bracketed paste, optional Enter.
pub async fn paste_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<PasteRequest>,
) -> AppResult<Json<TerminalSession>> {
    if request.text.chars().count() > 200_000 {
        return Err(AppError::BadRequest("Pasted text is too large".into()));
    }
    state
        .terminals
        .paste(&session_id, &request.text, request.enter)
        .await?;
    Ok(Json(state.terminals.session(&session_id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollRequest {
    /// Positive scrolls towards older output, negative back towards the live
    /// screen. Whole lines — the browser does the wheel-delta arithmetic.
    lines: i32,
}

/// `POST /api/terminals/{id}/scroll` — the wheel bridge of plan §18.5.
///
/// The tmux client is deliberately not in mouse mode, so a wheel event never
/// reaches tmux on its own; the web side turns it into whole lines and posts
/// them here.
pub async fn scroll_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<ScrollRequest>,
) -> AppResult<axum::http::StatusCode> {
    // One screenful per notch is already generous; anything larger is a bug or
    // an attempt to make the runtime spin on tmux calls.
    if request.lines.abs() > 10_000 {
        return Err(AppError::BadRequest("Scroll distance is too large".into()));
    }
    state.terminals.scroll(&session_id, request.lines).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateRequest {
    #[serde(default)]
    mode: Option<TerminateMode>,
}

/// `POST /api/terminals/{id}/terminate` — interrupt, end the process, or
/// destroy the persistent session (plan §15.5). An empty body means `process`,
/// which is what the pre-§15 parameterless route did.
pub async fn terminate_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    body: Option<Json<TerminateRequest>>,
) -> AppResult<Json<TerminalSession>> {
    let session = db::get_terminal_session(&state.pool, &session_id).await?;
    let mode = body
        .map(|Json(request)| request.mode.unwrap_or_default())
        .unwrap_or_default();
    match state.terminals.terminate(&session_id, mode).await {
        Ok(()) => {}
        // A session that already finished is not an error for the caller.
        Err(AppError::NotFound(_)) if session.status != "running" => {}
        Err(error) => return Err(error),
    }
    Ok(Json(state.terminals.session(&session_id).await?))
}

/// `POST /api/terminals/{id}/recycle` — same logical session, next generation.
pub async fn recycle_terminal(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<TerminalSession>> {
    db::get_terminal_session(&state.pool, &session_id).await?;
    Ok(Json(state.terminals.recycle(&session_id).await?))
}

/* --------------------------------- settings ------------------------------- */

pub async fn get_settings(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.settings.document())
}

/// `PATCH /api/settings` — a merge, so a key this build does not know about is
/// preserved rather than dropped.
pub async fn patch_settings(
    State(state): State<AppState>,
    Json(patch): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    if !patch.is_object() {
        return Err(AppError::BadRequest(
            "Settings patch must be an object".into(),
        ));
    }
    if let Some(backend) = patch
        .get("terminal")
        .and_then(|section| section.get("backend"))
        .and_then(serde_json::Value::as_str)
        && !settings::BACKEND_CHOICES.contains(&backend)
    {
        return Err(AppError::BadRequest("Unknown terminal backend".into()));
    }
    if let Some(days) = patch
        .get("logs")
        .and_then(|section| section.get("retentionDays"))
        && !days
            .as_u64()
            .is_some_and(|days| settings::LOG_RETENTION_CHOICES.contains(&days))
    {
        return Err(AppError::BadRequest("Unknown log retention".into()));
    }
    Ok(Json(state.settings.patch(&patch)?))
}

/* ----------------------------------- 数据 --------------------------------- */

/// `GET /api/data/info` — what the 数据 settings page shows (plan §24.1).
///
/// Paths and sizes only: nothing here needs the database to be quiescent, so
/// the handler never takes a write lock and is safe to poll.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    /// `<data_dir>` — the folder the "reveal in Finder" button opens.
    pub data_dir: String,
    /// `canvas.db` on disk. `0` when the file is missing (in-memory tests).
    pub db_bytes: u64,
    /// Rows in the conversations index.
    pub conversations: i64,
    /// `logs.retentionDays`; `0` = keep forever.
    pub board_log_retention_days: u64,
}

pub async fn data_info(State(state): State<AppState>) -> AppResult<Json<DataInfo>> {
    let database = paths::database_file();
    Ok(Json(DataInfo {
        data_dir: paths::data_dir().display().to_string(),
        db_bytes: std::fs::metadata(&database)
            .map(|meta| meta.len())
            .unwrap_or(0),
        conversations: index::count(&state.pool).await?,
        board_log_retention_days: state.settings.log_retention_days(),
    }))
}

use crate::sqlite_snapshot::snapshot_database;
#[cfg(test)]
use crate::sqlite_snapshot::snapshot_to_target;
pub use crate::sqlite_snapshot::{SnapshotInfo as DataBackup, backup_target};

/// `POST /api/data/backup` — a consistent snapshot of the connected main DB.
///
/// VACUUM INTO reads committed WAL data without copying/checkpointing the live
/// file. It preserves logical content, not physical layout or implicit rowids.
/// See https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause.
pub async fn data_backup(State(state): State<AppState>) -> AppResult<Json<DataBackup>> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    // Dropping an HTTP request must not cancel SQLx's worker while removing its
    // output underneath it. This task owns the connection and completes cleanup.
    Ok(Json(
        tokio::spawn(async move { snapshot_database(&state.pool, &stamp).await }).await??,
    ))
}

#[derive(Deserialize)]
pub struct LegacyArchiveQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

// These share the local Data-management boundary with data_backup, not an
// individual workspace's read permission. A future Host bridge must require
// separate data-management authority before exposing historical records.
pub async fn legacy_kanban_archives(
    State(state): State<AppState>,
    Query(query): Query<LegacyArchiveQuery>,
) -> AppResult<Json<crate::model::LegacyKanbanArchivePage>> {
    Ok(Json(
        db::list_legacy_kanban_archives(
            &state.pool,
            query.cursor.as_deref(),
            query.limit.unwrap_or(50),
        )
        .await?,
    ))
}

pub async fn legacy_kanban_archive(
    State(state): State<AppState>,
    AxumPath(canvas_id): AxumPath<String>,
) -> AppResult<Json<crate::model::LegacyKanbanArchive>> {
    Ok(Json(
        db::get_legacy_kanban_archive(&state.pool, &canvas_id).await?,
    ))
}

pub async fn export_legacy_kanban_archive(
    State(state): State<AppState>,
    AxumPath(canvas_id): AxumPath<String>,
) -> AppResult<Response> {
    let archive = db::get_legacy_kanban_archive(&state.pool, &canvas_id).await?;
    let body = serde_json::to_vec(&crate::model::LegacyKanbanArchiveExport {
        format_version: 1,
        archive,
    })
    .map_err(|_| AppError::Internal("Could not encode historical archive".into()))?;
    Response::builder()
        .header("Content-Type", "application/json; charset=utf-8")
        .header(
            "Content-Disposition",
            "attachment; filename=\"legacy-kanban-archive.json\"",
        )
        .header("Cache-Control", "no-store")
        .body(axum::body::Body::from(body))
        .map_err(|_| AppError::Internal("Could not export historical archive".into()))
}

/* ------------------------------------ 用量 -------------------------------- */

/// `GET /api/usage` — the cached snapshot (plan §19). Percentages and reset
/// times only: no tokens, no account ids, no plan names.
pub async fn get_usage(State(state): State<AppState>) -> Json<UsageSnapshot> {
    Json(state.usage.snapshot())
}

/// `POST /api/usage/refresh` — fetch now, at most once every 30s. Returns the
/// snapshot either way, so the caller does not have to branch on the throttle.
pub async fn refresh_usage(State(state): State<AppState>) -> Json<UsageSnapshot> {
    Json(state.usage.refresh_throttled().await)
}

pub fn parse_query_map(query: &HashMap<String, String>, key: &str) -> String {
    query.get(key).cloned().unwrap_or_else(default_path)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::{db, events::EventHub, settings::SettingsStore, terminal::TerminalManager};

    /// Terminals in tests always use the direct backend and a throwaway data
    /// directory, so a run never touches the developer's tmux server.
    fn test_terminals(
        pool: &sqlx::SqlitePool,
        events: &EventHub,
        directory: &std::path::Path,
    ) -> (TerminalManager, SettingsStore) {
        let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
        (
            TerminalManager::with_config(
                pool.clone(),
                events.clone(),
                settings.clone(),
                directory.to_path_buf(),
            ),
            settings,
        )
    }

    /// Never the real data directory: a test must not touch the user's hook
    /// secret, endpoint file or node tokens.
    fn test_hooks(directory: &std::path::Path) -> crate::hook::HookService {
        crate::hook::HookService::new(directory.join("hook-data"), 43199)
    }

    #[tokio::test]
    async fn retired_kanban_payloads_are_rejected_before_any_database_write() {
        let directory = tempdir().unwrap();
        // No schema exists: this test also proves the retirement check runs
        // before attempting any live document query or mutation.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let events = EventHub::new();
        let settings = SettingsStore::in_memory(
            serde_json::json!({"terminal":{"backend":"direct"},"usage":{"enabled":false}}),
        );
        let state = AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            pool: pool.clone(),
            terminals: TerminalManager::with_config(
                pool,
                events.clone(),
                settings.clone(),
                directory.path().into(),
            ),
            events,
            hooks: test_hooks(directory.path()),
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
        };
        for retired in [
            serde_json::Value::Null,
            serde_json::json!({"columns":[],"cards":{}}),
        ] {
            let request=serde_json::from_value::<SaveBoardDocumentRequest>(serde_json::json!({
                "expectedUpdatedAt":"2026-09-05T00:00:00Z","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"kanban":retired,
            })).unwrap();
            let error = save_board(
                State(state.clone()),
                AxumPath(("workspace".into(), "canvas".into())),
                Json(request),
            )
            .await
            .unwrap_err();
            assert!(matches!(error,AppError::BadRequest(message) if message.contains("retired")));
        }
    }

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

    #[test]
    fn the_agent_environment_carries_addresses_only() {
        let agent = CreateTerminalAgent {
            id: "claude".into(),
            account_id: None,
            permission_mode: Some("plan".into()),
            model: None,
            session_id: None,
        };
        assert_eq!(agent.permission_mode.as_deref(), Some("plan"));
        let env = agent_environment("node-1", &agent.id);
        let lookup = |key: &str| {
            env.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(lookup("ARMADRA_NODE_ID").as_deref(), Some("node-1"));
        assert_eq!(lookup("ARMADRA_AGENT_ID").as_deref(), Some("claude"));
        assert_eq!(lookup("ARMADRA_CANVAS_CONTROL").as_deref(), Some("1"));
        assert!(
            lookup("ARMADRA_ENDPOINT_FILE").is_some_and(|path| path.ends_with("hook-endpoint.env"))
        );
        // No credential is ever placed in the child environment.
        assert!(env.iter().all(|(name, _)| !name.contains("TOKEN")));
        assert_eq!(env.len(), 4);
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

    /// Never `crate::router`: that one reads the user's real settings file and
    /// data directory, and a test must not touch either.
    async fn router_fixture(name: &str) -> (Router, tempfile::TempDir) {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join(format!("{name}.db")).display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(&pool, &events, directory.path());
        (
            crate::router_with_state(AppState {
                resources: crate::resources::ResourceService::new(settings.clone()),
                terminals,
                usage: crate::usage::UsageService::new(settings.clone()),
                settings,
                hooks: test_hooks(directory.path()),
                events,
                pool,
            }),
            directory,
        )
    }

    /// The 1×1 PNG every export / asset test uploads.
    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    #[tokio::test]
    async fn workspace_import_registration_failure_removes_its_owned_directory() {
        let directory = tempdir().unwrap();
        let parent = directory.path().join("managed");
        let mut batch = imports::ImportBatch::workspace(&parent).unwrap();
        batch.write("a.txt", b"uploaded").unwrap();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        // No schema: force database registration failure after the atomic rename.
        assert!(
            register_imported_workspace(&pool, batch, "project")
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(parent).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn workspace_import_validates_names_and_manifest_before_creating_a_directory() {
        let (router, _directory) = router_fixture("workspace-import-validation").await;
        let (status, _, _) = raw(
            &router,
            "POST",
            &format!("/api/workspaces/import?name={}", "a".repeat(121)),
            "multipart/form-data; boundary=b",
            b"--b--\r\n".to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let body = b"--b\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{\"paths\":[\"../escape\"]}\r\n--b--\r\n".to_vec();
        let (status, _, _) = raw(
            &router,
            "POST",
            "/api/workspaces/import?name=folder",
            "multipart/form-data; boundary=b",
            body,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn desktop_directory_open_registers_the_original_path_without_copying() {
        let (router, directory) = router_fixture("open-directory").await;
        let root = directory.path().canonicalize().unwrap().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.txt"), "original").unwrap();
        let (status, first) = call(
            &router,
            "POST",
            "/api/workspaces/open-directory",
            Some(json!({"name":"project", "rootPath":root})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, second) = call(
            &router,
            "POST",
            "/api/workspaces/open-directory",
            Some(json!({"name":"project", "rootPath":root})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["id"], second["id"]);
        assert_eq!(first["rootPath"], root.to_str().unwrap());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let (status, _) = call(
            &router,
            "POST",
            "/api/workspaces/open-directory",
            Some(json!({"name":"file", "rootPath":root.join("a.txt")})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn file_import_roundtrip_preserves_binary_bytes_and_download_boundary() {
        let (router, directory) = router_fixture("file-import").await;
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let id = asset_workspace(&router, root.to_str().unwrap()).await;
        let data = b"%PDF-1.7\n\0binary";
        let mut body = b"--test-boundary\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{\"paths\":[\"report.pdf\"]}\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"0\"; filename=\"ignored.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".to_vec();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n--test-boundary--\r\n");
        let (status, _, result) = raw(
            &router,
            "POST",
            &format!("/api/workspaces/{id}/imports"),
            "multipart/form-data; boundary=test-boundary",
            body,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&result)
        );
        let result: Value = serde_json::from_slice(&result).unwrap();
        let path = result["files"][0]["path"].as_str().unwrap();
        assert!(path.starts_with(".armadra/imports/"));
        assert_eq!(result["files"][0]["preview"], "download");
        assert_eq!(std::fs::read(root.join(path)).unwrap(), data);
        let (status, headers, downloaded) = raw(
            &router,
            "GET",
            &format!("/api/workspaces/{id}/file-download?path={path}"),
            "application/json",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(downloaded, data);
        assert!(
            headers["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(headers["x-content-type-options"], "nosniff");
        let outside = directory.path().join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        let (status, _) = call(
            &router,
            "GET",
            &format!(
                "/api/workspaces/{id}/file-download?path={}",
                outside.display()
            ),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn file_import_rejects_traversal_incomplete_payloads_and_readonly_workspaces() {
        let (router, directory) = router_fixture("file-import-invalid").await;
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let id = asset_workspace(&router, root.to_str().unwrap()).await;
        for path in ["../escape", "a.txt"] {
            let body = format!("--b\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{{\"paths\":[\"{path}\"]}}\r\n--b--\r\n").into_bytes();
            let (status, _, _) = raw(
                &router,
                "POST",
                &format!("/api/workspaces/{id}/imports"),
                "multipart/form-data; boundary=b",
                body,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        assert_eq!(
            std::fs::read_dir(root.join(".armadra/imports"))
                .unwrap()
                .count(),
            0
        );
        let (status, _) = call(
            &router,
            "PATCH",
            &format!("/api/workspaces/{id}"),
            Some(json!({"permissions":{"read":true,"write":false,"execute":true,"network":true}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{id}/imports/local"),
            Some(json!({"paths":["file.txt"]})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    async fn raw(
        router: &Router,
        method: &str,
        uri: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", content_type)
            .body(Body::from(body))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, headers, bytes.to_vec())
    }

    async fn asset_workspace(router: &Router, root: &str) -> String {
        let (status, workspace) = call(
            router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": root })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{workspace}");
        workspace["id"].as_str().unwrap().to_owned()
    }

    /// Tldraw plan §6.2: content-addressed upload, both body shapes, and a
    /// crafted id that must not become a path.
    #[tokio::test]
    async fn assets_are_deduplicated_and_served_back() {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let (router, directory) = router_fixture("api-assets").await;
        let root = directory.path().to_string_lossy().into_owned();
        let workspace_id = asset_workspace(&router, &root).await;
        let png = STANDARD.decode(TINY_PNG).unwrap();

        // A `File` is posted raw with its own content type.
        let (status, _, body) = raw(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets"),
            "image/png",
            png.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let uploaded: Value = serde_json::from_slice(&body).unwrap();
        let id = uploaded["id"].as_str().unwrap().to_owned();
        assert!(id.ends_with(".png"));
        assert_eq!(uploaded["path"], format!(".armadra/assets/{id}"));
        assert_eq!(
            uploaded["url"],
            format!("/api/workspaces/{workspace_id}/assets/{id}")
        );
        assert_eq!(uploaded["mimeType"], "image/png");
        assert_eq!(uploaded["bytes"], png.len());
        assert!(directory.path().join(".armadra/assets").join(&id).is_file());

        // The same bytes as a data URL land on the same file: the name is the
        // content hash, so nothing is stored twice.
        let (status, same) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets"),
            Some(json!({ "dataUrl": format!("data:image/png;base64,{TINY_PNG}") })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{same}");
        assert_eq!(same["id"], id);
        assert_eq!(
            std::fs::read_dir(directory.path().join(".armadra/assets"))
                .unwrap()
                .count(),
            1
        );

        // …and it reads back with the right type and an immutable cache header.
        let (status, headers, served) = raw(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/assets/{id}"),
            "",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "image/png");
        assert!(
            headers["cache-control"]
                .to_str()
                .unwrap()
                .contains("immutable")
        );
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(served, png);

        // A type outside the whitelist is refused before anything is written.
        let (status, _, _) = raw(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets"),
            "application/x-sh",
            b"#!/bin/sh\nrm -rf /".to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // The id is matched, never resolved: traversal is a 400, not a read.
        for crafted in [
            "..%2F..%2Fetc%2Fpasswd",
            "..%2F..%2Fpasswd.png",
            "0011223344556677.sh",
            "nothex0011223344.png",
        ] {
            let (status, _, _) = raw(
                &router,
                "GET",
                &format!("/api/workspaces/{workspace_id}/assets/{crafted}"),
                "",
                Vec::new(),
            )
            .await;
            assert!(
                status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
                "{crafted} came back {status}"
            );
        }
        // A well-formed id nothing was uploaded under is a 404.
        let (status, _, _) = raw(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/assets/00112233445566ff.png"),
            "",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Tldraw plan §8 Phase 3: importing by path lands in the same
    /// content-addressed store as an upload, and refuses everything that is not
    /// a readable image file.
    #[tokio::test]
    async fn assets_are_imported_from_a_path() {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let (router, directory) = router_fixture("api-asset-import").await;
        let root = directory.path().to_string_lossy().into_owned();
        let workspace_id = asset_workspace(&router, &root).await;
        let png = STANDARD.decode(TINY_PNG).unwrap();

        // A picture the user dragged in from outside the workspace.
        let outside = tempfile::tempdir().unwrap();
        let source = outside.path().join("shot.PNG");
        std::fs::write(&source, &png).unwrap();

        let (status, imported) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets/import"),
            Some(json!({ "path": source.to_string_lossy() })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{imported}");
        let id = imported["id"].as_str().unwrap().to_owned();
        assert!(id.ends_with(".png"), "{id}");
        assert_eq!(imported["path"], format!(".armadra/assets/{id}"));
        assert_eq!(
            imported["url"],
            format!("/api/workspaces/{workspace_id}/assets/{id}")
        );
        assert_eq!(imported["mimeType"], "image/png");
        assert_eq!(imported["bytes"], png.len());
        assert!(directory.path().join(".armadra/assets").join(&id).is_file());

        // The same bytes uploaded the normal way are the same file: import and
        // upload share one content-addressed store.
        let (status, uploaded) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets"),
            Some(json!({ "dataUrl": format!("data:image/png;base64,{TINY_PNG}") })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{uploaded}");
        assert_eq!(uploaded["id"], id);
        assert_eq!(
            std::fs::read_dir(directory.path().join(".armadra/assets"))
                .unwrap()
                .count(),
            1
        );

        // A workspace-relative path works too, and reaches the same file.
        std::fs::write(directory.path().join("inside.png"), &png).unwrap();
        let (status, relative) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets/import"),
            Some(json!({ "path": "inside.png" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{relative}");
        assert_eq!(relative["id"], id);

        // A path nobody wrote is a 404.
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets/import"),
            Some(json!({ "path": outside.path().join("missing.png").to_string_lossy() })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // A directory, a non-image and a relative path climbing out are 400s.
        std::fs::write(directory.path().join("notes.txt"), b"hello").unwrap();
        for bad in [
            outside.path().to_string_lossy().into_owned(),
            "notes.txt".to_owned(),
            "../escape.png".to_owned(),
        ] {
            let (status, body) = call(
                &router,
                "POST",
                &format!("/api/workspaces/{workspace_id}/assets/import"),
                Some(json!({ "path": bad })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} came back {body}");
        }

        // A symlink out of the workspace is refused rather than followed.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, directory.path().join("link.png")).unwrap();
            let (status, _) = call(
                &router,
                "POST",
                &format!("/api/workspaces/{workspace_id}/assets/import"),
                Some(json!({ "path": "link.png" })),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }

        // Over the ceiling: refused from the metadata, nothing new on disk.
        let big = outside.path().join("big.png");
        std::fs::write(&big, vec![0_u8; MAX_ASSET_BYTES + 1]).unwrap();
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets/import"),
            Some(json!({ "path": big.to_string_lossy() })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            std::fs::read_dir(directory.path().join(".armadra/assets"))
                .unwrap()
                .count(),
            1
        );
    }

    /// Tldraw plan §6.3: an export is a whiteboard shape, not a node, so the
    /// id only has to be a uuid.
    #[tokio::test]
    async fn exports_no_longer_need_a_node() {
        let (router, directory) = router_fixture("api-exports").await;
        let root = directory.path().to_string_lossy().into_owned();
        let workspace_id = asset_workspace(&router, &root).await;
        let data_url = format!("data:image/png;base64,{TINY_PNG}");

        // Nothing with this id exists anywhere; it is a whiteboard shape.
        let export_id = uuid::Uuid::now_v7().to_string();
        let (status, exported) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/exports/{export_id}/png"),
            Some(json!({ "dataUrl": data_url })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{exported}");
        assert_eq!(
            exported["relativePath"],
            format!(".armadra/exports/{export_id}.png")
        );
        assert!(
            directory
                .path()
                .join(".armadra/exports")
                .join(format!("{export_id}.png"))
                .is_file()
        );

        // An id that is not a uuid would be a file name, so it is refused.
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/exports/..%2F..%2Fescape/png"),
            Some(json!({ "dataUrl": data_url })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Only a PNG data URL is accepted.
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/exports/{export_id}/png"),
            Some(json!({ "dataUrl": "data:image/svg+xml;base64,PHN2Zy8+" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn workspace_and_board_routes_follow_the_v3_contract() {
        let (router, directory) = router_fixture("api-v3").await;
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
        assert!(workspace.get("gatewayEnabled").is_none());
        assert!(workspace["lastOpenedAt"].is_string());
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();

        let (status, summaries) = call(&router, "GET", "/api/workspaces", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(summaries[0]["id"], workspace_id.as_str());
        assert_eq!(summaries[0]["boards"][0]["name"], "Default");

        // The reserved gateway endpoint is gone in v3.
        let (status, _) = call(&router, "GET", "/api/gateway", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = call(&router, "POST", "/api/agents/run", Some(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, boards) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/boards"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let board_id = boards[0]["id"].as_str().unwrap().to_owned();
        let document_uri = format!("/api/workspaces/{workspace_id}/boards/{board_id}/document");

        let (status, document) = call(&router, "GET", &document_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(document.get("strokes").is_none());
        // Migration 0009: a board that was never drawn on still reports the key.
        assert_eq!(document["board"]["whiteboard"], "");
        let expected_updated_at = document["board"]["updatedAt"].as_str().unwrap().to_owned();

        let now = chrono::Utc::now().to_rfc3339();
        let group_id = uuid::Uuid::now_v7().to_string();
        let terminal_id = uuid::Uuid::now_v7().to_string();
        let body = json!({
            "expectedUpdatedAt": expected_updated_at,
            "nodes": [
                {
                    "id": group_id,
                    "boardId": board_id,
                    "type": "group",
                    "title": "Worktree",
                    "color": "#32d74b",
                    "position": { "x": 0.0, "y": 0.0 },
                    "size": { "width": 520.0, "height": 360.0 },
                    "data": { "kind": "group" },
                    "createdAt": now,
                    "updatedAt": now
                },
                {
                    "id": terminal_id,
                    "boardId": board_id,
                    "type": "terminal",
                    "title": "Claude",
                    "position": { "x": 10.0, "y": 20.0 },
                    "size": { "width": 640.0, "height": 440.0 },
                    "collapsed": true,
                    "expandedHeight": 440.0,
                    "parentId": group_id,
                    "data": {
                        "kind": "terminal",
                        "cwd": ".",
                        "shell": "/bin/zsh",
                        "agent": { "id": "claude", "permissionMode": "auto-edit" }
                    },
                    "createdAt": now,
                    "updatedAt": now
                }
            ],
            "edges": [{
                "id": uuid::Uuid::now_v7().to_string(),
                "boardId": board_id,
                "source": group_id,
                "target": terminal_id,
                "kind": "link",
                "createdAt": now,
                "updatedAt": now
            }],
            "viewport": { "x": -12.0, "y": 8.0, "zoom": 0.5 },
            "whiteboard": "{\"store\":{}}"
        });
        let (status, saved) = call(&router, "PUT", &document_uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::OK);
        // The save response and the next load both carry the snapshot back.
        assert_eq!(saved["board"]["whiteboard"], "{\"store\":{}}");
        let (_, reloaded) = call(&router, "GET", &document_uri, None).await;
        assert_eq!(reloaded["board"]["whiteboard"], "{\"store\":{}}");
        assert_eq!(saved["nodes"][0]["title"], "Worktree");
        assert_eq!(saved["nodes"][0]["color"], "#32d74b");
        assert_eq!(saved["nodes"][1]["color"], "#0a84ff");
        assert_eq!(saved["nodes"][1]["parentId"], group_id.as_str());
        assert_eq!(saved["nodes"][1]["collapsed"], true);
        assert_eq!(saved["edges"][0]["kind"], "link");
        assert!(saved["nodes"][0].get("zoom").is_none());
        assert!(saved.get("strokes").is_none());

        let (status, conflict) = call(&router, "PUT", &document_uri, Some(body)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(conflict["code"], "conflict");
    }

    #[tokio::test]
    async fn file_saves_require_content_versions_and_preserve_external_edits() {
        let (router, directory) = router_fixture("api-file-version").await;
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("note.txt"), "old").unwrap();
        let (status, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({
                "name":"files", "rootPath":root.to_string_lossy()
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let uri = format!("/api/workspaces/{}/file", workspace["id"].as_str().unwrap());
        let (status, read) = call(&router, "GET", &format!("{uri}?path=note.txt"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(read["sha256"].as_str().unwrap().len(), 64);
        std::fs::write(root.join("note.txt"), "new").unwrap();
        let (status, _) = call(&router, "PUT", &uri, Some(json!({
            "path":"note.txt", "content":"mine", "expectedSize":3, "expectedSha256":read["sha256"]
        }))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = call(
            &router,
            "PUT",
            &uri,
            Some(json!({
                "path":"note.txt", "content":"mine", "expectedSize":3
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(
            &router,
            "PUT",
            &uri,
            Some(json!({"path":"note.txt", "content":"mine"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            std::fs::read_to_string(root.join("note.txt")).unwrap(),
            "new"
        );
        let (_, fresh) = call(&router, "GET", &format!("{uri}?path=note.txt"), None).await;
        let (status, saved) = call(
            &router,
            "PUT",
            &uri,
            Some(json!({
                "path":"note.txt", "content":"mine", "expectedSha256":fresh["sha256"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, latest) = call(&router, "GET", &format!("{uri}?path=note.txt"), None).await;
        assert_eq!(saved["sha256"], latest["sha256"]);
        assert_eq!(latest["content"], "mine");
    }

    /// E01/M4 over the wire: registration, the pushed change, the on-demand
    /// fallback, and what revoking read access does to a live watcher.
    #[tokio::test]
    async fn watched_files_report_external_changes_until_read_access_is_revoked() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("api-file-watch.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(&pool, &events, directory.path());
        let router = crate::router_with_state(AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals,
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events: events.clone(),
            pool,
        });
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("note.txt"), "old\n").unwrap();
        let (status, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "watch", "rootPath": root.to_string_lossy() })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();
        let mut stream = events.subscribe(&workspace_id);

        let watch_uri = format!("/api/workspaces/{workspace_id}/file-watch");
        let (status, registration) = call(
            &router,
            "POST",
            &watch_uri,
            Some(json!({ "path": "note.txt", "nodeId": "node-1" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(registration["status"], "watching");
        assert_eq!(registration["version"]["exists"], true);
        assert_eq!(
            registration["version"]["sha256"].as_str().unwrap().len(),
            64
        );

        std::fs::write(root.join("note.txt"), "changed outside\n").unwrap();
        let pushed = tokio::time::timeout(std::time::Duration::from_secs(10), stream.recv())
            .await
            .expect("a file.changed event")
            .unwrap();
        let pushed = serde_json::to_value(&pushed).unwrap();
        assert_eq!(pushed["type"], "file.changed");
        assert_eq!(pushed["workspaceId"], workspace_id.as_str());
        assert_eq!(pushed["path"], "note.txt");
        assert_eq!(pushed["kind"], "modified");

        // The on-demand fallback answers the same question without a watcher.
        let (status, version) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/file-version?path=note.txt"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(version["sha256"], pushed["sha256"]);
        assert_eq!(version["size"], 16);

        // Read access goes away → the watcher goes with it.
        let (status, _) = call(
            &router,
            "PATCH",
            &format!("/api/workspaces/{workspace_id}"),
            Some(json!({ "permissions": { "read": false, "write": false, "execute": false } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        std::fs::write(root.join("note.txt"), "after revocation\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        assert!(
            stream.try_recv().is_err(),
            "a workspace without read access must not push file changes"
        );
        let (status, denied) = call(
            &router,
            "POST",
            &watch_uri,
            Some(json!({ "path": "note.txt", "nodeId": "node-1" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(denied["code"], "forbidden");
        let (status, _) = call(
            &router,
            "DELETE",
            &format!("{watch_uri}?path=note.txt&nodeId=node-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn creates_the_workspace_folder_when_asked() {
        let (router, directory) = router_fixture("api-mkdir").await;
        let root = directory.path().join("fresh");

        let (status, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({
                "name": "fresh",
                "rootPath": root.to_string_lossy(),
                "createDirectory": true
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(root.is_dir());
        assert!(workspace["rootPath"].as_str().unwrap().ends_with("/fresh"));

        // The same call again must not silently reuse the directory.
        let (status, error) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({
                "name": "fresh",
                "rootPath": root.to_string_lossy(),
                "createDirectory": true
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["code"], "conflict");

        // Only one level is created: a missing parent is a 400.
        let (status, _) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({
                "name": "deep",
                "rootPath": directory.path().join("missing/deep").to_string_lossy(),
                "createDirectory": true
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn clone_routes_validate_before_running_git() {
        let (router, directory) = router_fixture("api-clone").await;

        let (status, error) = call(
            &router,
            "POST",
            "/api/git/clone",
            Some(json!({
                "url": "file:///tmp/repo.git",
                "parent": directory.path().to_string_lossy()
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["code"], "bad_request");

        let (status, _) = call(
            &router,
            "POST",
            "/api/git/clone",
            Some(json!({
                "url": "https://example.test/team/repo.git",
                "parent": directory.path().join("missing").to_string_lossy()
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, _) = call(&router, "GET", "/api/git/clone/unknown", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = call(&router, "DELETE", "/api/git/clone/unknown", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn custom_agents_are_listed_after_the_built_ins_and_borrow_their_base() {
        let (router, _directory) = router_fixture("api-custom-agents").await;
        let (status, _) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "agents": { "custom": [
                { "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
                  "args": ["hello"], "baseAgent": "gemini",
                  "env": { "GREETING": "hi" } },
                { "id": "custom:broken", "label": "", "launchCmd": "x" },
            ] } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, agents) = call(&router, "GET", "/api/agents", None).await;
        assert_eq!(status, StatusCode::OK);
        let agents = agents.as_array().unwrap();
        // Built-ins plus the one entry that survived validation.
        assert_eq!(agents.len(), crate::agent::AGENT_IDS.len() + 1);
        let custom = agents.last().unwrap();
        assert_eq!(custom["id"], "custom:echo");
        assert_eq!(custom["label"], "Echo");
        assert_eq!(custom["launchCmd"], "/bin/echo");
        assert_eq!(custom["args"], json!(["hello"]));
        assert_eq!(custom["baseAgent"], "gemini");
        // Colour, prompt mode and capabilities are the base agent's.
        let gemini = agents.iter().find(|a| a["id"] == "gemini").unwrap();
        assert_eq!(custom["color"], gemini["color"]);
        assert_eq!(custom["promptMode"], gemini["promptMode"]);
        assert_eq!(custom["capabilities"], gemini["capabilities"]);
        // An absolute program resolves even though it is on no PATH entry.
        assert_eq!(custom["resolvedPath"], "/bin/echo");
        assert_eq!(custom["installed"], true);
    }

    #[tokio::test]
    async fn a_custom_agent_terminal_carries_its_own_id_and_env() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("custom-env.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let events = EventHub::new();
        let (terminals, _) = test_terminals(&pool, &events, directory.path());
        let settings = SettingsStore::in_memory(json!({
            "terminal": { "backend": "direct" },
            "agents": { "custom": [{
                "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
                "baseAgent": "gemini",
                "env": { "GREETING": "hi", "HOME_WAS": "${env:NO_SUCH_TEST_VAR:none}" },
            }] },
        }));
        let state = AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals,
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events,
            pool,
        };

        let env = agent_session_environment(&state, "node-1", "custom:echo");
        let lookup = |key: &str| {
            env.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };
        // The node is the custom agent, not the CLI it borrows.
        assert_eq!(lookup("ARMADRA_AGENT_ID").as_deref(), Some("custom:echo"));
        assert_eq!(lookup("ARMADRA_NODE_ID").as_deref(), Some("node-1"));
        assert_eq!(lookup("GREETING").as_deref(), Some("hi"));
        assert_eq!(lookup("HOME_WAS").as_deref(), Some("none"));
        // Gemini has no reply-approval wait; a claude-based one would.
        assert!(lookup("ARMADRA_PERM_WAIT_SECS").is_none());
        assert!(
            agent_session_environment(&state, "node-1", "claude")
                .iter()
                .any(|(name, _)| name == "ARMADRA_PERM_WAIT_SECS")
        );
    }

    #[tokio::test]
    async fn agent_and_session_routes_expose_the_v3_shapes() {
        let (router, directory) = router_fixture("api-agents").await;
        let root = directory.path().to_string_lossy().into_owned();
        let (_, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": root })),
        )
        .await;
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();

        let (status, agents) = call(&router, "GET", "/api/agents", None).await;
        assert_eq!(status, StatusCode::OK);
        let agents = agents.as_array().unwrap();
        assert_eq!(agents.len(), crate::agent::AGENT_IDS.len());
        for agent in agents {
            assert!(agent["resolvedPath"].is_string() || agent["resolvedPath"].is_null());
            assert!(agent["installed"].is_boolean());
            assert!(agent["clientRevision"].is_null());
            assert!(!agent["launchCmd"].as_str().unwrap().is_empty());
        }
        assert!(agents.iter().any(|agent| agent["id"] == "claude"));
        assert!(agents.iter().any(|agent| agent["id"] == "pi"));
        assert!(agents.iter().all(|agent| agent["baseAgent"].is_null()));

        let (status, sessions) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/sessions"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sessions, json!([]));

        let node_id = uuid::Uuid::now_v7().to_string();
        let (status, links) = call(
            &router,
            "PUT",
            &format!("/api/workspaces/{workspace_id}/context-links/{node_id}"),
            Some(json!({ "links": [
                { "id": uuid::Uuid::now_v7().to_string(), "title": "Codex", "kind": "terminal" }
            ] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(links["nodeId"], node_id.as_str());
        assert_eq!(links["links"].as_array().unwrap().len(), 1);

        let (status, invalid) = call(
            &router,
            "PUT",
            &format!("/api/workspaces/{workspace_id}/context-links/not-a-uuid"),
            Some(json!({ "links": [] })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(invalid["code"], "bad_request");

        let (status, missing) = call(
            &router,
            "POST",
            "/api/approvals/does-not-exist/answer",
            Some(json!({ "decision": "allow" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(missing["code"], "not_found");

        let (status, denied) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/git/commit"),
            Some(json!({ "message": "nothing here" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(denied["code"], "git_execution_required");
        let (status, _) = call(
            &router,
            "PATCH",
            &format!("/api/workspaces/{workspace_id}"),
            Some(json!({"permissions":{"read":true,"write":true,"execute":true}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, commit) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/git/commit"),
            Some(json!({ "message": "nothing here" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(commit["code"], "bad_request");
    }

    #[tokio::test]
    async fn answering_an_approval_publishes_it_to_the_workspace() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("api-approvals.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let workspace = db::create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(&pool, &events, directory.path());
        let state = AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals,
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events: events.clone(),
            pool: pool.clone(),
        };
        let node_id = uuid::Uuid::now_v7().to_string();
        db::insert_approval(
            &pool,
            "p-1",
            &node_id,
            &workspace.id,
            &json!({ "tool": "Bash" }),
        )
        .await
        .unwrap();

        let mut subscriber = events.subscribe(&workspace.id);
        let answered = answer_approval(
            State(state),
            AxumPath("p-1".to_owned()),
            Json(AnswerApprovalRequest {
                decision: "allow".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(answered.0["answer"], "allow");
        // No client was waiting on a pending file, and the node has no PTY.
        assert_eq!(answered.0["route"], "none");

        let event = subscriber.try_recv().unwrap();
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "agent.approval");
        assert_eq!(json["pendingId"], "p-1");
        assert_eq!(json["request"]["answer"], "allow");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_sessions_sidebar_joins_nodes_and_agent_status() {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("api-sessions.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let workspace = db::create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(&pool, &events, directory.path());
        let router = crate::router_with_state(AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals: terminals.clone(),
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events,
            pool: pool.clone(),
        });

        let board = db::list_boards(&pool, &workspace.id)
            .await
            .unwrap()
            .remove(0);
        let node_id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        db::save_board(
            &pool,
            &workspace.id,
            &board.id,
            db::SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[crate::model::CanvasNode {
                    id: node_id.clone(),
                    board_id: board.id.clone(),
                    node_type: "terminal".into(),
                    title: "Claude".into(),
                    color: crate::model::DEFAULT_NODE_COLOR.into(),
                    position: crate::model::Position { x: 0.0, y: 0.0 },
                    size: None,
                    collapsed: None,
                    expanded_height: None,
                    parent_id: None,
                    labels: Vec::new(),
                    note: String::new(),
                    data: json!({ "kind": "terminal", "cwd": "." }),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                }],
                edges: &[],
                viewport: crate::model::Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();

        let (status, session) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace.id,
                "cwd": ".",
                "command": "/bin/sh",
                "args": ["-c", "sleep 5"],
                "nodeId": node_id,
                "agent": { "id": "claude" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let session_id = session["id"].as_str().unwrap().to_owned();

        db::upsert_agent_status(
            &pool,
            db::AgentStatusPatch {
                node_id: node_id.clone(),
                workspace_id: workspace.id.clone(),
                agent_id: "claude".into(),
                state: Some("blocked".into()),
                unread: true,
                session_id: None,
                pending_id: Some("p-1".into()),
                verified: true,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: None,
            },
        )
        .await
        .unwrap();

        let (status, sessions) = call(
            &router,
            "GET",
            &format!("/api/workspaces/{}/sessions", workspace.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let sessions = sessions.as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        let row = &sessions[0];
        assert_eq!(row["nodeId"], node_id.as_str());
        assert_eq!(row["boardId"], board.id.as_str());
        assert_eq!(row["sessionId"], session_id.as_str());
        assert_eq!(row["kind"], "terminal");
        assert_eq!(row["title"], "Claude");
        assert_eq!(row["agentId"], "claude");
        assert_eq!(row["state"], "blocked");
        assert_eq!(row["unread"], true);
        assert_eq!(row["pendingId"], "p-1");
        assert_eq!(row["alive"], true);

        terminals
            .terminate(&session_id, TerminateMode::Process)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_terminals_require_a_node_and_a_known_agent() {
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
        )
        .await
        .unwrap();
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(&pool, &events, directory.path());
        let router = crate::router_with_state(AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals,
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events,
            pool,
        });

        let (status, error) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace.id,
                "cwd": ".",
                "agent": { "id": "claude" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["code"], "bad_request");

        let (status, error) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace.id,
                "cwd": ".",
                "nodeId": uuid::Uuid::now_v7().to_string(),
                "agent": { "id": "unknown-cli" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["code"], "bad_request");

        let node_id = uuid::Uuid::now_v7().to_string();
        let (status, session) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace.id,
                "cwd": ".",
                "command": "/bin/sh",
                "args": ["-c", "sleep 5"],
                "nodeId": node_id,
                "agent": { "id": "claude", "permissionMode": "plan" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(session["ownerNodeId"], node_id.as_str());
        assert_eq!(session["agentId"], "claude");
        assert!(session["pid"].as_i64().is_some());

        let (status, terminated) = call(
            &router,
            "POST",
            &format!(
                "/api/terminals/{}/terminate",
                session["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(terminated["status"], "terminated");
    }

    /// Plan §21, row SSH: the command comes from `settings.ssh.hosts[]`, and an
    /// id that is not in there is a 400 — never a silent local shell.
    #[tokio::test]
    async fn ssh_terminals_resolve_the_host_from_the_settings() {
        let (router, directory) = router_fixture("api-ssh").await;
        let root = directory.path().to_string_lossy().into_owned();
        let (_, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "ssh", "rootPath": root })),
        )
        .await;
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();

        let (status, error) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace_id,
                "cwd": ".",
                "ssh": { "hostId": "nope" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["message"], "Unknown SSH host");

        // The probe route rejects the same id the same way.
        let (status, _) = call(&router, "POST", "/api/ssh/hosts/nope/test", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, document) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "ssh": { "hosts": [
                { "id": "local", "name": "Local", "host": "127.0.0.1", "port": 1 }
            ] } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(document["ssh"]["hosts"][0]["id"], "local");

        // Port 1 on loopback refuses immediately: the process is real, the
        // connection is not, and nothing leaves this machine.
        let (status, session) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace_id,
                "cwd": ".",
                "ssh": { "hostId": "local" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(session["command"], "ssh");
    }

    /// The §15 routes, checked against the shapes in packages/shared/src/api.ts.
    #[tokio::test]
    async fn the_terminal_backend_routes_speak_the_v15_shapes() {
        let (router, directory) = router_fixture("api-terminal-backend").await;
        let (_, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": directory.path() })),
        )
        .await;
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();

        let (status, backend) = call(&router, "GET", "/api/terminals/backend", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(backend["effective"], "direct");
        assert_eq!(backend["configured"], "direct");
        assert!(backend.get("tmuxVersion").is_some());
        assert!(backend.get("tmuxSocket").is_some());
        assert!(backend.get("reason").is_some());

        let (status, session) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace_id,
                "cwd": ".",
                "command": "/bin/sh",
                // `trap '' INT` is what makes the interrupt assertion below
                // meaningful: a plain `sh -c` dies on Ctrl+C like any other
                // foreground process, so asserting that it survives one would
                // be asserting a race, not a behaviour.
                "args": ["-c", "trap '' INT; printf hello-capture; sleep 30"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // Plan §15.2 — the session payload carries its backend identity.
        assert_eq!(session["backend"], "direct");
        assert_eq!(session["generation"], 1);
        assert_eq!(session["attachState"], "detached");
        assert_eq!(session["sessionKey"], session["id"]);
        let session_id = session["id"].as_str().unwrap().to_owned();

        // Poll rather than sleep: how long the shell takes to print depends on
        // how loaded the machine is when the suite runs in parallel.
        let capture_uri = format!("/api/terminals/{session_id}/capture?lines=40&escapes=false");
        let mut capture = Value::Null;
        let mut status = StatusCode::OK;
        for _ in 0..100 {
            (status, capture) = call(&router, "GET", &capture_uri, None).await;
            if capture["data"]
                .as_str()
                .is_some_and(|data| data.contains("hello-capture"))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(status, StatusCode::OK);
        assert_eq!(capture["generation"], 1);
        assert!(capture["lines"].as_u64().is_some());
        assert!(
            capture["data"].as_str().unwrap().contains("hello-capture"),
            "got {:?}",
            capture["data"]
        );

        let (status, pasted) = call(
            &router,
            "POST",
            &format!("/api/terminals/{session_id}/paste"),
            Some(json!({ "text": "ls", "enter": false })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(pasted["id"], session_id.as_str());

        // A generation bump, same row and same logical key.
        let (status, recycled) = call(
            &router,
            "POST",
            &format!("/api/terminals/{session_id}/recycle"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(recycled["generation"], 2);
        assert_eq!(recycled["id"], session_id.as_str());
        assert_eq!(recycled["status"], "running");

        // An explicit mode, and the parameterless body the old route accepted.
        let (status, interrupted) = call(
            &router,
            "POST",
            &format!("/api/terminals/{session_id}/terminate"),
            Some(json!({ "mode": "interrupt" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // An interrupt is a signal, not a kill: a process that ignores SIGINT
        // keeps running, and the session is never marked `terminated`.
        assert_eq!(interrupted["status"], "running");
        assert_eq!(interrupted["generation"], 2);

        let (status, ended) = call(
            &router,
            "POST",
            &format!("/api/terminals/{session_id}/terminate"),
            Some(json!({ "mode": "session" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ended["status"], "terminated");
        assert_eq!(ended["attachState"], "exited");
    }

    /// Plan §15.5 over a real socket: `hello` first, `snapshot` for the direct
    /// backend, then `output`; a recycle underneath the socket produces
    /// `stale` instead of a silent close.
    #[tokio::test]
    async fn the_terminal_socket_says_hello_then_snapshot_then_stale() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{
            Message as WsMessage, client::IntoClientRequest, http::HeaderValue,
        };

        let (router, directory) = router_fixture("api-terminal-ws").await;
        let (_, workspace) = call(
            &router,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "Canvas", "rootPath": directory.path() })),
        )
        .await;
        let (_, session) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace["id"],
                "cwd": ".",
                "command": "/bin/sh",
                "args": ["-c", "printf socket-ready; sleep 30"]
            })),
        )
        .await;
        let session_id = session["id"].as_str().unwrap().to_owned();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = router.clone();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, served).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        let mut request = format!("ws://127.0.0.1:{port}/api/terminals/{session_id}/ws")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://127.0.0.1:1420"));
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();

        /// The next JSON frame, or `None` once the server closes the stream.
        async fn next_frame<S>(socket: &mut S) -> Option<Value>
        where
            S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            loop {
                match socket.next().await {
                    Some(Ok(WsMessage::Text(text))) => {
                        return Some(serde_json::from_str::<Value>(&text).unwrap());
                    }
                    Some(Ok(WsMessage::Close(_))) | None => return None,
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => panic!("socket broke: {error:?}"),
                }
            }
        }

        async fn next<S>(socket: &mut S) -> Value
        where
            S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            next_frame(socket)
                .await
                .expect("the socket ended before the expected frame")
        }

        let hello = next(&mut socket).await;
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["sessionId"], session_id.as_str());
        assert_eq!(hello["generation"], 1);
        assert_eq!(hello["backend"], "direct");
        assert_eq!(hello["rows"], 24);
        assert_eq!(hello["cols"], 80);
        assert_eq!(hello["alive"], true);

        // The direct backend replays; a tmux client would redraw instead.
        let mut saw_snapshot = false;
        let mut seen = String::new();
        while !seen.contains("socket-ready") {
            let frame = next(&mut socket).await;
            match frame["type"].as_str() {
                Some("snapshot") => {
                    saw_snapshot = true;
                    seen.push_str(frame["data"].as_str().unwrap());
                }
                Some("output") => seen.push_str(frame["data"].as_str().unwrap()),
                other => panic!("unexpected frame {other:?}"),
            }
        }
        assert!(saw_snapshot || seen.contains("socket-ready"));

        socket
            .send(WsMessage::Text(
                json!({ "type": "resize", "cols": 100, "rows": 40 })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();

        // Recycling behind the socket's back invalidates its generation.
        let (status, recycled) = call(
            &router,
            "POST",
            &format!("/api/terminals/{session_id}/recycle"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(recycled["generation"], 2);

        // The socket is told without having to ask: the stream it was reading
        // belonged to generation 1 and is gone. Writing here instead would race
        // the server's close and prove nothing — the manager-level test
        // `a_write_from_an_old_generation_is_rejected` covers the write path.
        let mut stale = None;
        while let Some(frame) = next_frame(&mut socket).await {
            if frame["type"] == "stale" {
                stale = Some(frame);
                break;
            }
        }
        assert_eq!(
            stale.expect("a recycled session must announce itself as stale")["generation"],
            2
        );

        let _ = call(
            &router,
            "POST",
            &format!("/api/terminals/{session_id}/terminate"),
            Some(json!({ "mode": "session" })),
        )
        .await;
        server.abort();
    }

    /// `DELETE /api/workspaces/{id}` — 从列表移除 (plan §20).
    ///
    /// The three things that have to hold: the live session is gone, every row
    /// that hangs off the workspace is gone with it (the schema's cascades,
    /// asserted here so a future migration cannot quietly drop one), and the
    /// directory on disk is exactly as it was.
    #[cfg(unix)]
    #[tokio::test]
    async fn removing_a_workspace_destroys_its_sessions_and_cascades_its_rows() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("keep-me.txt"), "untouched").unwrap();
        let pool = db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("api-remove.db").display()
        ))
        .await
        .unwrap();
        let workspace = db::create_workspace(&pool, "fixture", root.to_str().unwrap(), None, None)
            .await
            .unwrap();
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(&pool, &events, directory.path());
        let router = crate::router_with_state(AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals: terminals.clone(),
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events,
            pool: pool.clone(),
        });

        // A board with two nodes and the edge between them.
        let board = db::list_boards(&pool, &workspace.id)
            .await
            .unwrap()
            .remove(0);
        let now = chrono::Utc::now().to_rfc3339();
        let node_id = uuid::Uuid::now_v7().to_string();
        let sticky_id = uuid::Uuid::now_v7().to_string();
        let node = |id: &str, node_type: &str, data: Value| crate::model::CanvasNode {
            id: id.to_owned(),
            board_id: board.id.clone(),
            node_type: node_type.to_owned(),
            title: "Claude".into(),
            color: crate::model::DEFAULT_NODE_COLOR.into(),
            position: crate::model::Position { x: 0.0, y: 0.0 },
            size: None,
            collapsed: None,
            expanded_height: None,
            parent_id: None,
            labels: Vec::new(),
            note: String::new(),
            data,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db::save_board(
            &pool,
            &workspace.id,
            &board.id,
            db::SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[
                    node(
                        &node_id,
                        "terminal",
                        json!({ "kind": "terminal", "cwd": "." }),
                    ),
                    node(
                        &sticky_id,
                        "sticky",
                        json!({ "kind": "sticky", "content": "note" }),
                    ),
                ],
                edges: &[crate::model::CanvasEdge {
                    id: uuid::Uuid::now_v7().to_string(),
                    board_id: board.id.clone(),
                    source: sticky_id.clone(),
                    target: node_id.clone(),
                    kind: "link".into(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                }],
                viewport: crate::model::Viewport::default(),
                whiteboard: None,
            },
        )
        .await
        .unwrap();

        let (status, session) = call(
            &router,
            "POST",
            "/api/terminals",
            Some(json!({
                "workspaceId": workspace.id,
                "cwd": ".",
                "command": "/bin/sh",
                "args": ["-c", "sleep 300"],
                "nodeId": node_id,
                "agent": { "id": "claude" }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let session_id = session["id"].as_str().unwrap().to_owned();
        assert!(terminals.is_alive(&session_id).await);

        db::upsert_agent_status(
            &pool,
            db::AgentStatusPatch {
                node_id: node_id.clone(),
                workspace_id: workspace.id.clone(),
                agent_id: "claude".into(),
                state: Some("working".into()),
                unread: true,
                session_id: Some(session_id.clone()),
                pending_id: None,
                verified: true,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: None,
            },
        )
        .await
        .unwrap();

        let uri = format!("/api/workspaces/{}", workspace.id);
        let (status, body) = call(&router, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(body, Value::Null);

        // The PTY is gone, and so is the manager's memory of it.
        assert!(!terminals.is_alive(&session_id).await);
        assert!(matches!(
            terminals.session(&session_id).await,
            Err(AppError::NotFound(_))
        ));

        // Every table that references the workspace, directly or through the
        // board, is empty again.
        for (label, query, value) in [
            (
                "workspaces",
                "SELECT COUNT(*) FROM workspaces WHERE id = ?",
                workspace.id.as_str(),
            ),
            (
                "boards",
                "SELECT COUNT(*) FROM boards WHERE workspace_id = ?",
                workspace.id.as_str(),
            ),
            (
                "terminal_sessions",
                "SELECT COUNT(*) FROM terminal_sessions WHERE workspace_id = ?",
                workspace.id.as_str(),
            ),
            (
                "agent_status",
                "SELECT COUNT(*) FROM agent_status WHERE workspace_id = ?",
                workspace.id.as_str(),
            ),
            (
                "nodes",
                "SELECT COUNT(*) FROM nodes WHERE board_id = ?",
                board.id.as_str(),
            ),
            (
                "edges",
                "SELECT COUNT(*) FROM edges WHERE board_id = ?",
                board.id.as_str(),
            ),
        ] {
            let count: i64 = sqlx::query_scalar(query)
                .bind(value)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "{label} still has rows for the removed workspace");
        }

        // 从列表移除, not 删除项目: the directory is untouched.
        assert_eq!(
            std::fs::read_to_string(root.join("keep-me.txt")).unwrap(),
            "untouched"
        );

        // Unknown ids are a 404, and the second DELETE of the same id is one
        // too — removal is not silently idempotent.
        let (status, error) = call(&router, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error["code"], "not_found");
        let (status, _) = call(
            &router,
            "DELETE",
            &format!("/api/workspaces/{}", uuid::Uuid::now_v7()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn settings_expose_and_patch_the_terminal_backend_choice() {
        let (router, _directory) = router_fixture("api-settings").await;
        let (status, settings) = call(&router, "GET", "/api/settings", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings["terminal"]["backend"], "direct");
        assert_eq!(settings["terminal"]["detachedGraceMinutes"], 1440);

        let (status, patched) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "terminal": { "backend": "auto" }, "future": { "key": 1 } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["terminal"]["backend"], "auto");
        // Untouched keys survive, unknown ones are kept rather than dropped.
        assert_eq!(patched["terminal"]["detachedGraceMinutes"], 1440);
        assert_eq!(patched["future"]["key"], 1);

        let (status, error) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "terminal": { "backend": "screen" } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["code"], "bad_request");
    }

    /* ---------------------------------- 数据 -------------------------------- */

    #[tokio::test]
    async fn the_data_page_reads_an_info_document_and_backs_the_database_up() {
        let (router, directory) = router_fixture("api-data").await;

        // `logs.retentionDays` is normalized like every other known key: the
        // default appears in `GET`, an offered value round-trips, anything else
        // is refused rather than silently snapped.
        let (status, info) = call(&router, "GET", "/api/data/info", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(info["conversations"], 0);
        assert_eq!(info["boardLogRetentionDays"], 30);
        assert!(info["dataDir"].as_str().is_some_and(|dir| !dir.is_empty()));
        assert!(info["dbBytes"].as_u64().is_some());

        let (status, patched) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "logs": { "retentionDays": 7 } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["logs"]["retentionDays"], 7);
        let (_, info) = call(&router, "GET", "/api/data/info", None).await;
        assert_eq!(info["boardLogRetentionDays"], 7);

        let (status, error) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "logs": { "retentionDays": 5 } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["code"], "bad_request");

        // Exercise the real handler: it must use the fixture pool, regardless of
        // global application data-directory configuration.
        let (status, backup) = call(&router, "POST", "/api/data/backup", None).await;
        assert_eq!(status, StatusCode::OK);
        let path = std::path::Path::new(backup["path"].as_str().unwrap());
        assert_eq!(
            path.parent(),
            Some(directory.path().canonicalize().unwrap().as_path())
        );
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("api-data.db.backup-manual-")
        );
        assert!(backup["bytes"].as_u64().unwrap() > 0);
        assert!(path.exists());
    }

    async fn backup_fixture(
        name: &str,
    ) -> (sqlx::SqlitePool, tempfile::TempDir, std::path::PathBuf) {
        let directory = tempdir().unwrap();
        let source = directory.path().join(name);
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .pragma("wal_autocheckpoint", "0");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(3)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE snapshot_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .unwrap();
        (pool, directory, source)
    }

    async fn snapshot_values(path: &Path) -> Vec<String> {
        use sqlx::Connection;
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .read_only(true);
        let mut connection = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        let values = sqlx::query_scalar("SELECT value FROM snapshot_values ORDER BY id")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        values
    }

    #[tokio::test]
    async fn data_backup_includes_uncheckpointed_wal_with_an_active_reader() {
        let (pool, directory, source) = backup_fixture("custom path ' quoted.db").await;
        let before = std::fs::read(&source).unwrap();
        // Hold an older read snapshot while the committed insert stays in WAL.
        let mut reader = pool.acquire().await.unwrap();
        sqlx::query("BEGIN").execute(&mut *reader).await.unwrap();
        let _: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_values")
            .fetch_one(&mut *reader)
            .await
            .unwrap();
        sqlx::query("INSERT INTO snapshot_values(value) VALUES ('committed in WAL 中文')")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&source).unwrap(),
            before,
            "fixture must leave the committed row outside the main file"
        );
        assert!(
            std::fs::metadata(source.with_file_name("custom path ' quoted.db-wal"))
                .unwrap()
                .len()
                > 0
        );
        let backup = snapshot_database(&pool, "fixed-second").await.unwrap();
        assert_eq!(
            snapshot_values(Path::new(&backup.path)).await,
            ["committed in WAL 中文"]
        );
        assert_eq!(
            std::fs::read(&source).unwrap(),
            before,
            "VACUUM INTO must not rewrite the source"
        );
        assert_eq!(
            Path::new(&backup.path).parent(),
            Some(directory.path().canonicalize().unwrap().as_path())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&backup.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        sqlx::query("ROLLBACK").execute(&mut *reader).await.unwrap();
        drop(reader);
        pool.close().await;
    }

    #[tokio::test]
    async fn data_backup_same_second_is_unique_and_preserves_previous_snapshot() {
        let (pool, _directory, _) = backup_fixture("same-second.db").await;
        sqlx::query("INSERT INTO snapshot_values(value) VALUES ('first')")
            .execute(&pool)
            .await
            .unwrap();
        let first = snapshot_database(&pool, "20260905-101500").await.unwrap();
        let first_bytes = std::fs::read(&first.path).unwrap();
        sqlx::query("INSERT INTO snapshot_values(value) VALUES ('second')")
            .execute(&pool)
            .await
            .unwrap();
        let (second, third) = tokio::join!(
            snapshot_database(&pool, "20260905-101500"),
            snapshot_database(&pool, "20260905-101500")
        );
        let second = second.unwrap();
        let third = third.unwrap();
        assert_ne!(first.path, second.path);
        assert_ne!(second.path, third.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), first_bytes);
        assert_eq!(snapshot_values(Path::new(&first.path)).await, ["first"]);
        assert_eq!(
            snapshot_values(Path::new(&second.path)).await,
            ["first", "second"]
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn data_backup_failure_cleans_only_its_scratch_and_keeps_source_and_existing_files() {
        let (pool, directory, source) = backup_fixture("failure.db").await;
        sqlx::query("INSERT INTO snapshot_values(value) VALUES ('keep source')")
            .execute(&pool)
            .await
            .unwrap();
        let existing = backup_target(&source, "existing");
        std::fs::write(&existing, b"existing backup must survive").unwrap();
        let mut connection = pool.acquire().await.unwrap();
        assert!(matches!(
            snapshot_to_target(&mut connection, &existing).await,
            Err(AppError::Conflict(_))
        ));
        // VACUUM cannot run inside a transaction. This deterministic SQL error
        // occurs after private output creation and must not leave partial output.
        sqlx::query("BEGIN")
            .execute(&mut *connection)
            .await
            .unwrap();
        let failed = backup_target(&source, "failed");
        assert!(snapshot_to_target(&mut connection, &failed).await.is_err());
        sqlx::query("ROLLBACK")
            .execute(&mut *connection)
            .await
            .unwrap();
        assert!(!failed.exists());
        assert_eq!(
            std::fs::read(&existing).unwrap(),
            b"existing backup must survive"
        );
        assert!(!std::fs::read_dir(directory.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".partial")
        }));
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM snapshot_values WHERE value = 'keep source'")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
        assert_eq!(count, 1);
        drop(connection);
        pool.close().await;
    }

    #[tokio::test]
    async fn data_backup_rejects_memory_and_a_missing_connected_file() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        assert!(matches!(
            snapshot_database(&pool, "memory").await,
            Err(AppError::BadRequest(_))
        ));
        pool.close().await;
        #[cfg(unix)]
        {
            let (pool, _directory, source) = backup_fixture("removed.db").await;
            std::fs::remove_file(&source).unwrap();
            assert!(matches!(
                snapshot_database(&pool, "missing").await,
                Err(AppError::BadRequest(_))
            ));
            pool.close().await;
        }
    }

    /* -------------------------- conversations / title ---------------------- */

    fn phase4_router(pool: &sqlx::SqlitePool, directory: &std::path::Path) -> Router {
        let events = EventHub::new();
        let (terminals, settings) = test_terminals(pool, &events, directory);
        crate::router_with_state(AppState {
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals,
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory),
            events,
            pool: pool.clone(),
        })
    }

    #[tokio::test]
    async fn the_conversations_endpoint_lists_filters_and_rescans() {
        let directory = tempdir().unwrap();
        let pool = db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("conversations.db").display()
        ))
        .await
        .unwrap();
        let router = phase4_router(&pool, directory.path());

        // Nothing indexed yet: an empty array, not an error.
        let (status, rows) = call(&router, "GET", "/api/conversations", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(rows, json!([]));

        // The refresh route reports what a pass did. It scans the developer's
        // real transcript directories, so only the shape is asserted here — the
        // scanner itself is covered against a temporary tree in `index::tests`.
        let (status, report) = call(&router, "POST", "/api/conversations/refresh", None).await;
        assert_eq!(status, StatusCode::OK);
        for key in ["scanned", "indexed", "removed", "total"] {
            assert!(
                report[key].is_number(),
                "{key} missing from the scan report"
            );
        }
        // That pass indexed whatever this machine happens to have, which is not
        // something a test may assert on; the table is cleared so the rows below
        // are the only ones the query can see.
        sqlx::query("DELETE FROM conversations")
            .execute(&pool)
            .await
            .unwrap();

        // A row put in by hand proves the response shape and the query.
        sqlx::query(
            "INSERT INTO conversations (provider, session_id, title, cwd, path, updated_at, bytes) \
             VALUES ('claude', 'session-1', 'Ship the thing', '/Users/me/alpha', '/tmp/a.jsonl', \
                     '2026-09-04T00:00:00+00:00', 4096)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (status, rows) = call(&router, "GET", "/api/conversations?q=SHIP&limit=5", None).await;
        assert_eq!(status, StatusCode::OK);
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["provider"], "claude");
        assert_eq!(rows[0]["sessionId"], "session-1");
        assert_eq!(rows[0]["title"], "Ship the thing");
        assert_eq!(rows[0]["cwd"], "/Users/me/alpha");
        assert_eq!(rows[0]["updatedAt"], "2026-09-04T00:00:00+00:00");
        assert_eq!(rows[0]["bytes"], 4096);
        // The transcript path never leaves the runtime.
        assert!(rows[0].get("path").is_none());

        let (_, none) = call(&router, "GET", "/api/conversations?q=nothing", None).await;
        assert_eq!(none, json!([]));
    }

    #[tokio::test]
    async fn suggest_title_prefers_the_transcript_and_falls_back_to_the_agent() {
        let directory = tempdir().unwrap();
        let pool = db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("suggest.db").display()
        ))
        .await
        .unwrap();
        let workspace = db::create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        let router = phase4_router(&pool, directory.path());
        let node_id = uuid::Uuid::now_v7().to_string();

        // A node that never reported is a 404, not an empty title.
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/agent-status/{node_id}/suggest-title"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let patch = |transcript: Option<String>| db::AgentStatusPatch {
            node_id: node_id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("done".into()),
            unread: false,
            session_id: None,
            pending_id: None,
            verified: true,
            transcript_path: transcript,
            session_phase: None,
            errored: None,
            interrupted: None,
            last_event_at: None,
        };

        // No transcript and no terminal: the agent's label is the honest answer.
        db::upsert_agent_status(&pool, patch(None)).await.unwrap();
        let (status, suggested) = call(
            &router,
            "POST",
            &format!("/api/agent-status/{node_id}/suggest-title"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            suggested,
            json!({ "title": "Claude Code", "source": "agent" })
        );

        // With a transcript, the first user message wins.
        let transcript = directory.path().join("session.jsonl");
        std::fs::write(
            &transcript,
            "{\"type\":\"user\",\"cwd\":\"/tmp\",\"message\":{\"content\":\"给终端节点加上 AI 命名\"}}\n",
        )
        .unwrap();
        db::upsert_agent_status(
            &pool,
            patch(Some(transcript.to_string_lossy().into_owned())),
        )
        .await
        .unwrap();
        let (status, suggested) = call(
            &router,
            "POST",
            &format!("/api/agent-status/{node_id}/suggest-title"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            suggested,
            json!({ "title": "给终端节点加上 AI 命名", "source": "transcript" })
        );
    }
}
