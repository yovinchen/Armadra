//! `/health` and `/api/health` — the liveness document the desktop shell and
//! the hook clients probe.

use axum::{Json, extract::State};
use serde::Serialize;

use crate::{AppState, hook::HookHealth};

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
