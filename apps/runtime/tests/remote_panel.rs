#![cfg(unix)]
//! The repository panel and file management on an execution host (remote
//! completion design §3.1, batch 4 acceptance 11).
//!
//! Every assertion here is about *where the work happened*. The controller is
//! forbidden from touching the "remote" directory, so an answer that mentions a
//! branch, a stash or a trashed file could only have come from the Worker
//! process — and when the test then looks at the directory itself, it is
//! checking that the Worker really did it rather than reporting that it had.

#[path = "support/remote.rs"]
mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{
    call, call_bytes, fixture, get, git, install_launcher, json_request, open_workspace,
    worker_binary, worker_pids,
};

/// One test function, because the launcher is process-wide environment: two
/// tests racing to set it would be a data race.
#[test]
fn a_remote_workspace_drives_its_repository_panel_and_file_tree_on_the_execution_host() {
    let temp = tempfile::tempdir().unwrap();
    let pids = install_launcher(temp.path());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(panel_scenario());
    runtime.block_on(file_tree_scenario());
    runtime.block_on(unknown_outcome_scenario(&pids));
}

async fn panel_scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    // A second branch and a stash, made on the "remote" machine directly, so
    // what the panel reports can only have been read there.
    git(&fixture.root, &["branch", "feature/one"]);
    std::fs::write(fixture.root.join("README.md"), "hello 世界\nstashed\n").unwrap();
    git(&fixture.root, &["stash", "push", "-m", "work in progress"]);

    let (status, branches) = call(
        app,
        get(format!("/api/workspaces/{id}/git/repository/branches")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{branches}");
    let names: Vec<&str> = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|branch| branch["name"].as_str())
        .collect();
    assert!(names.contains(&"main"), "{branches}");
    assert!(names.contains(&"feature/one"), "{branches}");

    let (status, history) = call(
        app,
        get(format!("/api/workspaces/{id}/git/repository/history")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["commits"][0]["subject"], "base");

    let (status, stashes) = call(
        app,
        get(format!("/api/workspaces/{id}/git/repository/stashes")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{stashes}");
    assert!(
        stashes["stashes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["subject"]
                .as_str()
                .is_some_and(|subject| subject.contains("work in progress"))),
        "{stashes}"
    );

    // Reading one stash's patch is a second round trip to the same host, and
    // it has to find the object the listing just named.
    let oid = stashes["stashes"][0]["oid"].as_str().unwrap().to_owned();
    let (status, detail) = call(
        app,
        get(format!(
            "/api/workspaces/{id}/git/repository/stash-detail?path=.&oid={oid}"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(
        detail["patch"].as_str().unwrap().contains("stashed"),
        "{detail}"
    );

    let (status, worktrees) = call(
        app,
        get(format!("/api/workspaces/{id}/git/repository/worktrees")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{worktrees}");
    assert_eq!(worktrees.as_array().unwrap().len(), 1, "{worktrees}");

    let (status, repositories) =
        call(app, get(format!("/api/workspaces/{id}/git/repositories"))).await;
    assert_eq!(status, StatusCode::OK, "{repositories}");
    assert!(
        !repositories["repositories"].as_array().unwrap().is_empty(),
        "{repositories}"
    );

    // The queue: start a real operation on the execution host, watch it
    // through to a terminal state, and confirm the worktree it created is
    // actually there.
    // Inside the workspace root: the execution host enforces its own
    // boundary, and a path outside it is refused there rather than here.
    let checkout = fixture.root.join("worktrees/one");
    let (status, started) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/git/repository/operations"),
            json!({
                "path": ".",
                "action": {
                    "kind": "createWorktree",
                    "path": checkout.to_str().unwrap(),
                    "branch": "feature/one",
                    "createBranch": false,
                    "startPoint": Value::Null,
                    "expectedOid": git(&fixture.root, &["rev-parse", "feature/one"]),
                },
                "expected": { "headOid": git(&fixture.root, &["rev-parse", "HEAD"]), "branch": "main" },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let operation = started["id"].as_str().unwrap().to_owned();

    let mut snapshot = started;
    for _ in 0..100 {
        if snapshot["state"] != "queued" && snapshot["state"] != "running" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let (status, current) = call(
            app,
            get(format!(
                "/api/workspaces/{id}/git/repository/operations/{operation}"
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{current}");
        snapshot = current;
    }
    assert_eq!(snapshot["state"], "succeeded", "{snapshot}");
    assert!(
        checkout.join(".git").exists(),
        "the worktree was not created"
    );

    // The queue listing is scoped to the workspace that started the operation,
    // and it is read from the execution host.
    let (status, operations) = call(
        app,
        get(format!("/api/workspaces/{id}/git/repository/operations")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{operations}");
    assert!(
        operations
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == operation.as_str()),
        "{operations}"
    );

    // Cancelling reaches the machine that holds the record. A finished
    // operation stays finished — cancellation is a request, not a rewrite —
    // and an operation this workspace never started is not found there either.
    let (status, cancelled) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/git/repository/operations/{operation}/cancel"),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["state"], "succeeded", "{cancelled}");
    assert_eq!(cancelled["cancellationRequested"], false, "{cancelled}");

    let (status, missing) = call(
        app,
        get(format!(
            "/api/workspaces/{id}/git/repository/operations/not-an-operation"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
}

async fn file_tree_scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    // A folder, then a file inside it: the parent has to exist on the machine
    // that owns the files, so both calls are proving the same thing.
    let (status, folder) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries"),
            json!({ "path": "notes", "kind": "directory" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{folder}");
    assert!(fixture.root.join("notes").is_dir());

    let (status, created) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries"),
            json!({ "path": "notes/draft.md", "kind": "file" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert!(fixture.root.join("notes/draft.md").is_file());

    let (status, renamed) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries/rename"),
            json!({ "from": "notes/draft.md", "to": "notes/final.md" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert!(fixture.root.join("notes/final.md").is_file());
    assert!(!fixture.root.join("notes/draft.md").exists());

    // A move to a different folder is the other operation number and the same
    // filesystem call.
    let (status, moved) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries/rename"),
            json!({ "from": "notes/final.md", "to": "final.md" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert!(fixture.root.join("final.md").is_file());

    // Deleting moves the bytes under the execution host's own trash; nothing
    // is unlinked.
    let (status, trashed) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries/trash"),
            json!({ "path": "final.md" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{trashed}");
    assert!(!fixture.root.join("final.md").exists());
    assert!(fixture.root.join(".armadra/trash").is_dir());

    let (status, listed) = call(app, get(format!("/api/workspaces/{id}/file-entries/trash"))).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let entry = listed.as_array().unwrap().first().cloned().unwrap();
    assert_eq!(entry["originalPath"], "final.md", "{listed}");

    let (status, restored) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries/restore"),
            json!({ "id": entry["id"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert!(fixture.root.join("final.md").is_file());

    // File metadata and a raw download both come off the other machine.
    std::fs::write(
        fixture.root.join("picture.png"),
        [0x89, b'P', b'N', b'G', 0, 1, 2],
    )
    .unwrap();
    let (status, info) = call(
        app,
        get(format!("/api/workspaces/{id}/file-info?path=picture.png")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["preview"], "image", "{info}");

    let (status, bytes) = call_bytes(
        app,
        get(format!(
            "/api/workspaces/{id}/file-download?path=picture.png"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, [0x89, b'P', b'N', b'G', 0, 1, 2]);
}

/// A write whose answer never came back is an unknown outcome, and the
/// reconnect that follows replays only reads.
async fn unknown_outcome_scenario(pids: &std::path::Path) {
    let _ = std::fs::remove_file(pids);
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    // One request to establish the connection.
    let (status, _) = call(app, get(format!("/api/workspaces/{id}/files?path=."))).await;
    assert_eq!(status, StatusCode::OK);
    let started = worker_pids(pids);
    assert_eq!(started.len(), 1, "one Worker so far: {started:?}");

    // Kill the session, then ask for a write. The request reaches a dead pipe
    // before it is written, so it is retried on a fresh connection rather than
    // reported as unknown: nothing ran.
    unsafe { libc::kill(started[0], libc::SIGKILL) };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (status, created) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-entries"),
            json!({ "path": "after-kill.txt", "kind": "file" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert!(fixture.root.join("after-kill.txt").is_file());
    assert_eq!(
        worker_pids(pids).len(),
        2,
        "the drop should have started exactly one replacement"
    );

    // A read after a second drop reconnects the same way; reads are the only
    // thing this path is allowed to replay.
    let running = worker_pids(pids);
    unsafe { libc::kill(*running.last().unwrap(), libc::SIGKILL) };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (status, listing) = call(app, get(format!("/api/workspaces/{id}/files?path=."))).await;
    assert_eq!(status, StatusCode::OK, "{listing}");
}
