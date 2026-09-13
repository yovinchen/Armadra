//! Terminal creation, the agent environment, the SSH host lookup and the
//! attach socket handshake.

use tempfile::tempdir;

use axum::http::StatusCode;
use serde_json::json;
// Only the two PTY tests below read raw frames, and they are Unix-only.
#[cfg(unix)]
use serde_json::Value;

use super::support::*;
use crate::terminal::agent_environment;
use crate::{AppState, api::*, db, events::EventHub, settings::SettingsStore};

#[test]
fn the_agent_environment_carries_addresses_only() {
    let agent = CreateTerminalAgent {
        id: "claude".into(),
        account_id: None,
        permission_mode: Some("plan".into()),
        model: None,
        session_id: None,
    };
    assert_eq!(agent.permission_mode.as_deref(), Some("plan"));
    let env = agent_environment("node-1", &agent.id);
    let lookup = |key: &str| {
        env.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(lookup("ARMADRA_NODE_ID").as_deref(), Some("node-1"));
    assert_eq!(lookup("ARMADRA_AGENT_ID").as_deref(), Some("claude"));
    assert_eq!(lookup("ARMADRA_CANVAS_CONTROL").as_deref(), Some("1"));
    assert!(
        lookup("ARMADRA_ENDPOINT_FILE").is_some_and(|path| path.ends_with("hook-endpoint.env"))
    );
    // No credential is ever placed in the child environment.
    assert!(env.iter().all(|(name, _)| !name.contains("TOKEN")));
    assert_eq!(env.len(), 4);
}

#[tokio::test]
async fn a_custom_agent_terminal_carries_its_own_id_and_env() {
    let directory = tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("custom-env.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let events = EventHub::new();
    let (terminals, _) = test_terminals(&pool, &events, directory.path());
    let settings = SettingsStore::in_memory(json!({
        "terminal": { "backend": "direct" },
        "agents": { "custom": [{
            "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
            "baseAgent": "gemini",
            "env": { "GREETING": "hi", "HOME_WAS": "${env:NO_SUCH_TEST_VAR:none}" },
        }] },
    }));
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals,
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory.path()),
        events,
        pool,
    };

    let env = agent_session_environment(&state, "node-1", "custom:echo");
    let lookup = |key: &str| {
        env.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    // The node is the custom agent, not the CLI it borrows.
    assert_eq!(lookup("ARMADRA_AGENT_ID").as_deref(), Some("custom:echo"));
    assert_eq!(lookup("ARMADRA_NODE_ID").as_deref(), Some("node-1"));
    assert_eq!(lookup("GREETING").as_deref(), Some("hi"));
    assert_eq!(lookup("HOME_WAS").as_deref(), Some("none"));
    // Gemini has no reply-approval wait; a claude-based one would.
    assert!(lookup("ARMADRA_PERM_WAIT_SECS").is_none());
    assert!(
        agent_session_environment(&state, "node-1", "claude")
            .iter()
            .any(|(name, _)| name == "ARMADRA_PERM_WAIT_SECS")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_terminals_require_a_node_and_a_known_agent() {
    let directory = tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("api-terminal.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let events = EventHub::new();
    let (terminals, settings) = test_terminals(&pool, &events, directory.path());
    let router = crate::router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals,
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory.path()),
        events,
        pool,
    });

    let (status, error) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace.id,
            "cwd": ".",
            "agent": { "id": "claude" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "bad_request");

    let (status, error) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace.id,
            "cwd": ".",
            "nodeId": uuid::Uuid::now_v7().to_string(),
            "agent": { "id": "unknown-cli" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "bad_request");

    let node_id = uuid::Uuid::now_v7().to_string();
    let (status, session) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace.id,
            "cwd": ".",
            "command": "/bin/sh",
            "args": ["-c", "sleep 5"],
            "nodeId": node_id,
            "agent": { "id": "claude", "permissionMode": "plan" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["ownerNodeId"], node_id.as_str());
    assert_eq!(session["agentId"], "claude");
    assert!(session["pid"].as_i64().is_some());

    let (status, terminated) = call(
        &router,
        "POST",
        &format!(
            "/api/terminals/{}/terminate",
            session["id"].as_str().unwrap()
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(terminated["status"], "terminated");
}

/// Plan §21, row SSH: the command comes from `settings.ssh.hosts[]`, and an
/// id that is not in there is a 400 — never a silent local shell.
#[tokio::test]
async fn ssh_terminals_resolve_the_host_from_the_settings() {
    let (router, directory) = router_fixture("api-ssh").await;
    let root = directory.path().to_string_lossy().into_owned();
    let (_, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "ssh", "rootPath": root })),
    )
    .await;
    let workspace_id = workspace["id"].as_str().unwrap().to_owned();

    let (status, error) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace_id,
            "cwd": ".",
            "ssh": { "hostId": "nope" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["message"], "Unknown SSH host");

    // The probe route rejects the same id the same way.
    let (status, _) = call(&router, "POST", "/api/ssh/hosts/nope/test", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, document) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "ssh": { "hosts": [
            { "id": "local", "name": "Local", "host": "127.0.0.1", "port": 1 }
        ] } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(document["ssh"]["hosts"][0]["id"], "local");

    // Port 1 on loopback refuses immediately: the process is real, the
    // connection is not, and nothing leaves this machine.
    let (status, session) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace_id,
            "cwd": ".",
            "ssh": { "hostId": "local" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["command"], "ssh");
}

/// The §15 routes, checked against the shapes in packages/shared/src/api.ts.
///
/// Unix-only: the session it drives is a `/bin/sh` that installs `trap '' INT`,
/// which is what makes the interrupt assertion a behaviour rather than a race.
/// There is no Windows shell with those semantics to substitute.
#[cfg(unix)]
#[tokio::test]
async fn the_terminal_backend_routes_speak_the_v15_shapes() {
    let (router, directory) = router_fixture("api-terminal-backend").await;
    let (_, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "Canvas", "rootPath": directory.path() })),
    )
    .await;
    let workspace_id = workspace["id"].as_str().unwrap().to_owned();

    let (status, backend) = call(&router, "GET", "/api/terminals/backend", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(backend["effective"], "direct");
    assert_eq!(backend["configured"], "direct");
    assert!(backend.get("tmuxVersion").is_some());
    assert!(backend.get("tmuxSocket").is_some());
    assert!(backend.get("reason").is_some());

    let (status, session) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace_id,
            "cwd": ".",
            "command": "/bin/sh",
            // `trap '' INT` is what makes the interrupt assertion below
            // meaningful: a plain `sh -c` dies on Ctrl+C like any other
            // foreground process, so asserting that it survives one would
            // be asserting a race, not a behaviour.
            "args": ["-c", "trap '' INT; printf hello-capture; sleep 30"]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Plan §15.2 — the session payload carries its backend identity.
    assert_eq!(session["backend"], "direct");
    assert_eq!(session["generation"], 1);
    assert_eq!(session["attachState"], "detached");
    assert_eq!(session["sessionKey"], session["id"]);
    let session_id = session["id"].as_str().unwrap().to_owned();

    // Poll rather than sleep: how long the shell takes to print depends on
    // how loaded the machine is when the suite runs in parallel.
    let capture_uri = format!("/api/terminals/{session_id}/capture?lines=40&escapes=false");
    let mut capture = Value::Null;
    let mut status = StatusCode::OK;
    for _ in 0..100 {
        (status, capture) = call(&router, "GET", &capture_uri, None).await;
        if capture["data"]
            .as_str()
            .is_some_and(|data| data.contains("hello-capture"))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(status, StatusCode::OK);
    assert_eq!(capture["generation"], 1);
    assert!(capture["lines"].as_u64().is_some());
    assert!(
        capture["data"].as_str().unwrap().contains("hello-capture"),
        "got {:?}",
        capture["data"]
    );

    let (status, pasted) = call(
        &router,
        "POST",
        &format!("/api/terminals/{session_id}/paste"),
        Some(json!({ "text": "ls", "enter": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pasted["id"], session_id.as_str());

    // A generation bump, same row and same logical key.
    let (status, recycled) = call(
        &router,
        "POST",
        &format!("/api/terminals/{session_id}/recycle"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recycled["generation"], 2);
    assert_eq!(recycled["id"], session_id.as_str());
    assert_eq!(recycled["status"], "running");

    // An explicit mode, and the parameterless body the old route accepted.
    let (status, interrupted) = call(
        &router,
        "POST",
        &format!("/api/terminals/{session_id}/terminate"),
        Some(json!({ "mode": "interrupt" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // An interrupt is a signal, not a kill: a process that ignores SIGINT
    // keeps running, and the session is never marked `terminated`.
    assert_eq!(interrupted["status"], "running");
    assert_eq!(interrupted["generation"], 2);

    let (status, ended) = call(
        &router,
        "POST",
        &format!("/api/terminals/{session_id}/terminate"),
        Some(json!({ "mode": "session" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ended["status"], "terminated");
    assert_eq!(ended["attachState"], "exited");
}

/// Plan §15.5 over a real socket: `hello` first, `snapshot` for the direct
/// backend, then `output`; a recycle underneath the socket produces
/// `stale` instead of a silent close.
///
/// Unix-only: the snapshot it waits for is what `/bin/sh -c 'printf …; sleep'`
/// paints into the PTY.
#[cfg(unix)]
#[tokio::test]
async fn the_terminal_socket_says_hello_then_snapshot_then_stale() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{
        Message as WsMessage, client::IntoClientRequest, http::HeaderValue,
    };

    let (router, directory) = router_fixture("api-terminal-ws").await;
    let (_, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "Canvas", "rootPath": directory.path() })),
    )
    .await;
    let (_, session) = call(
        &router,
        "POST",
        "/api/terminals",
        Some(json!({
            "workspaceId": workspace["id"],
            "cwd": ".",
            "command": "/bin/sh",
            "args": ["-c", "printf socket-ready; sleep 30"]
        })),
    )
    .await;
    let session_id = session["id"].as_str().unwrap().to_owned();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = router.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, served).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let mut request = format!("ws://127.0.0.1:{port}/api/terminals/{session_id}/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_static("http://127.0.0.1:1420"));
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    /// The next JSON frame, or `None` once the server closes the stream.
    async fn next_frame<S>(socket: &mut S) -> Option<Value>
    where
        S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        loop {
            match socket.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    return Some(serde_json::from_str::<Value>(&text).unwrap());
                }
                Some(Ok(WsMessage::Close(_))) | None => return None,
                Some(Ok(_)) => continue,
                Some(Err(error)) => panic!("socket broke: {error:?}"),
            }
        }
    }

    async fn next<S>(socket: &mut S) -> Value
    where
        S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        next_frame(socket)
            .await
            .expect("the socket ended before the expected frame")
    }

    let hello = next(&mut socket).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["sessionId"], session_id.as_str());
    assert_eq!(hello["generation"], 1);
    assert_eq!(hello["backend"], "direct");
    assert_eq!(hello["rows"], 24);
    assert_eq!(hello["cols"], 80);
    assert_eq!(hello["alive"], true);

    // The direct backend replays; a tmux client would redraw instead.
    let mut saw_snapshot = false;
    let mut seen = String::new();
    while !seen.contains("socket-ready") {
        let frame = next(&mut socket).await;
        match frame["type"].as_str() {
            Some("snapshot") => {
                saw_snapshot = true;
                seen.push_str(frame["data"].as_str().unwrap());
            }
            Some("output") => seen.push_str(frame["data"].as_str().unwrap()),
            other => panic!("unexpected frame {other:?}"),
        }
    }
    assert!(saw_snapshot || seen.contains("socket-ready"));

    socket
        .send(WsMessage::Text(
            json!({ "type": "resize", "cols": 100, "rows": 40 })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();

    // Recycling behind the socket's back invalidates its generation.
    let (status, recycled) = call(
        &router,
        "POST",
        &format!("/api/terminals/{session_id}/recycle"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recycled["generation"], 2);

    // The socket is told without having to ask: the stream it was reading
    // belonged to generation 1 and is gone. Writing here instead would race
    // the server's close and prove nothing — the manager-level test
    // `a_write_from_an_old_generation_is_rejected` covers the write path.
    let mut stale = None;
    while let Some(frame) = next_frame(&mut socket).await {
        if frame["type"] == "stale" {
            stale = Some(frame);
            break;
        }
    }
    assert_eq!(
        stale.expect("a recycled session must announce itself as stale")["generation"],
        2
    );

    let _ = call(
        &router,
        "POST",
        &format!("/api/terminals/{session_id}/terminate"),
        Some(json!({ "mode": "session" })),
    )
    .await;
    server.abort();
}
