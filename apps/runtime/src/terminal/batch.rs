//! Output batching: how many bytes and how much time a session's output is
//! allowed to accumulate before it goes out to the attached sockets.

use super::*;

/// The batching rule on its own, with no threads and no clock of its own, so
/// the interesting part is unit-testable.
#[derive(Debug)]
pub struct OutputBatch {
    buffer: Vec<u8>,
    /// When the first still-unsent byte arrived.
    started: Option<Instant>,
    /// How long a batch may wait before it has to go out. Not a constant: a
    /// session with no attached client widens it (see [`DORMANT_FLUSH_INTERVAL`]).
    flush_interval: Duration,
}

impl Default for OutputBatch {
    fn default() -> Self {
        Self {
            buffer: Vec::new(),
            started: None,
            flush_interval: OUTPUT_FLUSH_INTERVAL,
        }
    }
}

impl OutputBatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Widens or narrows the deadline. A batch already in flight keeps its
    /// start time, so narrowing takes effect immediately rather than at the
    /// next batch.
    pub fn set_flush_interval(&mut self, interval: Duration) {
        self.flush_interval = interval;
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Appends, and hands back a batch as soon as the byte budget is reached.
    pub fn push(&mut self, chunk: &[u8]) -> Option<Bytes> {
        if self.buffer.is_empty() {
            self.started = Some(Instant::now());
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() >= OUTPUT_FLUSH_BYTES {
            self.take()
        } else {
            None
        }
    }

    /// Everything buffered so far; `None` when there is nothing to send.
    pub fn take(&mut self) -> Option<Bytes> {
        self.started = None;
        if self.buffer.is_empty() {
            return None;
        }
        Some(Bytes::from(std::mem::take(&mut self.buffer)))
    }

    /// How long the caller may still block waiting for more input before this
    /// batch has to go out. `None` when nothing is buffered — then it may
    /// block forever.
    pub fn remaining(&self) -> Option<Duration> {
        let started = self.started?;
        Some(self.flush_interval.saturating_sub(started.elapsed()))
    }
}

/// The flush cadence of one session, in milliseconds, shared with whoever may
/// change it. [`TerminalManager`] widens it when the last client detaches and
/// narrows it again on the next attach.
pub type FlushCadence = Arc<std::sync::atomic::AtomicU64>;

/// A cadence handle starting at the interactive interval.
pub fn interactive_cadence() -> FlushCadence {
    Arc::new(std::sync::atomic::AtomicU64::new(
        OUTPUT_FLUSH_INTERVAL.as_millis() as u64,
    ))
}

/// Runs [`OutputBatch`] on its own thread. Returns the sender the PTY reader
/// pushes raw chunks into; `sink` receives the coalesced batches, and `on_eof`
/// runs once, **after** the final flush, so the last output always precedes the
/// exit status.
///
/// `cadence` is read once per turn rather than captured, so making a session
/// dormant changes the deadline of the batch already in flight instead of
/// waiting for the next one.
pub fn spawn_output_batcher(
    name: &str,
    cadence: FlushCadence,
    sink: impl Fn(Bytes) + Send + 'static,
    on_eof: impl FnOnce() + Send + 'static,
) -> std::sync::mpsc::Sender<Bytes> {
    use std::sync::mpsc::RecvTimeoutError;

    let (sender, receiver) = std::sync::mpsc::channel::<Bytes>();
    let _ = std::thread::Builder::new()
        .name(format!("pty-batch-{name}"))
        .spawn(move || {
            let mut batch = OutputBatch::new();
            loop {
                batch.set_flush_interval(Duration::from_millis(
                    cadence.load(Ordering::Relaxed).max(1),
                ));
                let received = match batch.remaining() {
                    Some(wait) => receiver.recv_timeout(wait),
                    None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match received {
                    Ok(chunk) => {
                        if let Some(ready) = batch.push(&chunk) {
                            sink(ready);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if let Some(ready) = batch.take() {
                            sink(ready);
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        if let Some(ready) = batch.take() {
                            sink(ready);
                        }
                        break;
                    }
                }
            }
            on_eof();
        });
    sender
}
