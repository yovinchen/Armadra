//! The server: one named pipe, many connections, every session this user owns.
//!
//! Shape, and why:
//!
//! * **One pipe, many instances.** Each connection is its own instance, so a
//!   slow subscriber cannot delay a control request on another connection.
//!   The name is derived (see [`crate::pipe`]), the DACL admits only this user
//!   and LocalSystem, and remote clients are refused outright.
//! * **Every accepted connection is identified.** The name is predictable, so
//!   being connected proves nothing; the client process' SID is checked before
//!   a single byte of terminal output is written to it.
//! * **A session with no subscribers is the normal case.** Output is drained
//!   and buffered regardless. Nothing about this process' idea of "idle"
//!   involves whether a UI exists — only whether sessions do.
//! * **Exit is conservative.** The host leaves when it owns no live session
//!   and has owned none for the idle period, or when it is asked to drain.
//!   While one session lives it stays, forever if need be.//! * **Grouped by job.** The accept loop, the watchdog and the shared state
//!   are here; [`connections`] owns one connection's life and [`requests`]
//!   owns what a client may ask for.

#![cfg(windows)]

mod connections;
mod requests;

use std::{
    collections::HashMap,
    io,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::{
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::{Mutex, mpsc},
};

use crate::{
    conpty::ConptySession,
    pipe,
    protocol::{Frame, HostMessage, MAX_PAYLOAD, encode_json},
    replay::{QueryResponder, ReplayBuffer},
    session::{ConnectionId, SessionTable},
    winsec,
};

/// How long the host stays alive after its last session ended.
pub const DEFAULT_IDLE_EXIT: Duration = Duration::from_secs(30 * 60);

/// How often the idle and liveness checks run.
const TICK: Duration = Duration::from_secs(5);

/// Frames one connection may fall behind by before it is treated as slow.
const CONNECTION_QUEUE: usize = 1024;

/// Output is chunked to comfortably fit a frame; the remaining headroom
/// absorbs the header without another length check on the hot path.
const OUTPUT_CHUNK: usize = MAX_PAYLOAD / 4;

/// One session's runtime state: the console, what it has said recently, and
/// the responder that keeps it from waiting on a terminal that may not exist.
struct Live {
    conpty: Arc<ConptySession>,
    replay: ReplayBuffer,
    responder: QueryResponder,
}

struct HostState {
    table: SessionTable,
    live: HashMap<String, Live>,
    connections: HashMap<ConnectionId, mpsc::Sender<Frame>>,
    /// When the last session ended, for the idle timer. `None` while any
    /// session is alive.
    idle_since: Option<Instant>,
    instance_id: String,
}

impl HostState {
    /// Delivers a control message to one connection.
    fn tell(&self, connection: ConnectionId, message: &HostMessage) {
        let Some(sender) = self.connections.get(&connection) else {
            return;
        };
        let Ok(frame) = encode_json(message) else {
            return;
        };
        // A control message that cannot be queued means the connection is
        // hopelessly behind; it will be closed by its own writer.
        let _ = sender.try_send(frame);
    }

    /// Delivers a control message to every subscriber of one session.
    fn tell_subscribers(&self, key: &str, message: &HostMessage) {
        let Some(entry) = self.table.get(key) else {
            return;
        };
        for connection in entry.subscribers().collect::<Vec<_>>() {
            self.tell(connection, message);
        }
    }
}

#[derive(Clone)]
pub struct Host {
    state: Arc<Mutex<HostState>>,
    idle_exit: Duration,
}

impl Host {
    pub fn new(idle_exit: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(HostState {
                table: SessionTable::new(),
                live: HashMap::new(),
                connections: HashMap::new(),
                idle_since: Some(Instant::now()),
                // Cheap and sufficient: it only has to differ between runs of
                // this executable, so a Worker can tell "the host restarted"
                // from "the host has no sessions".
                instance_id: format!(
                    "{}-{}",
                    winsec::current_pid(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|since| since.as_millis())
                        .unwrap_or_default()
                ),
            })),
            idle_exit,
        }
    }

    /// Serves until the idle timer expires or a drain completes.
    pub async fn serve(&self, data_dir: &str) -> io::Result<()> {
        let sid = winsec::current_sid()?;
        let endpoint = pipe::endpoint(&sid, data_dir);
        let mut attributes =
            winsec::SecurityAttributes::from_sddl(&pipe::security_descriptor(&sid))?;

        // `first_pipe_instance` is the concurrency guard: if another host of
        // this user and this major already listens, this call fails and this
        // process leaves rather than serving a second, competing table.
        let mut server = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .max_instances(255)
                .in_buffer_size(64 * 1024)
                .out_buffer_size(64 * 1024)
                .create_with_security_attributes_raw(&endpoint, attributes.as_ptr())
        }?;
        tracing::info!(%endpoint, "session host listening");

        let idle = self.clone();
        let deadline = self.idle_exit;
        let watchdog = tokio::spawn(async move { idle.watch_idle(deadline).await });

        let mut next_connection: ConnectionId = 1;
        loop {
            tokio::select! {
                accepted = server.connect() => {
                    accepted?;
                    // The next instance is created before this one is served,
                    // so there is never a moment with no listener: a Worker
                    // reconnecting during a busy period must not be told the
                    // host is gone.
                    let connected = std::mem::replace(&mut server, unsafe {
                        ServerOptions::new()
                            .reject_remote_clients(true)
                            .max_instances(255)
                            .in_buffer_size(64 * 1024)
                            .out_buffer_size(64 * 1024)
                            .create_with_security_attributes_raw(&endpoint, attributes.as_ptr())
                    }?);
                    let id = next_connection;
                    next_connection += 1;
                    let host = self.clone();
                    let expected = sid.clone();
                    tokio::spawn(async move {
                        if let Err(error) = host.serve_connection(id, connected, &expected).await {
                            tracing::debug!(connection = id, %error, "connection ended");
                        }
                        host.drop_connection(id).await;
                    });
                }
                _ = wait_forever(&watchdog) => break,
            }
        }
        Ok(())
    }

    /// Leaves once no session has existed for the idle period. A single live
    /// session keeps this process alive indefinitely, which is the promise the
    /// whole design rests on.
    async fn watch_idle(&self, deadline: Duration) {
        loop {
            tokio::time::sleep(TICK).await;
            self.reap_exited().await;
            let mut state = self.state.lock().await;
            let over = state.table.all_over();
            if over && state.idle_since.is_none() {
                state.idle_since = Some(Instant::now());
            }
            if !over {
                state.idle_since = None;
            }
            if state.table.drained() {
                tracing::info!("drained; leaving");
                return;
            }
            if let Some(since) = state.idle_since
                && since.elapsed() >= deadline
            {
                tracing::info!("idle for {deadline:?}; leaving");
                return;
            }
        }
    }

    /// Turns a process that ended into an `exit` for whoever is watching.
    async fn reap_exited(&self) {
        let finished: Vec<(String, u64, Option<i64>)> = {
            let state = self.state.lock().await;
            state
                .live
                .iter()
                .filter_map(|(key, live)| {
                    let entry = state.table.get(key)?;
                    if entry.state.is_over() {
                        return None;
                    }
                    let code = live.conpty.exit_code()?;
                    Some((key.clone(), entry.generation, Some(code)))
                })
                .collect()
        };
        for (key, generation, code) in finished {
            self.note_exit(&key, generation, code).await;
        }
    }

    async fn note_exit(&self, key: &str, generation: u64, code: Option<i64>) {
        let mut state = self.state.lock().await;
        if !state.table.mark_exited(key, generation, code) {
            return;
        }
        let message = HostMessage::Exit {
            session_key: key.to_owned(),
            generation,
            exit_code: code,
        };
        state.tell_subscribers(key, &message);
        // The console is released only now: until the process has ended,
        // closing it would *be* the ending.
        if let Some(live) = state.live.get(key) {
            live.conpty.destroy();
        }
    }
}

/// Waits for the watchdog to decide the host should leave.
async fn wait_forever(watchdog: &tokio::task::JoinHandle<()>) {
    if watchdog.is_finished() {
        return;
    }
    // Polled by `select!`; sleeping briefly is cheaper than another channel
    // for something that fires once in the life of the process.
    tokio::time::sleep(TICK).await;
    if !watchdog.is_finished() {
        std::future::pending::<()>().await;
    }
}

/// `NamedPipeServer` does not expose its handle directly; this is the one
/// place that needs it, for the client identity check.
trait RawHandleExt {
    fn as_raw_handle_checked(&self) -> io::Result<windows_sys::Win32::Foundation::HANDLE>;
}

impl RawHandleExt for NamedPipeServer {
    fn as_raw_handle_checked(&self) -> io::Result<windows_sys::Win32::Foundation::HANDLE> {
        use std::os::windows::io::AsRawHandle;
        let handle = self.as_raw_handle();
        if handle.is_null() {
            return Err(io::Error::other("pipe has no handle"));
        }
        Ok(handle.cast())
    }
}
