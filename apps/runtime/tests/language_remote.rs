#![cfg(unix)]
//! Editor language services on a remote execution host, over a real second
//! connection (language service design §2.7, batch D).
//!
//! **How this stands in for SSH.** Exactly as `remote_execution.rs` does:
//! `ARMADRA_REMOTE_WORKER_LAUNCHER` points at a shell script that parses `ssh`
//! options, discards them and runs the rest locally. Everything after argv[0]
//! is the production launch line — including `--language-link` — and what it
//! starts is the real binary speaking the real framed Protobuf protocol over a
//! real pipe. What is not covered is `ssh` itself.
//!
//! **What runs as the language server.** `tools/probes/mock-lsp.mjs`, pointed
//! at through a settings override in a temporary `ARMADRA_DATA_DIR`, so the
//! "remote" machine's own settings are what decide which program starts —
//! which is the rule this design has (§1.2). The real `ruff server` covers the
//! same path when this machine has it.
//!
//! The "remote" project is a temporary directory on this machine. The
//! controller is forbidden from touching it directly, so an answer that came
//! from the local filesystem would not prove anything — which is why the
//! assertions are about behaviour only the Worker can produce: a server
//! process it started, a method its allowlist refused, a session its death
//! disconnected.

use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use armadra_runtime::{
    events::{EventHub, WorkspaceEvent},
    language::{self, ServerState, jsonrpc},
    remote::{RemoteWorker, RemoteWorkers},
    terminal::ssh::{SshHost, SshWorker},
};
use serde_json::{Value, json};

const LAUNCHER: &str = "ARMADRA_REMOTE_WORKER_LAUNCHER";
const HOST_ID: &str = "box";
const WORKSPACE: &str = "ws-remote";
const ROOT_ID: &str = "root-remote";

/// An `ssh` stand-in. The Worker runs as a job so its pid can be recorded and
/// the tag says which of the two connections it is — that is what lets a test
/// pull the *language link* out from under the controller without touching the
/// serial one.
const SCRIPT: &str = r#"#!/bin/sh
tag=serial
case " $* " in *" --language-link "*) tag=link ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-p|-i) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
exec 3<&0
"$@" <&3 &
worker=$!
if [ -n "$ARMADRA_TEST_WORKER_PIDS" ]; then echo "$tag $worker" >> "$ARMADRA_TEST_WORKER_PIDS"; fi
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

/// The pids the launcher started for one kind of connection.
fn worker_pids(path: &Path, tag: &str) -> Vec<i32> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().split_once(' '))
        .filter(|(kind, _)| *kind == tag)
        .filter_map(|(_, pid)| pid.trim().parse().ok())
        .collect()
}

fn host(binary: &str) -> SshHost {
    SshHost {
        id: HOST_ID.into(),
        name: "Box".into(),
        host: "example.invalid".into(),
        user: Some("ada".into()),
        port: None,
        identity_file: None,
        extra_args: Vec::new(),
        worker: Some(SshWorker {
            path: binary.into(),
            state_dir: None,
        }),
    }
}

fn worker() -> Arc<RemoteWorker> {
    let workers = RemoteWorkers::new("0123456789abcdef0123456789abcdef".into());
    workers
        .get(Some(host(env!("CARGO_BIN_EXE_armadra-runtime"))), HOST_ID)
        .expect("the host has a Worker configured")
}

fn notification(method: &str, params: Value) -> Vec<u8> {
    serde_json::to_vec(&jsonrpc::notification(method, params)).unwrap()
}

fn request(id: &str, method: &str, params: Value) -> Vec<u8> {
    serde_json::to_vec(&jsonrpc::request(&Value::String(id.into()), method, params)).unwrap()
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

fn is_diagnostics(value: &Value) -> bool {
    value.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
}

/// One test function, because the launcher and the data directory are
/// process-wide environment: two tests racing to set them would be a data
/// race, and sequencing them here is both safe and closer to one host in use.
#[test]
fn a_remote_workspace_runs_language_servers_over_a_second_connection() {
    let temp = tempfile::tempdir().unwrap();
    let launcher = write_launcher(temp.path());
    let pids = temp.path().join("worker-pids");
    let data = temp.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let Some(node) = armadra_runtime::agent::resolve_command("node") else {
        eprintln!("skipping: `node` is not on PATH");
        return;
    };
    let mock = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/probes/mock-lsp.mjs")
        .canonicalize()
        .unwrap();
    // The execution host's *own* settings decide which program is a language
    // server. This is that file, on the machine the Worker runs on.
    std::fs::write(
        data.join("settings.json"),
        serde_json::to_vec_pretty(&json!({
            "language": { "servers": { "marksman": {
                "path": node.to_string_lossy(),
                "args": [mock.to_string_lossy()],
            }}}
        }))
        .unwrap(),
    )
    .unwrap();

    // SAFETY: single-threaded at this point; nothing else reads the environment.
    unsafe {
        std::env::set_var(LAUNCHER, &launcher);
        std::env::set_var("ARMADRA_TEST_WORKER_PIDS", &pids);
        std::env::set_var("ARMADRA_DATA_DIR", &data);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(mock_scenario(&pids));
    runtime.block_on(ruff_scenario());
}

/// Discovery, a session, diagnostics, the allowlist, an oversized answer and a
/// dropped link — all through `worker --stdio --language-link`.
async fn mock_scenario(pids: &Path) {
    let project = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(project.path()).unwrap();
    std::fs::write(root.join("notes.md"), "# notes\n\nTODO write this\n").unwrap();
    let root_path = root.to_str().unwrap().to_owned();
    let events = EventHub::new();
    let mut stream = events.subscribe(WORKSPACE);
    let worker = worker();

    // Discovery goes over the serial connection: it starts nothing, so a host
    // can be inspected before anybody opens an editor on it.
    let listed = worker
        .language_capabilities(ROOT_ID, &root_path, true)
        .await
        .expect("the execution host answers discovery");
    let servers = armadra_runtime::remote::language::descriptors(listed);
    let markdown = servers
        .iter()
        .find(|server| server.language_id == "markdown")
        .expect("markdown is in the registry");
    assert_eq!(markdown.state, ServerState::Available, "{markdown:?}");
    assert!(
        worker_pids(pids, "link").is_empty(),
        "discovery must not open the language link",
    );

    let link = worker
        .language
        .ensure(&worker, &events)
        .await
        .expect("the language link opens");
    let epoch = link.epoch();
    assert!(!epoch.is_empty(), "the link announces an epoch");
    assert_eq!(worker_pids(pids, "link").len(), 1, "exactly one link");

    let mut session = link
        .open_session(
            WORKSPACE, ROOT_ID, &root_path, "markdown", "node-1", true, true,
        )
        .await
        .expect("the session opens on the execution host");
    assert_eq!(session.state, ServerState::Running, "{:?}", session.reason);
    assert!(
        session.capabilities.get("hoverProvider").is_some(),
        "the server's own capabilities came back: {:?}",
        session.capabilities,
    );

    // ---- diagnostics over the link ---------------------------------------
    link.send(
        &session.session_id,
        notification(
            "textDocument/didOpen",
            json!({ "textDocument": {
                "uri": "armadra:///notes.md",
                "languageId": "markdown",
                "version": 1,
                "text": "# notes\n\nTODO write this\n",
            }}),
        ),
    )
    .await
    .expect("the notification crosses the link");
    let published = next_matching(&mut session.outbox, 30, is_diagnostics)
        .await
        .expect("diagnostics arrive over the link");
    assert_eq!(
        published["params"]["uri"], "armadra:///notes.md",
        "the browser is never shown an absolute path",
    );
    assert_eq!(published["params"]["diagnostics"][0]["source"], "mock-lsp");

    // ---- the allowlist runs on the execution host ------------------------
    link.send(
        &session.session_id,
        request(
            "x-1",
            "workspace/executeCommand",
            json!({ "command": "rm" }),
        ),
    )
    .await
    .expect("the request crosses the link");
    let refused = next_matching(&mut session.outbox, 15, |value| {
        value.get("id") == Some(&json!("x-1"))
    })
    .await
    .expect("the execution host answers");
    assert_eq!(
        refused["error"]["code"],
        jsonrpc::METHOD_NOT_FOUND,
        "executeCommand must be refused where it would run: {refused}",
    );

    // ---- an answer past the message ceiling ------------------------------
    // The mock only produces one on demand, so this covers the ordinary path;
    // the oversized branch has its own unit test against the window.
    link.send(
        &session.session_id,
        request(
            "h-1",
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "position": { "line": 0, "character": 3 },
            }),
        ),
    )
    .await
    .expect("the request crosses the link");
    let hover = next_matching(&mut session.outbox, 15, |value| {
        value.get("id") == Some(&json!("h-1"))
    })
    .await
    .expect("the hover answer comes back");
    assert_eq!(hover["result"]["contents"], "notes");

    // ---- the resource panel sees a remote server -------------------------
    let running: Vec<_> = link
        .descriptors()
        .into_iter()
        .filter(|server| server.pid.is_some())
        .collect();
    assert!(
        running.iter().any(|server| server.server_id == "marksman"),
        "the execution host reports the server it started: {running:?}",
    );

    // ---- restart and stop reach the remote process -----------------------
    // A button that quietly does nothing on one kind of workspace is worse
    // than no button, so these are asserted on the pid: a restart must have
    // produced a *different* process, and a stop must leave none at all.
    let before = running
        .iter()
        .find(|server| server.server_id == "marksman")
        .and_then(|server| server.pid)
        .expect("the execution host reports the pid it started");
    let restarted = link
        .control(
            WORKSPACE,
            ROOT_ID,
            &root_path,
            "marksman",
            language::Control::Restart,
            true,
        )
        .await
        .expect("a remote server restarts");
    assert_eq!(restarted.state, ServerState::Running, "{restarted:?}");
    assert!(
        restarted.pid.is_some_and(|pid| pid != before),
        "restart replaced the process rather than reporting the old one: {restarted:?}",
    );
    // Without the execute grant the restart is refused on the machine that
    // would start the process, not merely hidden in the interface.
    assert!(
        link.control(
            WORKSPACE,
            ROOT_ID,
            &root_path,
            "marksman",
            language::Control::Restart,
            false,
        )
        .await
        .is_err(),
        "a restart without the execute grant must be refused where it would run",
    );
    let stopped = link
        .control(
            WORKSPACE,
            ROOT_ID,
            &root_path,
            "marksman",
            language::Control::Stop,
            true,
        )
        .await
        .expect("a remote server stops");
    assert_eq!(stopped.state, ServerState::Stopped);
    assert_eq!(stopped.pid, None, "a stopped server reports no process");
    // The restart replayed `didOpen`, so the session has diagnostics waiting.
    // The next assertion is about the outbox *closing*, and a queue with
    // anything left in it would answer that question with the wrong message.
    while session.outbox.try_recv().is_ok() {}

    // ---- the link dies ---------------------------------------------------
    let started = worker_pids(pids, "link");
    unsafe { libc::kill(started[0], libc::SIGKILL) };
    let disconnected = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            match stream.recv().await {
                Ok(WorkspaceEvent::LanguageSession {
                    state: ServerState::Disconnected,
                    reason,
                    ..
                }) => return reason,
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    })
    .await
    .expect("the controller notices the link died");
    assert_eq!(disconnected.as_deref(), Some(language::reason::LINK_LOST));
    // The socket closes, so a client stops waiting rather than hanging on a
    // session whose server is on a machine we can no longer reach.
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), session.outbox.recv())
            .await
            .expect("the outbox closes")
            .is_none(),
    );
    assert!(!link.alive(), "the link reports itself dead");

    // ---- and is rebuilt under a new epoch --------------------------------
    let rebuilt = worker
        .language
        .ensure(&worker, &events)
        .await
        .expect("a new link opens");
    assert_ne!(rebuilt.epoch(), epoch, "a rebuilt link mints a new epoch");
    let mut second = rebuilt
        .open_session(
            WORKSPACE, ROOT_ID, &root_path, "markdown", "node-1", true, true,
        )
        .await
        .expect("the session opens again");
    assert_eq!(second.state, ServerState::Running, "{:?}", second.reason);
    // Nothing is replayed on the controller's behalf: the client re-opens its
    // documents, and only then do diagnostics come back.
    rebuilt
        .send(
            &second.session_id,
            notification(
                "textDocument/didOpen",
                json!({ "textDocument": {
                    "uri": "armadra:///notes.md",
                    "languageId": "markdown",
                    "version": 1,
                    "text": "# notes\n\nTODO write this\n",
                }}),
            ),
        )
        .await
        .expect("the notification crosses the new link");
    assert!(
        next_matching(&mut second.outbox, 30, is_diagnostics)
            .await
            .is_some(),
        "the rebuilt session diagnoses again",
    );
    assert_eq!(
        worker_pids(pids, "link").len(),
        2,
        "the drop started exactly one replacement",
    );
    worker.language.release().await;
}

/// The same path against a server nobody wrote for this proxy.
async fn ruff_scenario() {
    if armadra_runtime::agent::resolve_command("ruff").is_none() {
        eprintln!("skipping the real-server half: `ruff` is not installed on this machine");
        return;
    }
    let project = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(project.path()).unwrap();
    std::fs::write(
        root.join("main.py"),
        "import os\n\n\ndef greet():\n    return 1\n",
    )
    .unwrap();
    let root_path = root.to_str().unwrap().to_owned();
    let events = EventHub::new();
    let worker = worker();
    let link = worker
        .language
        .ensure(&worker, &events)
        .await
        .expect("the language link opens");
    let mut session = link
        .open_session(
            WORKSPACE, ROOT_ID, &root_path, "python", "node-2", true, true,
        )
        .await
        .expect("the session opens");
    assert_eq!(session.server_id, "ruff");
    assert_eq!(session.state, ServerState::Running, "{:?}", session.reason);
    link.send(
        &session.session_id,
        notification(
            "textDocument/didOpen",
            json!({ "textDocument": {
                "uri": "armadra:///main.py",
                "languageId": "python",
                "version": 1,
                "text": "import os\n\n\ndef greet():\n    return 1\n",
            }}),
        ),
    )
    .await
    .expect("the notification crosses the link");
    let published = next_matching(&mut session.outbox, 60, |value| {
        is_diagnostics(value)
            && !value["params"]["diagnostics"]
                .as_array()
                .map(Vec::is_empty)
                .unwrap_or(true)
    })
    .await
    .expect("ruff diagnoses the unused import over the link");
    assert_eq!(published["params"]["uri"], "armadra:///main.py");
    assert!(
        published["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "F401"),
        "the unused import is reported: {published}",
    );
    worker.language.release().await;
}
