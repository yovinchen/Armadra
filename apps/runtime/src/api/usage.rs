//! `/api/usage` and `/api/copilot` — quota snapshots, cost summaries and
//! the Copilot device-login flow.

use axum::{Json, extract::State};

use crate::{
    AppState,
    error::{AppError, AppResult},
    usage::UsageSnapshot,
};

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

/// `GET /api/usage/mini` — the two bars a desktop tray strip needs: the most
/// pressed session (≤ 24h) and week (> 24h) window across every provider.
/// A separate route so the tray does not have to parse the whole snapshot.
pub async fn usage_mini(State(state): State<AppState>) -> Json<crate::usage::MiniUsage> {
    Json(crate::usage::MiniUsage::from_snapshot(
        &state.usage.snapshot(),
    ))
}

/// `GET /api/usage/cost` — the cached local-transcript summary (roadmap §4.2).
/// Token counters, model ids and dates; never a line of transcript.
pub async fn get_usage_cost(
    State(state): State<AppState>,
) -> Json<crate::usage::cost::CostSummary> {
    Json(state.usage.cost.summary())
}

/// `POST /api/usage/cost/refresh` — rescan now, at most once every 30s.
pub async fn refresh_usage_cost(
    State(state): State<AppState>,
) -> Json<crate::usage::cost::CostSummary> {
    Json(state.usage.cost.refresh_manual().await)
}

/// `GET /api/usage/copilot` — signed-in flag, where the token lives and the
/// pending device-flow prompt. Never the token or the device code.
pub async fn copilot_state(
    State(state): State<AppState>,
) -> Json<crate::usage::copilot::AuthState> {
    let (_, login) = state.usage.copilot();
    Json(login.state().await)
}

/// `POST /api/usage/copilot/login` — start (or resume) the GitHub device flow.
pub async fn copilot_login(
    State(state): State<AppState>,
) -> AppResult<Json<crate::usage::copilot::AuthState>> {
    let (client, login) = state.usage.copilot();
    login.begin(client).await.map(Json).map_err(|error| {
        // Rule 3: the upstream detail is logged, not returned.
        tracing::debug!(%error, "Copilot device-flow start failed");
        AppError::Internal("Could not start the GitHub sign-in".into())
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPollResponse {
    progress: crate::usage::copilot::LoginProgress,
    #[serde(flatten)]
    state: crate::usage::copilot::AuthState,
}

/// `POST /api/usage/copilot/poll` — one poll of the running flow. The client
/// calls this on the interval GitHub asked for.
pub async fn copilot_poll(State(state): State<AppState>) -> Json<CopilotPollResponse> {
    let (client, login) = state.usage.copilot();
    let (progress, auth) = login.poll(client).await;
    if progress == crate::usage::copilot::LoginProgress::Authorized {
        // A fresh token should show up on the next board poll, not in five
        // minutes.
        state.usage.refresh().await;
    }
    Json(CopilotPollResponse {
        progress,
        state: auth,
    })
}

/// `POST /api/usage/copilot/logout` — drop the stored token.
pub async fn copilot_logout(
    State(state): State<AppState>,
) -> AppResult<Json<crate::usage::copilot::AuthState>> {
    let (_, login) = state.usage.copilot();
    let auth = login.logout().await.map_err(|error| {
        tracing::debug!(%error, "Copilot sign-out failed");
        AppError::Internal("Could not remove the stored GitHub token".into())
    })?;
    state.usage.refresh().await;
    Ok(Json(auth))
}
