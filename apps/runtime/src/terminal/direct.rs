//! The fallback backend: one `portable-pty` per session, held by this process.
//!
//! Identical in behaviour to the pre-§15 `PtyManager` — the session dies with
//! the runtime, `capture` replays the output buffer instead of reading a real
//! screen, and `paste` writes the bracketed-paste sequence straight into the
//! PTY. It is what runs when tmux is missing, too old, or turned off.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use bytes::Bytes;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{RwLock, broadcast, mpsc};

use crate::{
    error::{AppError, AppResult},
    terminal::backend::{
        AttachHandle, BackendKind, BackendNotice, BackendRef, DetachGuard, ForegroundInfo,
        NoticeSender, OutputPump, PASTE_END, PASTE_START, REPLAY_CHUNKS, SessionKey,
        TerminalBackend, TerminalHandle, TerminalSpec, child_commands, child_environment,
        process_table, sanitize_paste, spawn_input_pump, spawn_output_pump, strip_escapes,
        tail_lines, terminate_tree, trim_captured,
    },
};

struct DirectSession {
    generation: u64,
    /// Dropped on exit so the session stops holding a file descriptor while it
    /// keeps serving `capture` for the scrollback the UI still shows.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    pid: Option<i64>,
    input: mpsc::Sender<Bytes>,
    output: broadcast::Sender<Bytes>,
    replay: Arc<Mutex<VecDeque<Bytes>>>,
    exited: AtomicBool,
}

impl DirectSession {
    fn snapshot(&self) -> String {
        let chunks = self
            .replay
            .lock()
            .map(|replay| replay.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut joined = Vec::new();
        for chunk in chunks {
            joined.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&joined).into_owned()
    }
}

#[derive(Clone)]
pub struct DirectBackend {
    sessions: Arc<RwLock<HashMap<SessionKey, Arc<DirectSession>>>>,
    notices: NoticeSender,
}

impl DirectBackend {
    pub fn new(notices: NoticeSender) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            notices,
        }
    }

    async fn session(&self, key: &SessionKey) -> AppResult<Arc<DirectSession>> {
        self.sessions
            .read()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))
    }

    async fn live(&self, key: &SessionKey) -> AppResult<Arc<DirectSession>> {
        let session = self.session(key).await?;
        if session.exited.load(Ordering::SeqCst) {
            return Err(AppError::Conflict("Terminal session has exited".into()));
        }
        Ok(session)
    }

    pub async fn pid(&self, key: &SessionKey) -> Option<i64> {
        let session = self.sessions.read().await.get(key).cloned()?;
        if session.exited.load(Ordering::SeqCst) {
            return None;
        }
        session.pid
    }

    /// The replay buffer as one string — the `snapshot` frame of plan §15.5.
    pub async fn snapshot(&self, key: &SessionKey) -> Option<String> {
        let session = self.sessions.read().await.get(key).cloned()?;
        let snapshot = session.snapshot();
        (!snapshot.is_empty()).then_some(snapshot)
    }
    /// Explicit desktop Quit: report failures and observe real child exit before
    /// removing owned sessions. Normal detach/restart keeps its existing behavior.
    pub async fn shutdown_owned_checked(&self) -> AppResult<()> {
        let sessions: Vec<_> = self
            .sessions
            .read()
            .await
            .iter()
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect();
        let outcomes =
            futures_util::future::join_all(sessions.into_iter().map(|(key, session)| async move {
                let already_exited = {
                    let mut child = session
                        .child
                        .lock()
                        .map_err(|_| AppError::Internal("terminal child lock poisoned".into()))?;
                    match child.as_mut() {
                        Some(child) => child
                            .try_wait()
                            .map_err(|error| AppError::Internal(error.to_string()))?
                            .is_some(),
                        None => true,
                    }
                };
                if !already_exited {
                    if let Some(pid) = session.pid {
                        #[cfg(unix)]
                        terminate_tree(pid).await;
                        #[cfg(windows)]
                        {
                            let result = tokio::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .kill_on_drop(true)
                                .output()
                                .await?;
                            if !result.status.success() {
                                return Err(AppError::Internal(format!(
                                    "taskkill failed for owned terminal {key}"
                                )));
                            }
                        }
                    }
                    {
                        let mut child = session.child.lock().map_err(|_| {
                            AppError::Internal("terminal child lock poisoned".into())
                        })?;
                        if let Some(child) = child.as_mut()
                            && child
                                .try_wait()
                                .map_err(|error| AppError::Internal(error.to_string()))?
                                .is_none()
                        {
                            child.kill().map_err(|error| {
                                AppError::Internal(format!("could not terminate {key}: {error}"))
                            })?;
                        }
                    }
                    tokio::time::timeout(Duration::from_secs(3), async {
                        loop {
                            let exited = {
                                let mut child = session.child.lock().map_err(|_| {
                                    AppError::Internal("terminal child lock poisoned".into())
                                })?;
                                match child.as_mut() {
                                    Some(child) => child
                                        .try_wait()
                                        .map_err(|error| AppError::Internal(error.to_string()))?
                                        .is_some(),
                                    None => true,
                                }
                            };
                            if exited {
                                return Ok::<(), AppError>(());
                            }
                            tokio::time::sleep(Duration::from_millis(25)).await;
                        }
                    })
                    .await
                    .map_err(|_| {
                        AppError::Internal(format!("owned terminal {key} did not exit"))
                    })??;
                }
                session.exited.store(true, Ordering::SeqCst);
                self.sessions.write().await.remove(&key);
                Ok::<(), AppError>(())
            }))
            .await;
        let failures: Vec<String> = outcomes
            .into_iter()
            .filter_map(Result::err)
            .map(|error| error.to_string())
            .collect();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Internal(failures.join("; ")))
        }
    }
}

#[async_trait]
impl TerminalBackend for DirectBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Direct
    }

    async fn create(&self, spec: TerminalSpec) -> AppResult<TerminalHandle> {
        let executable = spec.executable();
        let pair = native_pty_system()
            .openpty(spec.size)
            .map_err(|error| AppError::Internal(format!("Could not create PTY: {error}")))?;
        let mut command = CommandBuilder::new(&executable);
        command.cwd(&spec.cwd);
        for argument in &spec.args {
            command.arg(argument);
        }
        // A built environment, never the runtime's own (see
        // `child_environment`). Set before `spec.env` so a caller can still
        // override any of it.
        command.env_clear();
        for (name, value) in child_environment() {
            command.env(name, value);
        }
        // Hook variables carry addresses only, never credentials: any process of
        // the same user can read another process' environment.
        for (name, value) in &spec.env {
            command.env(name, value);
        }
        let child = pair.slave.spawn_command(command).map_err(|error| {
            AppError::BadRequest(format!("Could not start {executable}: {error}"))
        })?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::Internal(format!("Could not read PTY: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| AppError::Internal(format!("Could not write PTY: {error}")))?;
        let pid = child.process_id().map(i64::from);
        let (output, _) = broadcast::channel(512);
        let (input, input_receiver) = mpsc::channel::<Bytes>(256);
        let session = Arc::new(DirectSession {
            generation: spec.generation,
            master: Mutex::new(Some(pair.master)),
            child: Mutex::new(Some(child)),
            pid,
            input,
            output: output.clone(),
            replay: Arc::new(Mutex::new(VecDeque::with_capacity(REPLAY_CHUNKS))),
            exited: AtomicBool::new(false),
        });
        self.sessions
            .write()
            .await
            .insert(spec.session_key.clone(), session.clone());

        spawn_input_pump(spec.session_key.to_string(), writer, input_receiver);
        spawn_output_pump(
            OutputPump {
                name: spec.session_key.to_string(),
                output,
                replay: Some(session.replay.clone()),
                notices: self.notices.clone(),
                key: spec.session_key.clone(),
                generation: spec.generation,
            },
            reader,
            || {},
        );
        self.spawn_exit_watcher(spec.session_key.clone(), session);

        Ok(TerminalHandle {
            session_key: spec.session_key,
            generation: spec.generation,
            backend_ref: None,
            pid,
        })
    }

    async fn attach(
        &self,
        key: &SessionKey,
        generation: u64,
        size: PtySize,
    ) -> AppResult<AttachHandle> {
        let session = self.session(key).await?;
        if session.generation != generation {
            return Err(stale(generation, session.generation));
        }
        if !session.exited.load(Ordering::SeqCst) {
            self.resize(key, size).await?;
        }
        Ok(AttachHandle {
            output: session.output.subscribe(),
            input: session.input.clone(),
            generation: session.generation,
            detach: DetachGuard::none(),
        })
    }

    async fn write(&self, key: &SessionKey, bytes: &[u8]) -> AppResult<()> {
        let session = self.live(key).await?;
        session
            .input
            .send(Bytes::copy_from_slice(bytes))
            .await
            .map_err(|_| AppError::NotFound("Terminal session is not running".into()))
    }

    async fn resize(&self, key: &SessionKey, size: PtySize) -> AppResult<()> {
        let session = self.live(key).await?;
        let master = session
            .master
            .lock()
            .map_err(|_| AppError::Internal("Terminal size controller is unavailable".into()))?;
        let Some(master) = master.as_ref() else {
            return Ok(());
        };
        master
            .resize(PtySize {
                rows: size.rows.max(2),
                cols: size.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::Internal(format!("Could not resize PTY: {error}")))
    }

    /// No real screen to read: the replay buffer is the best approximation.
    async fn capture(&self, key: &SessionKey, lines: u32, with_escapes: bool) -> AppResult<String> {
        let session = self.session(key).await?;
        let raw = session.snapshot();
        let text = if with_escapes {
            raw
        } else {
            strip_escapes(&raw)
        };
        Ok(tail_lines(&trim_captured(&text.replace('\r', "")), lines))
    }

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

    async fn foreground(&self, key: &SessionKey) -> AppResult<ForegroundInfo> {
        let session = self.session(key).await?;
        let Some(pid) = session.pid else {
            return Ok(ForegroundInfo::default());
        };
        let table = process_table();
        Ok(ForegroundInfo {
            pid: Some(pid),
            command: table.get(&pid).map(|(_, argv)| argv.clone()),
            children: child_commands(pid),
        })
    }

    async fn interrupt(&self, key: &SessionKey) -> AppResult<()> {
        // 0x03 travels through the line discipline, which turns it into SIGINT
        // for the foreground process group — the same path as a real Ctrl+C.
        self.write(key, b"\x03").await
    }

    async fn terminate_process(&self, key: &SessionKey) -> AppResult<()> {
        let session = self.session(key).await?;
        if let Some(pid) = session.pid {
            terminate_tree(pid).await;
        }
        if let Ok(mut child) = session.child.lock()
            && let Some(child) = child.as_mut()
        {
            let _ = child.kill();
        }
        Ok(())
    }

    async fn destroy(&self, key: &SessionKey) -> AppResult<()> {
        let _ = self.terminate_process(key).await;
        self.sessions.write().await.remove(key);
        Ok(())
    }

    async fn list_alive(&self) -> AppResult<Vec<BackendRef>> {
        Ok(self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| !session.exited.load(Ordering::SeqCst))
            .map(|(key, _)| BackendRef {
                name: key.to_string(),
                attached: true,
            })
            .collect())
    }

    /// Direct sessions cannot survive the runtime, so "release" means "kill".
    async fn detach_all(&self) {
        let keys: Vec<SessionKey> = self.sessions.read().await.keys().cloned().collect();
        for key in keys {
            let _ = self.destroy(&key).await;
        }
    }
}

impl DirectBackend {
    fn spawn_exit_watcher(&self, key: SessionKey, session: Arc<DirectSession>) {
        let notices = self.notices.clone();
        tokio::spawn(async move {
            loop {
                let status = session
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.as_mut().and_then(|child| child.try_wait().ok()))
                    .flatten();
                if let Some(status) = status {
                    session.exited.store(true, Ordering::SeqCst);
                    // Let the reader drain whatever the process wrote just
                    // before it died, then release the descriptors.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if let Ok(mut master) = session.master.lock() {
                        *master = None;
                    }
                    if let Ok(mut child) = session.child.lock() {
                        *child = None;
                    }
                    let _ = notices.send(BackendNotice::Exited {
                        session_key: key,
                        generation: session.generation,
                        exit_code: Some(status.exit_code() as i64),
                    });
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
    }
}

fn stale(requested: u64, current: u64) -> AppError {
    AppError::Conflict(format!(
        "Terminal generation {requested} is stale; the session is at {current}"
    ))
}
