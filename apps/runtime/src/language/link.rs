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
