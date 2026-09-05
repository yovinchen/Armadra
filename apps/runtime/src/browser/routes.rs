//! HTTP surface for the controlled browser (B01).
//!
//! Every route is workspace-scoped and re-checks that the session it names
//! belongs to that workspace: a session id is not a capability, and a client
//! that has one must still be allowed into the workspace it lives in.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;

use crate::{
    AppState,
    error::{AppError, AppResult},
    model::Workspace,
};

use super::{
    Availability, BrowserSession, Capture, Download, ReadMode, ReadResponse, SessionList,
    Subscription, Viewport, WaitOutcome, readable_workspace,
    session::{
        self, CaptureRequest, CreateRequest, InputRequest, Live, NavigateRequest, SubscribeRequest,
        WaitRequest,
    },
};

/// `GET /api/workspaces/{id}/browser/availability`
pub async fn availability(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> AppResult<Json<Availability>> {
    readable_workspace(&state, &workspace_id).await?;
    Ok(Json(super::availability(&state)))
}

/// `GET /api/workspaces/{id}/browser/sessions`
///
/// Rows that are stored but not running are reported as `disconnected` rather
/// than omitted: a session the user can still bring back is not the same as no
/// session at all.
pub async fn list(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> AppResult<Json<SessionList>> {
    readable_workspace(&state, &workspace_id).await?;
    let service = super::service(&state);
    let sessions = super::stored_for_workspace(&state.pool, &workspace_id)
        .await?
        .into_iter()
        .map(|stored| match service.live(&stored.id) {
            Some(live) => live.snapshot(),
            None => BrowserSession {
                session_id: stored.id,
                generation: stored.generation,
                workspace_id: stored.workspace_id,
                node_id: stored.node_id,
                url: stored.url,
                title: stored.title,
                viewport: stored.viewport,
                state: super::SessionState::Disconnected,
                reason_code: if stored.reason_code.is_empty() {
                    "not_running".to_owned()
                } else {
                    stored.reason_code
                },
                navigation_epoch: 0,
                headful: stored.headful,
                keep_alive: stored.keep_alive,
                can_go_back: false,
                can_go_forward: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
            },
        })
        .collect();
    Ok(Json(SessionList {
        sessions,
        availability: super::availability(&state),
    }))
}

/// `POST /api/workspaces/{id}/browser/sessions` — open or reattach.
pub async fn create(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<CreateRequest>,
) -> AppResult<Json<BrowserSession>> {
    let workspace = readable_workspace(&state, &workspace_id).await?;
    Ok(Json(session::ensure(&state, &workspace, request).await?))
}

/// `GET /api/workspaces/{id}/browser/sessions/{sessionId}`
pub async fn get(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
) -> AppResult<Json<BrowserSession>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(live.snapshot()))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloseQuery {
    #[serde(default)]
    terminate: bool,
}

/// `DELETE /api/workspaces/{id}/browser/sessions/{sessionId}`
///
/// `terminate=false` (the default) only stops the picture — design §9's
/// distinction between "移除展示" and "结束 BrowserSession".
pub async fn close(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Query(query): Query<CloseQuery>,
) -> AppResult<StatusCode> {
    readable_workspace(&state, &workspace_id).await?;
    belongs_to(&state, &workspace_id, &session_id).await?;
    session::close(&state, &session_id, query.terminate).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST …/sessions/{sessionId}/navigate`
pub async fn navigate(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Json(request): Json<NavigateRequest>,
) -> AppResult<Json<BrowserSession>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(session::navigate(&live, &request).await?))
}

/// `POST …/sessions/{sessionId}/viewport`
pub async fn viewport(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Json(viewport): Json<Viewport>,
) -> AppResult<Json<BrowserSession>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(session::set_viewport(&live, viewport).await?))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputResult {
    accepted: u32,
    navigation_epoch: u64,
}

/// `POST …/sessions/{sessionId}/input`
///
/// A 409 means the epoch no longer matches: the client drops the batch and
/// waits for a new frame rather than retrying against a different page.
pub async fn input(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Json(request): Json<InputRequest>,
) -> AppResult<Json<InputResult>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    let accepted = session::input(&live, &request).await?;
    Ok(Json(InputResult {
        accepted,
        navigation_epoch: live.navigation_epoch(),
    }))
}

/// `POST …/sessions/{sessionId}/subscription`
pub async fn subscribe(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Json(request): Json<SubscribeRequest>,
) -> AppResult<Json<Subscription>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(session::subscribe(&live, &request).await?))
}

/// `DELETE …/sessions/{sessionId}/subscription/{subscriptionId}`
pub async fn unsubscribe(
    State(state): State<AppState>,
    Path((workspace_id, session_id, subscription_id)): Path<(String, String, String)>,
) -> AppResult<StatusCode> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    session::unsubscribe(&live, &subscription_id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadQuery {
    mode: Option<String>,
    limit: Option<usize>,
    max_bytes: Option<usize>,
}

/// `GET …/sessions/{sessionId}/read`
pub async fn read(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Query(query): Query<ReadQuery>,
) -> AppResult<Json<ReadResponse>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    let mode = ReadMode::parse(query.mode.as_deref().unwrap_or("text")).ok_or_else(|| {
        AppError::BadRequest(format!(
            "Unknown read mode; expected one of {}",
            ReadMode::NAMES.join(", ")
        ))
    })?;
    Ok(Json(
        session::read(
            &live,
            mode,
            query.limit.unwrap_or(50),
            query.max_bytes.unwrap_or(super::MAX_TEXT_BYTES),
        )
        .await?,
    ))
}

/// `POST …/sessions/{sessionId}/capture`
pub async fn capture(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    body: Option<Json<CaptureRequest>>,
) -> AppResult<Json<Capture>> {
    let workspace = readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    let request = body.map(|Json(request)| request).unwrap_or_default();
    Ok(Json(session::capture(&live, &workspace, &request).await?))
}

/// `POST …/sessions/{sessionId}/wait`
pub async fn wait(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    Json(request): Json<WaitRequest>,
) -> AppResult<Json<WaitOutcome>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(session::wait(&live, &request).await?))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadList {
    downloads: Vec<Download>,
}

/// `GET …/sessions/{sessionId}/downloads`
pub async fn downloads(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
) -> AppResult<Json<DownloadList>> {
    readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(DownloadList {
        downloads: session::downloads(&live),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDecision {
    accept: bool,
}

/// `POST …/sessions/{sessionId}/downloads/{downloadId}` — the confirmation
/// that moves a staged file into the project, or throws it away.
pub async fn decide_download(
    State(state): State<AppState>,
    Path((workspace_id, session_id, download_id)): Path<(String, String, String)>,
    Json(decision): Json<DownloadDecision>,
) -> AppResult<Json<Download>> {
    let workspace = readable_workspace(&state, &workspace_id).await?;
    let live = live_in(&state, &workspace_id, &session_id).await?;
    Ok(Json(
        session::decide_download(&live, &workspace, &download_id, decision.accept).await?,
    ))
}

/* --------------------------------- helpers -------------------------------- */

/// A session id only means something inside the workspace that owns it.
async fn belongs_to(
    state: &AppState,
    workspace_id: &str,
    session_id: &str,
) -> AppResult<super::StoredSession> {
    let stored = super::stored(&state.pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound("That browser session does not exist".into()))?;
    if stored.workspace_id != workspace_id {
        return Err(AppError::NotFound(
            "That browser session does not exist".into(),
        ));
    }
    Ok(stored)
}

async fn live_in(
    state: &AppState,
    workspace_id: &str,
    session_id: &str,
) -> AppResult<std::sync::Arc<Live>> {
    belongs_to(state, workspace_id, session_id).await?;
    session::require_live(state, session_id).await
}

/// Shared by the agent verb: it resolves a workspace the same way.
pub async fn workspace_of(state: &AppState, workspace_id: &str) -> AppResult<Workspace> {
    readable_workspace(state, workspace_id).await
}
