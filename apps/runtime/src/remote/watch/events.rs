//! Filesystem events pushed from an execution host (design §3.4).
//!
//! The Worker sends a `WorkerWatchEvent` frame with no `request_id` whenever
//! the files it was asked to watch change; the connection's read task publishes
//! those on a broadcast channel, and this pump turns them into the same
//! `file.changed` the local watcher emits.
//!
//! The interesting part is the gap. `sequence` is monotonic **per connection**,
//! so a reconnect restarts it, and anything that happened while the connection
//! was down was never sent at all. Rather than pretend the stream is
//! continuous, this pump treats a sequence that does not follow the last one as
//! "re-subscribe and reconcile": the open paths are re-registered on the new
//! session and one poll compares them against what each node last saw. A change
//! made during the outage is then reported exactly once, from the poll, and a
//! change that was not missed compares equal and produces nothing.

use std::sync::Arc;

use armadra_protocol::v1::{WorkerServiceOperation, WorkerWatchEvent};
use tokio::sync::broadcast::error::RecvError;

use crate::{
    events::{EventHub, FileChangeKind, WorkspaceEvent},
    remote::{
        client::RemoteWorker,
        watch::{difference, poll, publish, registry},
    },
};

pub fn spawn(worker: Arc<RemoteWorker>, events: EventHub, workspace_id: String) {
    tokio::spawn(async move {
        let mut frames = worker.events();
        // The first frame of a session is sequence 1; anything else means this
        // pump started mid-stream and has to reconcile before trusting it.
        let mut expected: Option<u64> = None;
        loop {
            let frame = match frames.recv().await {
                Ok(frame) => frame,
                // Falling behind is a gap like any other: reconcile rather than
                // guess which changes were dropped.
                Err(RecvError::Lagged(_)) => {
                    expected = None;
                    reconcile(&worker, &events, &workspace_id).await;
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            if registry()
                .ok()
                .and_then(|registry| {
                    registry
                        .workspaces
                        .get(&workspace_id)
                        .map(|entry| entry.files.is_empty())
                })
                .unwrap_or(true)
            {
                break;
            }
            if expected.is_some_and(|next| frame.sequence != next) || expected.is_none() {
                // Either a fresh connection or a hole. Both are answered the
                // same way, and the frame in hand is still applied afterwards
                // because the poll may have run before the write landed.
                reconcile(&worker, &events, &workspace_id).await;
            }
            expected = Some(frame.sequence + 1);
            for change in translate(&workspace_id, frame) {
                publish(&events, &workspace_id, change);
            }
        }
        if let Ok(mut registry) = registry()
            && let Some(entry) = registry.workspaces.get_mut(&workspace_id)
        {
            entry.running = false;
        }
    });
}

/// Re-subscribe on whatever connection is live now, then compare every open
/// path against its baseline.
async fn reconcile(worker: &RemoteWorker, events: &EventHub, workspace_id: &str) {
    let Some((root_path, paths)) = poll::open_files(workspace_id) else {
        return;
    };
    // A subscription belongs to a connection, so after a reconnect the Worker
    // is watching nothing until it is told again.
    let _ = worker
        .watch(
            workspace_id,
            &root_path,
            WorkerServiceOperation::WatchSubscribe,
            paths.clone(),
        )
        .await;
    let Ok(versions) = poll::poll(worker, workspace_id, &root_path, paths).await else {
        return;
    };
    for change in difference(workspace_id, versions) {
        publish(events, workspace_id, change);
    }
}

/// The pure half of the pump, reachable from the module's tests. The pump
/// itself needs a live connection; this does not, and it is where the
/// baseline rules that matter actually live.
#[cfg(test)]
pub(super) fn translate_for_tests(
    workspace_id: &str,
    frame: WorkerWatchEvent,
) -> Vec<WorkspaceEvent> {
    translate(workspace_id, frame)
}

/// Turn one frame into workspace events, dropping paths nothing watches any
/// more and updating each file's baseline so a later poll does not report the
/// same change twice.
fn translate(workspace_id: &str, frame: WorkerWatchEvent) -> Vec<WorkspaceEvent> {
    let Ok(mut registry) = registry() else {
        return Vec::new();
    };
    let Some(entry) = registry.workspaces.get_mut(workspace_id) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    for change in frame.changes {
        let Some(file) = entry.files.get_mut(&change.path) else {
            continue;
        };
        let kind = match change.kind.as_str() {
            "removed" => FileChangeKind::Removed,
            "replaced" => FileChangeKind::Replaced,
            _ => FileChangeKind::Modified,
        };
        let sha256 = (!change.sha256.is_empty()).then(|| change.sha256.clone());
        // Our own save is not an external change. The Worker cannot know which
        // writes came from this controller, so the baseline comparison stays
        // here — exactly as it does for the poll.
        if kind != FileChangeKind::Removed && sha256.is_some() && sha256 == file.known.sha256 {
            continue;
        }
        file.known.exists = kind != FileChangeKind::Removed;
        file.known.sha256 = sha256.clone();
        file.known.size = (change.size > 0).then_some(change.size);
        file.known.mtime = (!change.mtime.is_empty()).then(|| change.mtime.clone());
        changes.push(WorkspaceEvent::FileChanged {
            workspace_id: workspace_id.to_owned(),
            path: change.path,
            kind,
            sha256,
            size: (change.size > 0).then_some(change.size),
            mtime: (!change.mtime.is_empty()).then_some(change.mtime),
        });
    }
    changes
}
