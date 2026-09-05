//! The execution host's `Manager`: which servers exist, and for how long
//! (design §1.3, §3.3, §4.1).
//!
//! One `Manager` per Runtime. It owns a [`Hub`] per `(workspace, serverId)`
//! and one sweep task that does three things nobody else can:
//!
//!  * **Idle stopping.** A server with no open document for `idleStopSeconds`
//!    is shut down. The sessions and shadow documents survive, so the next
//!    `didOpen` restarts it and replays them — the editor sees a pause, not a
//!    disconnection.
//!  * **The RSS ceiling.** Three consecutive samples above the limit stop the
//!    server with `resource_exhausted` and do **not** restart it: a server
//!    that grew past four gigabytes will do it again, and a restart loop is
//!    worse than an honest stop.
//!  * **Request expiry.** A request older than 30 s is cancelled towards the
//!    server and failed towards the session, so a hung server does not leave
//!    an editor waiting forever.
//!
//! The sweep runs only while at least one hub exists, so a Runtime with no
//! editor open pays nothing.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tokio::sync::mpsc;

use super::{
    MAX_SESSIONS, REQUEST_TIMEOUT_SECONDS, ServerState, discover, mux::Hub, mux::Sink, reason,
    registry, server::Launch, settings::LanguageSettings,
};
use crate::{
    error::{AppError, AppResult},
    events::EventHub,
    settings::SettingsStore,
};

/// How often idle, memory and request deadlines are checked.
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// One opened session, as the caller sees it.
pub struct OpenedSession {
    pub session_id: String,
    pub server_id: String,
    pub generation: u64,
    pub state: ServerState,
    pub reason: Option<String>,
    pub capabilities: serde_json::Value,
    /// Messages from the server towards this browser connection.
    pub outbox: mpsc::UnboundedReceiver<Vec<u8>>,
}

#[derive(Clone, Default)]
pub struct Manager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    hubs: Mutex<HashMap<(String, String), Arc<Hub>>>,
    sweeping: Mutex<bool>,
    /// The `language` section as of the last session opened. The sweep runs
    /// without a request behind it, so it cannot read the settings store; this
    /// is the snapshot it uses instead.
    limits: Mutex<Option<LanguageSettings>>,
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    fn hubs(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Arc<Hub>>> {
        self.inner
            .hubs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn hub(&self, workspace_id: &str, server_id: &str) -> Option<Arc<Hub>> {
        self.hubs()
            .get(&(workspace_id.to_owned(), server_id.to_owned()))
            .cloned()
    }

    /// Every hub of one workspace, for the settings page and the panel.
    pub fn hubs_for(&self, workspace_id: &str) -> Vec<Arc<Hub>> {
        self.hubs()
            .iter()
            .filter(|((workspace, _), _)| workspace == workspace_id)
            .map(|(_, hub)| hub.clone())
            .collect()
    }

    /// Running servers, for the resource panel's platform components.
    ///
    /// The manager is the only authority for this: a language server is an
    /// ordinary child process, and a name scan could not tell one apart from
    /// the same compiler running inside a terminal node.
    pub fn running_processes(&self) -> Vec<crate::resources::platform::LanguageServerTarget> {
        self.hubs()
            .values()
            .filter_map(|hub| {
                let state = hub.lock();
                let process = state.process.as_ref()?;
                Some(crate::resources::platform::LanguageServerTarget {
                    pid: process.pid?,
                    start_time_unix_ms: process.start_time_unix_ms,
                })
            })
            .collect()
    }

    /// Opens one browser session against the server for `language_id`.
    ///
    /// The workspace's grants are re-checked here, not only where the request
    /// arrived: this is the execution host, and it is what would start the
    /// process.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_session(
        &self,
        settings: &SettingsStore,
        events: &EventHub,
        workspace_id: &str,
        root: &std::path::Path,
        language_id: &str,
        client_id: &str,
        allow_write: bool,
        allow_execute: bool,
    ) -> AppResult<OpenedSession> {
        if !allow_execute {
            return Err(AppError::Forbidden(reason::EXECUTION_NOT_GRANTED.into()));
        }
        let language = LanguageSettings::from_document(&settings.document());
        *self
            .inner
            .limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(language.clone());
        let Some(entry) = registry::language(language_id) else {
            return Err(AppError::BadRequest(reason::LANGUAGE_UNKNOWN.into()));
        };
        let (server_id, executable, args) = self
            .resolve(settings, &language, entry)
            .ok_or_else(|| AppError::BadRequest(reason::SERVER_NOT_FOUND.into()))?;

        let hub = {
            let key = (workspace_id.to_owned(), server_id.clone());
            let mut hubs = self.hubs();
            if let Some(hub) = hubs.get(&key) {
                hub.clone()
            } else {
                // The ceiling counts servers, not sessions: each one is a
                // compiler-sized process, and six of them is already a lot of
                // machine for an editor to be using.
                let running = hubs
                    .keys()
                    .filter(|(workspace, _)| workspace == workspace_id)
                    .count();
                if running >= language.max_servers as usize {
                    return Err(AppError::Conflict(reason::TOO_MANY_SERVERS.into()));
                }
                let hub = Hub::new(
                    workspace_id,
                    entry.language_id,
                    root.to_path_buf(),
                    Launch {
                        server_id: server_id.clone(),
                        executable,
                        args,
                        root: root.to_path_buf(),
                        initialization_options: language.initialization_options(&server_id),
                    },
                    events.clone(),
                );
                hubs.insert(key, hub.clone());
                hub
            }
        };
        self.ensure_sweeping();

        let session_id = uuid::Uuid::new_v4().simple().to_string();
        let (outbox, receiver) = mpsc::unbounded_channel();
        {
            let mut state = hub.lock();
            if state.sessions.len() >= MAX_SESSIONS as usize {
                return Err(AppError::Conflict(reason::RESOURCE_EXHAUSTED.into()));
            }
            state.sessions.insert(
                session_id.clone(),
                Sink {
                    client_id: client_id.to_owned(),
                    allow_write,
                    outbox,
                    in_flight: 0,
                },
            );
            state.idle_since = None;
        }
        let start = hub.ensure_started().await;
        let (state, why, generation, capabilities) = {
            let held = hub.lock();
            (
                held.state,
                held.reason.clone().or_else(|| start.err()),
                held.generation,
                held.capabilities.clone(),
            )
        };
        hub.publish_status();
        Ok(OpenedSession {
            session_id,
            server_id,
            generation,
            state,
            reason: why,
            capabilities,
            outbox: receiver,
        })
    }

    /// The candidate that would actually be started: the first one whose probe
    /// resolved to a real program.
    fn resolve(
        &self,
        settings: &SettingsStore,
        language: &LanguageSettings,
        entry: &registry::LanguageEntry,
    ) -> Option<(String, PathBuf, Vec<String>)> {
        for candidate in entry.candidates {
            if !language.server(candidate.server_id).enabled {
                continue;
            }
            // Only the frozen path from the probe is launched; a bare name is
            // never re-resolved against whatever PATH a child would inherit.
            if let Some(executable) =
                discover::resolved_executable(settings, "local", candidate.server_id)
            {
                return Some((
                    candidate.server_id.to_owned(),
                    executable,
                    discover::args_for(language, candidate),
                ));
            }
        }
        None
    }

    /// Closes one session and drops its documents.
    pub async fn close_session(&self, workspace_id: &str, session_id: &str) -> bool {
        let Some(hub) = self
            .hubs_for(workspace_id)
            .into_iter()
            .find(|hub| hub.lock().sessions.contains_key(session_id))
        else {
            return false;
        };
        let uris: Vec<String> = {
            let state = hub.lock();
            state.documents.uris_for(session_id)
        };
        for uri in uris {
            // Reuse the ordinary close path so ownership moves and `didClose`
            // reach the server exactly as they would from the browser.
            let notification = super::jsonrpc::notification(
                "textDocument/didClose",
                serde_json::json!({ "textDocument": { "uri": uri } }),
            );
            let body = serde_json::to_vec(&notification).unwrap_or_default();
            super::session::handle(&hub, session_id, &body);
        }
        {
            let mut state = hub.lock();
            state.sessions.remove(session_id);
            state
                .pending
                .retain(|_, pending| pending.session_id != session_id);
            if state.documents.is_empty() {
                state.idle_since = Some(std::time::Instant::now());
            }
        }
        hub.publish_status();
        true
    }

    /// A person pressed restart. This is the only thing that clears an
    /// exhausted restart budget or a resource stop.
    pub async fn restart(&self, workspace_id: &str, server_id: &str) -> AppResult<()> {
        let hub = self
            .hub(workspace_id, server_id)
            .ok_or_else(|| AppError::NotFound("No such language server".into()))?;
        hub.stop_process(ServerState::Stopped, reason::USER).await;
        {
            let mut state = hub.lock();
            state.crashes.clear();
            state.reason = None;
            state.state = ServerState::Available;
        }
        hub.ensure_started().await.map_err(AppError::Conflict)?;
        Ok(())
    }

    /// A person pressed stop. It stays stopped until somebody restarts it.
    pub async fn stop(&self, workspace_id: &str, server_id: &str) -> AppResult<()> {
        let hub = self
            .hub(workspace_id, server_id)
            .ok_or_else(|| AppError::NotFound("No such language server".into()))?;
        hub.stop_process(ServerState::Stopped, reason::USER).await;
        Ok(())
    }

    /// The workspace closed, lost a grant, or the Runtime is going away.
    pub async fn release_workspace(&self, workspace_id: &str, why: &str) {
        let hubs: Vec<Arc<Hub>> = {
            let mut held = self.hubs();
            let keys: Vec<(String, String)> = held
                .keys()
                .filter(|(workspace, _)| workspace == workspace_id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| held.remove(&key))
                .collect()
        };
        for hub in hubs {
            hub.lock().sessions.clear();
            hub.stop_process(ServerState::Stopped, why).await;
        }
    }

    /// Every server, everywhere. Called when the Runtime shuts down.
    pub async fn shutdown(&self) {
        let hubs: Vec<Arc<Hub>> = self.hubs().drain().map(|(_, hub)| hub).collect();
        for hub in hubs {
            hub.lock().sessions.clear();
            hub.stop_process(ServerState::Stopped, reason::WORKSPACE_CLOSED)
                .await;
        }
    }

    fn ensure_sweeping(&self) {
        {
            let mut sweeping = self
                .inner
                .sweeping
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *sweeping {
                return;
            }
            *sweeping = true;
        }
        let manager = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_INTERVAL).await;
                if manager.sweep().await {
                    break;
                }
            }
            let mut sweeping = manager
                .inner
                .sweeping
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *sweeping = false;
        });
    }

    /// One pass. Returns `true` when there is nothing left to sweep.
    async fn sweep(&self) -> bool {
        let hubs: Vec<Arc<Hub>> = self.hubs().values().cloned().collect();
        if hubs.is_empty() {
            return true;
        }
        // `0` means idle stopping is off, which is a real choice; it is not
        // clamped up into "stop after one second".
        let idle_after = std::time::Duration::from_secs(
            self.inner
                .limits
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .map(|limits| limits.idle_stop_seconds)
                .unwrap_or(super::settings::DEFAULT_IDLE_STOP_SECONDS),
        );
        for hub in hubs {
            super::mux::expire_requests(
                &hub,
                std::time::Duration::from_secs(REQUEST_TIMEOUT_SECONDS),
            );
            let (running, idle_since) = {
                let state = hub.lock();
                (state.state == ServerState::Running, state.idle_since)
            };
            if !running {
                continue;
            }
            if let Some(since) = idle_since
                && idle_after.as_secs() > 0
                && since.elapsed() >= idle_after
            {
                // The sessions and the shadow documents stay. The next
                // `didOpen` restarts the process and replays them.
                hub.stop_process(ServerState::IdleStopped, reason::IDLE)
                    .await;
            }
        }
        false
    }

    /// Applies the RSS ceiling from one resource sample.
    ///
    /// Called by the sampler rather than sampling here: the process table is
    /// walked once per sample for the whole panel, and walking it a second
    /// time for language servers would double the cost of the expensive part.
    pub async fn note_memory(&self, samples: &HashMap<i64, u64>, ceiling: u64) {
        if ceiling == 0 {
            return;
        }
        let hubs: Vec<Arc<Hub>> = self.hubs().values().cloned().collect();
        for hub in hubs {
            let over = {
                let mut state = hub.lock();
                let Some(pid) = state.process.as_ref().and_then(|process| process.pid) else {
                    continue;
                };
                match samples.get(&pid) {
                    Some(rss) if *rss > ceiling => {
                        state.over_rss += 1;
                        state.over_rss
                    }
                    _ => {
                        state.over_rss = 0;
                        0
                    }
                }
            };
            // Three in a row, not one: a server indexing a large repository
            // spikes, and killing it for a spike would make big projects
            // unusable rather than safe.
            if over >= 3 {
                hub.stop_process(ServerState::Stopped, reason::RESOURCE_EXHAUSTED)
                    .await;
            }
        }
    }
}
