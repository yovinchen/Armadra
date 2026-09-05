//! The hook service — plan §5.2 / §5.4.
//!
//! Three surfaces, one router:
//!
//!   * the runtime's own TCP listener, so a client that cannot reach the socket
//!     (Windows, a stale socket path) still has somewhere to go;
//!   * a Unix socket at `<data_dir>/hook.sock`, which is the preferred path
//!     because it is not reachable from another machine at all;
//!   * `<data_dir>/hook-endpoint.env`, which tells a client where those two are.
//!
//! `HookService` owns the credentials and the reducer's per-node memory. It is
//! cheap to clone (one `Arc`) and lives in `AppState`.

pub mod auth;
pub mod endpoint;
pub mod ingest;
pub mod install;
pub mod normalize;
pub mod reduce;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use serde::Serialize;

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    paths,
};
use auth::{HookAuth, Verdict};
use endpoint::Endpoint;
use reduce::Memory;

/// The client reads stdin into memory with this cap; the server refuses more.
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// How often the stale-working sweep runs.
const SWEEP_INTERVAL_SECONDS: u64 = 60;
/// At most this many nodes are closed out per sweep, so one bad session cannot
/// produce a thousand-event burst on the WebSocket.
const SWEEP_BATCH: i64 = 64;
/// How long after a terminal ends before its node is closed out. A CLI's final
/// `Stop` is written on the way down and may still be in flight; the real
/// report is always better than our synthetic one.
const TERMINAL_GONE_GRACE_SECONDS: i64 = 30;

struct Inner {
    auth: HookAuth,
    data_dir: PathBuf,
    /// Rewritten whenever the runtime binds a different port. `None` when the
    /// runtime listens on sockets only (the desktop default, roadmap §4.4).
    port: RwLock<Option<u16>>,
    /// Per-node reducer state that does not survive a restart.
    memory: Mutex<HashMap<String, Memory>>,
    context_usage: crate::context_usage::ContextUsageCache,
}

#[derive(Clone)]
pub struct HookService {
    inner: Arc<Inner>,
}

/// What `GET /health` reports about the hook surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHealth {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The endpoint file exists and names this runtime.
    pub ok: bool,
}

impl HookService {
    pub fn context_usage(&self) -> &crate::context_usage::ContextUsageCache {
        &self.inner.context_usage
    }
    /// Loads (or creates) the credentials for `data_dir`. A data directory we
    /// cannot write is not fatal: the service falls back to in-memory
    /// credentials so the rest of the runtime still starts, and the endpoint
    /// file simply never appears — which the client reads as "no runtime".
    pub fn new(data_dir: PathBuf, port: Option<u16>) -> Self {
        let existing = endpoint::read(&data_dir.join("hook-endpoint.env"));
        let bearer = existing.get("ARMADRA_HOOK_TOKEN").cloned();
        let auth = HookAuth::load(&data_dir, bearer).unwrap_or_else(|error| {
            tracing::warn!(%error, "could not persist the hook secret; using an ephemeral one");
            HookAuth::ephemeral()
        });
        Self {
            inner: Arc::new(Inner {
                auth,
                data_dir,
                port: RwLock::new(port),
                memory: Mutex::new(HashMap::new()),
                context_usage: crate::context_usage::ContextUsageCache::default(),
            }),
        }
    }

    /// Uses the process-wide data directory (`ARMADRA_DATA_DIR` or the
    /// per-platform default).
    pub fn with_default_paths(port: Option<u16>) -> Self {
        Self::new(paths::data_dir(), port)
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    pub fn endpoint_file(&self) -> PathBuf {
        self.inner.data_dir.join("hook-endpoint.env")
    }

    pub fn node_token_dir(&self) -> PathBuf {
        self.inner.data_dir.join("node-tokens")
    }

    /// `None` on Windows, where the client uses the TCP fallback.
    pub fn socket_path(&self) -> Option<PathBuf> {
        cfg!(unix).then(|| self.inner.data_dir.join("hook.sock"))
    }

    pub fn port(&self) -> Option<u16> {
        self.inner.port.read().ok().and_then(|port| *port)
    }

    pub fn bearer_matches(&self, presented: Option<&str>) -> bool {
        self.inner.auth.bearer_matches(presented)
    }

    pub fn verdict(&self, node_id: &str, presented: Option<&str>) -> Verdict {
        self.inner.auth.verdict(node_id, presented)
    }

    /// Mints (or refreshes) `<data_dir>/node-tokens/<nodeId>`. Called when an
    /// agent terminal is created and by the refresh endpoint.
    pub fn issue_node_token(&self, node_id: &str) -> AppResult<String> {
        self.inner
            .auth
            .write_node_token(&self.node_token_dir(), node_id)
            .map_err(|error| AppError::Internal(format!("Could not write the node token: {error}")))
    }

    /// Runs `action` against this node's reducer memory. Held under one lock so
    /// two hooks firing in parallel for the same node cannot interleave.
    pub fn with_memory<T>(&self, node_id: &str, action: impl FnOnce(&mut Memory) -> T) -> T {
        let mut guard = match self.inner.memory.lock() {
            Ok(guard) => guard,
            // A poisoned lock must not take the hook surface down; the worst
            // case is one node losing its holdoff window.
            Err(poisoned) => poisoned.into_inner(),
        };
        action(guard.entry(node_id.to_owned()).or_default())
    }

    /// Writes the endpoint file. Called at start-up and whenever the port moves.
    pub fn publish_endpoint(&self, port: Option<u16>) -> AppResult<()> {
        if let Ok(mut current) = self.inner.port.write() {
            *current = port;
        }
        let endpoint = Endpoint {
            port,
            socket: self.socket_path(),
            token: self.inner.auth.bearer().to_owned(),
            node_token_dir: self.node_token_dir(),
        };
        endpoint.write(&self.endpoint_file()).map_err(|error| {
            AppError::Internal(format!("Could not write the hook endpoint file: {error}"))
        })
    }

    /// Extra PTY environment for an agent terminal, on top of
    /// [`crate::terminal::agent_environment`] — plan §5.5.
    ///
    /// `ARMADRA_PERM_WAIT_SECS` is what switches the hook client from "report and
    /// exit" to "write the request, wait for an answer file, print the
    /// decision". Only Claude implements a hook that can answer a permission
    /// request, and the user can turn it off with `hooks.replyApprovals`.
    pub fn extra_env(
        &self,
        agent_id: &str,
        settings: &crate::settings::SettingsStore,
    ) -> Vec<(String, String)> {
        let enabled = settings
            .document()
            .get("hooks")
            .and_then(|hooks| hooks.get("replyApprovals"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if agent_id != "claude" || !enabled {
            return Vec::new();
        }
        vec![(
            "ARMADRA_PERM_WAIT_SECS".to_owned(),
            crate::collab::approvals::PERM_WAIT_SECONDS.to_string(),
        )]
    }

    pub fn health(&self) -> HookHealth {
        let file = self.endpoint_file();
        let port = self.port();
        let published = endpoint::read(&file);
        // The file names this runtime when the transport it advertises is the
        // one we are actually on: the port when we have one, the socket
        // otherwise. A socket-only runtime whose file still carries a port is
        // a leftover from a previous run and is reported as not ok.
        let ok = match port {
            Some(port) => {
                published.get("ARMADRA_HOOK_PORT").map(String::as_str)
                    == Some(port.to_string().as_str())
            }
            None => {
                !published.contains_key("ARMADRA_HOOK_PORT")
                    && published.get("ARMADRA_HOOK_SOCK").map(String::as_str)
                        == self
                            .socket_path()
                            .map(|path| path.to_string_lossy().into_owned())
                            .as_deref()
            }
        };
        HookHealth {
            sock: self
                .socket_path()
                .map(|path| path.to_string_lossy().into_owned()),
            port,
            ok,
        }
    }
}

/// The routes the hook client talks to. Mounted on the main TCP router and,
/// identically, on the Unix socket listener.
///
/// They carry their own body limit and no CORS: a browser has no business here.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/verify", get(ingest::verify))
        .route("/hook/{agent_id}", post(ingest::ingest))
        // Plan §5.6 / §5.8 — the collaboration surface.
        .route("/context-link/{verb}", post(ingest::context_link))
        .route("/control/{verb}", post(ingest::control))
        // B01 — the controlled browser verbs. Same auth as `control`, plus a
        // context link to the browser node being driven.
        .route("/browser/{verb}", post(ingest::browser))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

/// Writes the endpoint file, starts the Unix socket listener and the stale
/// sweep. Every failure is logged rather than propagated: the runtime is still
/// useful without a hook surface, and a hard failure here would mean no canvas
/// at all.
pub fn start(state: AppState, port: Option<u16>) {
    if let Err(error) = state.hooks.publish_endpoint(port) {
        tracing::warn!(%error, "hook clients will not find this runtime");
    }
    spawn_unix_listener(state.clone());
    // Plan §5.5: pending permission files left by a client that was killed
    // mid-wait are cleared at start-up and hourly.
    crate::collab::approvals::start_sweep(state.clone());
    spawn_stale_sweep(state);
}

#[cfg(unix)]
fn spawn_unix_listener(state: AppState) {
    let Some(path) = state.hooks.socket_path() else {
        return;
    };
    tokio::spawn(async move {
        // A socket file left behind by a runtime that did not shut down cleanly
        // would refuse the bind; nothing can be listening on it, because the
        // bind below is what makes it live.
        let _ = std::fs::remove_file(&path);
        if let Some(directory) = path.parent() {
            let _ = std::fs::create_dir_all(directory);
            paths::harden_directory(directory);
        }
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "could not bind the hook socket");
                return;
            }
        };
        // The socket is a full grant of the hook surface: nobody else's.
        paths::harden_file(&path);
        tracing::info!(path = %path.display(), "hook socket is listening");
        let gate = state.terminals.clone();
        let router = routes()
            .with_state(state)
            .layer(axum::middleware::from_fn_with_state(
                gate,
                crate::desktop_control::reject_during_shutdown,
            ));
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "the hook socket listener stopped");
        }
    });
}

#[cfg(not(unix))]
fn spawn_unix_listener(_state: AppState) {
    // Windows clients use the TCP fallback named in the endpoint file.
}

/// Plan §5.4: a `working` node that has not reported for 20 minutes gets a
/// synthetic end, so it does not spin forever in the sessions sidebar.
fn spawn_stale_sweep(state: AppState) {
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(SWEEP_INTERVAL_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(error) = sweep_once(&state).await {
                tracing::warn!(%error, "the stale agent sweep failed");
            }
        }
    });
}

/// Two ways a turn can end without anyone saying so: the CLI stopped reporting
/// (20 minutes), or its terminal died and it will never report again.
pub async fn sweep_once(state: &AppState) -> AppResult<usize> {
    let now = chrono::Utc::now();
    let silent_since =
        (now - chrono::Duration::minutes(reduce::STALE_WORKING_MINUTES)).to_rfc3339();
    let gone_before = (now - chrono::Duration::seconds(TERMINAL_GONE_GRACE_SECONDS)).to_rfc3339();

    let mut closed = 0;
    for (agent, event) in db::stale_working_agents(&state.pool, &silent_since, SWEEP_BATCH)
        .await?
        .into_iter()
        .map(|agent| {
            let event = reduce::stale_event(&agent.node_id, &agent.agent_id);
            (agent, event)
        })
        .chain(
            db::agents_with_dead_terminals(&state.pool, &gone_before, SWEEP_BATCH)
                .await?
                .into_iter()
                .map(|agent| {
                    let event = reduce::terminal_gone_event(&agent.node_id, &agent.agent_id);
                    (agent, event)
                }),
        )
    {
        // The PTY is gone, so nothing is waiting for an answer any more: the
        // awaitingInput hold would otherwise rewrite this `done` to `waiting`
        // and leave the node claiming it wants input from a dead terminal.
        if event.silent {
            state
                .hooks
                .with_memory(&agent.node_id, |memory| memory.awaiting_input = false);
        }
        match ingest::apply(
            state,
            &agent.workspace_id,
            &agent.agent_id,
            event,
            &serde_json::Value::Null,
        )
        .await
        {
            Ok(Some(_)) => closed += 1,
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, node = %agent.node_id, "could not close a stale agent")
            }
        }
    }
    if closed > 0 {
        tracing::info!(closed, "closed agents that will not report again");
    }
    Ok(closed)
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn the_endpoint_file_is_written_and_the_bearer_survives_a_restart() {
        let directory = tempdir().unwrap();
        let service = HookService::new(directory.path().to_path_buf(), Some(43119));
        service.publish_endpoint(Some(43119)).unwrap();

        let published = endpoint::read(&service.endpoint_file());
        assert_eq!(published["ARMADRA_HOOK_VERSION"], "1");
        assert_eq!(published["ARMADRA_HOOK_PORT"], "43119");
        assert_eq!(
            published["ARMADRA_NODE_TOKEN_DIR"],
            service.node_token_dir().to_string_lossy()
        );
        assert!(published["ARMADRA_HOOK_TOKEN"].len() >= 32);
        #[cfg(unix)]
        assert_eq!(
            published["ARMADRA_HOOK_SOCK"],
            directory.path().join("hook.sock").to_string_lossy()
        );
        assert!(service.health().ok);

        // A second runtime over the same data directory keeps both secrets, so
        // terminals started by the first one keep reporting.
        let restarted = HookService::new(directory.path().to_path_buf(), Some(43118));
        assert!(restarted.bearer_matches(Some(&published["ARMADRA_HOOK_TOKEN"])));
        assert_eq!(
            restarted.verdict("node-a", Some(&service.issue_node_token("node-a").unwrap())),
            Verdict::Verified
        );

        // The health flag follows the port that is actually published.
        assert!(!restarted.health().ok);
        restarted.publish_endpoint(Some(43118)).unwrap();
        assert!(restarted.health().ok);
        assert_eq!(
            endpoint::read(&service.endpoint_file())["ARMADRA_HOOK_PORT"],
            "43118"
        );
    }

    /// A desktop Runtime binds no port. Its endpoint file must advertise the
    /// socket alone: a port key left over from a TCP run would send hook
    /// clients to whatever process now owns that number.
    #[cfg(unix)]
    #[test]
    fn a_socket_only_runtime_publishes_no_port_and_clears_a_previous_one() {
        let directory = tempdir().unwrap();
        let with_port = HookService::new(directory.path().to_path_buf(), Some(43119));
        with_port.publish_endpoint(Some(43119)).unwrap();
        assert!(with_port.health().ok);

        let socket_only = HookService::new(directory.path().to_path_buf(), None);
        // The stale port file does not describe this runtime.
        assert!(!socket_only.health().ok);
        socket_only.publish_endpoint(None).unwrap();
        let published = endpoint::read(&socket_only.endpoint_file());
        assert!(!published.contains_key("ARMADRA_HOOK_PORT"));
        assert_eq!(
            published["ARMADRA_HOOK_SOCK"],
            directory.path().join("hook.sock").to_string_lossy()
        );
        let health = socket_only.health();
        assert_eq!(health.port, None);
        assert!(health.ok);
        assert!(health.sock.is_some());
        // And the bearer is still the one earlier terminals were given.
        assert!(socket_only.bearer_matches(Some(&published["ARMADRA_HOOK_TOKEN"])));
    }

    #[test]
    fn node_tokens_are_written_next_to_the_endpoint_file() {
        let directory = tempdir().unwrap();
        let service = HookService::new(directory.path().to_path_buf(), Some(43119));
        let token = service.issue_node_token("node-a").unwrap();
        assert_eq!(
            std::fs::read_to_string(service.node_token_dir().join("node-a")).unwrap(),
            token
        );
        assert!(service.issue_node_token("../escape").is_err());
    }

    #[test]
    fn reducer_memory_is_per_node_and_survives_between_events() {
        let directory = tempdir().unwrap();
        let service = HookService::new(directory.path().to_path_buf(), Some(43119));
        service.with_memory("node-a", |memory| memory.awaiting_input = true);
        assert!(service.with_memory("node-a", |memory| memory.awaiting_input));
        assert!(!service.with_memory("node-b", |memory| memory.awaiting_input));
    }
}
