//! Agent discovery, the sessions sidebar, conversations and title
//! suggestions.

use tempfile::tempdir;

use axum::{Router, http::StatusCode};
use serde_json::json;

use super::support::*;
use crate::terminal::TerminateMode;
use crate::{AppState, db, events::EventHub};

#[tokio::test]
async fn custom_agents_are_listed_after_the_built_ins_and_borrow_their_base() {
    let (router, _directory) = router_fixture("api-custom-agents").await;
    let (status, _) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "agents": { "custom": [
            { "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
              "args": ["hello"], "baseAgent": "gemini",
              "env": { "GREETING": "hi" } },
            { "id": "custom:broken", "label": "", "launchCmd": "x" },
        ] } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, agents) = call(&router, "GET", "/api/agents", None).await;
    assert_eq!(status, StatusCode::OK);
    let agents = agents.as_array().unwrap();
    // Built-ins plus the one entry that survived validation.
    assert_eq!(agents.len(), crate::agent::AGENT_IDS.len() + 1);
    let custom = agents.last().unwrap();
    assert_eq!(custom["id"], "custom:echo");
    assert_eq!(custom["label"], "Echo");
    assert_eq!(custom["launchCmd"], "/bin/echo");
    assert_eq!(custom["args"], json!(["hello"]));
    assert_eq!(custom["baseAgent"], "gemini");
    // Colour, prompt mode and capabilities are the base agent's.
    let gemini = agents.iter().find(|a| a["id"] == "gemini").unwrap();
    assert_eq!(custom["color"], gemini["color"]);
    assert_eq!(custom["promptMode"], gemini["promptMode"]);
    assert_eq!(custom["capabilities"], gemini["capabilities"]);
    // An absolute program resolves even though it is on no PATH entry.
    assert_eq!(custom["resolvedPath"], "/bin/echo");
    assert_eq!(custom["installed"], true);
}

#[tokio::test]
async fn agent_and_session_routes_expose_the_v3_shapes() {
    let (router, directory) = router_fixture("api-agents").await;
    let root = directory.path().to_string_lossy().into_owned();
    let (_, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "Canvas", "rootPath": root })),
    )
    .await;
    let workspace_id = workspace["id"].as_str().unwrap().to_owned();

    let (status, agents) = call(&router, "GET", "/api/agents", None).await;
    assert_eq!(status, StatusCode::OK);
    let agents = agents.as_array().unwrap();
    assert_eq!(agents.len(), crate::agent::AGENT_IDS.len());
    for agent in agents {
        assert!(agent["resolvedPath"].is_string() || agent["resolvedPath"].is_null());
        assert!(agent["installed"].is_boolean());
        assert!(agent["clientRevision"].is_null());
        assert!(!agent["launchCmd"].as_str().unwrap().is_empty());
    }
    assert!(agents.iter().any(|agent| agent["id"] == "claude"));
    assert!(agents.iter().any(|agent| agent["id"] == "pi"));
    assert!(agents.iter().all(|agent| agent["baseAgent"].is_null()));

    let (status, sessions) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{workspace_id}/sessions"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions, json!([]));

    let node_id = uuid::Uuid::now_v7().to_string();
    let (status, links) = call(
        &router,
        "PUT",
        &format!("/api/workspaces/{workspace_id}/context-links/{node_id}"),
        Some(json!({ "links": [
            { "id": uuid::Uuid::now_v7().to_string(), "title": "Codex", "kind": "terminal" }
        ] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(links["nodeId"], node_id.as_str());
    assert_eq!(links["links"].as_array().unwrap().len(), 1);

    let (status, invalid) = call(
        &router,
        "PUT",
        &format!("/api/workspaces/{workspace_id}/context-links/not-a-uuid"),
        Some(json!({ "links": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid["code"], "bad_request");

    let (status, missing) = call(
        &router,
        "POST",
        "/api/approvals/does-not-exist/answer",
        Some(json!({ "decision": "allow" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["code"], "not_found");

    let (status, denied) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/git/commit"),
        Some(json!({ "message": "nothing here" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(denied["code"], "git_execution_required");
    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{workspace_id}"),
        Some(json!({"permissions":{"read":true,"write":true,"execute":true}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, commit) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/git/commit"),
        Some(json!({ "message": "nothing here" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(commit["code"], "bad_request");
}

#[cfg(unix)]
#[tokio::test]
async fn the_sessions_sidebar_joins_nodes_and_agent_status() {
    let directory = tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("api-sessions.db").display()
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
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals: terminals.clone(),
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory.path()),
        events,
        pool: pool.clone(),
    });

    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    let node_id = uuid::Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[crate::model::CanvasNode {
                id: node_id.clone(),
                board_id: board.id.clone(),
                node_type: "terminal".into(),
                title: "Claude".into(),
                color: crate::model::DEFAULT_NODE_COLOR.into(),
                position: crate::model::Position { x: 0.0, y: 0.0 },
                size: None,
                collapsed: None,
                expanded_height: None,
                parent_id: None,
                labels: Vec::new(),
                note: String::new(),
                data: json!({ "kind": "terminal", "cwd": "." }),
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            edges: &[],
            viewport: crate::model::Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

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
            "agent": { "id": "claude" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session["id"].as_str().unwrap().to_owned();

    db::upsert_agent_status(
        &pool,
        db::AgentStatusPatch {
            node_id: node_id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("blocked".into()),
            unread: true,
            session_id: None,
            pending_id: Some("p-1".into()),
            verified: true,
            transcript_path: None,
            session_phase: None,
            errored: None,
            interrupted: None,
            last_event_at: None,
        },
    )
    .await
    .unwrap();

    let (status, sessions) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{}/sessions", workspace.id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sessions = sessions.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    let row = &sessions[0];
    assert_eq!(row["nodeId"], node_id.as_str());
    assert_eq!(row["boardId"], board.id.as_str());
    assert_eq!(row["sessionId"], session_id.as_str());
    assert_eq!(row["kind"], "terminal");
    assert_eq!(row["title"], "Claude");
    assert_eq!(row["agentId"], "claude");
    assert_eq!(row["state"], "blocked");
    assert_eq!(row["unread"], true);
    assert_eq!(row["pendingId"], "p-1");
    assert_eq!(row["alive"], true);

    terminals
        .terminate(&session_id, TerminateMode::Process)
        .await
        .unwrap();
}

/* -------------------------- conversations / title ---------------------- */

fn phase4_router(pool: &sqlx::SqlitePool, directory: &std::path::Path) -> Router {
    let events = EventHub::new();
    let (terminals, settings) = test_terminals(pool, &events, directory);
    crate::router_with_state(AppState {
        remote: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals,
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory),
        events,
        pool: pool.clone(),
    })
}

#[tokio::test]
async fn the_conversations_endpoint_lists_filters_and_rescans() {
    let directory = tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("conversations.db").display()
    ))
    .await
    .unwrap();
    let router = phase4_router(&pool, directory.path());

    // Nothing indexed yet: an empty array, not an error.
    let (status, rows) = call(&router, "GET", "/api/conversations", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows, json!([]));

    // The refresh route reports what a pass did. It scans the developer's
    // real transcript directories, so only the shape is asserted here — the
    // scanner itself is covered against a temporary tree in `index::tests`.
    let (status, report) = call(&router, "POST", "/api/conversations/refresh", None).await;
    assert_eq!(status, StatusCode::OK);
    for key in ["scanned", "indexed", "removed", "total"] {
        assert!(
            report[key].is_number(),
            "{key} missing from the scan report"
        );
    }
    // That pass indexed whatever this machine happens to have, which is not
    // something a test may assert on; the table is cleared so the rows below
    // are the only ones the query can see.
    sqlx::query("DELETE FROM conversations")
        .execute(&pool)
        .await
        .unwrap();

    // A row put in by hand proves the response shape and the query.
    sqlx::query(
        "INSERT INTO conversations (provider, session_id, title, cwd, path, updated_at, bytes) \
         VALUES ('claude', 'session-1', 'Ship the thing', '/Users/me/alpha', '/tmp/a.jsonl', \
                 '2026-09-04T00:00:00+00:00', 4096)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (status, rows) = call(&router, "GET", "/api/conversations?q=SHIP&limit=5", None).await;
    assert_eq!(status, StatusCode::OK);
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["provider"], "claude");
    assert_eq!(rows[0]["sessionId"], "session-1");
    assert_eq!(rows[0]["title"], "Ship the thing");
    assert_eq!(rows[0]["cwd"], "/Users/me/alpha");
    assert_eq!(rows[0]["updatedAt"], "2026-09-04T00:00:00+00:00");
    assert_eq!(rows[0]["bytes"], 4096);
    // The transcript path never leaves the runtime.
    assert!(rows[0].get("path").is_none());

    let (_, none) = call(&router, "GET", "/api/conversations?q=nothing", None).await;
    assert_eq!(none, json!([]));
}

#[tokio::test]
async fn suggest_title_prefers_the_transcript_and_falls_back_to_the_agent() {
    let directory = tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("suggest.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let router = phase4_router(&pool, directory.path());
    let node_id = uuid::Uuid::now_v7().to_string();

    // A node that never reported is a 404, not an empty title.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/agent-status/{node_id}/suggest-title"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let patch = |transcript: Option<String>| db::AgentStatusPatch {
        node_id: node_id.clone(),
        workspace_id: workspace.id.clone(),
        agent_id: "claude".into(),
        state: Some("done".into()),
        unread: false,
        session_id: None,
        pending_id: None,
        verified: true,
        transcript_path: transcript,
        session_phase: None,
        errored: None,
        interrupted: None,
        last_event_at: None,
    };

    // No transcript and no terminal: the agent's label is the honest answer.
    db::upsert_agent_status(&pool, patch(None)).await.unwrap();
    let (status, suggested) = call(
        &router,
        "POST",
        &format!("/api/agent-status/{node_id}/suggest-title"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        suggested,
        json!({ "title": "Claude Code", "source": "agent" })
    );

    // With a transcript, the first user message wins.
    let transcript = directory.path().join("session.jsonl");
    std::fs::write(
        &transcript,
        "{\"type\":\"user\",\"cwd\":\"/tmp\",\"message\":{\"content\":\"给终端节点加上 AI 命名\"}}\n",
    )
    .unwrap();
    db::upsert_agent_status(
        &pool,
        patch(Some(transcript.to_string_lossy().into_owned())),
    )
    .await
    .unwrap();
    let (status, suggested) = call(
        &router,
        "POST",
        &format!("/api/agent-status/{node_id}/suggest-title"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        suggested,
        json!({ "title": "给终端节点加上 AI 命名", "source": "transcript" })
    );
}
