#![cfg(unix)]
//! End-to-end remote execution over a real Worker child process (H02).
//!
//! **How this stands in for SSH.** `ssh localhost` is not usable in a build
//! environment: it needs the daemon enabled and the host key already trusted,
//! and accepting one automatically is exactly the thing the design forbids. So
//! `ARMADRA_REMOTE_WORKER_LAUNCHER` points at a small shell script that parses
//! options the way `ssh` does — `-o VALUE`, `-p N`, `-i FILE`, then the
//! destination — discards them, and runs the rest locally. Everything after
//! argv[0] is the production launch line, byte for byte, and what it starts is
//! the real `armadra-runtime worker --stdio` binary talking the real framed
//! Protobuf protocol over a real pipe. What is *not* covered is `ssh` itself:
//! authentication, host-key handling and the network.
//!
//! The "remote" project is a temporary directory on this machine. That is what
//! makes the test meaningful rather than weaker: the controller is forbidden
//! from touching it directly, so if any answer came from the local filesystem
//! instead of the Worker the paths would still line up and only the Worker's
//! own behaviour distinguishes them — which is why the local-only routes are
//! asserted to refuse rather than to succeed.

use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use armadra_runtime::{
    AppState, db, events::EventHub, hook::HookService, router_with_state, settings::SettingsStore,
    terminal::TerminalManager, usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

const LAUNCHER: &str = "ARMADRA_REMOTE_WORKER_LAUNCHER";
const HOST_ID: &str = "box";

/// An `ssh` stand-in: same option grammar, no network. The Worker runs as a
/// job rather than replacing the shell so its pid can be recorded — that is
/// what lets a test pull the connection out from under the controller the way
/// a dropped SSH session would.
const SCRIPT: &str = r#"#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-p|-i) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
# A background job's stdin defaults to /dev/null without job control, so the
# frame pipe is handed to it explicitly.
exec 3<&0
"$@" <&3 &
worker=$!
if [ -n "$ARMADRA_TEST_WORKER_PIDS" ]; then echo "$worker" >> "$ARMADRA_TEST_WORKER_PIDS"; fi
wait "$worker"
"#;

fn write_launcher(directory: &Path) -> PathBuf {
    let path = directory.join("pseudo-ssh");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(SCRIPT.as_bytes()).unwrap();
    drop(file);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The Worker pids the launcher has started so far.
fn worker_pids(path: &Path) -> Vec<i32> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned()
}

struct Fixture {
    app: axum::Router,
    root: PathBuf,
    _temp: tempfile::TempDir,
}

async fn fixture(worker_path: &str) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    // The "remote" project. The controller must never read it directly.
    let root = temp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "Remote Test"]);
    git(&root, &["config", "user.email", "remote@example.invalid"]);
    std::fs::write(root.join("README.md"), "hello 世界\n").unwrap();
    git(&root, &["add", "README.md"]);
    git(&root, &["commit", "-m", "base"]);

    let settings = SettingsStore::in_memory(json!({
        "terminal": { "backend": "direct" },
        "ssh": { "hosts": [{
            "id": HOST_ID,
            "name": "Box",
            "host": "example.invalid",
            "user": "ada",
            "worker": { "path": worker_path },
        }] },
    }));
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let events = EventHub::new();
    let app = router_with_state(AppState {
        remote: Default::default(),
        resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
        pool: pool.clone(),
        events: events.clone(),
        settings: settings.clone(),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events,
            settings.clone(),
            temp.path().to_owned(),
        ),
        hooks: HookService::new(temp.path().to_owned(), None),
        usage: UsageService::new(settings),
    });
    Fixture {
        app,
        root,
        _temp: temp,
    }
}

async fn call(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn get(uri: String) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

fn json_request(method: &str, uri: String, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// One test function, because the launcher is process-wide environment: two
/// tests racing to set it would be a data race, and sequencing them here is
/// both safe and closer to what a user actually does with one host.
#[test]
fn a_remote_workspace_reads_edits_searches_and_commits_on_the_execution_host() {
    let temp = tempfile::tempdir().unwrap();
    let launcher = write_launcher(temp.path());
    // Set before any runtime thread exists.
    // SAFETY: single-threaded at this point; nothing else reads the environment.
    unsafe { std::env::set_var(LAUNCHER, &launcher) };
    let pids = temp.path().join("worker-pids");
    // SAFETY: same point, same reason.
    unsafe { std::env::set_var("ARMADRA_TEST_WORKER_PIDS", &pids) };
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
    let worker_path = env!("CARGO_BIN_EXE_armadra-runtime");
    let fixture = fixture(worker_path).await;
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
    // The signal is asynchronous; the next read is what observes it.
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

    // Surfaces with no remote implementation say so instead of answering
    // about the controller's own disk.
    for (method, uri, body) in [
        (
            "GET",
            format!("/api/workspaces/{id}/git/repository/branches"),
            Value::Null,
        ),
        (
            "GET",
            format!("/api/workspaces/{id}/file-download?path=README.md"),
            Value::Null,
        ),
        (
            "POST",
            format!("/api/workspaces/{id}/file-entries"),
            json!({ "path": "new.txt", "kind": "file" }),
        ),
    ] {
        let request = if body.is_null() {
            get(uri.clone())
        } else {
            json_request(method, uri.clone(), body)
        };
        let (status, answer) = call(app, request).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{uri}: {answer}");
        assert_eq!(answer["code"], "unsupported", "{uri}");
    }
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
    let temp = tempfile::tempdir().unwrap();
    let settings = SettingsStore::in_memory(json!({
        "ssh": { "hosts": [{ "id": HOST_ID, "name": "Box", "host": "example.invalid" }] },
    }));
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let events = EventHub::new();
    let app = router_with_state(AppState {
        remote: Default::default(),
        resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
        pool: pool.clone(),
        events: events.clone(),
        settings: settings.clone(),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events,
            settings.clone(),
            temp.path().to_owned(),
        ),
        hooks: HookService::new(temp.path().to_owned(), None),
        usage: UsageService::new(settings),
    });
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
