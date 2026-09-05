//! The control channel: the attached clients, the session table and every
//! `tmux` subcommand the backend issues.

use super::*;

pub(super) struct TmuxClient {
    pub(super) id: u64,
    pub(super) master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pub(super) child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    pub(super) input: mpsc::Sender<Bytes>,
}

impl TmuxClient {
    /// Ends the `tmux attach-session` process. The session keeps running: this
    /// is a detach, not a kill.
    pub(super) fn detach(&self) {
        if let Ok(mut child) = self.child.lock()
            && let Some(child) = child.as_mut()
        {
            let _ = child.kill();
        }
        if let Ok(mut master) = self.master.lock() {
            *master = None;
        }
    }
}

pub(super) struct TmuxSession {
    pub(super) name: String,
    pub(super) generation: u64,
    pub(super) clients: Mutex<Vec<Arc<TmuxClient>>>,
    /// Whether the pane is currently scrolled back in copy-mode (plan §18.5).
    ///
    /// Cached here rather than asked from tmux on every keystroke: `write()` is
    /// the hot path for every character the user types, and a `display -p`
    /// round trip per keystroke would be absurd. It is re-synced from
    /// `#{pane_in_mode}` after every scroll, which is the only thing that can
    /// put the pane into the mode in the first place.
    pub(super) in_copy_mode: AtomicBool,
}

impl TmuxBackend {
    /// Fails only if the configuration cannot be written; the server itself is
    /// started lazily by the first `new-session`.
    pub fn new(socket: PathBuf, conf: PathBuf, notices: NoticeSender) -> AppResult<Self> {
        ensure_conf(&conf)?;
        Ok(Self {
            socket,
            conf,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            notices,
            next_client_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn with_data_dir(directory: &Path, notices: NoticeSender) -> AppResult<Self> {
        Self::new(
            directory.join("tmux.sock"),
            directory.join("tmux.conf"),
            notices,
        )
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub(super) fn base_args(&self) -> Vec<String> {
        vec![
            // Force UTF-8 regardless of the runtime's locale: a GUI-launched
            // runtime often has no LANG at all, and tmux would then render every
            // multi-byte character (Chinese included) as `_`.
            "-u".into(),
            "-S".into(),
            self.socket.to_string_lossy().into_owned(),
            "-f".into(),
            self.conf.to_string_lossy().into_owned(),
        ]
    }

    pub(super) async fn run<I, S>(&self, arguments: I) -> AppResult<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        // The first command starts the server, and the server keeps this
        // environment for every session it will ever create: built, not
        // inherited (see `child_environment`).
        let output = tokio::process::Command::new("tmux")
            .args(self.base_args())
            .args(arguments)
            .env_clear()
            .envs(child_environment())
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| AppError::Internal(format!("Could not run tmux: {error}")))?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(AppError::Internal(format!("tmux failed: {message}")));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// `#{pane_in_mode}` — 1 while the pane is in copy-mode.
    pub(super) async fn pane_in_mode(&self, name: &str) -> bool {
        self.run(["display", "-p", "-t", name, "#{pane_in_mode}"])
            .await
            .map(|out| out.trim() == "1")
            .unwrap_or(false)
    }

    /// Leave copy-mode if we put the pane there, so the next keystroke reaches
    /// the application instead of being eaten as a copy-mode command
    /// (plan §18.5). Cheap when the flag is already clear: no tmux call at all.
    pub(super) async fn leave_copy_mode(&self, session: &TmuxSession) {
        if !session.in_copy_mode.swap(false, Ordering::SeqCst) {
            return;
        }
        let _ = self
            .run(["send-keys", "-X", "-t", &session.name, "cancel"])
            .await;
    }

    pub(super) async fn session(&self, key: &SessionKey) -> AppResult<Arc<TmuxSession>> {
        self.sessions
            .read()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))
    }

    /// Re-adopts a session that this runtime did not create — after a restart,
    /// the tmux server still has it but the in-memory map does not.
    pub async fn adopt(&self, key: &SessionKey, name: &str, generation: u64) {
        self.sessions.write().await.insert(
            key.clone(),
            Arc::new(TmuxSession {
                name: name.to_owned(),
                generation,
                clients: Mutex::new(Vec::new()),
                in_copy_mode: AtomicBool::new(false),
            }),
        );
    }

    pub async fn has_session(&self, name: &str) -> bool {
        self.run(["has-session", "-t", name]).await.is_ok()
    }

    /// The `@armadra-runtime` server option, if a server is running and stamped.
    pub(super) async fn server_owner(&self) -> Option<String> {
        self.run(["show-options", "-s", "-v", "-q", "@armadra-runtime"])
            .await
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    /// Claim the server for this runtime if nobody has yet. Called after every
    /// `new-session`, which is the call that starts the server lazily.
    pub(super) async fn stamp_server(&self) {
        if self.server_owner().await.is_none() {
            let _ = self
                .run([
                    "set-option",
                    "-s",
                    "@armadra-runtime",
                    &runtime_fingerprint(),
                ])
                .await;
        }
    }

    /// Startup check on a server that was already running.
    ///
    /// A server started by another runtime build (a development binary next to
    /// the packaged one, both on the same data directory) carries that
    /// runtime's environment and, on macOS, its sandbox — every session created
    /// under it would inherit both. An empty foreign server is therefore
    /// replaced; one that still has sessions is kept, because those sessions
    /// are the user's, and the mismatch is logged instead.
    pub async fn adopt_server(&self) {
        let Some(owner) = self.server_owner().await else {
            // No server, or an unstamped one from before this check existed.
            // The next `new-session` stamps it.
            return;
        };
        let ours = runtime_fingerprint();
        if owner == ours {
            return;
        }
        let sessions = self.list_alive().await.unwrap_or_default();
        if sessions.is_empty() {
            tracing::info!(owner, "replacing the empty tmux server of another runtime");
            let _ = self.run(["kill-server"]).await;
        } else {
            tracing::warn!(
                owner,
                sessions = sessions.len(),
                "the tmux server was started by another runtime; keeping its sessions"
            );
        }
    }

    pub async fn pane_pid(&self, key: &SessionKey) -> Option<i64> {
        let session = self.session(key).await.ok()?;
        let output = self
            .run([
                "display",
                "-p",
                "-t",
                &session.name,
                "#{pane_pid} #{pane_current_command}",
            ])
            .await
            .ok()?;
        output
            .split_whitespace()
            .next()
            .and_then(|pid| pid.parse::<i64>().ok())
    }

    pub(super) async fn send_keys_bytes(&self, name: &str, bytes: &[u8]) -> AppResult<()> {
        // `-H` takes hex, so arbitrary control bytes survive intact — no
        // quoting rules, no shell, no key-name parsing.
        let mut arguments = vec![
            "send-keys".to_owned(),
            "-t".to_owned(),
            name.to_owned(),
            "-H".to_owned(),
        ];
        arguments.extend(bytes.iter().map(|byte| format!("{byte:02x}")));
        self.run(arguments).await.map(|_| ())
    }
    /// Checked enumeration for explicit Quit. Existing list_alive intentionally
    /// tolerates a vanished server; here all other command failures are fatal.
    pub(super) async fn shutdown_session_names(&self) -> AppResult<Vec<String>> {
        let output = tokio::process::Command::new("tmux")
            .args(self.base_args())
            .args(["list-sessions", "-F", "#{session_name}"])
            .env_clear()
            .envs(child_environment())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_owned)
                .collect());
        }
        let error = String::from_utf8_lossy(&output.stderr);
        if error.contains("no server running on")
            || (error.contains("No such file or directory") && !self.socket.exists())
        {
            return Ok(Vec::new());
        }
        Err(AppError::Internal(format!(
            "could not verify owned tmux sessions: {}",
            error.trim()
        )))
    }

    pub async fn shutdown_owned_checked(&self) -> AppResult<()> {
        let owned: Vec<_> = self
            .sessions
            .read()
            .await
            .iter()
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect();
        if owned.is_empty() {
            return Ok(());
        }
        let running = self.shutdown_session_names().await?;
        let outcomes = futures_util::future::join_all(owned.iter().map(|(key, session)| async {
            if running.contains(&session.name) {
                self.terminate_process(key).await?;
                let output = tokio::process::Command::new("tmux")
                    .args(self.base_args())
                    .args(["kill-session", "-t", &session.name])
                    .env_clear()
                    .envs(child_environment())
                    .stdin(Stdio::null())
                    .kill_on_drop(true)
                    .output()
                    .await?;
                if !output.status.success()
                    && self.shutdown_session_names().await?.contains(&session.name)
                {
                    return Err(AppError::Internal(format!(
                        "owned tmux session {} did not terminate",
                        session.name
                    )));
                }
            }
            if let Ok(clients) = session.clients.lock() {
                for client in clients.iter() {
                    client.detach();
                }
            }
            Ok::<(), AppError>(())
        }))
        .await;
        let mut failures: Vec<String> = outcomes
            .into_iter()
            .filter_map(Result::err)
            .map(|error| error.to_string())
            .collect();
        match self.shutdown_session_names().await {
            Ok(remaining) => {
                for (key, session) in owned {
                    if remaining.contains(&session.name) {
                        failures.push(format!("tmux session {} remains alive", session.name));
                    } else {
                        self.sessions.write().await.remove(&key);
                    }
                }
            }
            Err(error) => failures.push(error.to_string()),
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Internal(failures.join("; ")))
        }
    }
}
