#![cfg(unix)]
//! Moving a workspace between execution hosts (design §3.3, batch 5
//! acceptance 16).
//!
//! Two pseudo-SSH hosts pointing at the same directory are the same project;
//! two pointing at different directories are not, and the difference has to be
//! *visible* in the refusal rather than reduced to "conflict". The third case
//! is a workspace that is still busy, which is refused before any comparison
//! happens — there is no point telling somebody their roots match if the
//! rebinding would strand an open editor.

#[path = "support/remote.rs"]
mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::{call, fixture, git, install_launcher, json_request, open_workspace, worker_binary};

#[test]
fn switching_execution_hosts_rebinds_only_when_the_new_root_is_the_same_project() {
    let temp = tempfile::tempdir().unwrap();
    install_launcher(temp.path());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(scenario());
}

async fn scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    // Moving the files is not what a switch is, and asking for it says so
    // rather than being ignored.
    let (status, refused) = call(
        app,
        json_request(
            "PATCH",
            format!("/api/workspaces/{id}/execution-host"),
            json!({
                "executionHostId": "",
                "rootPath": fixture.root.to_str().unwrap(),
                "migrateFiles": true,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{refused}");
    assert_eq!(refused["code"], "unsupported");

    // A different directory is a different project, and the answer shows both
    // fingerprints so a person can see which half differs.
    let other = fixture.temp.path().join("other");
    std::fs::create_dir(&other).unwrap();
    git(&other, &["init", "-b", "main"]);
    std::fs::write(other.join("UNRELATED.md"), "different\n").unwrap();
    let (status, mismatch) = call(
        app,
        json_request(
            "PATCH",
            format!("/api/workspaces/{id}/execution-host"),
            json!({ "executionHostId": "", "rootPath": other.to_str().unwrap() }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{mismatch}");
    assert_eq!(mismatch["code"], "root_mismatch", "{mismatch}");
    assert!(mismatch["from"]["entries"].is_string(), "{mismatch}");
    assert!(mismatch["to"]["entries"].is_string(), "{mismatch}");
    assert_ne!(
        mismatch["from"]["entries"], mismatch["to"]["entries"],
        "{mismatch}"
    );

    // An open editor is a blocker, and it is named rather than counted.
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
    let (status, blocked) = call(
        app,
        json_request(
            "PATCH",
            format!("/api/workspaces/{id}/execution-host"),
            json!({ "executionHostId": "", "rootPath": fixture.root.to_str().unwrap() }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{blocked}");
    assert_eq!(blocked["code"], "switch_blocked", "{blocked}");
    assert_eq!(blocked["blockers"][0]["kind"], "editorDraft", "{blocked}");
    assert_eq!(blocked["blockers"][0]["detail"], "README.md", "{blocked}");

    // Close it, and the same directory reached through this machine instead of
    // through the Worker is recognised as the same project.
    let (status, _) = call(
        app,
        axum::http::Request::builder()
            .method("DELETE")
            .uri(format!(
                "/api/workspaces/{id}/file-watch?path=README.md&nodeId=editor-1"
            ))
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, switched) = call(
        app,
        json_request(
            "PATCH",
            format!("/api/workspaces/{id}/execution-host"),
            json!({ "executionHostId": "", "rootPath": fixture.root.to_str().unwrap() }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{switched}");
    // An empty execution host is omitted rather than serialized: "this
    // machine" is the absence of a host, not a host named "".
    assert!(switched["executionHostId"].is_null(), "{switched}");

    // And the workspace now reads locally: same files, same content, no Worker.
    let (status, file) = call(
        app,
        support::get(format!("/api/workspaces/{id}/file?path=README.md")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{file}");
    assert_eq!(file["content"], "hello 世界\n");

    // Switching back onto the execution host works the same way round.
    let (status, back) = call(
        app,
        json_request(
            "PATCH",
            format!("/api/workspaces/{id}/execution-host"),
            json!({
                "executionHostId": support::HOST_ID,
                "rootPath": fixture.root.to_str().unwrap(),
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["executionHostId"], support::HOST_ID, "{back}");
}
