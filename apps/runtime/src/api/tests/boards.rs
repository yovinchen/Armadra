//! Board routes and the retired-kanban rejection.

use tempfile::tempdir;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::StatusCode,
};
use serde_json::json;

use super::support::*;
use crate::{
    AppState, api::*, error::AppError, events::EventHub, settings::SettingsStore,
    terminal::TerminalManager,
};

#[tokio::test]
async fn retired_kanban_payloads_are_rejected_before_any_database_write() {
    let directory = tempdir().unwrap();
    // No schema exists: this test also proves the retirement check runs
    // before attempting any live document query or mutation.
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let events = EventHub::new();
    let settings = SettingsStore::in_memory(
        serde_json::json!({"terminal":{"backend":"direct"},"usage":{"enabled":false}}),
    );
    let state = AppState {
        remote: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        pool: pool.clone(),
        terminals: TerminalManager::with_config(
            pool,
            events.clone(),
            settings.clone(),
            directory.path().into(),
        ),
        events,
        hooks: test_hooks(directory.path()),
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
    };
    for retired in [
        serde_json::Value::Null,
        serde_json::json!({"columns":[],"cards":{}}),
    ] {
        let request=serde_json::from_value::<SaveBoardDocumentRequest>(serde_json::json!({
            "expectedUpdatedAt":"2026-09-05T00:00:00Z","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"kanban":retired,
        })).unwrap();
        let error = save_board(
            State(state.clone()),
            AxumPath(("workspace".into(), "canvas".into())),
            Json(request),
        )
        .await
        .unwrap_err();
        assert!(matches!(error,AppError::BadRequest(message) if message.contains("retired")));
    }
}

#[tokio::test]
async fn workspace_and_board_routes_follow_the_v3_contract() {
    let (router, directory) = router_fixture("api-v3").await;
    let root = directory.path().to_string_lossy().into_owned();

    let (status, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "Canvas", "rootPath": root, "color": "#123456" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workspace["color"], "#123456");
    assert_eq!(workspace["permissions"]["read"], true);
    assert!(workspace.get("gatewayEnabled").is_none());
    assert!(workspace["lastOpenedAt"].is_string());
    let workspace_id = workspace["id"].as_str().unwrap().to_owned();

    let (status, summaries) = call(&router, "GET", "/api/workspaces", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summaries[0]["id"], workspace_id.as_str());
    assert_eq!(summaries[0]["boards"][0]["name"], "Default");

    // The reserved gateway endpoint is gone in v3.
    let (status, _) = call(&router, "GET", "/api/gateway", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&router, "POST", "/api/agents/run", Some(json!({}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, boards) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{workspace_id}/boards"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let board_id = boards[0]["id"].as_str().unwrap().to_owned();
    let document_uri = format!("/api/workspaces/{workspace_id}/boards/{board_id}/document");

    let (status, document) = call(&router, "GET", &document_uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(document.get("strokes").is_none());
    // Migration 0009: a board that was never drawn on still reports the key.
    assert_eq!(document["board"]["whiteboard"], "");
    let expected_updated_at = document["board"]["updatedAt"].as_str().unwrap().to_owned();

    let now = chrono::Utc::now().to_rfc3339();
    let group_id = uuid::Uuid::now_v7().to_string();
    let terminal_id = uuid::Uuid::now_v7().to_string();
    let body = json!({
        "expectedUpdatedAt": expected_updated_at,
        "nodes": [
            {
                "id": group_id,
                "boardId": board_id,
                "type": "group",
                "title": "Worktree",
                "color": "#32d74b",
                "position": { "x": 0.0, "y": 0.0 },
                "size": { "width": 520.0, "height": 360.0 },
                "data": { "kind": "group" },
                "createdAt": now,
                "updatedAt": now
            },
            {
                "id": terminal_id,
                "boardId": board_id,
                "type": "terminal",
                "title": "Claude",
                "position": { "x": 10.0, "y": 20.0 },
                "size": { "width": 640.0, "height": 440.0 },
                "collapsed": true,
                "expandedHeight": 440.0,
                "parentId": group_id,
                "data": {
                    "kind": "terminal",
                    "cwd": ".",
                    "shell": "/bin/zsh",
                    "agent": { "id": "claude", "permissionMode": "auto-edit" }
                },
                "createdAt": now,
                "updatedAt": now
            }
        ],
        "edges": [{
            "id": uuid::Uuid::now_v7().to_string(),
            "boardId": board_id,
            "source": group_id,
            "target": terminal_id,
            "kind": "link",
            "createdAt": now,
            "updatedAt": now
        }],
        "viewport": { "x": -12.0, "y": 8.0, "zoom": 0.5 },
        "whiteboard": "{\"store\":{}}"
    });
    let (status, saved) = call(&router, "PUT", &document_uri, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK);
    // The save response and the next load both carry the snapshot back.
    assert_eq!(saved["board"]["whiteboard"], "{\"store\":{}}");
    let (_, reloaded) = call(&router, "GET", &document_uri, None).await;
    assert_eq!(reloaded["board"]["whiteboard"], "{\"store\":{}}");
    assert_eq!(saved["nodes"][0]["title"], "Worktree");
    assert_eq!(saved["nodes"][0]["color"], "#32d74b");
    assert_eq!(saved["nodes"][1]["color"], "#0a84ff");
    assert_eq!(saved["nodes"][1]["parentId"], group_id.as_str());
    assert_eq!(saved["nodes"][1]["collapsed"], true);
    assert_eq!(saved["edges"][0]["kind"], "link");
    assert!(saved["nodes"][0].get("zoom").is_none());
    assert!(saved.get("strokes").is_none());

    let (status, conflict) = call(&router, "PUT", &document_uri, Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "conflict");
}
