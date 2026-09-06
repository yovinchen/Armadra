//! The full-duplex channel to an execution host (design §2.1, §2.7).
//!
//! The controller does not parse LSP. It moves [`LanguageFrame`]s between a
//! browser session and whichever machine holds the server, and this trait is
//! the whole of what it needs to know about that machine. A local workspace's
//! link is a pair of in-process channels; a remote workspace's is the second
//! ssh connection, which is batch D and implements exactly this.
//!
//! Frames carry a `link_epoch`. A link that is re-established mints a new one,
//! and a frame stamped with an older epoch is dropped rather than delivered —
//! otherwise a message in flight when a connection died would be applied to
//! the session that replaced it.

use armadra_protocol::v1::{LanguageFrame, language_frame};
use tokio::sync::mpsc;

/// One machine's language channel.
#[allow(async_fn_in_trait)]
pub trait LanguageLink: Send + Sync {
    /// The epoch frames on this link must carry.
    fn epoch(&self) -> &str;

    /// Towards the execution host. An error means the link is gone; the
    /// caller marks its sessions `disconnected` rather than retrying blindly.
    fn send(&self, frame: LanguageFrame) -> Result<(), LinkClosed>;

    /// The next frame from the execution host, or `None` once it is gone.
    fn recv(&mut self) -> impl std::future::Future<Output = Option<LanguageFrame>> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkClosed;

impl std::fmt::Display for LinkClosed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the language link is closed")
    }
}

impl std::error::Error for LinkClosed {}

/// A link whose execution host is this process.
///
/// The frames are real — the same envelope the remote link carries — so the
/// local path exercises the encoding rather than bypassing it. What it skips
/// is only the transport.
pub struct LocalLink {
    epoch: String,
    outbound: mpsc::UnboundedSender<LanguageFrame>,
    inbound: mpsc::UnboundedReceiver<LanguageFrame>,
}

/// The execution host's end of a [`LocalLink`].
pub struct LocalLinkHost {
    epoch: String,
    outbound: mpsc::UnboundedSender<LanguageFrame>,
    inbound: mpsc::UnboundedReceiver<LanguageFrame>,
}

impl LocalLink {
    /// A connected pair: the controller's end and the execution host's end.
    pub fn pair() -> (Self, LocalLinkHost) {
        let epoch = uuid::Uuid::new_v4().simple().to_string();
        let (to_host, from_controller) = mpsc::unbounded_channel();
        let (to_controller, from_host) = mpsc::unbounded_channel();
        (
            Self {
                epoch: epoch.clone(),
                outbound: to_host,
                inbound: from_host,
            },
            LocalLinkHost {
                epoch,
                outbound: to_controller,
                inbound: from_controller,
            },
        )
    }
}

impl LanguageLink for LocalLink {
    fn epoch(&self) -> &str {
        &self.epoch
    }

    fn send(&self, mut frame: LanguageFrame) -> Result<(), LinkClosed> {
        frame.link_epoch = self.epoch.clone();
        self.outbound.send(frame).map_err(|_| LinkClosed)
    }

    async fn recv(&mut self) -> Option<LanguageFrame> {
        loop {
            let frame = self.inbound.recv().await?;
            if frame.link_epoch == self.epoch {
                return Some(frame);
            }
        }
    }
}

impl LocalLinkHost {
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn send(&self, mut frame: LanguageFrame) -> Result<(), LinkClosed> {
        frame.link_epoch = self.epoch.clone();
        self.outbound.send(frame).map_err(|_| LinkClosed)
    }

    pub async fn recv(&mut self) -> Option<LanguageFrame> {
        self.inbound.recv().await
    }
}

/// Wraps one JSON-RPC message for the wire.
pub fn message_frame(
    session_id: &str,
    sequence: u64,
    kind: super::jsonrpc::Kind,
    method: &str,
    request_id: &str,
    payload: Vec<u8>,
) -> LanguageFrame {
    LanguageFrame {
        link_epoch: String::new(),
        payload: Some(language_frame::Payload::Message(
            armadra_protocol::v1::LanguageMessage {
                session_id: session_id.to_owned(),
                sequence,
                kind: kind.to_proto() as i32,
                method: method.to_owned(),
                request_id: request_id.to_owned(),
                payload_json: payload,
            },
        )),
    }
}

/// Wraps one session status change for the wire.
pub fn status_frame(status: armadra_protocol::v1::LanguageSessionStatus) -> LanguageFrame {
    LanguageFrame {
        link_epoch: String::new(),
        payload: Some(language_frame::Payload::Status(status)),
    }
}

/* ------------------------------- flow control ----------------------------- */

/// Unacknowledged bytes one direction of a link may hold before its writer
/// waits (design §2.7, §3.3).
///
/// Four mebibytes is roughly four oversized responses, or thousands of
/// ordinary ones. Past it the writer stops, which for the execution host means
/// it stops draining the server's stdout — and a language server that cannot
/// write blocks rather than losing messages, which is the property the whole
/// scheme exists for.
pub const CREDIT_BYTES: u64 = 4 * 1024 * 1024;

/// The sending half of one direction's credit window.
///
/// Every message frame reserves its own byte count and gets a sequence number.
/// The peer acknowledges a sequence, which releases that frame and everything
/// before it. Acks are not themselves counted — an ack that needed credit to
/// travel could not release the credit it was waiting for.
pub struct Window {
    limit: u64,
    state: std::sync::Mutex<WindowState>,
    notify: tokio::sync::Notify,
}

#[derive(Default)]
struct WindowState {
    next: u64,
    used: u64,
    /// `(sequence, bytes)` in send order.
    outstanding: std::collections::VecDeque<(u64, u64)>,
    closed: bool,
}

impl Window {
    pub fn new(limit: u64) -> Self {
        Self {
            limit,
            state: std::sync::Mutex::new(WindowState::default()),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WindowState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Claims room for one frame and returns its sequence number.
    ///
    /// Waits while the window is full. A frame larger than the whole window is
    /// admitted when nothing else is outstanding: refusing it would be a
    /// deadlock, and the message ceiling has already bounded how large it can
    /// be. `None` means the link closed while waiting.
    pub async fn reserve(&self, bytes: usize) -> Option<u64> {
        let bytes = bytes as u64;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Registered before the state is read, so an acknowledgement that
            // lands between the check and the await still wakes this waiter.
            notified.as_mut().enable();
            {
                let mut state = self.lock();
                if state.closed {
                    return None;
                }
                if state.used == 0 || state.used + bytes <= self.limit {
                    state.next += 1;
                    state.used += bytes;
                    let sequence = state.next;
                    state.outstanding.push_back((sequence, bytes));
                    return Some(sequence);
                }
            }
            notified.await;
        }
    }

    /// Releases everything up to and including `through`.
    pub fn acknowledge(&self, through: u64) {
        {
            let mut state = self.lock();
            while let Some((sequence, bytes)) = state.outstanding.front().copied() {
                if sequence > through {
                    break;
                }
                state.outstanding.pop_front();
                state.used = state.used.saturating_sub(bytes);
            }
        }
        self.notify.notify_waiters();
    }

    /// What the peer would be told it may still send.
    pub fn available(&self) -> u32 {
        let state = self.lock();
        u32::try_from(self.limit.saturating_sub(state.used)).unwrap_or(u32::MAX)
    }

    pub fn used(&self) -> u64 {
        self.lock().used
    }

    /// The link is gone. Every waiter is released so no task is left parked on
    /// credit that will never be returned.
    pub fn close(&self) {
        self.lock().closed = true;
        self.notify.notify_waiters();
    }
}

impl Default for Window {
    fn default() -> Self {
        Self::new(CREDIT_BYTES)
    }
}

/// Wraps one acknowledgement for the wire.
pub fn ack_frame(session_id: &str, received_through: u64, available: u32) -> LanguageFrame {
    LanguageFrame {
        link_epoch: String::new(),
        payload: Some(language_frame::Payload::Ack(
            armadra_protocol::v1::LanguageAck {
                session_id: session_id.to_owned(),
                received_through,
                available_credit_bytes: available,
            },
        )),
    }
}
