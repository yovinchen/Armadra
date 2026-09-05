use armadra_runtime::{
    AppState, db, events::EventHub, hook::HookService, router_with_state, settings::SettingsStore,
    terminal::TerminalManager, usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

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
fn git(root: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=API test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[cfg(unix)]
#[tokio::test]
async fn repository_routes_preserve_scope_permissions_and_real_operation_state() {
    let directory = tempfile::tempdir().unwrap();
    let repo = directory.path().join("project");
    let other = directory.path().join("other");
    std::fs::create_dir(&repo).unwrap();
    std::fs::create_dir(&other).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["commit", "--allow-empty", "-m", "第一条提交"]);
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let workspace = db::create_workspace(&pool, "project", repo.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let other_workspace = db::create_workspace(&pool, "other", other.to_str().unwrap(), None, None)
        .await
        .unwrap();
    // These happy-path scenarios explicitly authorize Git helpers; denial is
    // covered independently with real sentinel scripts.
    sqlx::query("UPDATE workspaces SET permissions_json = ?")
        .bind(r#"{"read":true,"write":true,"execute":true}"#)
        .execute(&pool)
        .await
        .unwrap();
    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({"terminal":{"backend":"direct"}}));
    let app = router_with_state(AppState {
        resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
        pool: pool.clone(),
        events: events.clone(),
        settings: settings.clone(),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events,
            settings.clone(),
            directory.path().to_owned(),
        ),
        hooks: HookService::new(directory.path().to_owned(), None),
        usage: UsageService::new(settings),
    });
    let base = format!("/api/workspaces/{}/git/repository", workspace.id);
    let (status, branches) =
        request(&app, "GET", &format!("{base}/branches?path=."), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(branches["head"]["branch"], "main");
    let (status, history) = request(
        &app,
        "GET",
        &format!("{base}/history?path=.&reference=HEAD&limit=1"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["commits"][0]["subject"], "第一条提交");
    let(status,operation)=request(&app,"POST",&format!("{base}/operations"),json!({"path":".","action":{"kind":"createBranch","name":"feature/api","switch":true},"expected":branches["head"]})).await;
    assert_eq!(status, StatusCode::OK, "{operation}");
    let id = operation["id"].as_str().unwrap();
    let (status, _) = request(
        &app,
        "GET",
        &format!(
            "/api/workspaces/{}/git/repository/operations/{id}",
            other_workspace.id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (status, value) =
                request(&app, "GET", &format!("{base}/operations/{id}"), Value::Null).await;
            assert_eq!(status, StatusCode::OK);
            if !["queued", "running"].contains(&value["state"].as_str().unwrap()) {
                break value;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed["state"], "succeeded", "{completed}");
    let (status, listed) = request(&app, "GET", &format!("{base}/operations"), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], id);
    sqlx::query("UPDATE workspaces SET root_path = ? WHERE id = ?")
        .bind(format!("{}/.", repo.display()))
        .bind(&other_workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    let (_, hidden) = request(
        &app,
        "GET",
        &format!(
            "/api/workspaces/{}/git/repository/operations",
            other_workspace.id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(hidden, json!([]));
    let (_, current) = request(&app, "GET", &format!("{base}/branches"), Value::Null).await;
    assert_eq!(current["head"]["branch"], "feature/api");
    sqlx::query("UPDATE workspaces SET permissions_json = ? WHERE id = ?")
        .bind(r#"{"read":true,"write":false,"execute":false}"#)
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = request(
        &app,
        "POST",
        &format!("{base}/operations/{id}/cancel"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = request(
        &app,
        "POST",
        &format!("/api/workspaces/{}/git/stage", workspace.id),
        json!({"paths":["new.txt"]}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    pool.close().await;
}
