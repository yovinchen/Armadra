//! One real language server, end to end (language service design §5, batch B).
//!
//! `ruff server` is the server this machine actually has, and it is a real
//! LSP: it pushes diagnostics, formats, and offers code actions. The mock in
//! `tools/probes/mock-lsp.mjs` covers the branches a real server only reaches
//! by accident; this file covers the thing the mock cannot prove — that the
//! proxy works against a server nobody wrote for it.
//!
//! Marked `#[ignore]` because it needs a program that may not be installed:
//!
//! ```sh
//! cargo test -p armadra-runtime --test language_real -- --ignored --nocapture
//! ```
//!
//! It skips itself, loudly, when `ruff` is missing, so a machine without it
//! reports "not run" rather than a green tick it did not earn.

use std::collections::HashMap;

use armadra_runtime::{
    events::{EventHub, WorkspaceEvent},
    language::{self, ServerState, jsonrpc},
    settings::SettingsStore,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SOURCE: &str = "import os\n\n\ndef greet(name):\n    return f'hello {name}'\n";

fn skip_unless_ruff() -> bool {
    if armadra_runtime::agent::resolve_command("ruff").is_some() {
        return false;
    }
    eprintln!("skipping: `ruff` is not installed on this machine");
    true
}

async fn next_matching(
    outbox: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    seconds: u64,
    matches: impl Fn(&Value) -> bool,
) -> Option<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(seconds), async {
        while let Some(body) = outbox.recv().await {
            let Ok(value) = serde_json::from_slice::<Value>(&body) else {
                continue;
            };
            if matches(&value) {
                return Some(value);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

#[tokio::test]
#[ignore = "needs `ruff` on PATH"]
async fn a_real_server_diagnoses_formats_and_its_edit_lands_on_disk() {
    if skip_unless_ruff() {
        return;
    }
    let directory = tempfile::tempdir().expect("a temporary project");
    let root = std::fs::canonicalize(directory.path()).expect("canonical root");
    std::fs::write(root.join("main.py"), SOURCE).expect("write the fixture");

    let settings = SettingsStore::in_memory(json!({}));
    let events = EventHub::new();
    let mut stream = events.subscribe("ws-1");
    let manager = language::Manager::new();

    // Discovery first: the launcher only ever runs the absolute path a probe
    // resolved, so nothing can start until `--version` has answered.
    let servers = language::discover::discover(&settings, "local", true, true).await;
    let python = servers
        .iter()
        .find(|server| server.language_id == "python")
        .expect("python is in the registry");
    assert_eq!(
        python.state,
        ServerState::Available,
        "ruff should probe cleanly: {python:?}"
    );
    assert_eq!(python.server_id, "ruff");
    assert!(!python.version.is_empty(), "the probe read a version");
    // Falling back to a linter narrows what is claimed rather than pretending.
    assert!(python.features.contains(&language::Feature::Diagnostics));
    assert!(!python.features.contains(&language::Feature::Completion));

    let mut session = manager
        .open_session(
            &settings, &events, "ws-1", &root, "python", "node-1", true, true,
        )
        .await
        .expect("the session opens");
    assert_eq!(session.state, ServerState::Running, "{:?}", session.reason);
    let hub = manager.hub("ws-1", "ruff").expect("the hub exists");

    // ---- diagnostics -----------------------------------------------------
    let uri = hub.rewriter.workspace_uri("main.py");
    let open = jsonrpc::notification(
        "textDocument/didOpen",
        json!({ "textDocument": {
            "uri": uri, "languageId": "python", "version": 1, "text": SOURCE
        }}),
    );
    language::session::handle(
        &hub,
        &session.session_id,
        &serde_json::to_vec(&open).unwrap(),
    );
    let published = next_matching(&mut session.outbox, 30, |value| {
        value.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
            && !value["params"]["diagnostics"]
                .as_array()
                .map(Vec::is_empty)
                .unwrap_or(true)
    })
    .await
    .expect("ruff published diagnostics for the unused import");
    let text = published.to_string();
    // F401 is "imported but unused" — the whole reason the fixture imports
    // `os` and never uses it.
    assert!(text.contains("F401"), "{text}");
    // The browser sees a workspace-relative uri and never an absolute path.
    assert_eq!(published["params"]["uri"], uri);
    assert!(!text.contains("file://"), "{text}");

    // ---- formatting ------------------------------------------------------
    let request = jsonrpc::request(
        &json!(1),
        "textDocument/formatting",
        json!({
            "textDocument": { "uri": uri },
            "options": { "tabSize": 4, "insertSpaces": true }
        }),
    );
    language::session::handle(
        &hub,
        &session.session_id,
        &serde_json::to_vec(&request).unwrap(),
    );
    let answer = next_matching(&mut session.outbox, 30, |value| {
        value.get("id") == Some(&json!(1))
    })
    .await
    .expect("formatting answered");
    let result = answer["result"].as_array().cloned().unwrap_or_default();
    assert!(
        !result.is_empty(),
        "ruff formats single quotes to double quotes: {answer}"
    );

    // ---- applying the edit ----------------------------------------------
    let edit = json!({ "changes": { uri.clone(): Value::Array(result) } });
    let files = language::edits::parse(&edit, &hub.rewriter).expect("the edit parses");
    let before = format!("{:x}", Sha256::digest(SOURCE.as_bytes()));
    let expected = HashMap::from([("main.py".to_owned(), before.clone())]);
    let applied =
        language::edits::apply(&root, "ws-1", &files, &expected, &events).expect("apply runs");
    assert!(applied.failed.is_empty(), "{:?}", applied.failed);
    assert_eq!(applied.applied.len(), 1);
    let after = std::fs::read_to_string(root.join("main.py")).expect("read back");
    assert_ne!(after, SOURCE, "the file on disk changed");
    assert_ne!(applied.applied[0].sha256, before, "the version moved");
    assert_eq!(
        applied.applied[0].sha256,
        format!("{:x}", Sha256::digest(after.as_bytes()))
    );

    // The write announces itself, which is how an open and clean editor
    // reloads — the same path an external change already takes.
    let mut announced = false;
    while let Ok(event) = stream.try_recv() {
        if let WorkspaceEvent::FileChanged { path, sha256, .. } = event
            && path == "main.py"
        {
            assert_eq!(sha256.as_deref(), Some(applied.applied[0].sha256.as_str()));
            announced = true;
        }
    }
    assert!(announced, "a `file.changed` event was published");

    // ---- shutdown --------------------------------------------------------
    let pid = hub
        .lock()
        .process
        .as_ref()
        .and_then(|process| process.pid)
        .expect("a running server has a pid");
    // The resource panel sees it as a platform component while it runs.
    assert!(
        manager
            .running_processes()
            .iter()
            .any(|target| target.pid == pid)
    );
    manager.close_session("ws-1", &session.session_id).await;
    manager.shutdown().await;
    assert!(manager.running_processes().is_empty());
}

#[tokio::test]
#[ignore = "needs `ruff` on PATH"]
async fn a_workspace_without_execute_lists_the_server_but_starts_nothing() {
    if skip_unless_ruff() {
        return;
    }
    let settings = SettingsStore::in_memory(json!({}));
    let servers = language::discover::discover(&settings, "local", false, true).await;
    let python = servers
        .iter()
        .find(|server| server.language_id == "python")
        .expect("python is listed even without the grant");
    // The row keeps the path and the version — hiding them would look like the
    // server is missing, which is a different problem with a different fix.
    assert_eq!(python.state, ServerState::Unsupported);
    assert_eq!(
        python.reason.as_deref(),
        Some(language::reason::EXECUTION_NOT_GRANTED)
    );
    assert!(!python.executable.is_empty());
    assert!(python.pid.is_none(), "nothing was started");

    let manager = language::Manager::new();
    let directory = tempfile::tempdir().expect("a temporary project");
    let refused = manager
        .open_session(
            &settings,
            &EventHub::new(),
            "ws-1",
            directory.path(),
            "python",
            "node-1",
            true,
            false,
        )
        .await;
    assert!(refused.is_err(), "no server may be started without execute");
    assert!(manager.running_processes().is_empty());
}

/// The rustup proxy is the reason discovery runs `--version` at all: the file
/// is on PATH whether or not the component is installed.
#[tokio::test]
#[ignore = "needs a rustup toolchain without the rust-analyzer component"]
async fn a_proxy_that_exists_but_cannot_run_is_a_probe_failure() {
    let Some(path) = armadra_runtime::agent::resolve_command("rust-analyzer") else {
        eprintln!("skipping: no `rust-analyzer` on PATH at all");
        return;
    };
    let settings = SettingsStore::in_memory(json!({}));
    let servers = language::discover::discover(&settings, "local", true, true).await;
    let rust = servers
        .iter()
        .find(|server| server.language_id == "rust")
        .expect("rust is in the registry");
    if rust.state == ServerState::Available {
        eprintln!("skipping: {} is a working rust-analyzer", path.display());
        return;
    }
    // "We could not find out" is its own answer, and it is not the same as
    // "there is nothing here" — which is exactly what a file-exists check
    // would have said.
    assert_eq!(rust.state, ServerState::Unsupported);
    assert_eq!(
        rust.reason.as_deref(),
        Some(language::reason::SERVER_PROBE_FAILED)
    );
}
