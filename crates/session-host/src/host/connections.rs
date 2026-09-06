//! One connection's life: identifying the peer, framing what it sends, and
//! keeping a slow subscriber from holding the pipe open for everybody else.

use std::{io, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::NamedPipeServer,
    sync::mpsc,
};

use crate::{
    HOST_VERSION, PROTOCOL_MAJOR, pipe,
    protocol::{ClientMessage, ErrorCode, Frame, FrameDecoder, FrameKind, HostMessage},
    session::ConnectionId,
    winsec,
};

use super::{CONNECTION_QUEUE, Host, RawHandleExt};

impl Host {
    /* ----------------------------- connections ---------------------------- */

    pub(super) async fn serve_connection(
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

    pub(super) async fn welcome(&self, id: ConnectionId) {
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
    pub(super) async fn drop_connection(&self, id: ConnectionId) {
        let mut state = self.state.lock().await;
        state.connections.remove(&id);
        for key in state.table.disconnect(id) {
            if let Some(live) = state.live.get(&key) {
                live.conpty.gate.set(false);
            }
        }
    }

    /// The reader may resume for anything this connection had paused.
    pub(super) async fn release_pressure(&self, id: ConnectionId) {
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
}
