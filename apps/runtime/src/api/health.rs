//! `/health` and `/api/health` — the liveness document the desktop shell and
//! the hook clients probe.
//!
//! `instanceId` is the field that makes this document answer "*which* Runtime
//! is this?" rather than only "is something alive?". The shell compares it
//! with the id its own child announced; two builds of the same version are
//! otherwise indistinguishable, which is how a Runtime from a previous session
//! was once adopted as the current one (用户实测反馈 F1).

use axum::{Json, extract::State};
use serde::Serialize;

use crate::{AppState, hook::HookHealth, instance};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    status: &'static str,
    version: &'static str,
    /// Unique per *run*. Never reused, never derived from anything on disk.
    instance_id: &'static str,
    /// Commit this binary was built from — `build.rs`. Diagnosis only.
    build: &'static str,
    /// Where the hook clients should be reaching us, and whether the endpoint
    /// file on disk agrees (plan §5.2).
    hook: HookHealth,
}

pub async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        instance_id: instance::instance_id(),
        build: instance::BUILD,
        hook: state.hooks.health(),
    })
}
