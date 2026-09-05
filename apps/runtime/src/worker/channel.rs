//! The resident bidirectional Worker channel (Go Host business migration §2.9,
//! §2.10).
//!
//! Phase one spoke only when spoken to: read one `WorkerRequest`, write one
//! `WorkerResponse`, repeat. This module keeps that exchange exactly as it was
//! and adds a second, independent flow in the other direction on the same
//! connection, so a Hook turn or an approval can reach the Host without waiting
//! for the Host to ask.
//!
//! # Telling the two flows apart
//!
//! Both directions share one four-byte prefix, but it is now read as a
//! **kind byte followed by a 24-bit length** rather than a 32-bit length. The
//! one-MiB ceiling fits in 24 bits, so every frame the first phase ever wrote
//! already has a zero kind byte and its bytes are unchanged. The alternative —
//! guessing the message from its field numbers — would have made a decode
//! ambiguity into a security question, and a peer that predates this file would
//! have silently misread an upcall instead of refusing it as an oversized
//! length.
//!
//! # Why nothing blocks anything
//!
//! One reader task owns the input and does no work of its own: it classifies a
//! frame and hands it to the right place. One writer task owns the output, so
//! a response and an upcall can never interleave their bytes. Requests are
//! handled one at a time (unchanged from phase one — the Worker's state machine
//! is not reentrant), but an upcall never waits behind a request and a request
//! never waits behind an upcall.
//!
//! # Why the outbox is on the write path
//!
//! [`Upcaller::send`] commits to the durable outbox before it returns, and
//! returns *before* the frame reaches the Host. A producer therefore learns
//! that its report is safe, not that it was delivered — delivery is the
//! channel's job across as many reconnects as it takes. See [`super::outbox`].

use std::sync::Arc;

use armadra_protocol::{Message, v1::*};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, mpsc},
};

use super::outbox::{Outbox, Queued};

/// A phase-one request or response. Its bytes are unchanged from phase one.
pub const KIND_CALL: u8 = 0;
/// Worker → Host: a `WorkerUpcall`.
pub const KIND_UPCALL: u8 = 1;
/// Host → Worker: a `WorkerUpcallReply`.
pub const KIND_UPCALL_REPLY: u8 = 2;

/// The capability a controller checks before it expects anything upward.
pub const CAPABILITY: &str = "worker.upcall.v1";

/// Worker→Host request ids carry this prefix and Host→Worker ids carry `h-`, so
/// the two pending tables on one connection cannot collide (§2.9, 方向区分).
pub const UPCALL_REQUEST_PREFIX: &str = "w-";

/// How many already-committed frames may wait for the writer before a producer
/// is made to wait. The durable outbox is the real bound; this only smooths a
/// burst.
const SEND_BUFFER: usize = 64;

/// Encodes the four-byte prefix. The length is checked against the frame
/// ceiling by the caller.
fn prefix(kind: u8, length: usize) -> [u8; 4] {
    let length = length as u32;
    [
        kind,
        (length >> 16) as u8,
        (length >> 8) as u8,
        length as u8,
    ]
}

/// Splits a four-byte prefix into its kind and length.
///
/// A first-phase peer writes a plain 32-bit length, which for any legal frame
/// has a zero high byte — so it decodes here as `KIND_CALL` with the same
/// length, and an illegally large one is refused by the ceiling check rather
/// than read as some other kind.
pub fn split(prefix: [u8; 4]) -> (u8, usize) {
    let length =
        (usize::from(prefix[1]) << 16) | (usize::from(prefix[2]) << 8) | usize::from(prefix[3]);
    (prefix[0], length)
}

/// One outgoing frame, already encoded.
struct Outgoing {
    kind: u8,
    bytes: Vec<u8>,
}

/// The producer-facing handle. Cloneable and cheap: a domain that wants to
/// report something holds one of these and knows nothing about the transport.
#[derive(Clone)]
pub struct Upcaller {
    outbox: Arc<Outbox>,
    outgoing: mpsc::Sender<Outgoing>,
}

impl Upcaller {
    /// Commits one upcall and hands it to the writer.
    ///
    /// Returns the assigned sequence once the frame is durable. A closed
    /// channel is not an error the producer has to handle: the frame stays in
    /// the outbox and is replayed on the next connection.
    pub async fn send(&self, event: worker_upcall::Event) -> anyhow::Result<u64> {
        let queued = self
            .outbox
            .queue(WorkerUpcall {
                request_id: format!("{UPCALL_REQUEST_PREFIX}{}", uuid::Uuid::new_v4().simple()),
                event: Some(event),
                ..Default::default()
            })
            .await?;
        let sequence = queued.sequence;
        // `try_send` on a full buffer would drop a frame the producer believes
        // is on its way; a blocking send applies back pressure instead, and the
        // frame is durable either way.
        if self
            .outgoing
            .send(Outgoing {
                kind: KIND_UPCALL,
                bytes: queued.frame.encode_to_vec(),
            })
            .await
            .is_err()
        {
            tracing::debug!(
                sequence,
                "no controller is attached; the upcall waits in the outbox"
            );
        }
        Ok(sequence)
    }

    /// What the handshake reports about this channel.
    pub async fn capability(
        &self,
        socket: Option<String>,
        pipe: Option<String>,
    ) -> WorkerChannelCapability {
        let unacknowledged = self.outbox.unacknowledged().await.unwrap_or(0);
        WorkerChannelCapability {
            worker_instance_id: self.outbox.instance_id().to_owned(),
            socket: socket.unwrap_or_default(),
            pipe: pipe.unwrap_or_default(),
            highest_sequence: self.outbox.highest_sequence().await.unwrap_or(0),
            unacknowledged,
            max_unacknowledged: super::outbox::MAX_UNACKNOWLEDGED,
            state: if unacknowledged > 0 {
                WorkerChannelState::Replaying as i32
            } else {
                WorkerChannelState::Ready as i32
            },
            reason_code: String::new(),
        }
    }
}

/// A channel that has an outbox and can therefore speak upward.
pub struct Channel {
    outbox: Arc<Outbox>,
    outgoing: mpsc::Sender<Outgoing>,
    incoming: Mutex<mpsc::Receiver<Outgoing>>,
}

impl Channel {
    pub fn new(outbox: Outbox) -> Self {
        let (outgoing, incoming) = mpsc::channel(SEND_BUFFER);
        Self {
            outbox: Arc::new(outbox),
            outgoing,
            incoming: Mutex::new(incoming),
        }
    }

    pub fn upcaller(&self) -> Upcaller {
        Upcaller {
            outbox: Arc::clone(&self.outbox),
            outgoing: self.outgoing.clone(),
        }
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    /// Everything unacknowledged, oldest first, encoded for a newly attached
    /// controller.
    ///
    /// These frames are handed straight to the writer rather than pushed
    /// through the send buffer: the outbox may hold far more than the buffer
    /// does, and a replay that filled the buffer would deadlock against the
    /// writer that is supposed to drain it.
    async fn replay(&self) -> anyhow::Result<Vec<Outgoing>> {
        let pending: Vec<Queued> = self.outbox.replay().await?;
        Ok(pending
            .into_iter()
            .map(|queued| Outgoing {
                kind: KIND_UPCALL,
                bytes: queued.frame.encode_to_vec(),
            })
            .collect())
    }

    /// Applies one reply from the controller.
    async fn acknowledge(&self, reply: &WorkerUpcallReply) {
        if reply.worker_instance_id.is_empty() {
            return;
        }
        let result = match WorkerUpcallDisposition::try_from(reply.disposition) {
            // An unrecognized disposition retires nothing. A controller this
            // build does not understand must not be able to make the Worker
            // forget a report by inventing a value.
            Ok(WorkerUpcallDisposition::Accepted | WorkerUpcallDisposition::Duplicate) => self
                .outbox
                .acknowledge(&reply.worker_instance_id, reply.ack_sequence)
                .await
                .map(|count| count as i64),
            Ok(WorkerUpcallDisposition::Rejected) => self
                .outbox
                .discard(&reply.worker_instance_id, reply.ack_sequence)
                .await
                .map(i64::from),
            _ => {
                tracing::warn!(
                    disposition = reply.disposition,
                    "ignoring an upcall reply this build cannot read"
                );
                return;
            }
        };
        if let Err(error) = result {
            tracing::warn!(%error, "an upcall acknowledgement could not be applied");
        }
    }
}

/// Runs one connection to completion.
///
/// `worker` answers requests exactly as phase one did. `channel`, when present,
/// adds the upward flow; the first connection to attach owns it, and a second
/// one is served requests without ever seeing an upcall — two controllers each
/// holding half of one durable stream, neither able to acknowledge the other's
/// frames, is worse than one controller and one waiting bearer.
///
/// Reading runs in its own task so end of input is noticed while a request is
/// still being handled: a controller that died must not leave this Worker
/// finishing journal work on its behalf.
pub async fn serve<R, W>(
    mut input: R,
    output: W,
    worker: Arc<Mutex<super::Worker>>,
    channel: Option<Arc<Channel>>,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (responses, mut pending) = mpsc::channel::<Outgoing>(SEND_BUFFER);
    let writer_channel = channel.clone();
    let writer = tokio::spawn(async move {
        let mut output = output;
        // `try_lock`, not `lock`: a second connection must keep answering
        // requests instead of blocking behind the owner of the upward flow.
        let mut upward = writer_channel
            .as_ref()
            .and_then(|channel| channel.incoming.try_lock().ok());
        if let (Some(channel), Some(upward)) = (writer_channel.as_ref(), upward.as_mut()) {
            // Frames buffered for a controller that is gone are still in the
            // outbox, so the replay — not this buffer — is the single source of
            // order for a new connection.
            while upward.try_recv().is_ok() {}
            match channel.replay().await {
                Ok(frames) => {
                    if !frames.is_empty() {
                        tracing::info!(count = frames.len(), "replaying unacknowledged upcalls");
                    }
                    for frame in frames {
                        output
                            .write_all(&prefix(frame.kind, frame.bytes.len()))
                            .await?;
                        output.write_all(&frame.bytes).await?;
                    }
                    output.flush().await?;
                }
                // A replay that cannot be read must not stop the Worker from
                // answering requests: the Host loses reports, which it can see,
                // and keeps execution, which it needs.
                Err(error) => {
                    tracing::error!(%error, "the upcall outbox could not be replayed")
                }
            }
        }
        loop {
            let frame = match upward.as_mut() {
                Some(upward) => tokio::select! {
                    frame = pending.recv() => frame,
                    frame = upward.recv() => frame,
                },
                None => pending.recv().await,
            };
            let Some(frame) = frame else {
                return Ok::<(), anyhow::Error>(());
            };
            anyhow::ensure!(
                !frame.bytes.is_empty() && frame.bytes.len() <= super::MAX_FRAME,
                "Worker frame exceeds the channel limit"
            );
            output
                .write_all(&prefix(frame.kind, frame.bytes.len()))
                .await?;
            output.write_all(&frame.bytes).await?;
            output.flush().await?;
        }
    });
    let (frames, mut incoming) = mpsc::channel::<(u8, Vec<u8>)>(1);
    let (closed, mut close_rx) = tokio::sync::watch::channel(false);
    let reader = tokio::spawn(async move {
        let result: anyhow::Result<()> = async {
            loop {
                let mut header = [0u8; 4];
                if input.read(&mut header[..1]).await? == 0 {
                    return Ok(());
                }
                input.read_exact(&mut header[1..]).await?;
                let (kind, length) = split(header);
                anyhow::ensure!(
                    length > 0 && length <= super::MAX_FRAME,
                    "Invalid Worker frame length"
                );
                let mut bytes = vec![0; length];
                input.read_exact(&mut bytes).await?;
                if frames.send((kind, bytes)).await.is_err() {
                    return Ok(());
                }
            }
        }
        .await;
        let _ = closed.send(true);
        result
    });
    let result: anyhow::Result<()> = async {
        loop {
            let (kind, bytes) = tokio::select! {
                _ = close_rx.changed() => break,
                frame = incoming.recv() => match frame {
                    Some(frame) => frame,
                    None => break,
                },
            };
            match kind {
                KIND_CALL => {
                    let request = WorkerRequest::decode(bytes.as_slice())?;
                    // A frame that does not re-encode to its own bytes was
                    // produced by something other than this contract, and its
                    // request identity would be ambiguous.
                    anyhow::ensure!(
                        request.encode_to_vec() == bytes,
                        "Noncanonical Worker request frame"
                    );
                    let response = tokio::select! {
                        _ = close_rx.changed() => break,
                        response = async { worker.lock().await.handle(request).await } => response,
                    };
                    if responses
                        .send(Outgoing {
                            kind: KIND_CALL,
                            bytes: response.encode_to_vec(),
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                KIND_UPCALL_REPLY => {
                    let reply = WorkerUpcallReply::decode(bytes.as_slice())?;
                    match channel.as_ref() {
                        Some(channel) => channel.acknowledge(&reply).await,
                        // A reply on a channel that never sent anything is a
                        // controller mistake, not a reason to drop execution.
                        None => {
                            tracing::warn!("ignoring an upcall reply on a channel with no outbox")
                        }
                    }
                }
                // An unknown kind is refused rather than skipped: a frame this
                // build cannot classify may be one it must not ignore.
                other => anyhow::bail!("unknown Worker frame kind {other}"),
            }
        }
        Ok(())
    }
    .await;
    reader.abort();
    let _ = reader.await;
    drop(responses);
    let _ = writer.await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phase_one_length_prefix_still_reads_as_a_call() {
        // Exactly the bytes the first phase wrote: a 32-bit big-endian length.
        for length in [1usize, 1024, super::super::MAX_FRAME] {
            let legacy = (length as u32).to_be_bytes();
            assert_eq!(split(legacy), (KIND_CALL, length));
            assert_eq!(prefix(KIND_CALL, length), legacy);
        }
    }

    #[test]
    fn every_kind_round_trips_through_the_prefix() {
        for kind in [KIND_CALL, KIND_UPCALL, KIND_UPCALL_REPLY, 200] {
            for length in [1usize, 0xff_ff_ff] {
                assert_eq!(split(prefix(kind, length)), (kind, length));
            }
        }
    }

    /// A first-phase reader sees an upcall prefix as a length above the ceiling
    /// and refuses the frame. That is the point: it must not decode it as
    /// something else.
    #[test]
    fn an_upcall_prefix_is_an_illegal_length_to_a_phase_one_reader() {
        let header = prefix(KIND_UPCALL, 16);
        assert!(u32::from_be_bytes(header) as usize > super::super::MAX_FRAME);
    }
}
