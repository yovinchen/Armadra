//! Explicit control from the desktop that owns this Runtime child. This is not
//! an HTTP API.
//!
//! Two different messages arrive on this one pipe, and they must not be
//! confused:
//!
//!   * a **shutdown frame** is the shell quitting on purpose. Sessions it owns
//!     are torn down, because the user asked for the application to stop.
//!   * **EOF** is the shell having disappeared — crashed, killed, force-quit.
//!     Nobody asked for anything, but this process must not outlive its owner:
//!     an orphan keeps the data directory's socket, and the next shell finds
//!     the address taken by a Runtime that is no longer anybody's
//!     (用户实测反馈 F1). So the parent going away ends this process too, the
//!     same way a restart signal does — persistent sessions are detached and
//!     left running, not killed.

use std::io::{self, Read};

use armadra_protocol::{
    Message,
    v1::{DesktopRuntimeControl, desktop_runtime_control::Action},
};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use tokio::sync::oneshot;

use crate::terminal::TerminalManager;

pub const MAX_CONTROL_BYTES: usize = 4096;

/// Why the control channel ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentSignal {
    /// The shell sent a canonical shutdown frame: an intentional quit.
    Shutdown,
    /// The pipe closed or went unreadable. The shell is gone; we go with it.
    Disconnected,
}

/// A dedicated OS thread avoids Tokio stdin's uncancellable blocking-pool read
/// holding Runtime exit open after an ordinary SIGTERM. The thread is not joined.
pub fn listen_to_parent() -> io::Result<oneshot::Receiver<ParentSignal>> {
    let (sender, receiver) = oneshot::channel();
    std::thread::Builder::new()
        .name("desktop-control-stdin".into())
        .spawn(move || {
            let signal = match read_shutdown(&mut io::stdin().lock()) {
                Ok(true) => ParentSignal::Shutdown,
                Ok(false) => {
                    tracing::info!("desktop control stdin closed; the shell is gone");
                    ParentSignal::Disconnected
                }
                Err(error) => {
                    // A pipe we can no longer read is a pipe that can no longer
                    // carry the shutdown frame, so staying alive would only
                    // produce the orphan this channel exists to prevent.
                    tracing::warn!(%error, "desktop control stream ended unreadable");
                    ParentSignal::Disconnected
                }
            };
            let _ = sender.send(signal);
        })?;
    Ok(receiver)
}

fn read_shutdown(reader: &mut impl Read) -> io::Result<bool> {
    loop {
        let mut header = [0u8; 4];
        // Distinguish clean EOF from a truncated header without retrying EOF.
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
        reader.read_exact(&mut header[1..])?;
        let size = u32::from_be_bytes(header) as usize;
        if size == 0 || size > MAX_CONTROL_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "desktop control frame length is invalid",
            ));
        }
        let mut payload = vec![0; size];
        reader.read_exact(&mut payload)?;
        match DesktopRuntimeControl::decode(payload.as_slice()) {
            Ok(control)
                if matches!(control.action, Some(Action::Shutdown(_)))
                    && control.encode_to_vec() == payload =>
            {
                return Ok(true);
            }
            // Canonical re-encoding rejects unknown/duplicate action fields and
            // unknown shutdown-request fields instead of silently dropping them.
            _ => tracing::warn!("ignored malformed or unsupported desktop control message"),
        }
    }
}

pub async fn reject_during_shutdown(
    State(terminals): State<TerminalManager>,
    request: Request,
    next: Next,
) -> Response {
    if terminals.is_shutting_down() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({
                "code": "runtime_shutting_down", "message": "Runtime is shutting down"
            })),
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use armadra_protocol::v1::DesktopShutdownRequest;

    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn desktop_control_only_accepts_explicit_canonical_shutdown() {
        let payload = DesktopRuntimeControl {
            action: Some(Action::Shutdown(DesktopShutdownRequest {})),
        }
        .encode_to_vec();
        assert!(read_shutdown(&mut frame(&payload).as_slice()).unwrap());
        for invalid in [
            vec![0x12, 0],
            vec![0x0a, 2, 0x08, 1],
            vec![0xff],
            vec![0x0a, 0, 0x12, 0],
            vec![0x0a, 0, 0x0a, 0],
        ] {
            assert!(!read_shutdown(&mut frame(&invalid).as_slice()).unwrap());
        }
        let mut mixed = frame(&[0x12, 0]);
        mixed.extend(frame(&payload));
        assert!(read_shutdown(&mut mixed.as_slice()).unwrap());
    }

    #[test]
    fn desktop_control_eof_truncation_and_oversize_never_shutdown() {
        assert!(!read_shutdown(&mut [].as_slice()).unwrap());
        for invalid in [
            vec![0],
            vec![0, 0, 0, 2, 0x0a],
            0u32.to_be_bytes().to_vec(),
            4097u32.to_be_bytes().to_vec(),
        ] {
            assert!(read_shutdown(&mut invalid.as_slice()).is_err());
        }
    }
}
