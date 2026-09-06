//! External-change watching for editor files on an execution host (H02,
//! completed in design §3.4).
//!
//! There are two ways a change can reach the controller, and the registration
//! answer says which one this workspace got:
//!
//! * **Events.** The Worker runs the same `notify` watcher a local Runtime
//!   runs and pushes unsolicited frames back down the existing stdio
//!   connection ([`events`]). Latency is the write.
//! * **Poll.** A Worker that does not advertise `remote.watch.v1` is asked for
//!   every open path every two seconds ([`poll`]). Latency is the interval,
//!   and the client is told so rather than left to assume otherwise.
//!
//! Two honest limits hold in both modes:
//!
//! * A replace in place reports `modified` when it comes from a poll. The
//!   device/inode pair the local watcher uses to tell them apart is a local
//!   detail that is deliberately not serialized, and inventing one from remote
//!   metadata would be a guess. Events carry the Worker's own classification,
//!   which does have that pair.
//! * A reconnect starts a new event stream. The controller re-subscribes and
//!   runs one poll to reconcile, so a change made while the connection was
//!   down is reported once rather than missed.

pub mod events;
pub mod poll;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex},
};

use armadra_protocol::v1::WorkerServiceOperation;

use crate::{
    error::{AppError, AppResult},
    events::{EventHub, FileChangeKind, WorkspaceEvent},
    file_watch::{FileVersion, WatchMode, WatchRegistration, WatchStatus},
    remote::{
        client::RemoteWorker,
        service::{MAX_WATCH_PATHS, PathPayload, replay::WATCH_CAPABILITY},
    },
};

pub(super) struct Watched {
    pub viewers: HashSet<String>,
    pub known: FileVersion,
}

pub(super) struct WorkspaceWatch {
    pub root_path: String,
    pub files: HashMap<String, Watched>,
    /// Set while a poll task or an event pump is running for this workspace.
    pub running: bool,
    pub mode: WatchMode,
}

#[derive(Default)]
pub(super) struct Registry {
    pub workspaces: HashMap<String, WorkspaceWatch>,
}

static WATCHES: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

pub(super) fn registry() -> AppResult<std::sync::MutexGuard<'static, Registry>> {
    WATCHES
        .lock()
        .map_err(|_| AppError::Internal("Remote watch registry unavailable".into()))
}

/// Read one path's version on the execution host.
pub async fn version(
    worker: &RemoteWorker,
    workspace_id: &str,
    root_path: &str,
    path: &str,
) -> AppResult<FileVersion> {
    let (status, body) = worker
        .service(
            workspace_id,
            root_path,
            WorkerServiceOperation::FileVersion,
            serde_json::to_vec(&PathPayload {
                path: path.to_owned(),
            })
            .map_err(|_| AppError::Internal("Request could not be encoded".into()))?,
            false,
            false,
        )
        .await?;
    crate::remote::decode(status, &body)
}

/// Register one editor node's view of a remote file. Idempotent per viewer,
/// and the answer carries the version on the execution host right now.
pub async fn register(
    worker: Arc<RemoteWorker>,
    events: EventHub,
    workspace_id: &str,
    root_path: &str,
    path: &str,
    node_id: &str,
) -> AppResult<WatchRegistration> {
    if node_id.is_empty() || node_id.len() > 128 {
        return Err(AppError::BadRequest("A node id is required".into()));
    }
    let current = version(&worker, workspace_id, root_path, path).await?;
    let relative = current.path.clone();
    // Asked before the registry is touched: a Worker that cannot push events
    // must leave this workspace polling, and finding that out afterwards would
    // mean a window with no watcher at all.
    let mode = if worker.advertises(WATCH_CAPABILITY).await {
        WatchMode::Events
    } else {
        WatchMode::Poll
    };
    let start = {
        let mut registry = registry()?;
        let entry = registry
            .workspaces
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceWatch {
                root_path: root_path.to_owned(),
                files: HashMap::new(),
                running: false,
                mode,
            });
        if entry.root_path != root_path {
            entry.root_path = root_path.to_owned();
            entry.files.clear();
        }
        entry.mode = mode;
        if entry.files.len() >= MAX_WATCH_PATHS && !entry.files.contains_key(&relative) {
            return Err(AppError::Conflict(
                "Too many watched files on this execution host".into(),
            ));
        }
        let file = entry
            .files
            .entry(relative.clone())
            .or_insert_with(|| Watched {
                viewers: HashSet::new(),
                known: current.clone(),
            });
        file.viewers.insert(node_id.to_owned());
        // A re-open re-baselines: what is on the host now is what the node shows.
        file.known = current.clone();
        let start = !entry.running;
        entry.running = true;
        start
    };
    if mode == WatchMode::Events {
        // Subscribing every time is what makes a newly opened file join an
        // existing subscription; the Worker treats a repeat as a re-baseline.
        worker
            .watch(
                workspace_id,
                root_path,
                WorkerServiceOperation::WatchSubscribe,
                vec![relative.clone()],
            )
            .await?;
    }
    if start {
        match mode {
            WatchMode::Events => events::spawn(worker, events, workspace_id.to_owned()),
            WatchMode::Poll => poll::spawn(worker, events, workspace_id.to_owned()),
        }
    }
    Ok(WatchRegistration {
        status: WatchStatus::Watching,
        reason: (mode == WatchMode::Poll).then(|| {
            "This execution host predates filesystem events, so its files are polled every two \
             seconds"
                .to_owned()
        }),
        mode,
        version: current,
    })
}

/// Drop one viewer; the workspace stops being watched with its last file.
pub fn unregister(workspace_id: &str, path: &str, node_id: &str) -> AppResult<()> {
    let mut registry = registry()?;
    let Some(entry) = registry.workspaces.get_mut(workspace_id) else {
        return Ok(());
    };
    let relative = crate::security::workspace_relative_path(path)?;
    if let Some(file) = entry.files.get_mut(&relative) {
        file.viewers.remove(node_id);
        if file.viewers.is_empty() {
            entry.files.remove(&relative);
        }
    }
    if entry.files.is_empty() {
        registry.workspaces.remove(workspace_id);
    }
    Ok(())
}

/// Stop watching a whole workspace: read access revoked, it went away, or it
/// moved to a different execution host.
pub fn release_workspace(workspace_id: &str) {
    if let Ok(mut registry) = registry() {
        registry.workspaces.remove(workspace_id);
    }
}

/// Which remote files a workspace currently has open, for the execution-host
/// switch (design §3.3).
pub fn watched_paths(workspace_id: &str) -> Vec<String> {
    let Ok(registry) = registry() else {
        return Vec::new();
    };
    let Some(entry) = registry.workspaces.get(workspace_id) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = entry.files.keys().cloned().collect();
    paths.sort();
    paths
}

/// Compare a set of versions against what each node last saw, updating the
/// baseline. Shared by the poll and by the reconciliation an event stream runs
/// after a reconnect.
pub(super) fn difference(workspace_id: &str, versions: Vec<FileVersion>) -> Vec<WorkspaceEvent> {
    let Ok(mut registry) = registry() else {
        return Vec::new();
    };
    let Some(entry) = registry.workspaces.get_mut(workspace_id) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    for current in versions {
        let Some(file) = entry.files.get_mut(&current.path) else {
            continue;
        };
        if current.exists == file.known.exists && current.sha256 == file.known.sha256 {
            file.known = current;
            continue;
        }
        let kind = if !current.exists {
            FileChangeKind::Removed
        } else if !file.known.exists {
            FileChangeKind::Replaced
        } else {
            FileChangeKind::Modified
        };
        changes.push(WorkspaceEvent::FileChanged {
            workspace_id: workspace_id.to_owned(),
            path: current.path.clone(),
            kind,
            sha256: current.sha256.clone(),
            size: current.size,
            mtime: current.mtime.clone(),
        });
        file.known = current;
    }
    changes
}

/// Publish one change, invalidating the repository scan when a `.git` entry
/// moved — the same rule the local watcher follows.
pub(super) fn publish(events: &EventHub, workspace_id: &str, change: WorkspaceEvent) {
    if let WorkspaceEvent::FileChanged { path, .. } = &change
        && crate::git_discovery::affects_repositories(path)
    {
        crate::git_discovery::invalidate(workspace_id);
    }
    events.publish(workspace_id, change);
}

#[cfg(test)]
mod tests;
