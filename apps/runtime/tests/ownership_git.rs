//! Route-level cover for git write ownership (business migration §2.8, §6.2).
//!
//! What is tested here is the door. Once the Host owns the git domain, every
//! route that makes this machine change a repository answers `ownership_moved`
//! with 409 — including the ones that reach `git` through the repository queue,
//! the per-path index writes, hunk application and starting a clone.
//!
//! Reads keep answering, and that is not an oversight: the panel has to go on
//! showing the repository it no longer writes. A switch moves who decides, not
//! what a person can look at, and a Runtime that went dark on `git status`
//! after a switch would make the domain unusable in exactly the window where
//! somebody is watching it most closely.

use std::process::Command;

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

struct Fixture {
    app: axum::Router,
    pool: sqlx::SqlitePool,
    workspace_id: String,
    _directory: tempfile::TempDir,
}

fn git(project: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(project)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .status()
        .expect("git is available");
    assert!(status.success(), "git {args:?}");
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    // A real repository, because the assertions are about the guard refusing
    // before the command runs -- which is only meaningful if the command would
    // otherwise have succeeded.
    git(&project, &["init", "--initial-branch=main"]);
    git(&project, &["config", "user.email", "test@example.invalid"]);
    git(&project, &["config", "user.name", "测试"]);
    std::fs::write(project.join("README.md"), "# 项目\n").unwrap();
    git(&project, &["add", "README.md"]);
    git(&project, &["commit", "-m", "initial"]);
    std::fs::write(project.join("README.md"), "# 项目\n\n改动\n").unwrap();

    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("app.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(&pool, "git", project.to_str().unwrap(), None, None)
        .await
        .unwrap();
    // Running Git is execution, and this scenario is about ownership rather
    // than about permissions: the workspace grants all three so a refusal below
    // can only be the ownership guard.
    sqlx::query("UPDATE workspaces SET permissions_json = ?")
        .bind(r#"{"read":true,"write":true,"execute":true}"#)
        .execute(&pool)
        .await
        .unwrap();
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
        _directory: directory,
    }
}

async fn json(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Every route that makes this machine change a repository.
fn writes(workspace: &str) -> Vec<(&'static str, String, Value)> {
    vec![
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/stage"),
            json!({"paths": ["README.md"]}),
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/unstage"),
            json!({"paths": ["README.md"]}),
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/revert"),
            json!({"paths": ["README.md"], "source": "index"}),
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/resolve"),
            json!({"paths": ["README.md"]}),
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/commit"),
            json!({"message": "提交"}),
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/init"),
            Value::Null,
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/hunks"),
            json!({
                "file": "README.md",
                "scope": "worktree",
                "diffDigest": "0".repeat(64),
                "hunkId": "1",
                "action": "stage",
            }),
        ),
        (
            "POST",
            format!("/api/workspaces/{workspace}/git/repository/operations"),
            json!({
                "path": ".",
                "action": {"kind": "createBranch", "name": "功能", "startPoint": null, "switch": false},
                "expected": {"headOid": null, "branch": "main"},
            }),
        ),
        (
            "POST",
            "/api/git/clone".to_owned(),
            json!({"url": "https://example.invalid/repo.git", "parent": "/tmp"}),
        ),
    ]
}

#[tokio::test]
async fn a_moved_git_domain_refuses_every_write_and_still_answers_every_read() {
    let fixture = fixture().await;
    let workspace = &fixture.workspace_id;

    // Before the switch the queue accepts work: the refusals below are about
    // ownership, not about a repository that was never usable.
    let (status, _) = json(
        &fixture.app,
        "POST",
        &format!("/api/workspaces/{workspace}/git/stage"),
        json!({"paths": ["README.md"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    ownership::apply(
        &fixture.pool,
        OwnershipHandoff {
            domain: ownership::OwnershipDomain::Git,
            owner: WriteOwner::Host,
            epoch: 2,
            expected_epoch: 1,
            reason_code: "ownership.switch.verified".into(),
        },
    )
    .await
    .unwrap();

    for (method, path, body) in writes(workspace) {
        let (status, body) = json(&fixture.app, method, &path, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {path}");
        assert_eq!(body["code"], "ownership_moved", "{method} {path}");
    }

    // Reads are the fallback that makes the switch survivable.
    for path in [
        format!("/api/workspaces/{workspace}/git/status"),
        format!("/api/workspaces/{workspace}/git/diff"),
        format!("/api/workspaces/{workspace}/git/head-commit"),
        format!("/api/workspaces/{workspace}/git/repositories"),
        format!("/api/workspaces/{workspace}/git/repository/branches"),
        format!("/api/workspaces/{workspace}/git/repository/history"),
        format!("/api/workspaces/{workspace}/git/repository/operations"),
    ] {
        let (status, _) = json(&fixture.app, "GET", &path, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "GET {path}");
    }

    // Moving one domain leaves the others alone: independent epochs are what
    // makes the switch order possible at all.
    let (status, _) = json(
        &fixture.app,
        "POST",
        &format!("/api/workspaces/{workspace}/boards"),
        json!({"name": "画布"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Handing the epoch back re-opens the same routes.
    ownership::apply(
        &fixture.pool,
        OwnershipHandoff {
            domain: ownership::OwnershipDomain::Git,
            owner: WriteOwner::Runtime,
            epoch: 3,
            expected_epoch: 2,
            reason_code: "ownership.rollback.exported".into(),
        },
    )
    .await
    .unwrap();
    let (status, _) = json(
        &fixture.app,
        "POST",
        &format!("/api/workspaces/{workspace}/git/unstage"),
        json!({"paths": ["README.md"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
