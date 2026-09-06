//! What a client may ask for: creating and attaching to a session, the writes
//! and resizes that follow, and the output pump behind them.

use std::{sync::Arc, time::Instant};

use tokio::sync::mpsc;

use crate::{
    conpty::{ConptySession, PtyEvent, SpawnSpec},
    protocol::{ClientMessage, ErrorCode, Frame, FrameKind, HostMessage, Size, base64},
    replay::{QueryResponder, ReplayBuffer},
    session::ConnectionId,
};

use super::{Host, Live, OUTPUT_CHUNK};

impl Host {
    /* ------------------------------- requests ----------------------------- */

    pub(super) async fn handle(&self, connection: ConnectionId, message: ClientMessage) {
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
    pub(super) async fn act(
        &self,
        connection: ConnectionId,
        id: u64,
        key: &str,
        action: impl FnOnce(&Live),
    ) {
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

    pub(super) async fn fail(
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

    pub(super) async fn create(
        &self,
        connection: ConnectionId,
        id: u64,
        spec: crate::protocol::CreateSpec,
    ) {
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

    pub(super) async fn attach(
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
    pub(super) async fn pump_output(
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
