//! The session socket over the real router — language service design §2.9.
//!
//! One thing is proved here that no unit test can: **the socket is the
//! session's lifetime.** A browser tab that reloads, a page that crashes and a
//! machine that sleeps all end the same way — the WebSocket closes and nothing
//! else happens. If the controller leaves the session behind, its shadow
//! documents stay open, and the *next* session for the same file is told it is
//! a follower (design §2.2 `documents`): it never sends `didOpen`, so the
//! server never re-publishes, and the editor sits there with no diagnostics
//! and no error to explain them.
//!
//! Needs `node` for `tools/probes/mock-lsp.mjs`; skips itself, loudly, when it
//! is missing.

#![cfg(unix)]

use std::path::Path;

use armadra_runtime::{
    AppState, db,
    events::EventHub,
    hook::HookService,
    listen::{self, ListenSpec},
    model::WorkspacePermissions,
    resources::ResourceService,
    router_with_state,
    settings::SettingsStore,
    terminal::TerminalManager,
    usage::UsageService,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Fixture {
    socket: std::path::PathBuf,
    workspace_id: String,
    state: AppState,
    stop: tokio::sync::oneshot::Sender<()>,
    served: tokio::task::JoinHandle<std::io::Result<()>>,
    _directory: tempfile::TempDir,
}

/// The mock is a Node script, so the "server" the settings pin is `node`, with
/// the script as its argument. Discovery runs `<program> --version` and
/// nothing else, so `node --version` is what decides this server exists — and
/// that is the point: the launcher only ever runs a path a probe resolved.
fn mock_settings() -> Option<Value> {
    let node = armadra_runtime::agent::resolve_command("node")?;
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/probes/mock-lsp.mjs")
        .to_string_lossy()
        .into_owned();
    Some(json!({
        "language": {
            "servers": {
                "marksman": {
                    "path": node.to_string_lossy(),
                    "args": [script],
                }
            }
        }
    }))
}

async fn serve() -> Option<Fixture> {
    let settings = SettingsStore::in_memory(mock_settings()?);
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("notes.md"), "alpha\n").unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("canvas.db").display()
    ))
    .await
    .unwrap();
    let workspace_id = db::create_workspace(
        &pool,
        "language",
        project.to_str().unwrap(),
        None,
        Some(&WorkspacePermissions {
            read: true,
            write: true,
            execute: true,
        }),
    )
    .await
    .unwrap()
    .id;
    let events = EventHub::new();
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        resources: ResourceService::new(settings.clone()),
        terminals: TerminalManager::new(pool.clone(), events.clone()),
        hooks: HookService::new(directory.path().to_path_buf(), None),
        usage: UsageService::new(settings.clone()),
        events,
        pool,
        settings,
    };
    let socket = directory.path().join("runtime.sock");
    let listener = listen::bind(&ListenSpec::Unix(socket.clone()))
        .await
        .unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let served = tokio::spawn(listen::serve(
        listener,
        router_with_state(state.clone()),
        async move {
            let _ = stopped.await;
        },
    ));
    Some(Fixture {
        socket,
        workspace_id,
        state,
        stop,
        served,
        _directory: directory,
    })
}

async fn get(socket: &Path, path: &str) -> (u16, String) {
    exchange(
        socket,
        format!("GET {path} HTTP/1.1\r\nHost: armadra.invalid\r\nConnection: close\r\n\r\n"),
    )
    .await
}

/// A hand-rolled `POST`, for the same reason `listen_transports.rs` hand-rolls
/// its `GET`: a client library would hide that this is a Unix socket.
async fn post(socket: &Path, path: &str, body: &str) -> (u16, String) {
    exchange(
        socket,
        format!(
            "POST {path} HTTP/1.1\r\nHost: armadra.invalid\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
    .await
}

async fn exchange(socket: &Path, request: String) -> (u16, String) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line).await.unwrap();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let mut payload = String::new();
    let mut line = String::new();
    let mut in_body = false;
    loop {
        line.clear();
        if reader.read_line(&mut line).await.unwrap() == 0 {
            break;
        }
        if in_body {
            payload.push_str(&line);
        } else if line.trim().is_empty() {
            in_body = true;
        }
    }
    (status, payload)
}

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::UnixStream>;

async fn connect(socket: &Path, workspace_id: &str, session_id: &str) -> Socket {
    let stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(format!(
            "ws://armadra.invalid/api/workspaces/{workspace_id}/language/sessions/{session_id}/stream"
        ))
        .header("Host", "armadra.invalid")
        .header("Origin", "http://127.0.0.1:1420")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .unwrap();
    let (socket, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("the session socket upgrades");
    socket
}

/// Sends `didOpen` and waits for the mock's diagnostics for that uri.
async fn open_and_wait(socket: &mut Socket, uri: &str) -> bool {
    let did_open = json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": { "textDocument": {
            "uri": uri, "languageId": "markdown", "version": 1, "text": "alpha TODO\n"
        }}
    });
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            did_open.to_string().into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while let Some(Ok(message)) = socket.next().await {
            let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value["method"] == "textDocument/publishDiagnostics" && value["params"]["uri"] == uri
            {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

#[tokio::test]
async fn a_closed_socket_ends_its_session_so_the_next_one_owns_the_document() {
    let Some(fixture) = serve().await else {
        eprintln!("skipping: `node` is not installed on this machine");
        return;
    };

    // Discovery first, exactly as the browser does it: the launcher only ever
    // runs a path a probe froze, so a session before the first probe would be
    // told `server_not_found` on a machine that has the server.
    let (status, body) = get(
        &fixture.socket,
        &format!("/api/workspaces/{}/language-service", fixture.workspace_id),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    let (status, body) = post(
        &fixture.socket,
        &format!("/api/workspaces/{}/language/sessions", fixture.workspace_id),
        r#"{"languageId":"markdown","clientId":"node-1"}"#,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let first: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(first["state"], "running", "{body}");

    let uri = "armadra:///notes.md";
    let mut socket = connect(
        &fixture.socket,
        &fixture.workspace_id,
        first["sessionId"].as_str().unwrap(),
    )
    .await;
    assert!(open_and_wait(&mut socket, uri).await, "no diagnostics");

    let hub = fixture
        .state
        .language
        .hub(&fixture.workspace_id, "marksman")
        .expect("the hub exists");
    assert_eq!(hub.descriptor().open_documents, 1);

    // The tab goes away. Nothing else happens — no `DELETE`, no goodbye.
    drop(socket);

    // The document is released, so the server is told the file closed.
    let released = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while hub.descriptor().open_documents != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        released.is_ok(),
        "the closed socket left its documents open"
    );

    // And the next session is an owner, not a follower: it sends `didOpen`,
    // and the diagnostics come back.
    let (status, body) = post(
        &fixture.socket,
        &format!("/api/workspaces/{}/language/sessions", fixture.workspace_id),
        r#"{"languageId":"markdown","clientId":"node-2"}"#,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let second: Value = serde_json::from_str(&body).unwrap();
    let mut socket = connect(
        &fixture.socket,
        &fixture.workspace_id,
        second["sessionId"].as_str().unwrap(),
    )
    .await;
    assert!(
        open_and_wait(&mut socket, uri).await,
        "a reloaded tab got no diagnostics",
    );

    drop(socket);
    let _ = fixture.stop.send(());
    let _ = fixture.served.await;
}
