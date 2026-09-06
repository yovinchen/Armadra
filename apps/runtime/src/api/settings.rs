//! `/api/settings` — reading and patching the settings document.

use axum::{Json, extract::State};

use crate::{
    AppState,
    error::{AppError, AppResult},
    ownership, settings,
};

/* --------------------------------- settings ------------------------------- */

pub async fn get_settings(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.settings.document())
}

/// What the settings page shows as "this machine" rather than "your account".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSettings {
    /// Dotted paths stored in `worker-settings.json`, in the order the split
    /// declares them.
    pub paths: Vec<String>,
    /// Where that file is, so the page can say it rather than imply it.
    pub file: String,
}

/// `GET /api/settings/local` — which keys belong to this execution host.
///
/// The list lives in the Runtime because the Runtime is what enforces it; a
/// second copy in the front end would be a second answer to "does this key
/// travel", and the two would drift. It is deliberately **not** gated on
/// settings ownership: local keys never move to the Host, so the page has to
/// be able to group them by source whoever owns the shared document.
pub async fn get_local_settings() -> Json<LocalSettings> {
    Json(LocalSettings {
        paths: settings::local_paths(),
        file: crate::paths::worker_settings_file()
            .to_string_lossy()
            .into_owned(),
    })
}

/// `PATCH /api/settings` — a merge, so a key this build does not know about is
/// preserved rather than dropped.
///
/// The gate is on the write alone. `GET /api/settings` keeps answering once the
/// Host owns the domain, which is what lets the UI show the settings this
/// Runtime no longer writes instead of an error page.
///
/// The two SSH probes (`POST /api/ssh/hosts/{id}/test` and
/// `.../worker/test`) are deliberately not gated: they run a command on a
/// machine and change no settings, and execution stays with the Worker whoever
/// owns a domain (§1.3).
pub async fn patch_settings(
    State(state): State<AppState>,
    Json(patch): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Settings).await?;
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
