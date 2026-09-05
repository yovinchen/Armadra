//! `/api/settings` — reading and patching the settings document.

use axum::{Json, extract::State};

use crate::{
    AppState,
    error::{AppError, AppResult},
    settings,
};

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
