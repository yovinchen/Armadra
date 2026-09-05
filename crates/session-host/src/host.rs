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
//!   While one session lives it stays, forever if need be.

#![cfg(windows)]

use std::{
    collections::HashMap,
    io,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::{Mutex, mpsc},
};

use crate::{
    HOST_VERSION, PROTOCOL_MAJOR,
    conpty::{ConptySession, PtyEvent, SpawnSpec},
    pipe,
    protocol::{
        ClientMessage, ErrorCode, Frame, FrameDecoder, FrameKind, HostMessage, MAX_PAYLOAD, Size,
        base64, encode_json,
    },
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

    /* ----------------------------- connections ---------------------------- */

    async fn serve_connection(
        &self,
        id: ConnectionId,
        pipe: NamedPipeServer,
        expected_sid: &str,
    ) -> io::Result<()> {
        // The identity check happens on this exact handle, before anything is
        // read or written. A predictable pipe name plus no check would let any
        // process on the machine read an agent's terminal.
        let actual = unsafe { winsec::client_sid(pipe.as_raw_handle_checked()?) }?;
        if !pipe::principal_allowed(expected_sid, &actual) {
            tracing::warn!(connection = id, %actual, "refusing a connection from another principal");
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "pipe client belongs to a different principal",
            ));
        }

        let (mut reader, mut writer) = tokio::io::split(pipe);
        let (sender, mut outgoing) = mpsc::channel::<Frame>(CONNECTION_QUEUE);
        self.state
            .lock()
            .await
            .connections
            .insert(id, sender.clone());

        let host = self.clone();
        let pump = tokio::spawn(async move {
            while let Some(frame) = outgoing.recv().await {
                let Ok(bytes) = frame.encode() else { continue };
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
                // Caught up enough to be worth un-pausing whatever this
                // connection stopped.
                if sender.capacity() * 4 >= sender.max_capacity() * 3 {
                    host.release_pressure(id).await;
                }
            }
        });

        let mut decoder = FrameDecoder::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut greeted = false;
        let handshake = tokio::time::Instant::now()
            + Duration::from_millis(crate::protocol::HANDSHAKE_TIMEOUT_MS);
        loop {
            let read = if greeted {
                reader.read(&mut buffer).await
            } else {
                // A connection that holds a pipe instance without ever saying
                // hello is a resource somebody else needs.
                match tokio::time::timeout_at(handshake, reader.read(&mut buffer)).await {
                    Ok(read) => read,
                    Err(_) => break,
                }
            };
            let count = match read {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            decoder.push(&buffer[..count]);
            loop {
                let frame = match decoder.next_frame() {
                    Ok(Some(frame)) => frame,
                    Ok(None) => break,
                    // Framing is gone; there is nothing to resynchronise to.
                    Err(error) => {
                        tracing::warn!(connection = id, %error, "closing an unreadable connection");
                        pump.abort();
                        return Ok(());
                    }
                };
                if frame.kind != FrameKind::Json {
                    continue;
                }
                let Ok(message) = serde_json::from_slice::<ClientMessage>(&frame.payload) else {
                    continue;
                };
                if !greeted {
                    match message {
                        ClientMessage::Hello { protocol, client } => {
                            if protocol != PROTOCOL_MAJOR {
                                let state = self.state.lock().await;
                                state.tell(
                                    id,
                                    &HostMessage::Error {
                                        id: 0,
                                        code: ErrorCode::UnsupportedProtocol,
                                        message: format!(
                                            "this host speaks protocol {PROTOCOL_MAJOR}"
                                        ),
                                    },
                                );
                                drop(state);
                                break;
                            }
                            greeted = true;
                            tracing::debug!(connection = id, %client, "client greeted");
                            self.welcome(id).await;
                        }
                        // Anything before hello is refused rather than served.
                        _ => {
                            let state = self.state.lock().await;
                            state.tell(
                                id,
                                &HostMessage::Error {
                                    id: 0,
                                    code: ErrorCode::Unauthorized,
                                    message: "hello first".into(),
                                },
                            );
                            drop(state);
                            break;
                        }
                    }
                    continue;
                }
                self.handle(id, message).await;
            }
            if !greeted {
                break;
            }
        }
        pump.abort();
        Ok(())
    }

    async fn welcome(&self, id: ConnectionId) {
        let state = self.state.lock().await;
        let message = HostMessage::Welcome {
            protocol: PROTOCOL_MAJOR,
            host: HOST_VERSION.to_owned(),
            pid: winsec::current_pid(),
            instance_id: state.instance_id.clone(),
            sessions: state.table.summaries(),
        };
        state.tell(id, &message);
    }

    /// A connection is gone: unsubscribe it everywhere and release any pause
    /// it was holding. Unconditional, because a frontend that crashed while
    /// paused must not freeze the CLI.
    async fn drop_connection(&self, id: ConnectionId) {
        let mut state = self.state.lock().await;
        state.connections.remove(&id);
        for key in state.table.disconnect(id) {
            if let Some(live) = state.live.get(&key) {
                live.conpty.gate.set(false);
            }
        }
    }

    /// The reader may resume for anything this connection had paused.
    async fn release_pressure(&self, id: ConnectionId) {
        let mut state = self.state.lock().await;
        let keys: Vec<String> = state
            .table
            .iter()
            .filter(|entry| entry.paused())
            .map(|entry| entry.session_key.clone())
            .collect();
        for key in keys {
            if state.table.set_flow(&key, id, false)
                && let Some(live) = state.live.get(&key)
            {
                live.conpty.gate.set(false);
            }
        }
    }

    /* ------------------------------- requests ----------------------------- */

    async fn handle(&self, connection: ConnectionId, message: ClientMessage) {
        match message {
            ClientMessage::Hello { .. } => {}
            ClientMessage::Create { id, spec } => self.create(connection, id, spec).await,
            ClientMessage::Attach {
                id,
                session_key,
                generation,
                size,
            } => {
                self.attach(connection, id, &session_key, generation, size)
                    .await
            }
            ClientMessage::Detach { id, session_key } => {
                let mut state = self.state.lock().await;
                state.table.detach(&session_key, connection);
                if let Some(live) = state.live.get(&session_key) {
                    live.conpty.gate.set(false);
                }
                let message = HostMessage::Ok {
                    id,
                    session: None,
                    sessions: None,
                };
                state.tell(connection, &message);
            }
            ClientMessage::Write {
                id,
                session_key,
                data,
            } => {
                let Some(bytes) = base64::decode(&data) else {
                    self.fail(
                        connection,
                        id,
                        ErrorCode::BadRequest,
                        "write data is not base64",
                    )
                    .await;
                    return;
                };
                self.act(connection, id, &session_key, |live| {
                    live.conpty.write(bytes);
                })
                .await;
            }
            ClientMessage::Resize {
                id,
                session_key,
                size,
            } => {
                let size = size.clamped();
                {
                    let mut state = self.state.lock().await;
                    if let Some(entry) = state.table.get_mut(&session_key) {
                        entry.size = size;
                    }
                }
                self.act(connection, id, &session_key, move |live| {
                    live.conpty.resize(size.cols, size.rows);
                })
                .await;
            }
            ClientMessage::List { id } => {
                let state = self.state.lock().await;
                let message = HostMessage::Ok {
                    id,
                    session: None,
                    sessions: Some(state.table.summaries()),
                };
                state.tell(connection, &message);
            }
            ClientMessage::Interrupt { id, session_key } => {
                // Windows has no SIGINT to send. `0x03` through the console
                // input is what a real Ctrl+C is, and it is the one path that
                // works for a Win32 CLI, a Node CLI and a WSL shell alike.
                self.act(connection, id, &session_key, |live| {
                    live.conpty.write(vec![0x03]);
                })
                .await;
            }
            ClientMessage::Kill { id, session_key } => {
                self.act(connection, id, &session_key, |live| live.conpty.kill())
                    .await;
            }
            ClientMessage::Destroy { id, session_key } => {
                let mut state = self.state.lock().await;
                if let Some(live) = state.live.remove(&session_key) {
                    live.conpty.destroy();
                }
                state.table.remove(&session_key);
                if state.table.all_over() && state.idle_since.is_none() {
                    state.idle_since = Some(Instant::now());
                }
                let message = HostMessage::Ok {
                    id,
                    session: None,
                    sessions: None,
                };
                state.tell(connection, &message);
            }
            ClientMessage::Flow {
                id,
                session_key,
                paused,
            } => {
                let mut state = self.state.lock().await;
                if state.table.set_flow(&session_key, connection, paused)
                    && let Some(live) = state.live.get(&session_key)
                {
                    live.conpty.gate.set(paused);
                }
                let message = HostMessage::Ok {
                    id,
                    session: None,
                    sessions: None,
                };
                state.tell(connection, &message);
            }
        }
    }

    /// Runs `action` against a live session, answering `ok` or the reason it
    /// could not. Everything that needs a current generation goes through here
    /// so the fence is applied once rather than at every call site.
    async fn act(&self, connection: ConnectionId, id: u64, key: &str, action: impl FnOnce(&Live)) {
        let state = self.state.lock().await;
        let Some(entry) = state.table.get(key) else {
            drop(state);
            self.fail(
                connection,
                id,
                ErrorCode::NotFound,
                format!("no session for {key}"),
            )
            .await;
            return;
        };
        if entry.state.is_over() {
            drop(state);
            self.fail(
                connection,
                id,
                ErrorCode::NotFound,
                format!("{key} has ended"),
            )
            .await;
            return;
        }
        let summary = entry.summary();
        let Some(live) = state.live.get(key) else {
            drop(state);
            self.fail(
                connection,
                id,
                ErrorCode::Internal,
                "session has no console",
            )
            .await;
            return;
        };
        action(live);
        let message = HostMessage::Ok {
            id,
            session: Some(summary),
            sessions: None,
        };
        state.tell(connection, &message);
    }

    async fn fail(
        &self,
        connection: ConnectionId,
        id: u64,
        code: ErrorCode,
        message: impl Into<String>,
    ) {
        let state = self.state.lock().await;
        state.tell(
            connection,
            &HostMessage::Error {
                id,
                code,
                message: message.into(),
            },
        );
    }

    async fn create(&self, connection: ConnectionId, id: u64, spec: crate::protocol::CreateSpec) {
        let program = spec.command.clone().unwrap_or_else(|| spec.shell.clone());
        let (events, receiver) = mpsc::unbounded_channel::<PtyEvent>();

        // Reserve the row first, so two creates racing for one key cannot both
        // start a console.
        {
            let mut state = self.state.lock().await;
            if let Err(error) = state.table.create(
                spec.session_key.clone(),
                spec.generation,
                spec.workspace_id.clone(),
                spec.cwd.clone(),
                spec.size,
            ) {
                drop(state);
                self.fail(connection, id, error.code, error.message).await;
                return;
            }
        }

        let size = spec.size.clamped();
        let spawned = ConptySession::spawn(
            SpawnSpec {
                cwd: &spec.cwd,
                program: &program,
                args: &spec.args,
                env: &spec.env,
                cols: size.cols,
                rows: size.rows,
            },
            events,
        );
        let conpty = match spawned {
            Ok(session) => Arc::new(session),
            Err(error) => {
                // The reservation must not survive a failed spawn, or the key
                // is permanently unusable.
                let mut state = self.state.lock().await;
                state.table.remove(&spec.session_key);
                drop(state);
                self.fail(connection, id, ErrorCode::BadRequest, error.to_string())
                    .await;
                return;
            }
        };

        let summary = {
            let mut state = self.state.lock().await;
            if let Some(entry) = state.table.get_mut(&spec.session_key) {
                entry.pid = conpty.pid;
            }
            state.live.insert(
                spec.session_key.clone(),
                Live {
                    conpty: conpty.clone(),
                    replay: ReplayBuffer::default(),
                    responder: QueryResponder::new(),
                },
            );
            state.idle_since = None;
            state
                .table
                .get(&spec.session_key)
                .map(|entry| entry.summary())
        };

        let host = self.clone();
        let key = spec.session_key.clone();
        let generation = spec.generation;
        tokio::spawn(async move { host.pump_output(key, generation, receiver).await });

        let state = self.state.lock().await;
        state.tell(
            connection,
            &HostMessage::Ok {
                id,
                session: summary,
                sessions: None,
            },
        );
    }

    async fn attach(
        &self,
        connection: ConnectionId,
        id: u64,
        key: &str,
        generation: u64,
        size: Size,
    ) {
        let mut state = self.state.lock().await;
        let current = state.table.get(key).map(|entry| entry.generation);
        match state.table.attach(key, generation, connection, size) {
            Ok(entry) => {
                let summary = entry.summary();
                // The replay goes out under the same lock that registered the
                // subscriber, so there is no window in which output is
                // produced but this connection is neither replayed nor
                // subscribed — that window is exactly how a re-attach loses a
                // line.
                let (snapshot, truncated) = state
                    .live
                    .get(key)
                    .map(|live| (live.replay.snapshot().to_vec(), live.replay.truncated()))
                    .unwrap_or_default();
                if let Some(live) = state.live.get(key) {
                    live.conpty.resize(summary.size.cols, summary.size.rows);
                }
                for chunk in snapshot.chunks(OUTPUT_CHUNK) {
                    let frame = Frame {
                        kind: FrameKind::Snapshot,
                        generation,
                        sequence: 0,
                        payload: chunk.to_vec(),
                    };
                    if let Some(sender) = state.connections.get(&connection) {
                        let _ = sender.try_send(frame);
                    }
                }
                if let Some(sender) = state.connections.get(&connection) {
                    let _ = sender.try_send(Frame {
                        kind: FrameKind::SnapshotEnd,
                        generation,
                        sequence: 0,
                        payload: Vec::new(),
                    });
                }
                if truncated {
                    let message = HostMessage::Warning {
                        session_key: key.to_owned(),
                        message: "older output was dropped from the replay buffer".into(),
                    };
                    state.tell(connection, &message);
                }
                let message = HostMessage::Ok {
                    id,
                    session: Some(summary),
                    sessions: None,
                };
                state.tell(connection, &message);
            }
            Err(error) => {
                if error.code == ErrorCode::Stale
                    && let Some(current) = current
                {
                    let message = HostMessage::Stale {
                        session_key: key.to_owned(),
                        generation,
                        current,
                    };
                    state.tell(connection, &message);
                }
                let message = HostMessage::Error {
                    id,
                    code: error.code,
                    message: error.message,
                };
                state.tell(connection, &message);
            }
        }
    }

    /// Consumes one session's console output for the life of that session.
    ///
    /// Runs whether or not anybody is attached, which is the rule ConPTY makes
    /// non-negotiable: an undrained console blocks the CLI and then deadlocks
    /// its own close.
    async fn pump_output(
        &self,
        key: String,
        generation: u64,
        mut events: mpsc::UnboundedReceiver<PtyEvent>,
    ) {
        while let Some(event) = events.recv().await {
            match event {
                PtyEvent::Output(chunk) => {
                    let mut state = self.state.lock().await;
                    let Some(live) = state.live.get_mut(&key) else {
                        continue;
                    };
                    // Answer the terminal's own questions before anything
                    // else: a ConPTY created with INHERIT_CURSOR waits for
                    // this, and there may be no UI to answer for it.
                    let reply = live.responder.observe(&chunk);
                    if !reply.is_empty() {
                        live.conpty.write(reply);
                    }
                    live.replay.push(&chunk);

                    let Some(entry) = state.table.get_mut(&key) else {
                        continue;
                    };
                    if entry.generation != generation {
                        continue;
                    }
                    let subscribers: Vec<ConnectionId> = entry.subscribers().collect();
                    if subscribers.is_empty() {
                        continue;
                    }
                    let mut frames = Vec::new();
                    for piece in chunk.chunks(OUTPUT_CHUNK) {
                        frames.push(Frame::output(
                            generation,
                            entry.next_sequence(),
                            piece.to_vec(),
                        ));
                    }
                    let mut behind = Vec::new();
                    for connection in subscribers {
                        let Some(sender) = state.connections.get(&connection) else {
                            continue;
                        };
                        for frame in &frames {
                            if sender.try_send(frame.clone()).is_err() {
                                behind.push(connection);
                                break;
                            }
                        }
                    }
                    // A subscriber that cannot keep up pauses the reader
                    // rather than being dropped: back pressure reaches the CLI
                    // the same way it would through a real terminal, and the
                    // pause is released when the connection catches up or goes
                    // away.
                    for connection in behind {
                        let message = HostMessage::Warning {
                            session_key: key.clone(),
                            message: "output is being throttled to let this client catch up".into(),
                        };
                        state.tell(connection, &message);
                        if state.table.set_flow(&key, connection, true)
                            && let Some(live) = state.live.get(&key)
                        {
                            live.conpty.gate.set(true);
                        }
                    }
                }
                PtyEvent::Eof => {
                    let code = self
                        .state
                        .lock()
                        .await
                        .live
                        .get(&key)
                        .and_then(|live| live.conpty.exit_code());
                    self.note_exit(&key, generation, code).await;
                    return;
                }
            }
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
