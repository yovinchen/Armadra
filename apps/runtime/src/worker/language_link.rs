//! `armadra-runtime worker --stdio --language-link` — the execution host's
//! half of a remote language service (design §2.7, §4.1).
//!
//! ## Why a second connection
//!
//! The ordinary Worker connection ([`super::serve`]) is strictly one request,
//! one answer, behind one mutex that doubles as the Git queue. A language
//! server does not fit that shape: it pushes diagnostics nobody asked for, and
//! a completion that takes two seconds must not stall a file read. So a host
//! with language sessions gets a second `ssh` connection which, after the
//! handshake, stops taking turns — either side writes a frame whenever it has
//! one.
//!
//! ## Where the sessions live
//!
//! In *this* process. The design sketched session opening on the serial
//! connection, but the two connections are two `ssh` invocations and therefore
//! two processes; a session opened in one of them could not reach the server
//! started by the other. So `open`, `close` and `apply_edit` are requests on
//! this connection — still request/answer, still with the controller's grants
//! re-checked here — and only server *discovery*, which starts nothing and
//! holds nothing, stays on the serial connection.
//!
//! ## Back pressure
//!
//! Every message frame reserves credit from a [`Window`]. When the controller
//! stops acknowledging, the session pump stops draining the server's stdout,
//! the server blocks on its own write, and nothing is lost. Acks are not
//! counted against the window, so the release path can never be the thing that
//! is blocked.
//!
//! Payloads are never logged here, at any level (§3.4).

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use armadra_protocol::{Message, v1::*};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
};

use crate::{
    error::{AppError, AppResult},
    events::{EventHub, WorkspaceEvent},
    language::{self, link::Window},
    settings::SettingsStore,
};

/// Advertised by a Worker started with `--language-link`. A controller that
/// does not see it never sends a frame.
pub const CAPABILITY: &str = "language.link.v1";
/// Advertised by every Worker: discovery works without a link.
pub const CAPABILITY_V1: &str = "language.v1";

/// Server discovery for a connection that holds no link.
///
/// Probing is not starting: it runs each candidate's `--version`, caches the
/// answer for a day and returns rows. That is why the serial connection may
/// answer it while it must refuse everything else — the settings page has to
/// be able to say what a host has before anybody opens an editor on it.
pub async fn discovery(refresh: bool) -> LanguageCapabilities {
    static SETTINGS: std::sync::OnceLock<SettingsStore> = std::sync::OnceLock::new();
    let settings = SETTINGS.get_or_init(SettingsStore::load);
    let servers = language::discover::discover(settings, "local", true, refresh).await;
    let (documents, sessions, message) = language::capability_limits();
    LanguageCapabilities {
        execution_host_id: "local".into(),
        servers: servers
            .iter()
            .map(language::ServerDescriptor::to_proto)
            .collect(),
        max_document_bytes: documents,
        max_sessions: sessions,
        max_message_bytes: message,
    }
}

/// One session as this host tracks it.
struct Session {
    workspace_id: String,
    server_id: String,
    pump: tokio::task::JoinHandle<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

/// Everything the language link owns on the execution host.
pub struct Host {
    manager: language::Manager,
    settings: SettingsStore,
    events: EventHub,
    epoch: String,
    outgoing: mpsc::UnboundedSender<LanguageFrame>,
    /// Host → controller credit.
    window: Arc<Window>,
    sessions: Mutex<HashMap<String, Session>>,
    /// Workspaces whose status stream is already being forwarded.
    watched: Mutex<Vec<String>>,
}

impl Host {
    fn new(outgoing: mpsc::UnboundedSender<LanguageFrame>) -> Arc<Self> {
        Arc::new(Self {
            manager: language::Manager::new(),
            settings: SettingsStore::load(),
            events: EventHub::new(),
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            outgoing,
            window: Arc::new(Window::default()),
            sessions: Mutex::new(HashMap::new()),
            watched: Mutex::new(Vec::new()),
        })
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn emit(&self, mut frame: LanguageFrame) {
        frame.link_epoch = self.epoch.clone();
        let _ = self.outgoing.send(frame);
    }

    /* ------------------------------ discovery ----------------------------- */

    /// Server discovery on this machine, with whatever is actually running
    /// folded in. The probe answers "could this start"; a live hub answers
    /// "is it", and the resource panel needs the second one.
    pub async fn capabilities(&self, refresh: bool) -> LanguageCapabilities {
        let mut servers =
            language::discover::discover(&self.settings, "local", true, refresh).await;
        let workspaces: Vec<String> = self
            .sessions()
            .values()
            .map(|session| session.workspace_id.clone())
            .collect();
        for workspace_id in workspaces {
            for hub in self.manager.hubs_for(&workspace_id) {
                let live = hub.descriptor();
                if let Some(row) = servers
                    .iter_mut()
                    .find(|row| row.server_id == live.server_id)
                {
                    row.state = live.state;
                    row.reason = live.reason.clone();
                    row.restart_count = live.restart_count;
                    row.pid = live.pid;
                    row.start_time_unix_ms = live.start_time_unix_ms;
                    row.open_documents = live.open_documents;
                }
            }
        }
        let (documents, sessions, message) = language::capability_limits();
        LanguageCapabilities {
            execution_host_id: "local".into(),
            servers: servers
                .iter()
                .map(language::ServerDescriptor::to_proto)
                .collect(),
            max_document_bytes: documents,
            max_sessions: sessions,
            max_message_bytes: message,
        }
    }

    /* ------------------------------- sessions ----------------------------- */

    /// Opens one session and starts pumping its server's messages upward.
    ///
    /// The session id is minted here, not taken from the request: the manager
    /// owns the id space that the shadow documents and the pending table are
    /// keyed by, and two id spaces for one session would be one more thing to
    /// keep in step for no gain.
    pub async fn open(
        self: &Arc<Self>,
        root: PathBuf,
        request: OpenLanguageSessionRequest,
    ) -> AppResult<LanguageSession> {
        let opened = self
            .manager
            .open_session(
                &self.settings,
                &self.events,
                &request.workspace_id,
                &root,
                &request.language_id,
                &request.client_id,
                request.allow_write,
                request.allow_execute,
            )
            .await?;
        self.watch(&request.workspace_id);
        let host = Arc::clone(self);
        let session_id = opened.session_id.clone();
        let mut outbox = opened.outbox;
        let pump = tokio::spawn(async move {
            while let Some(body) = outbox.recv().await {
                if host.forward(&session_id, body).await.is_err() {
                    break;
                }
            }
        });
        self.sessions().insert(
            opened.session_id.clone(),
            Session {
                workspace_id: request.workspace_id.clone(),
                server_id: opened.server_id.clone(),
                pump,
            },
        );
        Ok(LanguageSession {
            session_id: opened.session_id,
            server_id: opened.server_id,
            generation: opened.generation,
            state: opened.state.to_proto() as i32,
            reason: opened.reason.unwrap_or_default(),
            server_capabilities_json: if opened.capabilities.is_null() {
                Vec::new()
            } else {
                serde_json::to_vec(&opened.capabilities).unwrap_or_default()
            },
        })
    }

    pub async fn close(&self, session_id: &str, _reason: &str) -> LanguageSession {
        let removed = self.sessions().remove(session_id);
        let server_id = match removed {
            Some(session) => {
                self.manager
                    .close_session(&session.workspace_id, session_id)
                    .await;
                session.server_id.clone()
            }
            None => String::new(),
        };
        LanguageSession {
            session_id: session_id.to_owned(),
            server_id,
            generation: 0,
            state: language::ServerState::Stopped.to_proto() as i32,
            reason: language::reason::USER.into(),
            server_capabilities_json: Vec::new(),
        }
    }

    /// One JSON-RPC message on its way up, wrapped and credited.
    ///
    /// The envelope's `method`, `kind` and `request_id` come from the message
    /// itself so that routing and traces never have to open `payload_json`.
    async fn forward(&self, session_id: &str, body: Vec<u8>) -> Result<(), ()> {
        let parsed = language::jsonrpc::Message::parse(&body).map_err(|_| ())?;
        if body.len() > language::MAX_MESSAGE_BYTES as usize {
            // Past the ceiling the answer cannot travel, so the session is
            // given a failure it can show rather than a frame that would be
            // refused by the transport with nobody to attribute it to.
            let error = language::jsonrpc::error_response(
                parsed.id.as_ref(),
                language::jsonrpc::REQUEST_FAILED,
                "The language server's answer was too large to send over the link",
            );
            let body = serde_json::to_vec(&error).unwrap_or_default();
            return Box::pin(self.forward(session_id, body)).await;
        }
        let Some(sequence) = self.window.reserve(body.len()).await else {
            return Err(());
        };
        self.emit(language::link::message_frame(
            session_id,
            sequence,
            parsed.kind,
            &parsed.method,
            &parsed.id_string(),
            body,
        ));
        Ok(())
    }

    /// Forwards this workspace's session status upward, once per workspace.
    fn watch(self: &Arc<Self>, workspace_id: &str) {
        {
            let mut watched = self
                .watched
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if watched.iter().any(|known| known == workspace_id) {
                return;
            }
            watched.push(workspace_id.to_owned());
        }
        let mut stream = self.events.subscribe(workspace_id);
        let host = Arc::clone(self);
        tokio::spawn(async move {
            while let Ok(event) = stream.recv().await {
                let WorkspaceEvent::LanguageSession {
                    session_id,
                    generation,
                    state,
                    reason,
                    restart_count,
                    progress,
                    ..
                } = event
                else {
                    continue;
                };
                host.emit(language::link::status_frame(LanguageSessionStatus {
                    session_id,
                    generation,
                    state: state.to_proto() as i32,
                    reason: reason.unwrap_or_default(),
                    restart_count,
                    progress_percent: progress.as_ref().and_then(|progress| progress.percent),
                    progress_title: progress.map(|progress| progress.title).unwrap_or_default(),
                }));
            }
        });
    }

    /* -------------------------------- frames ------------------------------ */

    /// One frame from the controller. Frames from an older link are dropped:
    /// the sessions they name belong to a connection that has gone away.
    pub fn frame(&self, frame: LanguageFrame) {
        if !frame.link_epoch.is_empty() && frame.link_epoch != self.epoch {
            return;
        }
        match frame.payload {
            Some(language_frame::Payload::Ack(ack)) => {
                self.window.acknowledge(ack.received_through)
            }
            Some(language_frame::Payload::Message(message)) => self.deliver(message),
            // The controller has no status to report; a server's state is
            // decided here and travels the other way.
            _ => {}
        }
    }

    fn deliver(&self, message: LanguageMessage) {
        let target = self
            .sessions()
            .get(&message.session_id)
            .map(|session| (session.workspace_id.clone(), session.server_id.clone()));
        if let Some((workspace_id, server_id)) = target
            && let Some(hub) = self.manager.hub(&workspace_id, &server_id)
        {
            // Every gate — the method allowlist, the write grant, the shadow
            // documents, the uri rewrite — is the same code the local path
            // runs, on the machine that would do the thing.
            language::session::handle(&hub, &message.session_id, &message.payload_json);
        }
        // Acknowledged whether or not a session claimed it. The credit belongs
        // to the connection, and holding it back for a session that has
        // already closed would stall every other session on the link.
        self.emit(language::link::ack_frame(
            &message.session_id,
            message.sequence,
            self.window.available(),
        ));
    }

    /* --------------------------------- edits ------------------------------ */

    pub async fn apply_edit(
        &self,
        root: PathBuf,
        request: LanguageApplyEditRequest,
    ) -> AppResult<LanguageApplyEditResult> {
        if !request.allow_write {
            return Err(AppError::Forbidden(
                "This workspace is opened read-only".into(),
            ));
        }
        let target = self
            .sessions()
            .get(&request.session_id)
            .map(|session| (session.workspace_id.clone(), session.server_id.clone()));
        let Some((workspace_id, server_id)) = target else {
            return Err(AppError::NotFound("No such language session".into()));
        };
        let hub = self
            .manager
            .hub(&workspace_id, &server_id)
            .ok_or_else(|| AppError::NotFound("No such language server".into()))?;
        let edit: serde_json::Value = serde_json::from_slice(&request.workspace_edit_json)
            .map_err(|_| AppError::BadRequest("The edit is not readable".into()))?;
        let files = language::edits::parse(&edit, &hub.rewriter)?;
        let dirty = {
            let held = hub.lock();
            language::edits::dirty_files(&files, &held.documents, &hub.rewriter)
        };
        if !dirty.is_empty() {
            return Err(AppError::Conflict(format!(
                "Save these files before applying the edit: {}",
                dirty.join(", ")
            )));
        }
        let events = self.events.clone();
        let expected: HashMap<String, String> = request.expected_sha256.into_iter().collect();
        let result = tokio::task::spawn_blocking(move || {
            language::edits::apply(&root, &workspace_id, &files, &expected, &events)
        })
        .await??;
        Ok(result.to_proto())
    }

    /// The Runtime is going away; end every server this link started.
    pub async fn shutdown(&self) {
        self.sessions().clear();
        self.window.close();
        self.manager.shutdown().await;
    }
}

/* ---------------------------------- serving -------------------------------- */

/// Runs one `--language-link` connection to completion.
///
/// Three concurrent parts: a writer owning stdout, a reader owning stdin, and
/// the request handler in between. A pushed frame never waits behind a request
/// and a request never waits behind a frame, which is the whole reason this
/// connection exists.
pub async fn serve<R, W>(input: R, output: W) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (outgoing, mut queued) = mpsc::unbounded_channel::<LanguageFrame>();
    let host = Host::new(outgoing);
    let (responses, mut pending) = mpsc::unbounded_channel::<WorkerResponse>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        loop {
            let response = tokio::select! {
                frame = queued.recv() => match frame {
                    Some(frame) => WorkerResponse {
                        result: Some(worker_response::Result::LanguageFrame(frame)),
                        ..Default::default()
                    },
                    None => return Ok::<(), anyhow::Error>(()),
                },
                response = pending.recv() => match response {
                    Some(response) => response,
                    None => return Ok(()),
                },
            };
            let bytes = response.encode_to_vec();
            anyhow::ensure!(
                !bytes.is_empty() && bytes.len() <= super::MAX_FRAME,
                "Worker frame exceeds the link limit"
            );
            output
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .await?;
            output.write_all(&bytes).await?;
            output.flush().await?;
        }
    });
    // The epoch is announced before anything else, so the controller can stamp
    // its first frame without waiting for a round trip it has no reason to make.
    host.emit(LanguageFrame {
        link_epoch: host.epoch().to_owned(),
        payload: None,
    });

    let mut worker = super::Worker::default();
    worker.attach_language(Arc::clone(&host));
    let result = read_loop(input, &mut worker, &host, &responses).await;
    drop(responses);
    host.shutdown().await;
    writer.abort();
    let _ = writer.await;
    result
}

async fn read_loop<R: AsyncRead + Unpin>(
    mut input: R,
    worker: &mut super::Worker,
    host: &Arc<Host>,
    responses: &mpsc::UnboundedSender<WorkerResponse>,
) -> anyhow::Result<()> {
    loop {
        let mut prefix = [0u8; 4];
        if input.read(&mut prefix[..1]).await? == 0 {
            return Ok(());
        }
        input.read_exact(&mut prefix[1..]).await?;
        let length = u32::from_be_bytes(prefix) as usize;
        anyhow::ensure!(
            length > 0 && length <= super::MAX_FRAME,
            "Invalid Worker frame length"
        );
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes).await?;
        let request = WorkerRequest::decode(bytes.as_slice())?;
        // A pushed frame has no request id and no answer. It is taken off the
        // request path entirely so the envelope rules that exist for
        // request/answer traffic do not reject it.
        if let Some(worker_request::Action::LanguageFrame(frame)) = request.action {
            host.frame(frame);
            continue;
        }
        let response = worker.handle(request).await;
        if responses.send(response).is_err() {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> (Arc<Host>, mpsc::UnboundedReceiver<LanguageFrame>) {
        let (outgoing, queued) = mpsc::unbounded_channel();
        (Host::new(outgoing), queued)
    }

    fn message(epoch: &str, session_id: &str, sequence: u64) -> LanguageFrame {
        let mut frame = language::link::message_frame(
            session_id,
            sequence,
            language::jsonrpc::Kind::Notification,
            "textDocument/didOpen",
            "",
            b"{}".to_vec(),
        );
        frame.link_epoch = epoch.to_owned();
        frame
    }

    /// A frame stamped with an older link names a session that has since been
    /// replaced. Applying it would let one connection's traffic land on
    /// another's documents, so it is dropped — and the drop is silent on the
    /// wire too: no ack, because there is nothing to acknowledge.
    #[tokio::test]
    async fn a_frame_from_an_older_link_is_dropped() {
        let (host, mut queued) = host();
        // The epoch announcement is the first thing any link writes.
        host.emit(LanguageFrame {
            link_epoch: host.epoch().to_owned(),
            payload: None,
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), queued.recv())
                .await
                .expect("the announcement is written")
                .is_some(),
        );

        host.frame(message("an-older-link", "s-1", 1));
        assert!(
            queued.try_recv().is_err(),
            "a stale frame produces nothing at all",
        );

        // The current epoch is acknowledged even though no session claims it:
        // the credit belongs to the connection, and withholding it for a
        // session that already left would stall every other session on it.
        host.frame(message(host.epoch(), "s-1", 4));
        let written = tokio::time::timeout(std::time::Duration::from_secs(5), queued.recv())
            .await
            .expect("an acknowledgement is written rather than withheld")
            .expect("the link is open");
        let Some(language_frame::Payload::Ack(ack)) = written.payload else {
            panic!("an ack frame");
        };
        assert_eq!(ack.received_through, 4);
        assert_eq!(ack.session_id, "s-1");
    }

    /// The controller's acknowledgement is what returns this host's credit.
    #[tokio::test]
    async fn an_acknowledgement_from_the_controller_returns_credit() {
        let (host, _queued) = host();
        assert_eq!(host.window.reserve(1_024).await, Some(1));
        assert_eq!(host.window.used(), 1_024);
        host.frame(language::link::ack_frame("s-1", 1, 0));
        assert_eq!(host.window.used(), 0);
    }
}
