#![cfg(unix)]
// Shared by four test binaries; each one uses a different subset.
#![allow(dead_code)]
//! The pseudo-SSH harness the remote tests share.
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
//! makes the tests meaningful rather than weaker: the controller is forbidden
//! from touching it directly, so if any answer came from the local filesystem
//! instead of the Worker the paths would still line up and only the Worker's
//! own behaviour distinguishes them.

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

pub const LAUNCHER: &str = "ARMADRA_REMOTE_WORKER_LAUNCHER";
pub const HOST_ID: &str = "box";

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

pub fn write_launcher(directory: &Path) -> PathBuf {
    let path = directory.join("pseudo-ssh");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(SCRIPT.as_bytes()).unwrap();
    drop(file);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The Worker pids the launcher has started so far.
pub fn worker_pids(path: &Path) -> Vec<i32> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

/// Point the whole process at the pseudo-SSH launcher. Called once per test
/// binary, before any runtime thread exists.
pub fn install_launcher(temp: &Path) -> PathBuf {
    let launcher = write_launcher(temp);
    // SAFETY: single-threaded at this point; nothing else reads the environment.
    unsafe { std::env::set_var(LAUNCHER, &launcher) };
    let pids = temp.join("worker-pids");
    // SAFETY: same point, same reason.
    unsafe { std::env::set_var("ARMADRA_TEST_WORKER_PIDS", &pids) };
    pids
}

pub fn git(root: &Path, args: &[&str]) -> String {
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

pub struct Fixture {
    pub app: axum::Router,
    pub root: PathBuf,
    pub temp: tempfile::TempDir,
    /// The same hub the router publishes to. Subscribing to it directly is how
    /// a test observes pushed events without opening the WebSocket the
    /// canvas uses.
    pub events: EventHub,
}

/// A workspace whose files live in a directory this process must not read
/// directly, served by a real Worker child over the pseudo-SSH launcher.
pub async fn fixture(worker_path: &str) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
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
    let hub = EventHub::new();
    let events = hub.clone();
    let app = router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
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
        temp,
        events: hub,
    }
}

/// A router whose configured SSH host has no Worker at all: it can run
/// terminals and nothing else, which is a different refusal from an unreachable
/// one and must stay distinguishable.
pub async fn app_without_worker() -> axum::Router {
    let temp = tempfile::tempdir().unwrap();
    let settings = SettingsStore::in_memory(json!({
        "ssh": { "hosts": [{ "id": HOST_ID, "name": "Box", "host": "example.invalid" }] },
    }));
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let events = EventHub::new();
    router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
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
    })
}

pub async fn call(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

/// Like [`call`], but keeps the raw body — downloads are not JSON.
pub async fn call_bytes(app: &axum::Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    (status, bytes.to_vec())
}

pub fn get(uri: String) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

pub fn json_request(method: &str, uri: String, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// Open the remote workspace and grant it everything, which is what the Git
/// panel and the file writes need.
pub async fn open_workspace(app: &axum::Router, root: &Path) -> String {
    let (status, workspace) = call(
        app,
        json_request(
            "POST",
            "/api/workspaces/remote".into(),
            json!({
                "name": "Remote project",
                "executionHostId": HOST_ID,
                "rootPath": root.to_str().unwrap(),
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    let id = workspace["id"].as_str().unwrap().to_owned();
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
    id
}

pub fn worker_binary() -> &'static str {
    env!("CARGO_BIN_EXE_armadra-runtime")
}
