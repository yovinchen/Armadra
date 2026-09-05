//! The same router, served over a socket instead of a port — roadmap §4.4.
//!
//! A desktop install listens on a Unix socket only, so both halves of the
//! Runtime API have to work there: ordinary HTTP *and* the WebSocket upgrade
//! the terminal and event streams depend on. These tests drive a real listener
//! (no `oneshot`) so an upgrade that only works over TCP would fail here.

#![cfg(unix)]

use std::path::Path;

use armadra_runtime::{
    AppState, db, endpoints,
    events::EventHub,
    hook::HookService,
    listen::{self, ListenSpec},
    router_with_state,
    settings::SettingsStore,
    terminal::TerminalManager,
    usage::UsageService,
};
use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Fixture {
    socket: std::path::PathBuf,
    workspace_id: String,
    stop: tokio::sync::oneshot::Sender<()>,
    served: tokio::task::JoinHandle<std::io::Result<()>>,
    _directory: tempfile::TempDir,
}

async fn serve_on_socket() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("canvas.db").display()
    ))
    .await
    .unwrap();
    let workspace_id = db::create_workspace(
        &pool,
        "socket",
        project.to_str().unwrap(),
        None,
        Default::default(),
    )
    .await
    .unwrap()
    .id;
    let events = EventHub::new();
    let settings = SettingsStore::load();
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
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
        router_with_state(state),
        async move {
            let _ = stopped.await;
        },
    ));
    Fixture {
        socket,
        workspace_id,
        stop,
        served,
        _directory: directory,
    }
}

/// A minimal HTTP/1.1 exchange over the socket. Deliberately hand-rolled: a
/// client library could hide the fact that the connection is a Unix socket.
async fn get(socket: &Path, path: &str) -> (u16, String) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: armadra.invalid\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line).await.unwrap();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let mut body = String::new();
    let mut line = String::new();
    let mut in_body = false;
    loop {
        line.clear();
        if reader.read_line(&mut line).await.unwrap() == 0 {
            break;
        }
        if in_body {
            body.push_str(&line);
        } else if line.trim().is_empty() {
            in_body = true;
        }
    }
    (status, body)
}

#[tokio::test]
async fn http_requests_are_answered_over_a_unix_socket() {
    let fixture = serve_on_socket().await;
    let (status, body) = get(&fixture.socket, "/health").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"status\":\"ok\""), "{body}");
    // A socket-only Runtime advertises no port for hook clients to try.
    assert!(!body.contains("\"port\""), "{body}");

    let (status, body) = get(&fixture.socket, "/api/workspaces").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(&fixture.workspace_id), "{body}");

    let _ = fixture.stop.send(());
    fixture.served.await.unwrap().unwrap();
}

#[tokio::test]
async fn websocket_upgrades_complete_over_a_unix_socket() {
    let fixture = serve_on_socket().await;
    let stream = tokio::net::UnixStream::connect(&fixture.socket)
        .await
        .unwrap();
    // The URI's authority is never dialled — the socket already decided where
    // this goes — but the Origin check is the same one a browser would face.
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(format!(
            "ws://armadra.invalid/api/workspaces/{}/events",
            fixture.workspace_id
        ))
        .header("Host", "armadra.invalid")
        .header("Origin", "tauri://localhost")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .unwrap();
    let (mut socket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("the events socket should upgrade over a Unix socket");
    assert_eq!(response.status().as_u16(), 101);
    // Closing from our side is what ends the handler; the point of the test is
    // that the upgrade itself completed on a transport with no port.
    socket.close(None).await.unwrap();
    while socket.next().await.transpose().unwrap_or(None).is_some() {}

    let _ = fixture.stop.send(());
    fixture.served.await.unwrap().unwrap();
}

/// Reaching the Runtime through a socket is not an origin exemption: the same
/// check a TCP WebSocket faces still runs, so a page that got hold of the path
/// cannot skip it.
#[tokio::test]
async fn a_socket_websocket_still_enforces_the_origin_check() {
    let fixture = serve_on_socket().await;
    for origin in ["https://evil.example", "http://127.0.0.1.evil.example"] {
        let stream = tokio::net::UnixStream::connect(&fixture.socket)
            .await
            .unwrap();
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!(
                "ws://armadra.invalid/api/workspaces/{}/events",
                fixture.workspace_id
            ))
            .header("Host", "armadra.invalid")
            .header("Origin", origin)
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .body(())
            .unwrap();
        let error = tokio_tungstenite::client_async(request, stream)
            .await
            .err()
            .unwrap_or_else(|| panic!("{origin} should not have been upgraded"));
        assert!(
            matches!(
                error,
                tokio_tungstenite::tungstenite::Error::Http(ref response)
                    if response.status().as_u16() == 403
            ),
            "{error}"
        );
    }
    // And a plain GET is still not an upgrade.
    let (status, _) = get(
        &fixture.socket,
        &format!("/api/workspaces/{}/events", fixture.workspace_id),
    )
    .await;
    assert_eq!(status, 400);
    let _ = fixture.stop.send(());
    fixture.served.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_tcp_runtime_publishes_the_port_the_kernel_chose() {
    let directory = tempfile::tempdir().unwrap();
    let listener = listen::bind(&ListenSpec::parse("tcp:127.0.0.1:0").unwrap())
        .await
        .unwrap();
    let port = listener.tcp_port().expect("a TCP listener has a port");
    assert_ne!(port, 0);
    let path = endpoints::file(directory.path());
    let mut record = endpoints::ServiceEndpoint::now("instance");
    record.http = Some(format!("http://127.0.0.1:{port}"));
    record.websocket = Some(format!("ws://127.0.0.1:{port}"));
    endpoints::publish(&path, endpoints::RUNTIME_SERVICE, record).unwrap();

    let published = endpoints::read(&path);
    let runtime = published.service(endpoints::RUNTIME_SERVICE).unwrap();
    assert_eq!(
        runtime.http.as_deref(),
        Some(&*format!("http://127.0.0.1:{port}"))
    );
    assert!(runtime.socket.is_none());

    // The same port is refused rather than silently moved.
    let error = listen::bind(&ListenSpec::parse(&format!("tcp:127.0.0.1:{port}")).unwrap())
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("already in use"), "{error}");
}
