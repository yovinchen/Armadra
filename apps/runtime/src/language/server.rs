//! One language server process (design §2.2 `server`, §3.2).
//!
//! ## What starting one means
//!
//! It means running the project's code. A language server loads the project's
//! plugins, its `build.rs`, its `tsconfig` resolution and, for
//! `rust-analyzer`, a `cargo check`. That is why the gate is the workspace's
//! **execute** grant and not its read grant, and why nothing here is started
//! implicitly by a probe.
//!
//! ## How it is started
//!
//! * No shell, and no argv assembled from user text: the executable is the
//!   absolute path the probe froze, and the arguments are an array.
//! * The environment is the login environment the server needs (`PATH`,
//!   `GOPATH`, `CARGO_HOME`) **minus** every `ARMADRA_*` variable and the hook
//!   endpoint. A language server that reads its environment must not find the
//!   Runtime's credentials there.
//! * Its own session (`setsid`) on unix, so the whole tree can be ended with
//!   one `killpg`; on Windows the Runtime's Job Object, which children inherit
//!   — and where that is unavailable, no server is started at all.
//!
//! ## What is not read
//!
//! stderr is kept as a 64 KiB tail in memory, redacted, and shown only when a
//! server crashes. It is never written to a log, a board log or the database.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

use super::{STDERR_TAIL_BYTES, jsonrpc};

/// Everything needed to start one server.
#[derive(Debug, Clone)]
pub struct Launch {
    pub server_id: String,
    /// The absolute path the probe resolved. Never a bare name.
    pub executable: PathBuf,
    pub args: Vec<String>,
    /// Working directory and the single workspace folder.
    pub root: PathBuf,
    pub initialization_options: Option<Value>,
}

/// What the reader task hands the multiplexer.
#[derive(Debug)]
pub enum Event {
    /// One complete JSON-RPC message, exactly as the server wrote it.
    /// `oversize` means it is past [`super::MAX_MESSAGE_BYTES`] and must be
    /// replaced by an error — after its id has been read, so the session that
    /// asked for it stops waiting.
    Message { body: Vec<u8>, oversize: bool },
    /// The process is gone.
    Exited { code: Option<i32> },
}

/// A running (or once-running) server process.
pub struct Process {
    pub pid: Option<i64>,
    pub start_time_unix_ms: Option<i64>,
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    stderr: Arc<Mutex<Tail>>,
    #[cfg(unix)]
    pgid: Option<i32>,
    child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
}

/// A fixed-size tail of stderr. Only the end matters: a server that failed to
/// start says why in its last few lines, and keeping the whole stream would be
/// an unbounded buffer holding text nobody asked for.
#[derive(Debug, Default)]
pub struct Tail {
    bytes: VecDeque<u8>,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        for byte in chunk {
            if self.bytes.len() == STDERR_TAIL_BYTES {
                self.bytes.pop_front();
            }
            self.bytes.push_back(*byte);
        }
    }

    pub fn text(&self) -> String {
        let bytes: Vec<u8> = self.bytes.iter().copied().collect();
        crate::security::redact_secrets(&String::from_utf8_lossy(&bytes))
    }
}

#[derive(Debug)]
pub enum StartError {
    /// This platform cannot contain what it would start (Windows, no Job).
    ContainmentUnavailable,
    Spawn(std::io::Error),
}

impl Process {
    /// Starts the process and the three tasks that serve it: one draining
    /// stdout into framed messages, one draining stderr into the tail, and one
    /// writing whatever the multiplexer queues.
    pub fn start(
        launch: &Launch,
        events: mpsc::UnboundedSender<Event>,
    ) -> Result<Self, StartError> {
        if !crate::command::containment_ready() {
            return Err(StartError::ContainmentUnavailable);
        }
        let mut command = tokio::process::Command::new(&launch.executable);
        command
            .args(&launch.args)
            .current_dir(&launch.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        strip_runtime_environment(&mut command);
        #[cfg(unix)]
        // SAFETY: `setsid` is async-signal-safe and touches only this child.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(StartError::Spawn)?;
        let pid = child.id().map(i64::from);
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let stderr = Arc::new(Mutex::new(Tail::default()));
        let (queue, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();

        if let Some(mut sink) = stdin {
            tokio::spawn(async move {
                while let Some(frame) = outgoing.recv().await {
                    if sink.write_all(&frame).await.is_err() || sink.flush().await.is_err() {
                        break;
                    }
                }
            });
        }
        if let Some(mut source) = stdout {
            let events = events.clone();
            tokio::spawn(async move {
                let mut decoder = jsonrpc::Decoder::default();
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    let read = match source.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => read,
                    };
                    decoder.push(&buffer[..read]);
                    loop {
                        match decoder.next_frame() {
                            Ok(Some(frame)) => {
                                let event = Event::Message {
                                    body: frame.body,
                                    oversize: frame.oversize,
                                };
                                if events.send(event).is_err() {
                                    return;
                                }
                            }
                            Ok(None) => break,
                            // Past the hard limit: skipped, and the stream
                            // carries on with the next frame.
                            Err(jsonrpc::Error::TooLarge(_)) => continue,
                            // A stream we can no longer find message
                            // boundaries in is not recoverable by guessing.
                            Err(_) => return,
                        }
                    }
                }
            });
        }
        if let Some(mut source) = stderr_pipe {
            let tail = stderr.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 8 * 1024];
                while let Ok(read) = source.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    if let Ok(mut tail) = tail.lock() {
                        tail.push(&buffer[..read]);
                    }
                }
            });
        }

        #[cfg(unix)]
        let pgid = pid.map(|pid| pid as i32);
        let child = Arc::new(tokio::sync::Mutex::new(Some(child)));
        {
            let child = child.clone();
            tokio::spawn(async move {
                let code = {
                    let mut guard = child.lock().await;
                    match guard.as_mut() {
                        Some(process) => process.wait().await.ok().and_then(|status| status.code()),
                        None => None,
                    }
                };
                let _ = events.send(Event::Exited { code });
            });
        }
        Ok(Self {
            pid,
            start_time_unix_ms: Some(chrono::Utc::now().timestamp_millis()),
            stdin: queue,
            stderr,
            #[cfg(unix)]
            pgid,
            child,
        })
    }

    /// Queues one JSON-RPC message. A closed channel means the process is
    /// gone; the caller learns that from [`Event::Exited`] and does not need a
    /// second error path here.
    pub fn send(&self, body: &[u8]) -> bool {
        self.stdin.send(jsonrpc::encode(body)).is_ok()
    }

    pub fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .map(|tail| tail.text())
            .unwrap_or_default()
    }

    /// Ends the process group. Called after `shutdown`/`exit` were given their
    /// five seconds, and directly when a workspace or the Runtime goes away.
    pub async fn terminate(&self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            // The whole session, not just the leader: servers fork helpers
            // (`rust-analyzer` runs `cargo`), and killing only the leader
            // would orphan them.
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// The environment a language server is given.
///
/// It inherits the login environment, because that is where `PATH`, `GOPATH`
/// and `CARGO_HOME` live and a server without them cannot find its own
/// toolchain. What it does not inherit is anything that identifies or
/// authorises Armadra: every `ARMADRA_*` variable, and the hook endpoint the
/// agents use. A language server is the project's code; it gets no credential.
fn strip_runtime_environment(command: &mut tokio::process::Command) {
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if is_runtime_variable(&name) {
            command.env_remove(&key);
        }
    }
}

pub fn is_runtime_variable(name: &str) -> bool {
    name.starts_with("ARMADRA_")
        || name.starts_with("CLAUDE_HOOK_")
        || name == "ARMADRA_HOOK_TOKEN"
        || name == "ARMADRA_HOOK_PORT"
}

/// The `initialize` params for one workspace root.
///
/// One folder, always: multi-root workspaces are explicitly out of scope
/// (design §6.2), and handing a server a second root would let it read and
/// index a directory the workspace does not cover.
pub fn initialize_params(
    root: &Path,
    client_capabilities: Value,
    initialization_options: Option<Value>,
) -> Value {
    let uri = format!(
        "file://{}",
        root.to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
    );
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".into());
    serde_json::json!({
        "processId": std::process::id(),
        "clientInfo": { "name": "Armadra", "version": env!("CARGO_PKG_VERSION") },
        "rootUri": uri,
        "workspaceFolders": [{ "uri": uri, "name": name }],
        "capabilities": client_capabilities,
        "initializationOptions": initialization_options,
    })
}

/// The capabilities the host claims towards the server.
///
/// This is the host's own set, not the browser's: the host is the LSP client.
/// A browser's capabilities are intersected with the server's answer before
/// the session sees `initialize`, which is what lets one server serve two
/// clients that asked for different things.
pub fn host_capabilities() -> Value {
    serde_json::json!({
        "workspace": {
            "workspaceFolders": true,
            "configuration": true,
            "applyEdit": true,
            "didChangeConfiguration": { "dynamicRegistration": false },
        },
        "textDocument": {
            "synchronization": { "didSave": true, "willSave": false, "dynamicRegistration": false },
            "publishDiagnostics": { "relatedInformation": true, "versionSupport": true },
            "completion": { "completionItem": { "snippetSupport": false } },
            "hover": { "contentFormat": ["markdown", "plaintext"] },
            "signatureHelp": {},
            "definition": { "linkSupport": true },
            "typeDefinition": { "linkSupport": true },
            "implementation": { "linkSupport": true },
            "references": {},
            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
            "documentHighlight": {},
            "codeAction": {
                "codeActionLiteralSupport": {
                    "codeActionKind": { "valueSet": ["quickfix", "refactor", "source"] }
                },
                "resolveSupport": { "properties": ["edit"] },
            },
            "formatting": {},
            "rangeFormatting": {},
            "rename": { "prepareSupport": true },
        },
        "window": { "workDoneProgress": true },
        "general": { "positionEncodings": ["utf-16"] },
    })
}
