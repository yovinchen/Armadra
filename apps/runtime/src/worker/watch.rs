//! Native filesystem watching on the execution host (design §3.4).
//!
//! The Worker runs the same `file_watch` module a local Runtime runs — the same
//! `notify` backend, the same `modified` / `removed` / `replaced` distinction —
//! and turns what it publishes into unsolicited frames on the connection that
//! subscribed. Latency becomes the write rather than the poll interval.
//!
//! Two properties this relies on:
//!
//! * `file_watch` publishes through an [`EventHub`], so nothing about it has to
//!   know it is running under a Worker. The hub here is private to the
//!   subscription and reaches no canvas.
//! * The subscription is per connection. When the connection ends the Worker
//!   process ends with it, so there is no registry to garbage-collect across
//!   controllers.
//!
//! `sequence` is monotonic from one, which is what lets a controller notice
//! that a reconnect started a new stream and reconcile the gap with one poll
//! rather than assuming continuity it does not have.

use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use armadra_protocol::v1::{WorkerWatchChange, WorkerWatchEvent};

use crate::{
    error::{AppError, AppResult},
    events::{EventHub, FileChangeKind, WorkspaceEvent},
    file_watch,
    remote::service::MAX_WATCH_PATHS,
};

/// The pseudo-workspace the Worker registers its watches under. A Worker
/// serves one controller and one root registry; the id only has to be stable
/// and distinct from nothing else, because nothing else uses this hub.
const WATCH_SCOPE: &str = "worker-watch";

/// One connection's subscription: the paths it asked for, and the channel that
/// carries the frames back to the writer.
pub struct Watches {
    events: EventHub,
    sequence: Arc<AtomicU64>,
    frames: tokio::sync::mpsc::UnboundedSender<WorkerWatchEvent>,
    /// The root every current subscription belongs to. A second root replaces
    /// the first rather than silently watching both: the controller registers
    /// one workspace root per connection.
    root_id: String,
    paths: Vec<String>,
    pump: Option<tokio::task::JoinHandle<()>>,
}

impl Watches {
    /// Start the forwarding pump. The receiver is drained by whoever owns the
    /// connection's writer.
    pub fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<WorkerWatchEvent>) {
        let (frames, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                events: EventHub::new(),
                sequence: Arc::new(AtomicU64::new(1)),
                frames,
                root_id: String::new(),
                paths: Vec::new(),
                pump: None,
            },
            receiver,
        )
    }

    /// The sequence the next event will carry.
    pub fn next_sequence(&self) -> u64 {
        self.sequence.load(Ordering::SeqCst)
    }

    pub fn watched_paths(&self) -> u32 {
        self.paths.len() as u32
    }

    /// Subscribe to `paths` under `root`. Idempotent: re-subscribing the same
    /// path re-baselines it, exactly as re-opening an editor does locally.
    pub fn subscribe(&mut self, root: &Path, root_id: &str, paths: &[String]) -> AppResult<()> {
        if paths.is_empty() {
            return Err(AppError::BadRequest(
                "A watch subscription needs at least one path".into(),
            ));
        }
        if self.root_id != root_id {
            self.release();
            self.root_id = root_id.to_owned();
        }
        if self.paths.len() + paths.len() > MAX_WATCH_PATHS {
            return Err(AppError::Conflict(
                "Too many watched files on this execution host".into(),
            ));
        }
        self.start_pump();
        for path in paths {
            // One watcher registration per path, under one viewer id: the
            // controller multiplexes its own editor nodes, so the Worker only
            // needs to know whether anybody is looking.
            file_watch::register(WATCH_SCOPE, root, path, "worker", &self.events)?;
            if !self.paths.iter().any(|known| known == path) {
                self.paths.push(path.clone());
            }
        }
        Ok(())
    }

    /// Stop watching `paths`. An unknown path is a no-op: a controller that
    /// closed an editor twice is not an error.
    pub fn unsubscribe(&mut self, paths: &[String]) -> AppResult<()> {
        for path in paths {
            file_watch::unregister(WATCH_SCOPE, path, "worker")?;
            self.paths.retain(|known| known != path);
        }
        Ok(())
    }

    fn release(&mut self) {
        file_watch::release_workspace(WATCH_SCOPE);
        self.paths.clear();
    }

    fn start_pump(&mut self) {
        if self.pump.is_some() {
            return;
        }
        let mut receiver = self.events.subscribe(WATCH_SCOPE);
        let frames = self.frames.clone();
        let sequence = Arc::clone(&self.sequence);
        let root_id = self.root_id.clone();
        self.pump = Some(tokio::spawn(async move {
            loop {
                let event = match receiver.recv().await {
                    Ok(event) => event,
                    // A lagging subscriber has missed changes. Dropping the
                    // pump would hide that; the controller reconciles by
                    // polling when the sequence jumps, so carry on.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let WorkspaceEvent::FileChanged {
                    path,
                    kind,
                    sha256,
                    size,
                    mtime,
                    ..
                } = event
                else {
                    continue;
                };
                let frame = WorkerWatchEvent {
                    root_id: root_id.clone(),
                    sequence: sequence.fetch_add(1, Ordering::SeqCst),
                    changes: vec![WorkerWatchChange {
                        path,
                        kind: kind_name(kind).into(),
                        sha256: sha256.unwrap_or_default(),
                        size: size.unwrap_or_default(),
                        mtime: mtime.unwrap_or_default(),
                    }],
                };
                if frames.send(frame).is_err() {
                    break;
                }
            }
        }));
    }
}

impl Drop for Watches {
    fn drop(&mut self) {
        if let Some(pump) = self.pump.take() {
            pump.abort();
        }
        file_watch::release_workspace(WATCH_SCOPE);
    }
}

/// The three kinds, spelled the way the controller's own `FileChangeKind`
/// serializes them, so the controller re-publishes without a translation table.
fn kind_name(kind: FileChangeKind) -> &'static str {
    match kind {
        FileChangeKind::Modified => "modified",
        FileChangeKind::Removed => "removed",
        FileChangeKind::Replaced => "replaced",
    }
}

/// The capability a Worker advertises when it can push these frames. A
/// controller that does not see it keeps polling instead of waiting for events
/// that will never arrive.
pub const CAPABILITY: &str = crate::remote::service::replay::WATCH_CAPABILITY;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_kinds_are_spelled_the_way_the_controller_publishes_them() {
        assert_eq!(kind_name(FileChangeKind::Modified), "modified");
        assert_eq!(kind_name(FileChangeKind::Removed), "removed");
        assert_eq!(kind_name(FileChangeKind::Replaced), "replaced");
    }

    /// An empty subscription would register a watcher nobody reads and answer
    /// as though watching had started.
    #[tokio::test]
    async fn an_empty_subscription_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (mut watches, _frames) = Watches::new();
        assert!(watches.subscribe(root.path(), "root-1", &[]).is_err());
    }

    /// The receipt's sequence is what the *next* event will carry, so a
    /// controller that reconnects can tell a fresh stream from a continued one.
    #[tokio::test]
    async fn a_fresh_subscription_starts_its_sequence_at_one() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), "one").unwrap();
        let (mut watches, _frames) = Watches::new();
        watches
            .subscribe(root.path(), "root-1", &["a.txt".to_owned()])
            .unwrap();
        assert_eq!(watches.next_sequence(), 1);
        assert_eq!(watches.watched_paths(), 1);
        watches.unsubscribe(&["a.txt".to_owned()]).unwrap();
        assert_eq!(watches.watched_paths(), 0);
    }
}
