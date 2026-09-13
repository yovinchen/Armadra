// Every case in this file drives the real `git` CLI over a POSIX
// temporary tree and a Unix-socket Runtime; there is nothing left to run on
// Windows, so the whole file compiles away instead of leaving dead helpers.
#![cfg(unix)]

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
#[tokio::test]
async fn message_routes_read_staged_source_and_require_execution_authority() {
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
    let _other_workspace =
        db::create_workspace(&pool, "other", other.to_str().unwrap(), None, None)
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
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
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

    std::fs::write(repo.join("feature.txt"), "new feature\n").unwrap();
    git(&repo, &["add", "feature.txt"]);
    let endpoint = format!("/api/workspaces/{}/git/message", workspace.id);
    let (status, source) = request(&app, "GET", &format!("{endpoint}/source"), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source["includedFiles"], json!(["feature.txt"]));
    sqlx::query("UPDATE workspaces SET permissions_json = ? WHERE id = ?")
        .bind(r#"{"read":true,"write":true,"execute":false}"#)
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    let (status,_)=request(&app,"POST",&format!("{endpoint}/generate"),json!({"provider":"claude-bare","expectedHead":source["expectedHead"],"indexDigest":source["indexDigest"]})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    sqlx::query("UPDATE workspaces SET permissions_json = ? WHERE id = ?")
        .bind(r#"{"read":false,"write":false,"execute":false}"#)
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    for path in ["source", "providers"] {
        assert_eq!(
            request(&app, "GET", &format!("{endpoint}/{path}"), Value::Null)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    pool.close().await;
}
