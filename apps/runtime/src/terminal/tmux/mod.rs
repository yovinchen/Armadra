//! The primary backend: a private tmux server (plan §15.3).
//!
//! Every command goes through `tmux -S <data_dir>/tmux.sock -f
//! <data_dir>/tmux.conf`, so the runtime's sessions share nothing with the
//! user's own tmux server or `~/.tmux.conf`. The pane's process is a child of
//! that server, not of the runtime, which is the whole point: closing the app,
//! or crashing it, leaves the agent running and re-attachable.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use async_trait::async_trait;
use bytes::Bytes;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{RwLock, broadcast, mpsc};

use crate::{
    error::{AppError, AppResult},
    paths,
    terminal::backend::{
        AttachHandle, BackendKind, BackendNotice, BackendRef, DetachGuard, ForegroundInfo,
        NoticeSender, OutputPump, SESSION_PREFIX, SessionKey, TerminalBackend, TerminalHandle,
        TerminalSpec, child_commands, child_environment, runtime_fingerprint, sanitize_paste,
        session_name, spawn_input_pump, spawn_output_pump, strip_escapes, tail_lines,
        terminate_tree, trim_captured,
    },
};

mod config;
mod control;
#[cfg(test)]
mod tests;

pub use config::{MINIMUM_VERSION, TmuxDetection, detect, ensure_conf};

use control::{TmuxClient, TmuxSession};

/// `#{window_activity}`, not `#{session_activity}`: tmux bumps
/// `session_activity` to `now` on every client **attach**, regardless of
/// whether the pane has produced any output (nodeterm research,
/// `docs/research/nodeterm/terminal-and-tmux.md` §2.3 — one 67-session
/// server had a newest `session_activity` of 33 minutes and a newest
/// `window_activity` of 37 hours). Using `session_activity` as an idle
/// judgement would call a long-attached, silent session "just active" every
/// time something reattaches to it. `window_activity` only moves when the
/// active window's pane actually emits output.
const LIST_ALIVE_FORMAT: &str = "#{session_name} #{session_attached} #{window_activity}";

/// The tmux invocations issued by [`TerminalBackend::paste`], broken out as a
/// pure function so the argument sequence can be asserted without a live
/// tmux server.
///
/// Two guards beyond the plain `load-buffer` / `paste-buffer` / `send-keys
/// Enter` sequence (nodeterm research §2.6):
/// - `-r` on `paste-buffer` keeps `\n` as `\n` instead of rewriting it to
///   `\r`.
/// - the copy-mode exit (`send-keys -X cancel`) is gated by `if-shell
///   -F '#{pane_in_mode}'` **inside the same tmux invocation** as
///   `paste-buffer`, not a separate round trip beforehand: `paste-buffer -p`
///   silently does nothing while the pane is in copy-mode, and a prior,
///   separate exit call leaves a window where that state could still change
///   before the paste itself runs.
fn paste_plan(buffer: &str, file: &Path, session: &str, press_enter: bool) -> Vec<Vec<String>> {
    let mut plan = vec![
        vec![
            "load-buffer".to_owned(),
            "-b".to_owned(),
            buffer.to_owned(),
            file.to_string_lossy().into_owned(),
        ],
        vec![
            "if-shell".to_owned(),
            "-F".to_owned(),
            "#{pane_in_mode}".to_owned(),
            "send-keys -X cancel".to_owned(),
            ";".to_owned(),
            "paste-buffer".to_owned(),
            "-p".to_owned(),
            "-r".to_owned(),
            "-d".to_owned(),
            "-b".to_owned(),
            buffer.to_owned(),
            "-t".to_owned(),
            session.to_owned(),
        ],
    ];
    if press_enter {
        plan.push(vec![
            "send-keys".to_owned(),
            "-t".to_owned(),
            session.to_owned(),
            "Enter".to_owned(),
        ]);
    }
    plan
}

#[derive(Clone)]
pub struct TmuxBackend {
    socket: PathBuf,
    conf: PathBuf,
    sessions: Arc<RwLock<HashMap<SessionKey, Arc<TmuxSession>>>>,
    notices: NoticeSender,
    next_client_id: Arc<AtomicU64>,
}

#[async_trait]
impl TerminalBackend for TmuxBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Tmux
    }

    async fn create(&self, spec: TerminalSpec) -> AppResult<TerminalHandle> {
        ensure_conf(&self.conf)?;
        let name = session_name(&spec.workspace_id, &spec.session_key, spec.generation);
        // A leftover session under the same name would silently be reused.
        let _ = self.run(["kill-session", "-t", &name]).await;

        let mut arguments = vec![
            "new-session".to_owned(),
            "-d".to_owned(),
            "-s".to_owned(),
            name.clone(),
            "-x".to_owned(),
            spec.size.cols.max(2).to_string(),
            "-y".to_owned(),
            spec.size.rows.max(2).to_string(),
            "-c".to_owned(),
            spec.cwd.clone(),
        ];
        for (key, value) in &spec.env {
            arguments.push("-e".to_owned());
            arguments.push(format!("{key}={value}"));
        }
        arguments.push("--".to_owned());
        arguments.push(spec.executable());
        arguments.extend(spec.args.iter().cloned());
        self.run(arguments).await?;
        self.stamp_server().await;

        self.sessions.write().await.insert(
            spec.session_key.clone(),
            Arc::new(TmuxSession {
                name,
                generation: spec.generation,
                clients: Mutex::new(Vec::new()),
                in_copy_mode: AtomicBool::new(false),
            }),
        );
        let pid = self.pane_pid(&spec.session_key).await;
        Ok(TerminalHandle {
            session_key: spec.session_key.clone(),
            generation: spec.generation,
            backend_ref: Some(session_name(
                &spec.workspace_id,
                &spec.session_key,
                spec.generation,
            )),
            pid,
        })
    }

    /// One `tmux attach-session` client per socket, inside a PTY the runtime
    /// owns. The client redraws the pane by itself, which is why the tmux
    /// backend sends no `snapshot` frame.
    async fn attach(
        &self,
        key: &SessionKey,
        generation: u64,
        size: PtySize,
    ) -> AppResult<AttachHandle> {
        let session = self.session(key).await?;
        if session.generation != generation {
            return Err(AppError::Conflict(format!(
                "Terminal generation {generation} is stale; the session is at {}",
                session.generation
            )));
        }
        if !self.has_session(&session.name).await {
            return Err(AppError::NotFound("Terminal session has exited".into()));
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: size.rows.max(2),
                cols: size.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::Internal(format!("Could not create PTY: {error}")))?;
        let mut command = CommandBuilder::new("tmux");
        for argument in self.base_args() {
            command.arg(argument);
        }
        command.arg("attach-session");
        command.arg("-t");
        command.arg(&session.name);
        command.env_clear();
        for (name, value) in child_environment() {
            command.env(name, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| AppError::Internal(format!("Could not attach to tmux: {error}")))?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::Internal(format!("Could not read PTY: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| AppError::Internal(format!("Could not write PTY: {error}")))?;

        let (output, receiver) = broadcast::channel(512);
        // A second cursor over the same stream; the returned one keeps every
        // byte, including the ones consumed by the readiness wait below.
        let mut ready = output.subscribe();
        let (input, input_receiver) = mpsc::channel::<Bytes>(256);
        let id = self.next_client_id.fetch_add(1, Ordering::SeqCst);
        let client = Arc::new(TmuxClient {
            id,
            master: Mutex::new(Some(pair.master)),
            child: Mutex::new(Some(child)),
            input: input.clone(),
        });
        if let Ok(mut clients) = session.clients.lock() {
            clients.push(client.clone());
        }

        spawn_input_pump(format!("tmux-{id}"), writer, input_receiver);
        let backend = self.clone();
        let name = session.name.clone();
        let eof_key = key.clone();
        let eof_generation = session.generation;
        spawn_output_pump(
            OutputPump {
                name: format!("tmux-{id}"),
                output,
                replay: None,
                notices: self.notices.clone(),
                key: key.clone(),
                generation: session.generation,
                // A tmux pump exists only while a client does, and a client
                // exists only while something is attached, so this pump is
                // never the dormant case: the interactive cadence is correct
                // for its whole life.
                cadence: super::interactive_cadence(),
            },
            reader,
            move || {
                // The client is gone. Either we detached it, or the session it
                // was showing ended — only the second case is an exit.
                let alive = std::process::Command::new("tmux")
                    .args(backend.base_args())
                    .args(["has-session", "-t", &name])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|status| status.success())
                    .unwrap_or(false);
                if !alive {
                    let _ = backend.notices.send(BackendNotice::Exited {
                        session_key: eof_key,
                        generation: eof_generation,
                        exit_code: None,
                    });
                }
            },
        );

        // tmux puts the client PTY into raw mode with TCSAFLUSH, which throws
        // away anything written before that point. Waiting for the client's
        // first redraw means the first keystroke of a caller that writes
        // immediately after attaching is not silently swallowed.
        let _ = tokio::time::timeout(std::time::Duration::from_millis(2000), ready.recv()).await;

        let detach_session = session.clone();
        let detach_client = client.clone();
        Ok(AttachHandle {
            output: receiver,
            input,
            generation: session.generation,
            detach: DetachGuard::new(move || {
                detach_client.detach();
                if let Ok(mut clients) = detach_session.clients.lock() {
                    clients.retain(|entry| entry.id != detach_client.id);
                }
            }),
        })
    }

    async fn write(&self, key: &SessionKey, bytes: &[u8]) -> AppResult<()> {
        let session = self.session(key).await?;
        // Typing always wins over scrollback: if we scrolled the pane back,
        // drop out of copy-mode first so the bytes reach the application.
        self.leave_copy_mode(&session).await;
        let client = session
            .clients
            .lock()
            .ok()
            .and_then(|clients| clients.last().cloned());
        match client {
            Some(client) => client
                .input
                .send(Bytes::copy_from_slice(bytes))
                .await
                .map_err(|_| AppError::NotFound("Terminal session is not running".into())),
            // Nothing is attached: hand the bytes to the pane directly.
            None => self.send_keys_bytes(&session.name, bytes).await,
        }
    }

    /// `window-size latest` makes the pane follow whichever client last moved,
    /// so resizing the client PTYs is all that is needed.
    async fn resize(&self, key: &SessionKey, size: PtySize) -> AppResult<()> {
        let session = self.session(key).await?;
        let clients = session
            .clients
            .lock()
            .map(|clients| clients.clone())
            .unwrap_or_default();
        let size = PtySize {
            rows: size.rows.max(2),
            cols: size.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        for client in clients {
            if let Ok(master) = client.master.lock()
                && let Some(master) = master.as_ref()
            {
                let _ = master.resize(size);
            }
        }
        Ok(())
    }

    async fn capture(&self, key: &SessionKey, lines: u32, with_escapes: bool) -> AppResult<String> {
        let session = self.session(key).await?;
        let start = if lines == 0 {
            "-".to_owned()
        } else {
            format!("-{lines}")
        };
        let mut arguments = vec!["capture-pane".to_owned(), "-p".to_owned(), "-J".to_owned()];
        if with_escapes {
            arguments.push("-e".to_owned());
        }
        arguments.extend([
            "-t".to_owned(),
            session.name.clone(),
            "-S".to_owned(),
            start,
        ]);
        let raw = self.run(arguments).await?;
        let text = if with_escapes {
            raw
        } else {
            strip_escapes(&raw)
        };
        Ok(tail_lines(&trim_captured(&text), lines))
    }

    /// A tmux buffer, not keystrokes: `-p` wraps it in the bracketed-paste
    /// sequence, `-d` deletes the buffer afterwards.
    async fn paste(&self, key: &SessionKey, text: &str, press_enter: bool) -> AppResult<()> {
        let session = self.session(key).await?;
        let buffer = format!("armadra-{}", uuid::Uuid::now_v7().simple());
        let file = std::env::temp_dir().join(format!("{buffer}.txt"));
        std::fs::write(&file, sanitize_paste(text).as_bytes())?;
        paths::harden_file(&file);
        let plan = paste_plan(&buffer, &file, &session.name, press_enter);
        let result = async {
            for arguments in &plan {
                self.run(arguments).await?;
            }
            // The plan's `if-shell` guard force-exits copy-mode regardless of
            // the cached flag's prior value.
            session.in_copy_mode.store(false, Ordering::SeqCst);
            Ok::<(), AppError>(())
        }
        .await;
        let _ = std::fs::remove_file(&file);
        if result.is_err() {
            let _ = self.run(["delete-buffer", "-b", &buffer]).await;
        }
        result
    }

    /// Wheel bridge (plan §18.5). The client is not in mouse mode, so tmux
    /// never sees the wheel; the web side sends whole lines here instead.
    ///
    /// `copy-mode -e` is the "exit when you scroll back to the bottom" variant,
    /// which is exactly the behaviour a wheel should have. `#{pane_in_mode}` is
    /// re-read afterwards because that automatic exit is the one transition we
    /// do not initiate ourselves.
    async fn scroll(&self, key: &SessionKey, lines: i32) -> AppResult<()> {
        if lines == 0 {
            return Ok(());
        }
        let session = self.session(key).await?;
        if !self.pane_in_mode(&session.name).await {
            // Entering copy-mode to scroll *down* would just bounce straight
            // back out; there is nothing below the live screen.
            if lines < 0 {
                session.in_copy_mode.store(false, Ordering::SeqCst);
                return Ok(());
            }
            self.run(["copy-mode", "-e", "-t", &session.name]).await?;
        }
        let count = lines.unsigned_abs().min(10_000).to_string();
        let command = if lines > 0 {
            "scroll-up"
        } else {
            "scroll-down"
        };
        self.run([
            "send-keys",
            "-X",
            "-N",
            &count,
            "-t",
            &session.name,
            command,
        ])
        .await?;
        // `-e` drops out on its own once the view is back at the bottom.
        let still = self.pane_in_mode(&session.name).await;
        session.in_copy_mode.store(still, Ordering::SeqCst);
        Ok(())
    }

    async fn foreground(&self, key: &SessionKey) -> AppResult<ForegroundInfo> {
        let session = self.session(key).await?;
        let output = self
            .run([
                "display",
                "-p",
                "-t",
                &session.name,
                "#{pane_pid} #{pane_current_command}",
            ])
            .await?;
        let mut parts = output.trim().splitn(2, ' ');
        let pid = parts.next().and_then(|pid| pid.parse::<i64>().ok());
        let command = parts.next().map(str::to_owned).filter(|it| !it.is_empty());
        Ok(ForegroundInfo {
            pid,
            command,
            children: pid.map(child_commands).unwrap_or_default(),
        })
    }

    async fn interrupt(&self, key: &SessionKey) -> AppResult<()> {
        let session = self.session(key).await?;
        self.run(["send-keys", "-t", &session.name, "C-c"])
            .await
            .map(|_| ())
    }

    async fn terminate_process(&self, key: &SessionKey) -> AppResult<()> {
        if let Some(pid) = self.pane_pid(key).await {
            terminate_tree(pid).await;
        }
        Ok(())
    }

    async fn destroy(&self, key: &SessionKey) -> AppResult<()> {
        let session = self.session(key).await?;
        if let Ok(clients) = session.clients.lock() {
            for client in clients.iter() {
                client.detach();
            }
        }
        let _ = self.run(["kill-session", "-t", &session.name]).await;
        self.sessions.write().await.remove(key);
        Ok(())
    }

    async fn list_alive(&self) -> AppResult<Vec<BackendRef>> {
        let output = match self.run(["list-sessions", "-F", LIST_ALIVE_FORMAT]).await {
            Ok(output) => output,
            // "no server running on ..." is the empty case, not a failure.
            Err(_) => return Ok(Vec::new()),
        };
        Ok(output
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let name = parts.next()?.to_owned();
                if !name.starts_with(SESSION_PREFIX) {
                    return None;
                }
                Some(BackendRef {
                    name,
                    attached: parts.next().is_some_and(|value| value != "0"),
                })
            })
            .collect())
    }

    /// Destroys any `armadra-*` session the caller does not know about.
    async fn destroy_by_reference(&self, reference: &str) -> AppResult<()> {
        self.run(["kill-session", "-t", reference])
            .await
            .map(|_| ())
    }

    /// Runtime shutdown: drop the clients, keep the sessions. That is the whole
    /// reason tmux is the primary backend.
    async fn detach_all(&self) {
        let sessions: Vec<Arc<TmuxSession>> =
            self.sessions.read().await.values().cloned().collect();
        for session in sessions {
            let clients = session
                .clients
                .lock()
                .map(|clients| clients.clone())
                .unwrap_or_default();
            for client in clients {
                client.detach();
            }
        }
    }
}
