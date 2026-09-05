//! The Windows backend: terminals owned by `armadra-session-host`.
//!
//! Windows only, and cfg-gated as a whole. Unix keeps tmux, whose server
//! already does this job; nothing here changes anything for it.
//!
//! What makes this different from [`super::direct`] is a process boundary. The
//! pseudo console belongs to the session host, not to this process, so:
//!
//! * `create` is a request, not a spawn. Two Workers racing to start a host
//!   end up with one, because only one can own the first pipe instance.
//! * `attach` opens its own pipe connection, so a slow socket cannot delay a
//!   control request — and its `DetachGuard` closes that connection, which is
//!   a detach and never an end.
//! * `detach_all` closes connections and leaves the host alone. Runtime
//!   shutdown must not take a user's agents with it; that is the whole point.
//!
//! The pipe itself, the identity checks and the frame routing live in
//! `armadra_session_host::link`. Not for tidiness: this crate cannot be
//! cross-compiled for Windows on a Mac (`docs/research/m0-executor-probes.md`),
//! so Windows code here is written blind, while that crate does cross-compile.
//! What is left below is mapping, and nothing that touches a handle.

#![cfg(windows)]

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use armadra_session_host::{
    client::RequestIds,
    link::{self, Link, LinkEvent},
    protocol::{ClientMessage, CreateSpec, ErrorCode, HostMessage, Size, base64},
    replay,
};
use async_trait::async_trait;
use bytes::Bytes;
use portable_pty::PtySize;
use tokio::sync::{Mutex, RwLock, broadcast, mpsc};

use crate::{
    error::{AppError, AppResult},
    terminal::backend::{
        AttachHandle, BackendKind, BackendNotice, BackendRef, DetachGuard, ForegroundInfo,
        NoticeSender, PASTE_END, PASTE_START, SessionKey, TerminalBackend, TerminalHandle,
        TerminalSpec, sanitize_paste, strip_escapes, tail_lines, trim_captured,
    },
};

/// Everything this Worker remembers about one host session.
#[derive(Debug, Clone)]
struct Remembered {
    generation: u64,
    pid: Option<i64>,
    /// The last replay this Worker saw, for `capture`. The host keeps bytes
    /// rather than a screen, so this is the same approximation the direct
    /// backend makes — labelled as such, not presented as a real capture.
    screen: Arc<std::sync::Mutex<Vec<u8>>>,
}

pub struct SessionHostBackend {
    data_dir: PathBuf,
    notices: NoticeSender,
    /// The one long-lived connection every control request goes through.
    control: Mutex<Option<Arc<Link>>>,
    sessions: RwLock<HashMap<SessionKey, Remembered>>,
    ids: Mutex<RequestIds>,
    /// Identifies the host process this Worker is talking to. A change means
    /// the host restarted and the sessions it held are gone — a fact worth
    /// reporting, not one to infer from an empty list.
    instance: Mutex<Option<String>>,
}

impl SessionHostBackend {
    /// Prepares the backend without touching the host.
    ///
    /// Connecting lazily is deliberate: the manager is built synchronously,
    /// and starting a second process from a constructor would make "the
    /// runtime started" depend on "the session host started". The first
    /// request connects, launching the host if nothing answers, and fails
    /// loudly if it cannot — which is the honest outcome, because falling back
    /// to the direct backend would quietly hand the user terminals that die
    /// with this process.
    pub fn new(data_dir: &Path, notices: NoticeSender) -> Self {
        Self {
            data_dir: data_dir.to_owned(),
            notices,
            control: Mutex::new(None),
            sessions: RwLock::new(HashMap::new()),
            ids: Mutex::new(RequestIds::default()),
            instance: Mutex::new(None),
        }
    }

    /// Reaches the host, starting it if needed, so a failure is reported
    /// before the first terminal rather than inside it.
    pub async fn probe(&self) -> AppResult<()> {
        self.control_link().await.map(|_| ())
    }

    /// Takes a session the host still holds back under management after a
    /// Worker restart, and reports the pid behind it.
    ///
    /// The T01 promise made concrete: the console was never this process', so
    /// coming back is bookkeeping, not a restart, and the CLI on the other
    /// side sees nothing at all.
    pub async fn adopt(&self, key: &SessionKey, reference: &str, generation: u64) -> Option<i64> {
        let pid = match self.request(|id| ClientMessage::List { id }).await {
            Ok(HostMessage::Ok {
                sessions: Some(sessions),
                ..
            }) => sessions
                .into_iter()
                .find(|summary| {
                    summary.session_key == key.as_str() && summary.generation == generation
                })
                .and_then(|summary| summary.pid)
                .map(i64::from),
            _ => None,
        };
        tracing::debug!(%key, reference, generation, ?pid, "adopted a session host session");
        self.sessions.write().await.insert(
            key.clone(),
            Remembered {
                generation,
                pid,
                screen: Arc::new(std::sync::Mutex::new(Vec::new())),
            },
        );
        pid
    }

    fn endpoint(&self) -> AppResult<String> {
        link::endpoint_for(&self.data_dir.to_string_lossy()).map_err(|error| {
            AppError::Internal(format!("could not name the session host pipe: {error}"))
        })
    }

    /// The control connection, opened or reopened as needed.
    ///
    /// Reconnecting is normal — the host may have been upgraded, or this
    /// Worker may have been asleep. What must not happen is silently moving to
    /// a *different* host instance, so the instance id is compared and a
    /// change is reported and clears what this Worker thought it knew.
    async fn control_link(&self) -> AppResult<Arc<Link>> {
        let mut held = self.control.lock().await;
        if let Some(link) = held.as_ref()
            && link.alive()
        {
            return Ok(link.clone());
        }
        let endpoint = self.endpoint()?;
        let sink = self.event_sink();
        let link = match Link::connect(&endpoint, sink.clone()).await {
            Ok(link) => link,
            Err(first) => {
                let executable = link::resolve_host_binary().map_err(|error| {
                    AppError::NotFound(format!("could not find the session host: {error}"))
                })?;
                link::start_host(&executable, &self.data_dir).map_err(|error| {
                    AppError::Internal(format!("could not start {}: {error}", executable.display()))
                })?;
                link::wait_for_host(&endpoint, sink, link::START_TIMEOUT)
                    .await
                    .map_err(|_| {
                        AppError::Internal(format!(
                            "the session host did not come up ({first}); terminals would not \
                             survive a restart"
                        ))
                    })?
            }
        };
        let greeting = link
            .handshake(&format!("armadra-runtime/{}", env!("CARGO_PKG_VERSION")))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;

        let mut instance = self.instance.lock().await;
        if let Some(previous) = instance.as_ref()
            && *previous != greeting.instance_id
        {
            tracing::warn!(
                previous = %previous,
                current = %greeting.instance_id,
                "the session host restarted; the sessions it held are gone"
            );
            self.sessions.write().await.clear();
        }
        *instance = Some(greeting.instance_id.clone());
        tracing::info!(
            host = %greeting.host_version,
            pid = greeting.pid,
            sessions = greeting.sessions.len(),
            "attached to the Windows session host"
        );
        *held = Some(link.clone());
        Ok(link)
    }

    /// Turns control-connection events into the notices the manager already
    /// understands. An attach connection gets its own sink; see `attach`.
    fn event_sink(&self) -> link::EventSink {
        let notices = self.notices.clone();
        Arc::new(move |event: LinkEvent| match event {
            LinkEvent::Exit {
                session_key,
                generation,
                exit_code,
            } => {
                let _ = notices.send(BackendNotice::Exited {
                    session_key: SessionKey::new(session_key),
                    generation,
                    exit_code,
                });
            }
            LinkEvent::Warning {
                session_key,
                message,
            } => tracing::warn!(%session_key, %message, "session host warning"),
            LinkEvent::Bye { reason, drain } => {
                tracing::info!(%reason, drain, "the session host is leaving")
            }
            _ => {}
        })
    }

    async fn next_id(&self) -> u64 {
        self.ids.lock().await.issue()
    }

    /// Sends one control request and waits for its answer.
    async fn request(&self, build: impl FnOnce(u64) -> ClientMessage) -> AppResult<HostMessage> {
        let id = self.next_id().await;
        let message = build(id);
        // One reconnect, then give up: retrying forever would hide a host that
        // is refusing rather than absent.
        for attempt in 0..2 {
            let link = self.control_link().await?;
            match link.request(id, &message).await {
                Ok(response) => return Ok(response),
                Err(error) if attempt == 0 => {
                    tracing::debug!(%error, "session host request failed; reconnecting");
                    *self.control.lock().await = None;
                }
                Err(error) => return Err(AppError::Internal(error.to_string())),
            }
        }
        Err(AppError::Internal(
            "the session host stopped answering".into(),
        ))
    }

    /// A request whose only interesting outcome is success or the reason it
    /// failed.
    async fn call(
        &self,
        build: impl FnOnce(u64) -> ClientMessage,
    ) -> AppResult<Option<armadra_session_host::protocol::SessionSummary>> {
        match self.request(build).await? {
            HostMessage::Ok { session, .. } => Ok(session),
            HostMessage::Error { code, message, .. } => Err(host_error(code, message)),
            other => Err(AppError::Internal(format!(
                "unexpected session host reply: {other:?}"
            ))),
        }
    }

    async fn remembered(&self, key: &SessionKey) -> AppResult<Remembered> {
        self.sessions
            .read()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))
    }
}

fn host_error(code: ErrorCode, message: String) -> AppError {
    match code {
        ErrorCode::NotFound => AppError::NotFound(message),
        ErrorCode::Stale | ErrorCode::Conflict | ErrorCode::Draining => AppError::Conflict(message),
        ErrorCode::BadRequest => AppError::BadRequest(message),
        _ => AppError::Internal(message),
    }
}

fn size_of(size: PtySize) -> Size {
    Size {
        cols: size.cols,
        rows: size.rows,
    }
    .clamped()
}

/// Keeps this Worker's copy of a session's recent output bounded the same way
/// the host's own buffer is. A convenience for `capture`, not a second history.
fn remember_output(screen: &Arc<std::sync::Mutex<Vec<u8>>>, chunk: &[u8], reset: bool) {
    let Ok(mut screen) = screen.lock() else {
        return;
    };
    if reset {
        screen.clear();
    }
    screen.extend_from_slice(chunk);
    if screen.len() > replay::DEFAULT_CAPACITY {
        let cut = replay::safe_cut(&screen, screen.len() - replay::DEFAULT_CAPACITY);
        screen.drain(..cut);
    }
}

#[async_trait]
impl TerminalBackend for SessionHostBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::SessionHost
    }

    async fn create(&self, spec: TerminalSpec) -> AppResult<TerminalHandle> {
        let create = CreateSpec {
            session_key: spec.session_key.to_string(),
            generation: spec.generation,
            workspace_id: spec.workspace_id.clone(),
            cwd: spec.cwd.clone(),
            shell: spec.shell.clone(),
            command: spec.command.clone(),
            args: spec.args.clone(),
            env: spec.env.clone(),
            size: size_of(spec.size),
        };
        let summary = self
            .call(|id| ClientMessage::Create {
                id,
                spec: create.clone(),
            })
            .await?
            .ok_or_else(|| AppError::Internal("the session host created nothing".into()))?;
        let pid = summary.pid.map(i64::from);
        self.sessions.write().await.insert(
            spec.session_key.clone(),
            Remembered {
                generation: spec.generation,
                pid,
                screen: Arc::new(std::sync::Mutex::new(Vec::new())),
            },
        );
        Ok(TerminalHandle {
            session_key: spec.session_key,
            generation: spec.generation,
            // The host addresses sessions by key; the generation makes the
            // reference unique across a recycle, as the tmux name does.
            backend_ref: Some(reference(&summary.session_key, summary.generation)),
            pid,
        })
    }

    async fn attach(
        &self,
        key: &SessionKey,
        generation: u64,
        size: PtySize,
    ) -> AppResult<AttachHandle> {
        let remembered = self.remembered(key).await?;
        if remembered.generation != generation {
            return Err(AppError::Conflict(format!(
                "Terminal generation {generation} is stale; the session is at {}",
                remembered.generation
            )));
        }

        let (output, receiver) = broadcast::channel(512);
        let (input, mut input_receiver) = mpsc::channel::<Bytes>(256);
        let notices = self.notices.clone();
        let screen = remembered.screen.clone();
        let sink_key = key.clone();
        let sink_output = output.clone();
        // A gap or a stale generation must resolve into a fresh attach with a
        // fresh replay, never into misaligned bytes on screen. Holding the
        // sender here is what lets the sink end the stream to force that.
        let closer: Arc<std::sync::Mutex<Option<broadcast::Sender<Bytes>>>> =
            Arc::new(std::sync::Mutex::new(Some(output)));
        let sink_closer = closer.clone();
        let sink: link::EventSink = Arc::new(move |event: LinkEvent| {
            // A snapshot is the session's past being redrawn, so it replaces
            // this Worker's idea of the screen; live output appends to it.
            let deliver = |payload: Vec<u8>, replacing: bool| {
                remember_output(&screen, &payload, replacing);
                let data = Bytes::from(payload);
                let _ = sink_output.send(data.clone());
                let _ = notices.send(BackendNotice::Output {
                    session_key: sink_key.clone(),
                    generation,
                    data,
                });
            };
            // Dropping the output sender ends this attachment's stream, which
            // is how the socket layer is told to clear and reconnect — the
            // same path tmux and direct already use.
            let end = || {
                if let Ok(mut held) = sink_closer.lock() {
                    held.take();
                }
            };
            match event {
                LinkEvent::Snapshot { payload, .. } => deliver(payload, true),
                LinkEvent::Output { payload, .. } => deliver(payload, false),
                LinkEvent::Gap { missing, .. } => {
                    tracing::warn!(
                        key = %sink_key,
                        missing,
                        "session host output has a gap; re-attaching"
                    );
                    end();
                }
                LinkEvent::Stale { .. } | LinkEvent::Closed => end(),
                _ => {}
            }
        });

        // Its own connection, so a slow socket delays only itself. It never
        // starts a host: if the host is gone the session is gone, and a fresh
        // empty host would look like the session had merely ended.
        let endpoint = self.endpoint()?;
        let link = Link::connect(&endpoint, sink).await.map_err(|error| {
            AppError::NotFound(format!("the session host is not running: {error}"))
        })?;
        link.handshake(&format!(
            "armadra-runtime-attach/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
        // Registered before the request goes out, so no frame can arrive
        // unchecked.
        link.expect_output(generation).await;

        let id = self.next_id().await;
        let response = link
            .request(
                id,
                &ClientMessage::Attach {
                    id,
                    session_key: key.to_string(),
                    generation,
                    size: size_of(size),
                },
            )
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        if let HostMessage::Error { code, message, .. } = response {
            return Err(host_error(code, message));
        }

        // Input goes down the same connection, so a keystroke cannot overtake
        // this socket's own resize or be overtaken by it.
        let writer = link.clone();
        let write_key = key.to_string();
        let ids = Arc::new(AtomicU64::new(1_000_000));
        tokio::spawn(async move {
            while let Some(chunk) = input_receiver.recv().await {
                let message = ClientMessage::Write {
                    id: ids.fetch_add(1, Ordering::Relaxed),
                    session_key: write_key.clone(),
                    data: base64::encode(&chunk),
                };
                if writer.notify(&message).await.is_err() {
                    break;
                }
            }
        });

        let detach_link = link.clone();
        Ok(AttachHandle {
            output: receiver,
            input,
            generation,
            detach: DetachGuard::new(move || {
                // Closing the connection is the detach. The host keeps the
                // session; only `destroy` ends one.
                detach_link.close();
            }),
        })
    }

    async fn write(&self, key: &SessionKey, bytes: &[u8]) -> AppResult<()> {
        let data = base64::encode(bytes);
        self.call(|id| ClientMessage::Write {
            id,
            session_key: key.to_string(),
            data,
        })
        .await
        .map(|_| ())
    }

    async fn resize(&self, key: &SessionKey, size: PtySize) -> AppResult<()> {
        let size = size_of(size);
        self.call(|id| ClientMessage::Resize {
            id,
            session_key: key.to_string(),
            size,
        })
        .await
        .map(|_| ())
    }

    /// The host keeps bytes, not a screen (see
    /// `armadra_session_host::replay`), so this is the replay this Worker has
    /// seen — the same approximation the direct backend makes.
    async fn capture(&self, key: &SessionKey, lines: u32, with_escapes: bool) -> AppResult<String> {
        let remembered = self.remembered(key).await?;
        let raw = remembered
            .screen
            .lock()
            .map(|screen| String::from_utf8_lossy(&screen).into_owned())
            .unwrap_or_default();
        let text = if with_escapes {
            raw
        } else {
            strip_escapes(&raw)
        };
        Ok(tail_lines(&trim_captured(&text.replace('\r', "")), lines))
    }

    /// ConPTY has no paste buffer, so bracketed paste is written straight into
    /// the console. A CLI that does not understand the brackets sees multi-line
    /// text as separate lines — a real difference from tmux, and not one this
    /// side can work around.
    async fn paste(&self, key: &SessionKey, text: &str, press_enter: bool) -> AppResult<()> {
        let mut payload = String::with_capacity(text.len() + 16);
        payload.push_str(PASTE_START);
        payload.push_str(&sanitize_paste(text));
        payload.push_str(PASTE_END);
        if press_enter {
            payload.push('\r');
        }
        self.write(key, payload.as_bytes()).await
    }

    /// The host reports the session's own pid. Walking the tree needs a
    /// process snapshot this Worker does not take on Windows, so the children
    /// are honestly empty rather than guessed at.
    async fn foreground(&self, key: &SessionKey) -> AppResult<ForegroundInfo> {
        let remembered = self.remembered(key).await?;
        Ok(ForegroundInfo {
            pid: remembered.pid,
            command: None,
            children: Vec::new(),
        })
    }

    async fn interrupt(&self, key: &SessionKey) -> AppResult<()> {
        self.call(|id| ClientMessage::Interrupt {
            id,
            session_key: key.to_string(),
        })
        .await
        .map(|_| ())
    }

    async fn terminate_process(&self, key: &SessionKey) -> AppResult<()> {
        self.call(|id| ClientMessage::Kill {
            id,
            session_key: key.to_string(),
        })
        .await
        .map(|_| ())
    }

    async fn destroy(&self, key: &SessionKey) -> AppResult<()> {
        let result = self
            .call(|id| ClientMessage::Destroy {
                id,
                session_key: key.to_string(),
            })
            .await;
        self.sessions.write().await.remove(key);
        result.map(|_| ())
    }

    async fn list_alive(&self) -> AppResult<Vec<BackendRef>> {
        let HostMessage::Ok {
            sessions: Some(sessions),
            ..
        } = self.request(|id| ClientMessage::List { id }).await?
        else {
            return Ok(Vec::new());
        };
        Ok(sessions
            .into_iter()
            .filter(|summary| !summary.exited)
            .map(|summary| BackendRef {
                name: reference(&summary.session_key, summary.generation),
                attached: summary.subscribers > 0,
            })
            .collect())
    }

    async fn destroy_by_reference(&self, reference: &str) -> AppResult<()> {
        let key = reference.split('#').next().unwrap_or(reference).to_owned();
        self.call(|id| ClientMessage::Destroy {
            id,
            session_key: key,
        })
        .await
        .map(|_| ())
    }

    /// Runtime shutdown. Connections go, sessions stay — the whole reason this
    /// backend exists.
    async fn detach_all(&self) {
        if let Some(link) = self.control.lock().await.take() {
            link.close();
        }
    }
}

/// `backend_ref` for a host session: key plus generation, so a recycle is a
/// different reference and an orphan sweep cannot confuse the two.
fn reference(session_key: &str, generation: u64) -> String {
    format!("{session_key}#{generation}")
}
