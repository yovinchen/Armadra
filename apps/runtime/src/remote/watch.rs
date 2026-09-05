//! External-change watching for editor files on an execution host (H02).
//!
//! There is no filesystem event to subscribe to across an `ssh` pipe, so this
//! is a poll and the code says so rather than pretending otherwise: one
//! `WATCH_POLL` per workspace per tick carries every path that workspace's
//! editor nodes have open, and the difference against the last answer is
//! published as the same [`WorkspaceEvent::FileChanged`] the local watcher
//! emits.
//!
//! Two honest limits, both visible to the client:
//!
//! * Latency is the poll interval, not the write.
//! * A replace in place reports `modified`. The device/inode pair the local
//!   watcher uses to tell them apart is a local detail that is deliberately
//!   not serialized, and inventing one from the remote metadata would be a
//!   guess.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use armadra_protocol::v1::WorkerServiceOperation;

use crate::{
    error::{AppError, AppResult},
    events::{EventHub, FileChangeKind, WorkspaceEvent},
    file_watch::{FileVersion, WatchRegistration, WatchStatus},
    remote::{
        client::RemoteWorker,
        service::{MAX_WATCH_PATHS, WatchPollPayload, WatchPollResult},
    },
};

/// How often a workspace with open remote editors is polled.
const INTERVAL: Duration = Duration::from_secs(2);

struct Watched {
    viewers: HashSet<String>,
    known: FileVersion,
}

struct WorkspaceWatch {
    root_path: String,
    files: HashMap<String, Watched>,
    /// Set while a poll task is running for this workspace.
    polling: bool,
}

#[derive(Default)]
struct Registry {
    workspaces: HashMap<String, WorkspaceWatch>,
}

static WATCHES: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

fn registry() -> AppResult<std::sync::MutexGuard<'static, Registry>> {
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
            serde_json::to_vec(&crate::remote::service::PathPayload {
                path: path.to_owned(),
            })
            .map_err(|_| AppError::Internal("Request could not be encoded".into()))?,
            false,
            false,
        )
        .await?;
    decode(status, &body)
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
    let start = {
        let mut registry = registry()?;
        let entry = registry
            .workspaces
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceWatch {
                root_path: root_path.to_owned(),
                files: HashMap::new(),
                polling: false,
            });
        if entry.root_path != root_path {
            entry.root_path = root_path.to_owned();
            entry.files.clear();
        }
        if entry.files.len() >= MAX_WATCH_PATHS && !entry.files.contains_key(&relative) {
            return Err(AppError::Conflict(
                "Too many watched files on this execution host".into(),
            ));
        }
        let file = entry.files.entry(relative).or_insert_with(|| Watched {
            viewers: HashSet::new(),
            known: current.clone(),
        });
        file.viewers.insert(node_id.to_owned());
        // A re-open re-baselines: what is on the host now is what the node shows.
        file.known = current.clone();
        let start = !entry.polling;
        entry.polling = true;
        start
    };
    if start {
        spawn(worker, events, workspace_id.to_owned());
    }
    Ok(WatchRegistration {
        status: WatchStatus::Watching,
        reason: None,
        version: current,
    })
}

/// Drop one viewer; the workspace stops being polled with its last file.
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

/// Stop polling a whole workspace: read access revoked, or it went away.
pub fn release_workspace(workspace_id: &str) {
    if let Ok(mut registry) = registry() {
        registry.workspaces.remove(workspace_id);
    }
}

fn spawn(worker: Arc<RemoteWorker>, events: EventHub, workspace_id: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            let request = {
                let Ok(registry) = registry() else { break };
                let Some(entry) = registry.workspaces.get(&workspace_id) else {
                    break;
                };
                if entry.files.is_empty() {
                    break;
                }
                (
                    entry.root_path.clone(),
                    entry.files.keys().cloned().collect::<Vec<_>>(),
                )
            };
            let Ok(versions) = poll(&worker, &workspace_id, &request.0, request.1).await else {
                // A host that is down is not a change. The next tick retries,
                // and the connection's own backoff keeps that cheap.
                continue;
            };
            for change in difference(&workspace_id, versions) {
                if let WorkspaceEvent::FileChanged { path, .. } = &change
                    && crate::git_discovery::affects_repositories(path)
                {
                    crate::git_discovery::invalidate(&workspace_id);
                }
                events.publish(&workspace_id, change);
            }
        }
        if let Ok(mut registry) = registry()
            && let Some(entry) = registry.workspaces.get_mut(&workspace_id)
        {
            entry.polling = false;
        }
    });
}

async fn poll(
    worker: &RemoteWorker,
    workspace_id: &str,
    root_path: &str,
    paths: Vec<String>,
) -> AppResult<Vec<FileVersion>> {
    let (status, body) = worker
        .service(
            workspace_id,
            root_path,
            WorkerServiceOperation::WatchPoll,
            serde_json::to_vec(&WatchPollPayload { paths })
                .map_err(|_| AppError::Internal("Request could not be encoded".into()))?,
            false,
            false,
        )
        .await?;
    let result: WatchPollResult = decode(status, &body)?;
    Ok(result.versions)
}

/// Compare the poll against what each node last saw, updating the baseline.
fn difference(workspace_id: &str, versions: Vec<FileVersion>) -> Vec<WorkspaceEvent> {
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

/// A poll answer that is not 200 is the execution host's own error, and keeps
/// its meaning instead of becoming a decode failure.
fn decode<T: for<'a> serde::Deserialize<'a>>(status: u16, body: &[u8]) -> AppResult<T> {
    if status != 200 {
        let message = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "The execution host refused the request".to_owned());
        return Err(match status {
            400 => AppError::BadRequest(message),
            403 => AppError::Forbidden(message),
            404 => AppError::NotFound(message),
            409 => AppError::Conflict(message),
            501 => AppError::Unsupported(message),
            _ => AppError::Internal(message),
        });
    }
    serde_json::from_slice(body).map_err(|_| {
        AppError::Internal("The execution host answered with an unreadable body".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(path: &str, sha: Option<&str>) -> FileVersion {
        FileVersion {
            path: path.to_owned(),
            exists: sha.is_some(),
            sha256: sha.map(str::to_owned),
            size: sha.map(|_| 3),
            mtime: None,
            ..FileVersion::default()
        }
    }

    fn seed(workspace_id: &str, path: &str, known: FileVersion) {
        let mut registry = registry().unwrap();
        let entry = registry
            .workspaces
            .entry(workspace_id.to_owned())
            .or_insert_with(|| WorkspaceWatch {
                root_path: "/remote/project".into(),
                files: HashMap::new(),
                polling: true,
            });
        entry.files.insert(
            path.to_owned(),
            Watched {
                viewers: HashSet::from(["node".to_owned()]),
                known,
            },
        );
    }

    #[test]
    fn an_identical_rewrite_is_not_reported_as_a_change() {
        let workspace = "remote-watch-identical";
        seed(workspace, "a.txt", version("a.txt", Some("aa")));
        assert!(difference(workspace, vec![version("a.txt", Some("aa"))]).is_empty());
        release_workspace(workspace);
    }

    #[test]
    fn edits_removals_and_reappearances_each_get_their_own_kind() {
        let workspace = "remote-watch-kinds";
        seed(workspace, "a.txt", version("a.txt", Some("aa")));
        let changes = difference(workspace, vec![version("a.txt", Some("bb"))]);
        assert!(matches!(
            changes.as_slice(),
            [WorkspaceEvent::FileChanged {
                kind: FileChangeKind::Modified,
                ..
            }]
        ));
        let changes = difference(workspace, vec![version("a.txt", None)]);
        assert!(matches!(
            changes.as_slice(),
            [WorkspaceEvent::FileChanged {
                kind: FileChangeKind::Removed,
                ..
            }]
        ));
        let changes = difference(workspace, vec![version("a.txt", Some("cc"))]);
        assert!(matches!(
            changes.as_slice(),
            [WorkspaceEvent::FileChanged {
                kind: FileChangeKind::Replaced,
                ..
            }]
        ));
        release_workspace(workspace);
    }

    #[test]
    fn a_path_no_node_watches_any_more_produces_nothing() {
        let workspace = "remote-watch-unwatched";
        seed(workspace, "a.txt", version("a.txt", Some("aa")));
        unregister(workspace, "a.txt", "node").unwrap();
        assert!(difference(workspace, vec![version("a.txt", Some("bb"))]).is_empty());
        release_workspace(workspace);
    }

    #[test]
    fn a_remote_error_keeps_its_status_instead_of_becoming_a_decode_failure() {
        let error =
            decode::<WatchPollResult>(403, br#"{"code":"forbidden","message":"no"}"#).unwrap_err();
        assert!(matches!(error, AppError::Forbidden(message) if message == "no"));
    }
}
