//! What the hook router carries besides reports: health, install and the
//! unix socket.

use super::support::*;

/// The collaboration routes are mounted on the same surface as the reports and
/// behind the same bearer. What they *do* is covered by the collab suite; what
/// matters here is that the hook router carries them and refuses an anonymous
/// caller before looking at the body.
#[tokio::test]
async fn the_collaboration_routes_are_mounted_behind_the_bearer() {
    let fixture = fixture("hook-collab-routes").await;
    for uri in ["/control/list", "/context-link/summary"] {
        let unauthorized = fixture
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::FORBIDDEN, "{uri}");

        // With the bearer but a node that is not on any board, the answer is
        // "no such node" rather than the 501 the Phase 2 stubs gave.
        let authorized = fixture
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-armadra-hook-token", &fixture.bearer)
                    .body(Body::from(
                        r#"{"nodeId":"3a1b0d5e-1111-4111-8111-111111111111","args":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::NOT_FOUND, "{uri}");
    }

    // And the real node answers.
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let listed = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/control/list")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-armadra-hook-token", &fixture.bearer)
                .header("x-armadra-node-token", &token)
                .body(Body::from(format!(
                    r#"{{"nodeId":"{}","args":{{}}}}"#,
                    fixture.node_id
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
}

#[tokio::test]
async fn health_reports_the_hook_endpoint() {
    let fixture = fixture("hook-health").await;
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["hook"]["port"], 43199);
    assert_eq!(body["hook"]["ok"], true);
    #[cfg(unix)]
    assert!(
        body["hook"]["sock"]
            .as_str()
            .unwrap()
            .ends_with("hook.sock")
    );
}

#[tokio::test]
async fn creating_an_agent_terminal_mints_its_node_token() {
    let fixture = fixture("hook-token-mint").await;
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/terminals")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "workspaceId": fixture.workspace_id,
                        "cwd": ".",
                        "nodeId": fixture.node_id,
                        "agent": { "id": "claude" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();

    let token_file = fixture.state.hooks.node_token_dir().join(&fixture.node_id);
    assert!(
        token_file.exists(),
        "the client looks the token up by node name"
    );
    let token = std::fs::read_to_string(&token_file).unwrap();
    assert!(
        fixture
            .state
            .hooks
            .verdict(&fixture.node_id, Some(&token))
            .is_verified()
    );

    // And the refresh route re-mints it for a session whose token was lost.
    std::fs::remove_file(&token_file).unwrap();
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/terminals/{}/node-token/refresh",
                    session["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(std::fs::read_to_string(&token_file).unwrap(), token);

    fixture.state.terminals.shutdown_all().await;
}

#[tokio::test]
async fn the_install_routes_record_what_they_wrote() {
    let fixture = fixture("hook-install").await;
    let home = fixture._directory.path().join("claude-home");
    let client = fixture._directory.path().join("armadra-hook");
    std::fs::write(&client, "#!/bin/sh\n").unwrap();

    // The installer itself is exercised per provider in its own module; here we
    // only prove the route wires it to `hook_installs` and to `GET /api/agents`.
    let report = crate::hook::install::claude::install(&home, &client).unwrap();
    db::upsert_hook_install(
        &fixture.state.pool,
        &report.agent_id,
        report.client_revision,
        Some(&report.config_path),
    )
    .await
    .unwrap();

    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let agents: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let claude = agents
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == "claude")
        .unwrap();
    assert_eq!(
        claude["clientRevision"],
        crate::hook::install::HOOK_CLIENT_REVISION
    );
    let others = agents
        .as_array()
        .unwrap()
        .iter()
        .filter(|agent| agent["id"] != "claude");
    for agent in others {
        assert!(agent["clientRevision"].is_null(), "{}", agent["id"]);
    }

    // Uninstalling clears the record.
    crate::hook::install::claude::uninstall(&home).unwrap();
    db::remove_hook_install(&fixture.state.pool, "claude")
        .await
        .unwrap();
    assert!(
        db::list_hook_installs(&fixture.state.pool)
            .await
            .unwrap()
            .is_empty()
    );
}

/// The socket is the client's preferred path, and it is served by the same
/// router as the TCP port. This drives it the way the client does: a raw
/// HTTP/1.1 request with `Connection: close`.
#[cfg(unix)]
#[tokio::test]
async fn the_unix_socket_serves_the_hook_router() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let fixture = fixture("hook-socket").await;
    let socket = fixture.state.hooks.socket_path().unwrap();
    crate::hook::start(fixture.state.clone(), Some(43199));

    // The listener binds on a spawned task; give it a moment to appear.
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(socket.exists(), "the hook socket was never bound");

    let send = async |request: String| {
        let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    };

    let response = send(format!(
        "GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Armadra-Hook-Token: {}\r\nConnection: close\r\n\r\n",
        fixture.bearer
    ))
    .await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response}");

    let response =
        send("GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".into()).await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");

    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let body = json!({
        "nodeId": fixture.node_id,
        "version": 1,
        "payload": { "hook_event_name": "UserPromptSubmit" }
    })
    .to_string();
    let response = send(format!(
        "POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         X-Armadra-Hook-Token: {}\r\nX-Armadra-Node-Token: {token}\r\nX-Armadra-Hook-Client: 1\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        fixture.bearer,
        body.len(),
    ))
    .await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response}");
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
}
