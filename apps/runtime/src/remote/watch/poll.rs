//! The fallback: ask an execution host what its open files look like, on a
//! timer.
//!
//! Kept, and kept honest, because a Worker built before `remote.watch.v1`
//! cannot push anything and the alternative would be an editor that silently
//! never notices an external change. It is also what an event stream uses to
//! reconcile after a reconnect, so it is not dead code on a modern host.

use std::{sync::Arc, time::Duration};

use armadra_protocol::v1::WorkerServiceOperation;

use crate::{
    error::{AppError, AppResult},
    events::EventHub,
    file_watch::FileVersion,
    remote::{
        client::RemoteWorker,
        service::{WatchPollPayload, WatchPollResult},
        watch::{difference, publish, registry},
    },
};

/// How often a workspace with open remote editors is polled.
pub const INTERVAL: Duration = Duration::from_secs(2);

pub fn spawn(worker: Arc<RemoteWorker>, events: EventHub, workspace_id: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            let Some((root_path, paths)) = open_files(&workspace_id) else {
                break;
            };
            let Ok(versions) = poll(&worker, &workspace_id, &root_path, paths).await else {
                // A host that is down is not a change. The next tick retries,
                // and the connection's own backoff keeps that cheap.
                continue;
            };
            for change in difference(&workspace_id, versions) {
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

/// The root and the paths a workspace currently has open, or `None` when there
/// is nothing left to watch.
pub(super) fn open_files(workspace_id: &str) -> Option<(String, Vec<String>)> {
    let registry = registry().ok()?;
    let entry = registry.workspaces.get(workspace_id)?;
    if entry.files.is_empty() {
        return None;
    }
    Some((
        entry.root_path.clone(),
        entry.files.keys().cloned().collect(),
    ))
}

pub(super) async fn poll(
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
    let result: WatchPollResult = crate::remote::decode(status, &body)?;
    Ok(result.versions)
}
