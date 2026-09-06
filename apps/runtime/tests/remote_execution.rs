#![cfg(unix)]
//! End-to-end remote execution over a real Worker child process (H02).
//!
//! The pseudo-SSH harness and the fixture live in `support/remote.rs`; what is
//! here is the first round's surface — listing, reading, saving, searching and
//! the proxied Git subset — plus the two things that must still refuse.

#[path = "support/remote.rs"]
mod support;

use std::path::Path;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{
    HOST_ID, call, fixture, get, git, install_launcher, json_request, worker_binary, worker_pids,
};

/// One test function, because the launcher is process-wide environment: two
/// tests racing to set it would be a data race, and sequencing them here is
/// both safe and closer to what a user actually does with one host.
#[test]
fn a_remote_workspace_reads_edits_searches_and_commits_on_the_execution_host() {
    let temp = tempfile::tempdir().unwrap();
    let pids = install_launcher(temp.path());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(scenario());
    runtime.block_on(reconnect_scenario(&pids));
}

/// A dropped session is reconnected, and the reconnect re-registers the root
/// rather than assuming the new Worker remembers the old one's state.
async fn reconnect_scenario(pids: &Path) {
    let _ = std::fs::remove_file(pids);
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let (status, workspace) = call(
        app,
        json_request(
            "POST",
            "/api/workspaces/remote".into(),
            json!({
                "name": "Remote project",
                "executionHostId": HOST_ID,
                "rootPath": fixture.root.to_str().unwrap(),
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    let id = workspace["id"].as_str().unwrap().to_owned();

    let (status, first) = call(
        app,
        get(format!("/api/workspaces/{id}/file?path=README.md")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let started = worker_pids(pids);
    assert_eq!(started.len(), 1, "one Worker so far: {started:?}");

    // Pull the session out from under the controller.
    unsafe { libc::kill(started[0], libc::SIGKILL) };
    // The signal is asynchronous; the read task is what observes it.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let (status, second) = call(
        app,
        get(format!("/api/workspaces/{id}/file?path=README.md")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "reconnect failed: {second}");
    assert_eq!(second["content"], first["content"]);
    let restarted = worker_pids(pids);
    assert_eq!(
        restarted.len(),
        2,
        "the drop should have started exactly one replacement: {restarted:?}"
    );
}

async fn scenario() {
    let worker_path = env!("CARGO_BIN_EXE_armadra-runtime");
    let fixture = fixture(worker_path).await;
    let app = &fixture.app;
    let remote_root = fixture.root.to_str().unwrap().to_owned();

    // The Worker itself answers what it is, before any workspace exists.
    let (status, probe) = call(
        app,
        json_request(
            "POST",
            format!("/api/ssh/hosts/{HOST_ID}/worker/test"),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["runtimeVersion"], env!("CARGO_PKG_VERSION"));
    assert!(
        probe["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("remote.execution.v1"))
    );

    // Opening the project: the execution host canonicalizes the root.
    let (status, workspace) = call(
        app,
        json_request(
            "POST",
            "/api/workspaces/remote".into(),
            json!({
                "name": "Remote project",
                "executionHostId": HOST_ID,
                "rootPath": remote_root,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    assert_eq!(workspace["executionHostId"], HOST_ID);
    let id = workspace["id"].as_str().unwrap().to_owned();
    // Git needs the execution grant, exactly as it does locally.
    let (status, _) = call(
        app,
        json_request(
            "PATCH",
            format!("/api/workspaces/{id}"),
            json!({ "permissions": { "read": true, "write": true, "execute": true } }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Listing and reading come from the other machine.
    let (status, listing) = call(app, get(format!("/api/workspaces/{id}/files?path=."))).await;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert!(
        listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == "README.md")
    );
    let (status, file) = call(
        app,
        get(format!("/api/workspaces/{id}/file?path=README.md")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{file}");
    assert_eq!(file["content"], "hello 世界\n");
    let version = file["sha256"].as_str().unwrap().to_owned();

    // A save without the content version the editor read is a conflict, and a
    // stale one stays a conflict rather than overwriting the other machine.
    let (status, conflict) = call(
        app,
        json_request(
            "PUT",
            format!("/api/workspaces/{id}/file"),
            json!({
                "path": "README.md",
                "content": "clobber\n",
                "expectedSha256": "0".repeat(64),
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("README.md")).unwrap(),
        "hello 世界\n",
        "a refused save must not have touched the execution host"
    );

    let (status, written) = call(
        app,
        json_request(
            "PUT",
            format!("/api/workspaces/{id}/file"),
            json!({
                "path": "README.md",
                "content": "hello 世界\nedited\n",
                "expectedSha256": version,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{written}");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("README.md")).unwrap(),
        "hello 世界\nedited\n"
    );

    // Project search runs where the files are.
    let (status, search) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/file-search"),
            json!({ "query": "edited" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{search}");
    assert!(
        search["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "README.md"),
        "{search}"
    );

    // Git status sees the edit the remote save made.
    let (status, git_status) = call(app, get(format!("/api/workspaces/{id}/git/status"))).await;
    assert_eq!(status, StatusCode::OK, "{git_status}");
    assert_eq!(git_status["repository"], true);
    assert_eq!(git_status["branch"], "main");
    assert_eq!(git_status["files"][0]["path"], "README.md");

    // Stage and commit, and check the execution host's own history for it.
    let (status, staged) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/git/stage"),
            json!({ "paths": ["README.md"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    let (status, committed) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/git/commit"),
            json!({ "message": "edit from the controller" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert_eq!(
        git(&fixture.root, &["log", "-1", "--pretty=%s"]),
        "edit from the controller"
    );

    // The file version endpoint is the editor's conflict probe, and it also
    // comes from the execution host.
    let (status, current) = call(
        app,
        get(format!("/api/workspaces/{id}/file-version?path=README.md")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{current}");
    assert_eq!(current["exists"], true);
    assert_ne!(current["sha256"], Value::Null);

    // Drafting a commit message reaches the execution host now: the diff is
    // captured there and only the model runs here. What comes back is a
    // repository answer — this request names an index digest the host does not
    // have — rather than "your workspace is on the wrong machine".
    let (status, answer) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/git/message/generate"),
            json!({ "provider": "claude-bare", "indexDigest": "0".repeat(64) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    assert_eq!(answer["code"], "conflict", "{answer}");

    // Language servers live on the execution host too: restarting one is
    // dispatched over the language link, so with no server running there the
    // answer is the host's own "nothing to restart", not a local refusal.
    let (status, answer) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/language/servers/rust-analyzer/restart"),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{answer}");
    assert_eq!(answer["code"], "not_found", "{answer}");
}

/// A host whose Worker cannot be started is refused, and refused as
/// `UNSUPPORTED` — the workspace's files are elsewhere, so answering from this
/// machine would be a different project.
#[tokio::test]
async fn a_missing_remote_worker_binary_is_unsupported_and_never_falls_back_locally() {
    let fixture = fixture("/nonexistent/armadra-runtime").await;
    let (status, answer) = call(
        &fixture.app,
        json_request(
            "POST",
            format!("/api/ssh/hosts/{HOST_ID}/worker/test"),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{answer}");
    assert_eq!(answer["code"], "unsupported");

    let (status, answer) = call(
        &fixture.app,
        json_request(
            "POST",
            "/api/workspaces/remote".into(),
            json!({
                "name": "Remote project",
                "executionHostId": HOST_ID,
                "rootPath": fixture.root.to_str().unwrap(),
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{answer}");
}

/// An SSH host that has no `worker` configuration can still run terminals, and
/// must not become a silent local execution host.
#[tokio::test]
async fn an_ssh_host_without_a_worker_cannot_execute_a_workspace() {
    let app = support::app_without_worker().await;
    let (status, answer) = call(
        &app,
        json_request(
            "POST",
            "/api/workspaces/remote".into(),
            json!({
                "name": "Remote project",
                "executionHostId": HOST_ID,
                "rootPath": "/srv/project",
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{answer}");
    assert!(
        answer["message"].as_str().unwrap().contains("Worker"),
        "{answer}"
    );
}
