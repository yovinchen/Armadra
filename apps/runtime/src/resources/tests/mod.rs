//! T02 end-to-end: sampling against a real child process, orphan listing
//! against a real database, and the lease lifecycle against the real platform
//! inhibitor.
//!
//! The shared fixture lives here; the cases are grouped by subject in the
//! modules beside it.

mod components;
mod orphan_sessions;
mod power;
mod sampling;
mod subscriptions;

use std::time::Duration;

use tempfile::TempDir;

use super::{
    ResourceService, SubscribeRequest, orphans, platform,
    power::{LeaseRequest, LeaseSource, PowerService, RenewRequest},
    sample::{self, Sampler},
};
use crate::{
    AppState, db,
    events::{EventHub, WorkspaceEvent},
    hook::HookService,
    settings::SettingsStore,
    terminal::{SpawnRequest, TerminateMode},
    usage::UsageService,
};

/// A whole runtime-shaped fixture on a temporary data directory, so a tmux run
/// never touches the developer's own socket.
struct Fixture {
    state: AppState,
    workspace_id: String,
    root: String,
    _directory: TempDir,
}

impl Fixture {
    fn resources(&self) -> &ResourceService {
        &self.state.resources
    }

    fn terminals(&self) -> &crate::terminal::TerminalManager {
        &self.state.terminals
    }

    fn events(&self) -> &EventHub {
        &self.state.events
    }

    fn pool(&self) -> &sqlx::SqlitePool {
        &self.state.pool
    }

    async fn snapshot(&self, prime: bool) -> super::ResourceSnapshot {
        self.resources()
            .snapshot(&self.state, &self.workspace_id, prime)
            .await
            .unwrap()
    }
}

async fn fixture_with(settings: serde_json::Value) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("runtime.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let workspace = db::create_workspace(
        &pool,
        "resources",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let events = EventHub::new();
    let settings = SettingsStore::in_memory(settings);
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        terminals: crate::terminal::TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        resources: ResourceService::new(settings.clone()),
        hooks: HookService::new(directory.path().to_path_buf(), None),
        usage: UsageService::new(settings.clone()),
        events,
        settings,
        pool,
    };
    Fixture {
        state,
        root: directory.path().to_string_lossy().into_owned(),
        workspace_id: workspace.id,
        _directory: directory,
    }
}

async fn fixture() -> Fixture {
    fixture_with(serde_json::json!({
        "terminal": { "backend": "direct" },
        "power": { "policy": "manual" },
        "resources": { "intervalMs": 500 }
    }))
    .await
}
