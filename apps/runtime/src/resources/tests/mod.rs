//! T02 end-to-end: sampling against a real child process, orphan listing
//! against a real database, and the lease lifecycle against the real platform
//! inhibitor.
//!
//! The shared fixture lives here; the cases are grouped by subject in the
//! modules beside it.

// `components` and `orphan_sessions` measure real children of a real shell, so
// every case in them spawns `/bin/sh`; there is no Windows equivalent to point
// them at yet (T01 is what would give them one).
#[cfg(unix)]
mod components;
#[cfg(unix)]
mod orphan_sessions;
mod power;
mod sampling;
mod subscriptions;

use std::time::Duration;

use tempfile::TempDir;

use super::{ResourceService, SubscribeRequest, sample::Sampler};
// Everything below belongs to a case that spawns a real shell, which is what
// the Unix-only modules above do.
#[cfg(unix)]
use super::{orphans, platform, sample};
#[cfg(unix)]
use crate::terminal::{SpawnRequest, TerminateMode};
// The lease cases in `power` drive the real macOS inhibitor; on the other
// platforms that module compiles to nothing and these names have no user.
#[cfg(target_os = "macos")]
use super::power::{LeaseRequest, LeaseSource, PowerService, RenewRequest};
use crate::{
    AppState, db,
    events::{EventHub, WorkspaceEvent},
    hook::HookService,
    settings::SettingsStore,
    usage::UsageService,
};

/// A whole runtime-shaped fixture on a temporary data directory, so a tmux run
/// never touches the developer's own socket.
struct Fixture {
    state: AppState,
    workspace_id: String,
    #[cfg(unix)]
    root: String,
    _directory: TempDir,
}

impl Fixture {
    fn resources(&self) -> &ResourceService {
        &self.state.resources
    }

    #[cfg(unix)]
    fn terminals(&self) -> &crate::terminal::TerminalManager {
        &self.state.terminals
    }

    fn events(&self) -> &EventHub {
        &self.state.events
    }

    #[cfg(unix)]
    fn pool(&self) -> &sqlx::SqlitePool {
        &self.state.pool
    }

    #[cfg(unix)]
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
        #[cfg(unix)]
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
