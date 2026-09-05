//! Route-level cover for canvas write ownership (host protocol design §4).
//!
//! The store's own rules are unit-tested next to `ownership.rs`. What is tested
//! here is the door: that every canvas write answers `ownership_moved` with 409
//! once the Host owns the domain, that the read-only fallback keeps answering
//! so the UI can still show a board it may not edit, and that handing the epoch
//! back re-opens the same routes.
use armadra_runtime::{
    AppState, db,
    events::EventHub,
    hook::HookService,
    ownership::{self, OwnershipHandoff, WriteOwner},
    router_with_state,
    settings::SettingsStore,
    terminal::TerminalManager,
    usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

const MULTIPART: &str = "multipart/form-data; boundary=armadra";

struct Fixture {
    app: axum::Router,
    pool: sqlx::SqlitePool,
    workspace_id: String,
    board_id: String,
    updated_at: String,
    _directory: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("app.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(&pool, "ownership", project.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    let settings = SettingsStore::in_memory(
        json!({"terminal":{"backend":"direct"},"usage":{"enabled":false}}),
    );
    let events = EventHub::new();
    let app = router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
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
    Fixture {
        app,
        pool,
        workspace_id: workspace.id,
        board_id: board.id.clone(),
        updated_at: board.updated_at,
        _directory: directory,
    }
}

async fn send(
    app: &axum::Router,
    method: &str,
    path: &str,
    content_type: &str,
    body: Body,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", content_type)
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn json(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    send(
        app,
        method,
        path,
        "application/json",
        if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        },
    )
    .await
}

/// Every route that stores canvas state, in the shape the web client sends it.
fn writes(fixture: &Fixture) -> Vec<(&'static str, String, Value)> {
    let workspace = &fixture.workspace_id;
    let board = &fixture.board_id;
    vec![
        (
            "POST",
            "/api/workspaces".into(),
            json!({"name": "second", "rootPath": "/tmp"}),
        ),
        (
            "POST",
            "/api/workspaces/open-directory".into(),
            json!({"name": "opened", "rootPath": "/tmp"}),
        ),
        (
            "PATCH",
            format!("/api/workspaces/{workspace}"),
            json!({"name": "renamed"}),
        ),
        (
            "DELETE",
            format!("/api/workspaces/{workspace}"),
            Value::Null,
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/open"),
            Value::Null,
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/boards"),
            json!({"name": "second canvas"}),
        ),
        (
            "PATCH",
            format!("/api/workspaces/{workspace}/boards/{board}"),
            json!({"name": "renamed canvas"}),
        ),
        (
            "DELETE",
            format!("/api/workspaces/{workspace}/boards/{board}"),
            Value::Null,
        ),
        (
            "PUT",
            format!("/api/workspaces/{workspace}/boards/{board}/document"),
            json!({
                "expectedUpdatedAt": fixture.updated_at,
                "nodes": [],
                "edges": [],
                "viewport": {"x": 0, "y": 0, "zoom": 1},
            }),
        ),
    ]
}

#[tokio::test]
async fn a_moved_canvas_refuses_every_write_and_still_answers_every_read() {
    let fixture = fixture().await;
    let workspace = &fixture.workspace_id;
    let board = &fixture.board_id;
    let (status, body) = json(&fixture.app, "GET", "/api/ownership", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "domain": "canvas",
            "owner": "runtime",
            "epoch": "1",
            "reasonCode": "ownership.initial",
            "updatedAt": "1970-01-01T00:00:00Z",
        })
    );

    ownership::apply(
        &fixture.pool,
        OwnershipHandoff {
            domain: ownership::CANVAS_DOMAIN.into(),
            owner: WriteOwner::Host,
            epoch: 9_007_199_254_740_993,
            expected_epoch: 1,
            reason_code: "ownership.switch.verified".into(),
        },
    )
    .await
    .unwrap();

    for (method, path, body) in writes(&fixture) {
        let (status, body) = json(&fixture.app, method, &path, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {path}");
        assert_eq!(body["code"], "ownership_moved", "{method} {path}");
    }
    // The import route reaches the guard before a single uploaded byte is
    // staged, so its refusal costs nothing on disk either.
    let (status, body) = send(
        &fixture.app,
        "POST",
        "/api/workspaces/import?name=imported",
        MULTIPART,
        Body::from("--armadra--\r\n"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "ownership_moved");

    // Reads are the fallback that makes the switch survivable.
    for path in [
        "/api/workspaces".to_owned(),
        format!("/api/workspaces/{workspace}/boards"),
        format!("/api/workspaces/{workspace}/boards/{board}/document"),
    ] {
        let (status, _) = json(&fixture.app, "GET", &path, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "GET {path}");
    }
    let (_, moved) = json(&fixture.app, "GET", "/api/ownership", Value::Null).await;
    assert_eq!(moved["owner"], "host");
    // A u64 epoch past 2^53 has to survive the trip as text; a JSON number
    // would round it and the client would compare the wrong epoch.
    assert_eq!(moved["epoch"], "9007199254740993");
    // Nothing that belongs to the Runtime was gated along with the canvas.
    let (status, _) = json(
        &fixture.app,
        "GET",
        &format!("/api/workspaces/{workspace}/git/status"),
        Value::Null,
    )
    .await;
    assert_ne!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn handing_the_epoch_back_reopens_the_same_routes() {
    let fixture = fixture().await;
    for (owner, epoch, expected) in [(WriteOwner::Host, 2, 1), (WriteOwner::Runtime, 3, 2)] {
        ownership::apply(
            &fixture.pool,
            OwnershipHandoff {
                domain: ownership::CANVAS_DOMAIN.into(),
                owner,
                epoch,
                expected_epoch: expected,
                reason_code: "ownership.rollback".into(),
            },
        )
        .await
        .unwrap();
    }
    // Refused while the Host held it, stored now: the rollback direction is a
    // plain handoff, not a database swap.
    let (status, created) = json(
        &fixture.app,
        "POST",
        &format!("/api/workspaces/{}/boards", fixture.workspace_id),
        json!({"name": "after rollback"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["name"], "after rollback");
    let (status, saved) = json(
        &fixture.app,
        "PUT",
        &format!(
            "/api/workspaces/{}/boards/{}/document",
            fixture.workspace_id, fixture.board_id
        ),
        json!({
            "expectedUpdatedAt": fixture.updated_at,
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["board"]["id"], fixture.board_id);
    // And nothing above quietly re-answered as the Host.
    let (_, record) = json(&fixture.app, "GET", "/api/ownership", Value::Null).await;
    assert_eq!(record["owner"], "runtime");
    assert_eq!(record["epoch"], "3");
}
