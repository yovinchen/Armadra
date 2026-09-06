//! The controller half of a remote language service (design §2.7, §4.1).
//!
//! ## What this is
//!
//! A second `ssh` connection to one execution host, opened the first time an
//! editor asks for a language session there and closed when the last one goes.
//! The serial connection ([`super::client`]) stays exactly what it was: one
//! request, one answer, one queue. This one is full duplex, because a server
//! pushes diagnostics nobody asked for and a slow completion must not stall a
//! file read.
//!
//! ## What the controller does and does not do
//!
//! It routes. It never parses a JSON-RPC payload, never logs one, and never
//! decides what a method may do — the execution host re-checks the method
//! allowlist and the workspace's grants, because it is the machine that would
//! run the thing (§3.1).
//!
//! ## Epochs
//!
//! The link announces a `link_epoch` as its first frame. Every frame in both
//! directions carries it, and a frame stamped with anything else is dropped.
//! When the connection dies, every session on it becomes `disconnected` and
//! its socket closes; the next session opens a new link with a new epoch. In
//! flight requests are not replayed — a rename that was written and then lost
//! its answer may already have touched files, and re-sending it is the one
//! thing that could do the damage twice.
//!
//! This module owns the connection state every caller shares; [`link`] is the
//! request surface an editor drives, and [`lifetime`] opens and replaces the
//! connection underneath it.

mod lifetime;
mod link;

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use armadra_protocol::v1;
use tokio::sync::{mpsc, oneshot};

use super::client::{RemoteWorker, remote_error};
use crate::{
    error::{AppError, AppResult},
    events::{EventHub, WorkspaceEvent},
    language::{self, link::Window},
};

/// Capability the second connection must advertise before a frame is written.
pub const LINK_CAPABILITY: &str = "language.link.v1";
/// How long one request on the link may take end to end.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// One session as the controller sees it: somewhere to put what arrives.
struct Sink {
    workspace_id: String,
    server_id: String,
    outbox: mpsc::UnboundedSender<Vec<u8>>,
}

/// What an opened remote session hands back, shaped like the local one so the
/// route does not care which machine answered.
pub struct OpenedSession {
    pub session_id: String,
    pub server_id: String,
    pub generation: u64,
    pub state: language::ServerState,
    pub reason: Option<String>,
    pub capabilities: serde_json::Value,
    pub outbox: mpsc::UnboundedReceiver<Vec<u8>>,
}

/// State shared between the reader task, the writer task and every caller.
struct Shared {
    controller_id: String,
    host_name: String,
    execution_host_id: String,
    outgoing: mpsc::UnboundedSender<v1::WorkerRequest>,
    /// Controller → execution host credit.
    window: Window,
    sessions: Mutex<HashMap<String, Sink>>,
    pending: Mutex<HashMap<String, oneshot::Sender<v1::worker_response::Result>>>,
    instance: Mutex<String>,
    epoch: Mutex<String>,
    roots: Mutex<HashSet<String>>,
    events: EventHub,
    alive: AtomicBool,
    /// The last descriptors the execution host reported, for the resource
    /// panel and the settings page.
    descriptors: Mutex<Vec<language::ServerDescriptor>>,
}

impl Shared {
    fn epoch(&self) -> String {
        self.epoch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Sink>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Sends one request and waits for its answer.
    async fn call(
        &self,
        action: v1::worker_request::Action,
    ) -> AppResult<v1::worker_response::Result> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(self.unavailable());
        }
        let request_id = uuid::Uuid::now_v7().simple().to_string();
        let (answer, wait) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request_id.clone(), answer);
        let request = v1::WorkerRequest {
            request_id: request_id.clone(),
            host_id: self.controller_id.clone(),
            expected_instance_id: self
                .instance
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
            deadline_unix_ms: chrono::Utc::now().timestamp_millis()
                + REQUEST_TIMEOUT.as_millis() as i64,
            action: Some(action),
        };
        if self.outgoing.send(request).is_err() {
            return Err(self.unavailable());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, wait).await {
            Ok(Ok(result)) => Ok(result),
            _ => {
                self.pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&request_id);
                Err(self.unavailable())
            }
        }
    }

    /// Pushes one frame. Frames are not requests: nothing waits for them.
    fn push(&self, mut frame: v1::LanguageFrame) -> Result<(), AppError> {
        frame.link_epoch = self.epoch();
        self.outgoing
            .send(v1::WorkerRequest {
                request_id: String::new(),
                host_id: self.controller_id.clone(),
                expected_instance_id: String::new(),
                deadline_unix_ms: 0,
                action: Some(v1::worker_request::Action::LanguageFrame(frame)),
            })
            .map_err(|_| self.unavailable())
    }

    fn unavailable(&self) -> AppError {
        AppError::Unavailable(format!(
            "The language link to {} is not available",
            self.host_name
        ))
    }

    /// The link is gone. Every session it held is `disconnected`, its socket
    /// closes, and every caller waiting for an answer is told the outcome is
    /// not known rather than being left to a timeout.
    fn fail(&self) {
        if !self.alive.swap(false, Ordering::SeqCst) {
            return;
        }
        self.window.close();
        let sessions: Vec<(String, Sink)> = self.sessions().drain().collect();
        for (session_id, sink) in sessions {
            self.events.publish(
                &sink.workspace_id,
                WorkspaceEvent::LanguageSession {
                    workspace_id: sink.workspace_id.clone(),
                    session_id,
                    server_id: sink.server_id.clone(),
                    generation: 0,
                    state: language::ServerState::Disconnected,
                    reason: Some(language::reason::LINK_LOST.into()),
                    restart_count: 0,
                    progress: None,
                },
            );
            // Dropping the sender closes the browser's socket, which is how a
            // client learns to stop waiting and re-open.
            drop(sink);
        }
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.descriptors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        tracing::info!(host = %self.execution_host_id, "the remote language link closed");
    }

    /// One frame from the execution host.
    fn frame(&self, frame: v1::LanguageFrame) {
        let epoch = self.epoch();
        if !epoch.is_empty() && !frame.link_epoch.is_empty() && frame.link_epoch != epoch {
            return;
        }
        match frame.payload {
            Some(v1::language_frame::Payload::Message(message)) => {
                let delivered = {
                    let sessions = self.sessions();
                    sessions
                        .get(&message.session_id)
                        .is_some_and(|sink| sink.outbox.send(message.payload_json).is_ok())
                };
                if !delivered {
                    tracing::debug!(
                        host = %self.execution_host_id,
                        method = %message.method,
                        "dropping a language message for a session that is gone",
                    );
                }
                // Acknowledged whether or not it landed: the credit is the
                // execution host's, and holding it back for a session that
                // already left would stall every other session on the link.
                let _ = self.push(language::link::ack_frame(
                    &message.session_id,
                    message.sequence,
                    language::link::CREDIT_BYTES as u32,
                ));
            }
            Some(v1::language_frame::Payload::Ack(ack)) => {
                self.window.acknowledge(ack.received_through)
            }
            Some(v1::language_frame::Payload::Status(status)) => self.status(status),
            // The epoch announcement: no payload, and the epoch is adopted by
            // the reader before this is ever called.
            None => {}
        }
    }

    fn status(&self, status: v1::LanguageSessionStatus) {
        let target = self
            .sessions()
            .get(&status.session_id)
            .map(|sink| (sink.workspace_id.clone(), sink.server_id.clone()));
        let Some((workspace_id, server_id)) = target else {
            return;
        };
        let state = state_of(status.state);
        self.events.publish(
            &workspace_id,
            WorkspaceEvent::LanguageSession {
                workspace_id: workspace_id.clone(),
                session_id: status.session_id,
                server_id,
                generation: status.generation,
                state,
                reason: (!status.reason.is_empty()).then_some(status.reason),
                restart_count: status.restart_count,
                progress: (status.progress_percent.is_some() || !status.progress_title.is_empty())
                    .then_some(crate::events::LanguageProgress {
                        percent: status.progress_percent,
                        title: status.progress_title,
                    }),
            },
        );
    }
}

fn state_of(value: i32) -> language::ServerState {
    use language::ServerState as State;
    match v1::LanguageServerState::try_from(value) {
        Ok(v1::LanguageServerState::Available) => State::Available,
        Ok(v1::LanguageServerState::Starting) => State::Starting,
        Ok(v1::LanguageServerState::Running) => State::Running,
        Ok(v1::LanguageServerState::IdleStopped) => State::IdleStopped,
        Ok(v1::LanguageServerState::Crashed) => State::Crashed,
        Ok(v1::LanguageServerState::Stopped) => State::Stopped,
        Ok(v1::LanguageServerState::Disconnected) => State::Disconnected,
        // An unspecified or unknown state is not guessed into "running".
        _ => State::Unsupported,
    }
}
/* ----------------------------------- link ---------------------------------- */

/// One live second connection.
pub struct Link {
    shared: Arc<Shared>,
    child: tokio::sync::Mutex<tokio::process::Child>,
}
/* --------------------------------- lifetime -------------------------------- */

/// One execution host's link slot. Empty until an editor needs it.
#[derive(Default)]
pub struct RemoteLanguage {
    link: tokio::sync::Mutex<Option<Arc<Link>>>,
}
pub use self::link::descriptors;
