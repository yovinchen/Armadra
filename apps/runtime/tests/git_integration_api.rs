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
async fn integration_routes_require_the_creating_workspace_and_explicit_continue() {
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

    git(&repo, &["switch", "-c", "feature/merge-target"]);
    git(&repo, &["commit", "--allow-empty", "-m", "target"]);
    git(&repo, &["switch", "main"]);
    let base = format!("/api/workspaces/{}/git/repository", workspace.id);
    let (_, branches) = request(&app, "GET", &format!("{base}/branches"), Value::Null).await;
    let target = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|branch| branch["name"] == "feature/merge-target")
        .unwrap()["oid"]
        .clone();
    let (_, before) = request(&app, "GET", &format!("{base}/integration"), Value::Null).await;
    let (status,operation)=request(&app,"POST",&format!("{base}/operations"),json!({"action":{"kind":"startMerge","targetOid":target,"message":"fixture merge","expectedStateToken":before["stateToken"]},"expected":before["head"]})).await;
    assert_eq!(status, StatusCode::OK, "{operation}");
    let original = operation["id"].as_str().unwrap();
    let result = wait(&app, &base, original).await;
    assert_eq!(result["state"], "awaitingResolution", "{result}");
    let (_, pending) = request(&app, "GET", &format!("{base}/integration"), Value::Null).await;
    assert_eq!(pending["owned"], true);
    assert_eq!(pending["canContinue"], true);
    assert_eq!(pending["sessionId"], original);
    let alias = _other_workspace.id;
    sqlx::query("UPDATE workspaces SET root_path=? WHERE id=?")
        .bind(format!("{}/.", repo.display()))
        .bind(&alias)
        .execute(&pool)
        .await
        .unwrap();
    let alias_base = format!("/api/workspaces/{alias}/git/repository");
    let (_, other) = request(
        &app,
        "GET",
        &format!("{alias_base}/integration"),
        Value::Null,
    )
    .await;
    assert_eq!(other["owned"], false);
    assert_eq!(other["canContinue"], false);
    assert!(other["sessionId"].is_null());
    let action = json!({"action":{"kind":"continueIntegration","sessionId":original,"expectedStateToken":pending["stateToken"]},"expected":pending["head"]});
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("{alias_base}/operations"),
            action.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, operation) = request(&app, "POST", &format!("{base}/operations"), action).await;
    assert_eq!(status, StatusCode::OK, "{operation}");
    assert_eq!(
        wait(&app, &base, operation["id"].as_str().unwrap()).await["state"],
        "succeeded"
    );
    assert_eq!(
        request(&app, "GET", &format!("{base}/integration"), Value::Null)
            .await
            .1["kind"],
        "none"
    );
    pool.close().await;
}
async fn wait(app: &axum::Router, base: &str, id: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (_, result) =
                request(app, "GET", &format!("{base}/operations/{id}"), Value::Null).await;
            if !["queued", "running"].contains(&result["state"].as_str().unwrap()) {
                break result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn cherry_pick_preview_and_empty_skip_remain_workspace_scoped() {
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

    git(&repo, &["switch", "-c", "feature/pick-target"]);
    std::fs::write(repo.join("picked.txt"), "picked content\n").unwrap();
    git(&repo, &["add", "picked.txt"]);
    git(&repo, &["commit", "-m", "pick fixture"]);
    git(&repo, &["switch", "main"]);
    let base = format!("/api/workspaces/{}/git/repository", workspace.id);
    let (_, branches) = request(&app, "GET", &format!("{base}/branches"), Value::Null).await;
    let target = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|branch| branch["name"] == "feature/pick-target")
        .unwrap()["oid"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, preview) = request(
        &app,
        "GET",
        &format!("{base}/cherry-pick-preview?oid={target}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["subject"], "pick fixture");
    assert!(
        preview["patch"]
            .as_str()
            .unwrap()
            .contains("picked content")
    );
    for expected_state in ["succeeded", "awaitingResolution"] {
        let (_, state) = request(&app, "GET", &format!("{base}/integration"), Value::Null).await;
        let (status,operation)=request(&app,"POST",&format!("{base}/operations"),json!({"action":{"kind":"startCherryPick","targetOid":target,"mainline":null,"recordOrigin":true,"expectedStateToken":state["stateToken"]},"expected":state["head"]})).await;
        assert_eq!(status, StatusCode::OK, "{operation}");
        assert_eq!(
            wait(&app, &base, operation["id"].as_str().unwrap()).await["state"],
            expected_state
        );
    }
    let (_, state) = request(&app, "GET", &format!("{base}/integration"), Value::Null).await;
    assert_eq!(state["empty"], true);
    assert_eq!(state["canSkip"], true);
    let action = json!({"action":{"kind":"skipIntegration","sessionId":state["sessionId"],"expectedStateToken":state["stateToken"]},"expected":state["head"]});
    let alias = _other_workspace.id;
    sqlx::query("UPDATE workspaces SET root_path=? WHERE id=?")
        .bind(format!("{}/.", repo.display()))
        .bind(&alias)
        .execute(&pool)
        .await
        .unwrap();
    let alias_base = format!("/api/workspaces/{alias}/git/repository");
    let (_, other) = request(
        &app,
        "GET",
        &format!("{alias_base}/integration"),
        Value::Null,
    )
    .await;
    assert_eq!(other["owned"], false);
    assert_eq!(other["canSkip"], false);
    assert!(other["originalHead"].is_null());
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("{alias_base}/operations"),
            action.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, operation) = request(&app, "POST", &format!("{base}/operations"), action).await;
    assert_eq!(status, StatusCode::OK, "{operation}");
    assert_eq!(
        wait(&app, &base, operation["id"].as_str().unwrap()).await["state"],
        "succeeded"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("picked.txt")).unwrap(),
        "picked content\n"
    );
    assert_eq!(
        request(&app, "GET", &format!("{base}/integration"), Value::Null)
            .await
            .1["head"],
        state["head"]
    );
    pool.close().await;
}
