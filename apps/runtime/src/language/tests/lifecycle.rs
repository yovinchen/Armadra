//! Crashing, idle stopping and hanging — the lifecycle branches a real server
//! reaches only by accident, driven by the mock's `--crash-after` and
//! `--hang` switches.

use serde_json::json;

use super::mux::Harness;
use crate::language::{ServerState, jsonrpc, reason};

fn did_open(text: &str) -> serde_json::Value {
    jsonrpc::notification(
        "textDocument/didOpen",
        json!({ "textDocument": {
            "uri": "armadra:///notes.md",
            "languageId": "markdown",
            "version": 1,
            "text": text
        }}),
    )
}

fn diagnostics(value: &serde_json::Value) -> bool {
    value.get("method").and_then(serde_json::Value::as_str)
        == Some("textDocument/publishDiagnostics")
}

async fn until(deadline: std::time::Duration, mut condition: impl FnMut() -> bool) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < deadline {
        if condition() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    condition()
}

#[tokio::test]
async fn a_crash_restarts_the_server_and_replays_the_open_documents() {
    // Three client messages get through — `initialize`, `initialized` and the
    // first `didOpen` — and the fourth kills it. The restart has to re-send
    // that didOpen from the shadow document, which is the whole point of
    // keeping one.
    let Some(mut harness) = Harness::start(&["--crash-after=3"]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("TODO first\n"));
    let first = harness.expect("a", diagnostics).await;
    assert!(first.is_some(), "the first server published diagnostics");

    // The fourth message is the one it dies on.
    harness.send(
        "a",
        &jsonrpc::notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "contentChanges": [{ "text": "TODO second\n" }]
            }),
        ),
    );

    // The crash is noticed, the restart budget allows it, and after the
    // back-off the replayed didOpen produces diagnostics again.
    assert!(
        until(std::time::Duration::from_secs(20), || {
            harness.hub.lock().restart_count > 0
        })
        .await,
        "the crash was counted"
    );
    let again = harness.expect("a", diagnostics).await;
    assert!(
        again.is_some(),
        "the restarted server was given the open document back"
    );
}

#[test]
fn a_server_that_keeps_crashing_stops_being_restarted() {
    // A server that fails on startup fails on startup every time. Three tries
    // with a growing pause, and then it stays stopped until a person asks —
    // an endless restart loop looks like a busy machine, not like a problem.
    assert_eq!(crate::language::mux::restart_delay(1), Some(1));
    assert_eq!(crate::language::mux::restart_delay(2), Some(5));
    assert_eq!(crate::language::mux::restart_delay(3), Some(20));
    assert_eq!(crate::language::mux::restart_delay(4), None);
    assert_eq!(
        crate::language::mux::restart_delay(crate::language::MAX_RESTARTS + 1),
        None
    );
}

#[tokio::test]
async fn an_idle_server_stops_and_the_next_open_brings_it_back() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("TODO here\n"));
    assert!(harness.expect("a", diagnostics).await.is_some());

    // Closing the last document is what starts the idle clock.
    harness.send(
        "a",
        &jsonrpc::notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": "armadra:///notes.md" } }),
        ),
    );
    assert!(harness.hub.lock().documents.is_empty());
    assert!(harness.hub.lock().idle_since.is_some());

    // The sweep would do this after ten minutes; the test does it directly so
    // it can assert what comes *after* the stop.
    harness
        .hub
        .stop_process(ServerState::IdleStopped, reason::IDLE)
        .await;
    assert_eq!(harness.hub.lock().state, ServerState::IdleStopped);
    assert!(harness.hub.lock().process.is_none());

    // Opening a document again restarts it, and the session never had to know.
    harness.hub.ensure_started().await.expect("it comes back");
    assert_eq!(harness.hub.lock().state, ServerState::Running);
    harness.send("a", &did_open("TODO again\n"));
    assert!(
        harness.expect("a", diagnostics).await.is_some(),
        "diagnostics reappear after an idle stop"
    );
}

#[tokio::test]
async fn a_hung_request_is_failed_and_cancelled_rather_than_left_waiting() {
    let Some(mut harness) = Harness::start(&["--hang"]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("alpha\n"));
    assert!(harness.expect("a", diagnostics).await.is_some());
    harness.send(
        "a",
        &jsonrpc::request(
            &json!(5),
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "position": { "line": 0, "character": 1 }
            }),
        ),
    );
    assert_eq!(harness.hub.lock().pending.len(), 1);
    // Expiry is normally 30 s; the sweep's own deadline is passed in so the
    // test asserts the behaviour rather than waiting for the clock.
    crate::language::mux::expire_requests(&harness.hub, std::time::Duration::ZERO);
    let answer = harness
        .expect("a", |value| {
            value.get("id").map(|id| id == &json!(5)).unwrap_or(false)
        })
        .await
        .expect("the session is told the request failed");
    assert_eq!(answer["error"]["code"], jsonrpc::REQUEST_FAILED);
    assert!(harness.hub.lock().pending.is_empty());
    // The in-flight budget is released, so the session is not permanently
    // poorer for having asked a question the server ignored.
    assert_eq!(harness.hub.lock().sessions["a"].in_flight, 0);
}

#[tokio::test]
async fn a_stopped_server_leaves_no_process_behind() {
    let Some(harness) = Harness::start(&[]).await else {
        return;
    };
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    let pid = harness
        .hub
        .lock()
        .process
        .as_ref()
        .and_then(|process| process.pid)
        .expect("a running server has a pid");
    harness
        .hub
        .stop_process(ServerState::Stopped, reason::USER)
        .await;
    // `setsid` plus `killpg` is what makes this true for a server that forked
    // helpers; the mock has none, so this checks the leader at least.
    assert!(
        until(std::time::Duration::from_secs(10), || {
            !process_alive(pid)
        })
        .await,
        "the server process is gone"
    );
}

#[cfg(unix)]
fn process_alive(pid: i64) -> bool {
    // Signal 0 asks "could I signal this?", which answers "does it exist?"
    // without touching it. A zombie answers yes, so the test allows the
    // reaper a moment either way.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn process_alive(_pid: i64) -> bool {
    false
}

#[test]
fn a_language_server_never_inherits_the_runtimes_own_variables() {
    // A language server is the project's code. It needs `PATH` and the
    // toolchain variables; it must not be handed anything that identifies or
    // authorises Armadra.
    assert!(crate::language::server::is_runtime_variable(
        "ARMADRA_HOOK_TOKEN"
    ));
    assert!(crate::language::server::is_runtime_variable(
        "ARMADRA_DATA_DIR"
    ));
    assert!(crate::language::server::is_runtime_variable(
        "ARMADRA_NODE_ID"
    ));
    assert!(!crate::language::server::is_runtime_variable("PATH"));
    assert!(!crate::language::server::is_runtime_variable("GOPATH"));
    assert!(!crate::language::server::is_runtime_variable("CARGO_HOME"));
}

#[test]
fn the_initialize_params_name_exactly_one_workspace_folder() {
    let params = crate::language::server::initialize_params(
        std::path::Path::new("/项目/仓库"),
        serde_json::json!({}),
        None,
    );
    let folders = params["workspaceFolders"].as_array().unwrap();
    // Multi-root is out of scope; a second folder would let a server index a
    // directory the workspace does not cover.
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0]["uri"], params["rootUri"]);
    assert_eq!(params["rootUri"], "file:///项目/仓库");
}
