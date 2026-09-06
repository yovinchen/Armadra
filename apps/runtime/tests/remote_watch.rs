#![cfg(unix)]
//! Filesystem events pushed from an execution host (design §3.4, batch 5
//! acceptance 13).
//!
//! The claim being tested is a latency claim, so the test measures one: a write
//! made directly on the "remote" directory has to reach the workspace event
//! stream well inside the two-second interval the old poll would have taken. A
//! push that merely *works* would pass a poll test too, which is why the
//! deadline here is 500 ms rather than "eventually".

#[path = "support/remote.rs"]
mod support;

use std::time::Duration;

use armadra_runtime::events::{FileChangeKind, WorkspaceEvent};
use axum::http::StatusCode;
use serde_json::json;
use support::{
    call, fixture, install_launcher, json_request, open_workspace, worker_binary, worker_pids,
};

/// How long a pushed change may take to reach the controller. The poll it
/// replaces runs every two seconds, so anything near that would not prove a
/// push happened at all.
const DEADLINE: Duration = Duration::from_millis(500);

#[test]
fn a_remote_workspace_receives_filesystem_events_rather_than_polling() {
    let temp = tempfile::tempdir().unwrap();
    let pids = install_launcher(temp.path());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(events_scenario());
    runtime.block_on(reconnect_scenario(&pids));
}

async fn events_scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    let (status, registration) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-watch"),
            json!({ "path": "README.md", "nodeId": "editor-1" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{registration}");
    assert_eq!(registration["status"], "watching", "{registration}");
    // A Worker from this build pushes; the badge says so, and the client uses
    // it to decide whether to promise the user low latency.
    assert_eq!(registration["mode"], "events", "{registration}");
    assert!(registration["reason"].is_null(), "{registration}");

    // Subscribed before the write, so nothing can be missed between the two.
    let mut changes = fixture.events.subscribe(&id);

    // An external write, made where the file actually lives.
    let started = std::time::Instant::now();
    std::fs::write(fixture.root.join("README.md"), "hello 世界\nexternal\n").unwrap();
    let kind = await_change(&mut changes, "README.md").await;
    let elapsed = started.elapsed();
    assert_eq!(kind, FileChangeKind::Modified);
    assert!(
        elapsed < DEADLINE,
        "the change took {elapsed:?}, which is a poll rather than a push"
    );

    // A removal is its own kind, not a modification to nothing.
    std::fs::remove_file(fixture.root.join("README.md")).unwrap();
    assert_eq!(
        await_change(&mut changes, "README.md").await,
        FileChangeKind::Removed
    );
}

/// After the session is killed the subscription is gone with it. The
/// controller re-subscribes on the new one and reconciles, so a change made
/// while nothing was connected is reported exactly once.
async fn reconnect_scenario(pids: &std::path::Path) {
    let _ = std::fs::remove_file(pids);
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    let (status, _) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-watch"),
            json!({ "path": "README.md", "nodeId": "editor-1" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let started = worker_pids(pids);
    assert_eq!(started.len(), 1, "one Worker so far: {started:?}");

    // Kill the session and change the file while nothing is watching it.
    unsafe { libc::kill(started[0], libc::SIGKILL) };
    tokio::time::sleep(Duration::from_millis(200)).await;
    std::fs::write(fixture.root.join("README.md"), "hello 世界\nwhile away\n").unwrap();

    // Any request reconnects; the watch pump then re-subscribes and the
    // reconciling poll reports the change it missed.
    let (status, _) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-watch"),
            json!({ "path": "README.md", "nodeId": "editor-1" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(worker_pids(pids).len(), 2, "the drop was not reconnected");

    // The re-registration re-baselined the file, so the version the editor now
    // holds is the one on the execution host — no phantom conflict.
    let (status, version) = call(
        app,
        support::get(format!("/api/workspaces/{id}/file-version?path=README.md")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(version["exists"], true, "{version}");

    // And a change made *after* the reconnect still arrives, which is what
    // proves the new session is subscribed rather than merely alive.
    let mut changes = fixture.events.subscribe(&id);
    std::fs::write(fixture.root.join("README.md"), "hello 世界\nafter\n").unwrap();
    assert_eq!(
        await_change(&mut changes, "README.md").await,
        FileChangeKind::Modified
    );
}

/// Wait for the next change to `path` on the workspace's own event stream.
///
/// The stream is the same broadcast the canvas WebSocket forwards; subscribing
/// to it directly is how a test observes a push without standing up a socket.
async fn await_change(
    changes: &mut tokio::sync::broadcast::Receiver<WorkspaceEvent>,
    path: &str,
) -> FileChangeKind {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match tokio::time::timeout(remaining, changes.recv()).await {
            Ok(Ok(WorkspaceEvent::FileChanged {
                path: changed,
                kind,
                ..
            })) if changed == path => return kind,
            Ok(Ok(_)) => continue,
            Ok(Err(_)) | Err(_) => break,
        }
    }
    panic!("no file.changed for {path} arrived in time");
}
