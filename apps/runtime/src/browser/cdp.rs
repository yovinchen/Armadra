//! A deliberately narrow Chrome DevTools Protocol client.
//!
//! It is a transport, not a proxy. Nothing in this file lets a caller name a
//! CDP method: every `call` in the crate is written out in [`super::session`]
//! or [`super::dom`], which is the rule design §5 sets — "首轮 Browser Worker
//! 使用 Rust 管理 Chromium 生命周期和受限 CDP 适配；不引入公开的原始 CDP 代理".
//!
//! Shape: one reader task owns the socket's receiving half and either resolves
//! a pending `id` or forwards an event; one writer task owns the sending half.
//! `CdpClient` is therefore `Send + Sync` and can be called concurrently from
//! any number of request handlers without a lock across an await.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};

/// How long one CDP call may take before it is reported as a timeout.
///
/// Deliberately not infinite: a page that is blocked in a modal `alert()` never
/// answers `Runtime.evaluate`, and an agent waiting forever is worse than a
/// refusal it can act on.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Ceiling on one incoming CDP message. A screencast frame is a base64 JPEG
/// inside JSON, so the bound has to be generous, but not unbounded: a hostile
/// page must not be able to make the Runtime buffer arbitrary memory.
const MAX_MESSAGE_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
}

/// Why a call did not produce a result. Every variant maps to a stable reason
/// code the API hands back, never to raw browser text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpError {
    /// The socket is gone — the browser exited or crashed.
    Closed,
    Timeout,
    /// The browser answered with an `error` member. The string is the
    /// protocol's own message and is only ever used for logs and for the
    /// `message` of a 4xx, never parsed.
    Protocol(String),
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => formatter.write_str("browser connection closed"),
            Self::Timeout => formatter.write_str("browser did not answer in time"),
            Self::Protocol(message) => write!(formatter, "browser refused: {message}"),
        }
    }
}

impl CdpError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Closed => "cdp_closed",
            Self::Timeout => "cdp_timeout",
            Self::Protocol(_) => "cdp_refused",
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>>;

pub struct CdpClient {
    outgoing: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
}

impl CdpClient {
    /// Connects to one page target's debugger URL and starts the two pumps.
    ///
    /// The returned receiver carries every event the browser emits; the caller
    /// is expected to drain it, because an unread channel would otherwise grow
    /// for as long as the page is alive.
    pub async fn connect(
        url: &str,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<CdpEvent>), String> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|error| format!("could not open the CDP socket: {error}"))?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut queued) = mpsc::unbounded_channel::<Message>();
        let (events, receiver) = mpsc::unbounded_channel::<CdpEvent>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        tokio::spawn(async move {
            while let Some(message) = queued.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let reader_pending = pending.clone();
        let reader_closed = closed.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => match String::from_utf8(bytes.to_vec()) {
                        Ok(text) => text,
                        Err(_) => continue,
                    },
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let waiting = reader_pending
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .remove(&id);
                    if let Some(waiting) = waiting {
                        let answer = match value.get("error") {
                            Some(error) => Err(CdpError::Protocol(
                                error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown error")
                                    .to_owned(),
                            )),
                            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = waiting.send(answer);
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    // A dead receiver means the session is being torn down;
                    // that is not an error, it just ends the pump.
                    if events
                        .send(CdpEvent {
                            method: method.to_owned(),
                            params: value.get("params").cloned().unwrap_or(Value::Null),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
            // Everything still waiting has to be told, or a handler would hang
            // until its own timeout for no reason.
            reader_closed.store(true, Ordering::SeqCst);
            let waiting: Vec<_> = reader_pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .drain()
                .collect();
            for (_, sender) in waiting {
                let _ = sender.send(Err(CdpError::Closed));
            }
        });

        Ok((
            Arc::new(Self {
                outgoing,
                pending,
                next_id: AtomicU64::new(0),
                closed,
            }),
            receiver,
        ))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// One request/response round trip.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        self.call_with_timeout(method, params, CALL_TIMEOUT).await
    }

    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        if self.is_closed() {
            return Err(CdpError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, sender);
        let frame = json!({ "id": id, "method": method, "params": params });
        if self
            .outgoing
            .send(Message::Text(frame.to_string().into()))
            .is_err()
        {
            self.pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            return Err(CdpError::Closed);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(CdpError::Closed),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&id);
                Err(CdpError::Timeout)
            }
        }
    }

    /// Fire and forget. Used only for screencast acknowledgements, where
    /// waiting for the reply would gate the next frame on a round trip.
    pub fn notify(&self, method: &str, params: Value) {
        if self.is_closed() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = json!({ "id": id, "method": method, "params": params });
        let _ = self.outgoing.send(Message::Text(frame.to_string().into()));
    }
}
