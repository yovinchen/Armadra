//! The Runtime's end of `browser:drive`.
//!
//! One loopback WebSocket, dialled by this process, to the Electron shell that
//! started it. The address and a one-time token arrive in this process's
//! environment and nowhere else: not a file, not a well-known port, not a
//! constant. A Runtime nobody's shell started therefore has no channel at all,
//! which is the right answer — it has no claim on somebody else's window
//! either.
//!
//! Authorization does not live here. The three rules and the lease are decided
//! before a request reaches this file (design §4.2); what travels is an
//! already-authorized **verb**, never a CDP method name.

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
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use crate::error::{AppError, AppResult};

/// Where the shell is listening. Written by `apps/desktop/src/main/
/// runtime-process.ts` into this process's spawn environment.
pub const ADDRESS_ENV: &str = "ARMADRA_SHELL_DRIVE_WS";
/// The one-time token for that channel, from the same place.
pub const TOKEN_ENV: &str = "ARMADRA_SHELL_DRIVE_TOKEN";

/// The code a verb gets when there is no shell to drive through. It is a code
/// and not prose because a caller branches on it: "no window is open" is a
/// different thing from "you may not drive that node".
pub const UNAVAILABLE: &str = "browser_unavailable";

/// Longest one verb may wait for the shell. Slightly longer than the shell's
/// own per-verb bound, so a timeout is normally reported by the side that knows
/// which page stopped answering.
const CALL_TIMEOUT: Duration = Duration::from_secs(50);
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(10);

/// An event the shell pushed: a guest navigated, a person touched a page, a
/// lease should end. Delivered to whatever [`Client::connect`] was given.
pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;
type Outbox = tokio::sync::mpsc::UnboundedSender<Message>;

pub struct Client {
    address: String,
    token: String,
    outbox: Mutex<Option<Outbox>>,
    pending: Pending,
    connected: AtomicBool,
    next_id: AtomicU64,
}

impl Client {
    /// Reads the environment. `None` when this Runtime was not started by a
    /// shell, which is the ordinary case for `cargo test` and for a developer
    /// running the Runtime by hand.
    pub fn from_environment() -> Option<Arc<Self>> {
        let address = std::env::var(ADDRESS_ENV).ok().filter(|v| !v.is_empty())?;
        let token = std::env::var(TOKEN_ENV).ok().filter(|v| !v.is_empty())?;
        Some(Arc::new(Self {
            address,
            token,
            outbox: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            connected: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
        }))
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Dials, and keeps dialling. The task lives as long as the process: a
    /// shell that restarts its window, or a socket that died under a laptop
    /// lid, must not leave browser nodes permanently unavailable.
    pub fn connect(self: &Arc<Self>, events: EventSink) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut backoff = RECONNECT_MIN;
            loop {
                match me.run_once(&events).await {
                    Ok(()) => backoff = RECONNECT_MIN,
                    Err(error) => {
                        tracing::debug!(%error, "browser drive channel dropped");
                    }
                }
                me.disconnect();
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RECONNECT_MAX);
            }
        });
    }

    async fn run_once(&self, events: &EventSink) -> AppResult<()> {
        let (stream, _) = tokio_tungstenite::connect_async(&self.address)
            .await
            .map_err(|error| AppError::Conflict(error.to_string()))?;
        let (mut writer, mut reader) = stream.split();
        let (outbox, mut queue) = tokio::sync::mpsc::unbounded_channel::<Message>();

        // The hello must be first on the wire; the shell drops a socket that
        // sends anything else before it.
        writer
            .send(Message::Text(
                json!({ "type": "hello", "token": self.token })
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|error| AppError::Conflict(error.to_string()))?;

        let pump = tokio::spawn(async move {
            while let Some(message) = queue.recv().await {
                if writer.send(message).await.is_err() {
                    break;
                }
            }
        });

        while let Some(message) = reader.next().await {
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    pump.abort();
                    return Err(AppError::Conflict(error.to_string()));
                }
            };
            let Message::Text(text) = message else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("ready") => {
                    *self
                        .outbox
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(outbox.clone());
                    self.connected.store(true, Ordering::Relaxed);
                    tracing::info!("browser drive channel ready");
                }
                Some("event") => events(value),
                _ => self.settle(value),
            }
        }
        pump.abort();
        Ok(())
    }

    /// Hands one answer to whoever is waiting for it. An answer for a request
    /// nobody is waiting on is dropped: it is a reply to a call that already
    /// timed out, and there is nothing useful to do with it.
    fn settle(&self, value: Value) {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return;
        };
        let waiter = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
        if let Some(waiter) = waiter {
            let _ = waiter.send(value);
        }
    }

    fn disconnect(&self) {
        self.connected.store(false, Ordering::Relaxed);
        *self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        // Everything in flight is now unanswerable. Dropping the senders wakes
        // each waiter with a closed channel, which each turns into
        // `browser_unavailable` — a named absence rather than a hang.
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    /// Sends one already-authorized verb and waits for its answer.
    pub async fn drive(&self, node_id: &str, verb: &str, args: Value) -> AppResult<Value> {
        let outbox = {
            let guard = self
                .outbox
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.clone()
        };
        let Some(outbox) = outbox.filter(|_| self.is_connected()) else {
            return Err(unavailable());
        };
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id.clone(), sender);
        let request = json!({ "id": id, "nodeId": node_id, "verb": verb, "args": args });
        if outbox
            .send(Message::Text(request.to_string().into()))
            .is_err()
        {
            self.pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            return Err(unavailable());
        }
        let answer = match tokio::time::timeout(CALL_TIMEOUT, receiver).await {
            Ok(Ok(answer)) => answer,
            // The channel went away: the shell closed, or the window did.
            Ok(Err(_)) => return Err(unavailable()),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&id);
                return Err(AppError::Conflict(
                    "browser_timeout: that page did not answer in time".into(),
                ));
            }
        };
        interpret(answer)
    }

    /// Tells the shell something without waiting: a lease ended, and every
    /// debugger attached to that node must go.
    pub fn notify(&self, node_id: &str, event: &str, detail: Value) {
        let guard = self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(outbox) = guard.as_ref() else { return };
        let message = json!({
            "id": "",
            "type": "notice",
            "notice": event,
            "nodeId": node_id,
            "detail": detail,
        });
        let _ = outbox.send(Message::Text(message.to_string().into()));
    }
}

pub fn unavailable() -> AppError {
    AppError::Conflict(format!(
        "{UNAVAILABLE}: 这个窗口里没有可驱动的浏览器节点（桌面壳未连接）。"
    ))
}

/// Turns one `{ id, ok, result | error }` answer into a result.
///
/// A refusal keeps its code at the front of the message, the same shape the
/// lease refusals use, because the reader is a model printing its own stdout
/// and the code is the part it can act on.
pub(crate) fn interpret(answer: Value) -> AppResult<Value> {
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(answer.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = answer.get("error");
    let code = error
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("browser_failed");
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("that browser node could not do it");
    Err(match code {
        "browser_bad_argument" | "browser_unknown_verb" => {
            AppError::BadRequest(format!("{code}: {message}"))
        }
        "browser_not_found" | "browser_not_drivable" => {
            AppError::NotFound(format!("{code}: {message}"))
        }
        "browser_refused" => AppError::Forbidden(format!("{code}: {message}")),
        _ => AppError::Conflict(format!("{code}: {message}")),
    })
}
