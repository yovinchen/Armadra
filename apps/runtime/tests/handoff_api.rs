//! Route-level cover for the handoff surface.
//!
//! The module functions are unit-tested next to their own code; what is tested
//! here is the door itself: that a workspace id in the path is the only
//! workspace a request can reach, that approving twice leaves one inbox entry
//! rather than two, and that withdrawing takes that entry back out.
use armadra_runtime::{
    AppState, db, events::EventHub, hook::HookService, model::ContextLink, router_with_state,
    settings::SettingsStore, terminal::TerminalManager, usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::Utc;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

struct Fixture {
    app: axum::Router,
    pool: sqlx::SqlitePool,
    workspace_id: String,
    other_workspace_id: String,
    source_node_id: String,
    target_node_id: String,
    prepare_body: Value,
    _directory: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    let other = directory.path().join("other");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&other).unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("app.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(&pool, "handoff", project.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let other_workspace = db::create_workspace(&pool, "other", other.to_str().unwrap(), None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET permissions_json=?")
        .bind(r#"{"read":true,"write":true,"execute":true}"#)
        .execute(&pool)
        .await
        .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    let source = Uuid::now_v7().to_string();
    let target = Uuid::now_v7().to_string();
    let source_session = Uuid::now_v7().to_string();
    let target_session = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    for (node, session, agent) in [
        (&source, &source_session, "claude"),
        (&target, &target_session, "codex"),
    ] {
        sqlx::query("INSERT INTO nodes(id,board_id,type,x,y,title,note,data_json,created_at,updated_at) VALUES(?,?,'terminal',0,0,?,'',?,?,?)")
            .bind(node).bind(&board.id).bind(agent)
            .bind(json!({"kind":"terminal","cwd":".","agent":{"id":agent}}).to_string())
            .bind(&now).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO terminal_sessions(id,workspace_id,owner_node_id,agent_id,session_key,generation,cwd,shell,status,created_at) VALUES(?,?,?,?,?,1,?,'/bin/sh','running',?)")
            .bind(session).bind(&workspace.id).bind(node).bind(agent).bind(node)
            .bind(project.to_string_lossy().as_ref()).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO agent_status(node_id,workspace_id,agent_id,state,verified,session_id,last_event_at,updated_at) VALUES(?,?,?,'done',1,?,?,?)")
            .bind(node).bind(&workspace.id).bind(agent).bind(format!("provider-{agent}"))
            .bind(&now).bind(&now).execute(&pool).await.unwrap();
    }
    db::put_context_links(
        &pool,
        &workspace.id,
        &source,
        &[ContextLink {
            id: target.clone(),
            title: "Target".into(),
            kind: "terminal".into(),
            content: None,
        }],
    )
    .await
    .unwrap();
    let settings = SettingsStore::in_memory(
        json!({"terminal":{"backend":"direct"},"usage":{"enabled":false}}),
    );
    let events = EventHub::new();
    let app = router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        events,
        hooks: HookService::new(directory.path().to_path_buf(), None),
        usage: UsageService::new(settings.clone()),
        settings,
        pool: pool.clone(),
    });
    let prepare_body = json!({
        "sourceNodeId": source,
        "sourceSessionId": source_session,
        "sourceGeneration": 1,
        "targetNodeId": target,
        "targetSessionId": target_session,
        "targetGeneration": 1,
        "sections": {"goal": "Continue the reviewed work", "constraints": "Keep the source running"},
        "filePaths": [],
        "byteBudget": 8192,
        "includeTranscript": true,
    });
    Fixture {
        app,
        pool,
        workspace_id: workspace.id,
        other_workspace_id: other_workspace.id,
        source_node_id: source,
        target_node_id: target,
        prepare_body,
        _directory: directory,
    }
}

#[tokio::test]
async fn handoff_routes_preview_then_accept_once_and_never_leak_across_workspaces() {
    let fixture = fixture().await;
    let base = format!("/api/workspaces/{}/handoffs", fixture.workspace_id);

    let (status, prepared) =
        request(&fixture.app, "POST", &base, fixture.prepare_body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["state"], "prepared");
    // Preparing freezes material; it does not notify anyone.
    assert_eq!(prepared["acceptedAt"], Value::Null);
    assert_eq!(mailbox_count(&fixture.pool).await, 0);
    let id = prepared["bundle"]["handoffId"].as_str().unwrap().to_owned();
    let digest = prepared["digest"].as_str().unwrap().to_owned();

    let (status, fetched) =
        request(&fixture.app, "GET", &format!("{base}/{id}"), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["digest"], digest);
    assert_eq!(fetched["bundle"]["trust"], "peerDataNotSystemInstructions");

    let (status, listed) = request(
        &fixture.app,
        "GET",
        &format!("{base}?sourceNodeId={}", fixture.source_node_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    // The target sees what was addressed to it without asking as the source.
    let (_, addressed) = request(
        &fixture.app,
        "GET",
        &format!("{base}?sourceNodeId={}", fixture.target_node_id),
        Value::Null,
    )
    .await;
    assert_eq!(addressed.as_array().unwrap().len(), 1);

    // A path workspace the handoff does not belong to reaches nothing, even
    // though the caller can read that workspace.
    let other = format!("/api/workspaces/{}/handoffs", fixture.other_workspace_id);
    let (status, _) = request(&fixture.app, "GET", &format!("{other}/{id}"), Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &fixture.app,
        "POST",
        &format!("{other}/{id}/accept"),
        json!({"expectedDigest": digest}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(&fixture.app, "POST", &other, fixture.prepare_body.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(mailbox_count(&fixture.pool).await, 0);

    // A stale preview cannot be approved: the digest is what the user saw.
    let (status, _) = request(
        &fixture.app,
        "POST",
        &format!("{base}/{id}/accept"),
        json!({"expectedDigest": "not-the-preview"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(mailbox_count(&fixture.pool).await, 0);

    let (status, accepted) = request(
        &fixture.app,
        "POST",
        &format!("{base}/{id}/accept"),
        json!({"expectedDigest": digest}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["state"], "queued");
    assert_eq!(mailbox_count(&fixture.pool).await, 1);
    // Approving is the whole of delivery: the material is in the target's
    // inbox under a key naming this handoff, and nothing was written anywhere
    // a terminal could scroll away.
    assert_eq!(
        message_key(&fixture.pool).await,
        format!("handoff:{id}"),
        "the inbox entry does not name this handoff"
    );
    assert_eq!(outbox_rows(&fixture.pool).await, 0);
    assert_eq!(delivery_rows(&fixture.pool).await, 0);

    // Approving again returns the same inbox entry rather than a second one: a
    // double click is not two copies of somebody's work.
    let (status, again) = request(
        &fixture.app,
        "POST",
        &format!("{base}/{id}/accept"),
        json!({"expectedDigest": digest}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["mailboxId"], accepted["mailboxId"]);
    assert_eq!(again["state"], "queued");
    assert_eq!(mailbox_count(&fixture.pool).await, 1);
}

#[tokio::test]
async fn cancelling_a_queued_handoff_takes_the_inbox_entry_back_out() {
    let fixture = fixture().await;
    let base = format!("/api/workspaces/{}/handoffs", fixture.workspace_id);
    let (_, prepared) = request(&fixture.app, "POST", &base, fixture.prepare_body.clone()).await;
    let id = prepared["bundle"]["handoffId"].as_str().unwrap().to_owned();
    let digest = prepared["digest"].as_str().unwrap().to_owned();
    let (status, _) = request(
        &fixture.app,
        "POST",
        &format!("{base}/{id}/accept"),
        json!({"expectedDigest": digest}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mailbox_count(&fixture.pool).await, 1);

    let (status, cancelled) = request(
        &fixture.app,
        "POST",
        &format!("{base}/{id}/cancel"),
        json!({"expectedDigest": digest}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["state"], "cancelled");
    // Withdrawing is deleting the inbox entry. There is nothing else to undo:
    // the target's next `inbox` simply does not list it.
    assert_eq!(mailbox_count(&fixture.pool).await, 0);

    // Cancelling again is refused rather than pretending it withdrew something.
    let (status, _) = request(
        &fixture.app,
        "POST",
        &format!("{base}/{id}/cancel"),
        json!({"expectedDigest": digest}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

async fn mailbox_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM agent_mailbox")
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn message_key(pool: &sqlx::SqlitePool) -> String {
    sqlx::query_scalar("SELECT message_key FROM agent_mailbox")
        .fetch_one(pool)
        .await
        .unwrap()
}
/// Both tables survive their published migrations and neither is written any
/// more. A row in either would mean a delivery path came back.
async fn outbox_rows(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM agent_handoff_outbox")
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn delivery_rows(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM agent_deliveries")
        .fetch_one(pool)
        .await
        .unwrap()
}
