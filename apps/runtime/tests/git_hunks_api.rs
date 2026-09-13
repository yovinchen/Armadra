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
async fn hunk_routes_reject_stale_writes_and_enforce_workspace_permissions() {
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

    std::fs::write(repo.join("file.txt"), "first\nsecond\nthird\n").unwrap();
    git(&repo, &["add", "file.txt"]);
    git(&repo, &["commit", "-m", "fixture"]);
    std::fs::write(repo.join("file.txt"), "first\nchanged\nthird\n").unwrap();

    // A nested repository holding a file of the same name. Without `path` both
    // reads answered about the root's `file.txt`, and the apply staged that one
    // — a different repository, and the wrong file.
    let nested = repo.join("嵌套");
    std::fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-b", "main"]);
    std::fs::write(nested.join("file.txt"), "alpha\nbeta\ngamma\n").unwrap();
    git(&nested, &["add", "file.txt"]);
    git(&nested, &["commit", "-m", "nested fixture"]);
    std::fs::write(nested.join("file.txt"), "alpha\nDELTA\ngamma\n").unwrap();

    let endpoint = format!("/api/workspaces/{}/git/hunks", workspace.id);
    let (code, diff) = request(
        &app,
        "GET",
        &format!("{endpoint}?file=file.txt&scope=worktree"),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{diff}");
    assert_eq!(diff["hunks"].as_array().unwrap().len(), 1);
    let mutation = json!({"file":"file.txt","scope":"worktree","diffDigest":diff["diffDigest"],"hunkId":diff["hunks"][0]["id"],"action":"stage"});
    std::fs::write(repo.join("file.txt"), "first\nnewer\nthird\n").unwrap();
    let (code, _) = request(&app, "POST", &endpoint, mutation.clone()).await;
    assert_eq!(code, StatusCode::CONFLICT);
    std::fs::write(repo.join("file.txt"), "first\nchanged\nthird\n").unwrap();
    let (code, result) = request(&app, "POST", &endpoint, mutation.clone()).await;
    assert_eq!(code, StatusCode::OK, "{result}");
    assert_eq!(result["applied"], true);

    // The nested checkout's own hunk, addressed by `path`. Its content is the
    // nested file's, and staging it leaves the root's index alone.
    let (code, inner) = request(
        &app,
        "GET",
        &format!("{endpoint}?path=%E5%B5%8C%E5%A5%97&file=file.txt&scope=worktree"),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{inner}");
    assert!(
        inner["hunks"][0]["content"]
            .as_str()
            .unwrap()
            .contains("DELTA"),
        "{inner}"
    );
    let (code, staged) = request(
        &app,
        "POST",
        &endpoint,
        json!({"path":"嵌套","file":"file.txt","scope":"worktree","diffDigest":inner["diffDigest"],"hunkId":inner["hunks"][0]["id"],"action":"stage"}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{staged}");
    let root_index = std::process::Command::new("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&root_index.stdout).trim(),
        "file.txt",
        "the nested apply must not add anything to the root's index"
    );
    sqlx::query("UPDATE workspaces SET permissions_json = ? WHERE id = ?")
        .bind(r#"{"read":true,"write":false,"execute":false}"#)
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "POST", &endpoint, mutation).await.0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE workspaces SET permissions_json = ? WHERE id = ?")
        .bind(r#"{"read":false,"write":false,"execute":false}"#)
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{endpoint}?file=file.txt&scope=staged"),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    pool.close().await;
}
