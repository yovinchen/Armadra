//! Workspace routes: import, directory open, folder creation and the
//! cascade a removal performs.

use tempfile::tempdir;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::support::*;
use crate::api::workspaces::register_imported_workspace;
use crate::imports;
use crate::{AppState, db, error::AppError, events::EventHub};

#[tokio::test]
async fn workspace_import_registration_failure_removes_its_owned_directory() {
    let directory = tempdir().unwrap();
    let parent = directory.path().join("managed");
    let mut batch = imports::ImportBatch::workspace(&parent).unwrap();
    batch.write("a.txt", b"uploaded").unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    // No schema: force database registration failure after the atomic rename.
    assert!(
        register_imported_workspace(&pool, batch, "project")
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 0);
}

#[tokio::test]
async fn workspace_import_validates_names_and_manifest_before_creating_a_directory() {
    let (router, _directory) = router_fixture("workspace-import-validation").await;
    let (status, _, _) = raw(
        &router,
        "POST",
        &format!("/api/workspaces/import?name={}", "a".repeat(121)),
        "multipart/form-data; boundary=b",
        b"--b--\r\n".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let body = b"--b\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{\"paths\":[\"../escape\"]}\r\n--b--\r\n".to_vec();
    let (status, _, _) = raw(
        &router,
        "POST",
        "/api/workspaces/import?name=folder",
        "multipart/form-data; boundary=b",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn desktop_directory_open_registers_the_original_path_without_copying() {
    let (router, directory) = router_fixture("open-directory").await;
    let root = directory.path().canonicalize().unwrap().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a.txt"), "original").unwrap();
    let (status, first) = call(
        &router,
        "POST",
        "/api/workspaces/open-directory",
        Some(json!({"name":"project", "rootPath":root})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, second) = call(
        &router,
        "POST",
        "/api/workspaces/open-directory",
        Some(json!({"name":"project", "rootPath":root})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["id"], second["id"]);
    assert_eq!(first["rootPath"], root.to_str().unwrap());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    let (status, _) = call(
        &router,
        "POST",
        "/api/workspaces/open-directory",
        Some(json!({"name":"file", "rootPath":root.join("a.txt")})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn creates_the_workspace_folder_when_asked() {
    let (router, directory) = router_fixture("api-mkdir").await;
    let root = directory.path().join("fresh");

    let (status, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({
            "name": "fresh",
            "rootPath": root.to_string_lossy(),
            "createDirectory": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(root.is_dir());
    assert!(workspace["rootPath"].as_str().unwrap().ends_with("/fresh"));

    // The same call again must not silently reuse the directory.
    let (status, error) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({
            "name": "fresh",
            "rootPath": root.to_string_lossy(),
            "createDirectory": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "conflict");

    // Only one level is created: a missing parent is a 400.
    let (status, _) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({
            "name": "deep",
            "rootPath": directory.path().join("missing/deep").to_string_lossy(),
            "createDirectory": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// `DELETE /api/workspaces/{id}` — 从列表移除 (plan §20).
///
/// The three things that have to hold: the live session is gone, every row
/// that hangs off the workspace is gone with it (the schema's cascades,
/// asserted here so a future migration cannot quietly drop one), and the
/// directory on disk is exactly as it was.
#[cfg(unix)]
#[tokio::test]
async fn removing_a_workspace_destroys_its_sessions_and_cascades_its_rows() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("keep-me.txt"), "untouched").unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("api-remove.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(&pool, "fixture", root.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let events = EventHub::new();
    let (terminals, settings) = test_terminals(&pool, &events, directory.path());
    let router = crate::router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals: terminals.clone(),
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory.path()),
        events,
        pool: pool.clone(),
    });

    // A board with two nodes and the edge between them.
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    let now = chrono::Utc::now().to_rfc3339();
    let node_id = uuid::Uuid::now_v7().to_string();
    let sticky_id = uuid::Uuid::now_v7().to_string();
    let node = |id: &str, node_type: &str, data: Value| crate::model::CanvasNode {
        id: id.to_owned(),
        board_id: board.id.clone(),
        node_type: node_type.to_owned(),
        title: "Claude".into(),
        color: crate::model::DEFAULT_NODE_COLOR.into(),
        position: crate::model::Position { x: 0.0, y: 0.0 },
        size: None,
        collapsed: None,
        expanded_height: None,
        parent_id: None,
        labels: Vec::new(),
        note: String::new(),
        data,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[
                node(
                    &node_id,
                    "terminal",
                    json!({ "kind": "terminal", "cwd": "." }),
                ),
                node(
                    &sticky_id,
                    "sticky",
                    json!({ "kind": "sticky", "content": "note" }),
                ),
            ],
            edges: &[crate::model::CanvasEdge {
                id: uuid::Uuid::now_v7().to_string(),
                board_id: board.id.clone(),
                source: sticky_id.clone(),
                target: node_id.clone(),
                kind: "link".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
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
            "args": ["-c", "sleep 300"],
            "nodeId": node_id,
            "agent": { "id": "claude" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session["id"].as_str().unwrap().to_owned();
    assert!(terminals.is_alive(&session_id).await);

    db::upsert_agent_status(
        &pool,
        db::AgentStatusPatch {
            node_id: node_id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("working".into()),
            unread: true,
            session_id: Some(session_id.clone()),
            pending_id: None,
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

    let uri = format!("/api/workspaces/{}", workspace.id);
    let (status, body) = call(&router, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);

    // The PTY is gone, and so is the manager's memory of it.
    assert!(!terminals.is_alive(&session_id).await);
    assert!(matches!(
        terminals.session(&session_id).await,
        Err(AppError::NotFound(_))
    ));

    // Every table that references the workspace, directly or through the
    // board, is empty again.
    for (label, query, value) in [
        (
            "workspaces",
            "SELECT COUNT(*) FROM workspaces WHERE id = ?",
            workspace.id.as_str(),
        ),
        (
            "boards",
            "SELECT COUNT(*) FROM boards WHERE workspace_id = ?",
            workspace.id.as_str(),
        ),
        (
            "terminal_sessions",
            "SELECT COUNT(*) FROM terminal_sessions WHERE workspace_id = ?",
            workspace.id.as_str(),
        ),
        (
            "agent_status",
            "SELECT COUNT(*) FROM agent_status WHERE workspace_id = ?",
            workspace.id.as_str(),
        ),
        (
            "nodes",
            "SELECT COUNT(*) FROM nodes WHERE board_id = ?",
            board.id.as_str(),
        ),
        (
            "edges",
            "SELECT COUNT(*) FROM edges WHERE board_id = ?",
            board.id.as_str(),
        ),
    ] {
        let count: i64 = sqlx::query_scalar(query)
            .bind(value)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{label} still has rows for the removed workspace");
    }

    // 从列表移除, not 删除项目: the directory is untouched.
    assert_eq!(
        std::fs::read_to_string(root.join("keep-me.txt")).unwrap(),
        "untouched"
    );

    // Unknown ids are a 404, and the second DELETE of the same id is one
    // too — removal is not silently idempotent.
    let (status, error) = call(&router, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], "not_found");
    let (status, _) = call(
        &router,
        "DELETE",
        &format!("/api/workspaces/{}", uuid::Uuid::now_v7()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
