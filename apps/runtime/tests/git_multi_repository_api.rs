//! Multi-repository discovery, per-repository status and commit-graph data
//! against real temporary repositories (roadmap §4.1).
//!
//! Everything here runs against repositories this test creates in a temporary
//! directory. Nothing contacts a network, and no repository outside the
//! temporary workspace is touched.

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
    let bytes = to_bytes(response.into_body(), 1 << 22).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn git(root: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            // The developer's own global ignore file must not decide what this
            // test's repositories track.
            "-c",
            "core.excludesFile=/dev/null",
            "-c",
            "protocol.file.allow=always",
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
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn seed(root: &std::path::Path, name: &str) {
    std::fs::create_dir_all(root).unwrap();
    git(root, &["init", "-b", "main"]);
    std::fs::write(root.join("README.md"), format!("{name}\n")).unwrap();
    git(root, &["add", "README.md"]);
    git(root, &["commit", "-m", &format!("seed {name}")]);
}

fn repositories(list: &Value) -> Vec<(&str, &str)> {
    list["repositories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| {
            (
                record["repositoryPath"].as_str().unwrap(),
                record["kind"].as_str().unwrap(),
            )
        })
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn discovers_every_checkout_and_scopes_status_and_graph_data_per_repository() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let upstream = directory.path().join("upstream");

    // The workspace root, an independent nested repository, a submodule, and a
    // linked worktree — every kind the switcher has to offer.
    seed(&upstream, "upstream");
    seed(&root, "root");
    // The nested checkouts are ignored by the root repository. Discovery must
    // find them anyway: an ignored directory is very often exactly where an
    // independent repository lives, so gitignore is not a skip rule (§4.1).
    std::fs::write(root.join(".gitignore"), "node_modules/\napps/\ntrees/\n").unwrap();
    git(&root, &["add", ".gitignore"]);
    git(&root, &["commit", "-m", "ignore nested checkouts"]);
    seed(&root.join("apps/inner"), "inner");
    git(
        &root,
        &["submodule", "add", upstream.to_str().unwrap(), "libs/dep"],
    );
    git(&root, &["commit", "-m", "add submodule"]);
    git(
        &root,
        &["worktree", "add", "-b", "feature", "trees/feature"],
    );
    // Directories that are never scanned, even though they hold repositories.
    seed(&root.join("node_modules/pkg"), "pkg");

    // Distinct dirty states, so an aggregate view cannot pass by accident.
    std::fs::write(root.join("root-change.txt"), "one\n").unwrap();
    std::fs::write(root.join("apps/inner/inner-change.txt"), "two\n").unwrap();
    std::fs::write(root.join("apps/inner/second.txt"), "three\n").unwrap();

    let pool = db::connect("sqlite::memory:").await.unwrap();
    let workspace = db::create_workspace(&pool, "workspace", root.to_str().unwrap(), None, None)
        .await
        .unwrap();
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
    let base = format!("/api/workspaces/{}/git", workspace.id);

    /* ----------------------------- discovery ------------------------------ */

    let (status, list) = request(
        &app,
        "GET",
        &format!("{base}/repositories?refresh=true"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let found = repositories(&list);
    assert_eq!(
        found,
        vec![
            (".", "root"),
            ("apps/inner", "nested"),
            ("libs/dep", "submodule"),
            ("trees/feature", "worktree"),
        ],
        "every checkout is offered and node_modules is never descended into"
    );
    assert_eq!(list["maxDepth"], 4);
    assert_eq!(list["truncated"], false);

    let records = list["repositories"].as_array().unwrap();
    // A linked worktree is the same repository as its main checkout, so it
    // shares the id; `repositoryPath` is what tells the two checkouts apart.
    assert_eq!(records[3]["repositoryId"], records[0]["repositoryId"]);
    assert_ne!(records[2]["repositoryId"], records[0]["repositoryId"]);
    assert_eq!(records[3]["headBranch"], "feature");
    assert_eq!(records[0]["headBranch"], "main");
    // With an execution grant the dirty counts are real numbers, and they are
    // per repository rather than one workspace-wide total.
    assert_eq!(records[0]["dirtyCount"], 1);
    assert_eq!(records[1]["dirtyCount"], 2);

    /* --------------------- per-repository Changes ------------------------- */

    let (status, root_status) =
        request(&app, "GET", &format!("{base}/status?path=."), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{root_status}");
    assert_eq!(root_status["changedCount"], 1);
    assert_eq!(root_status["files"][0]["path"], "root-change.txt");

    let (status, inner_status) = request(
        &app,
        "GET",
        &format!("{base}/status?path=apps/inner"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{inner_status}");
    assert_eq!(inner_status["changedCount"], 2);
    assert_eq!(inner_status["branch"], "main");
    // The nested repository reports its own paths, relative to itself — the
    // aggregate view labels them with the repository they came from.
    let inner_paths: Vec<&str> = inner_status["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(inner_paths, vec!["inner-change.txt", "second.txt"]);

    // A commit named a repository, and lands only in that repository.
    let (status, committed) = request(
        &app,
        "POST",
        &format!("{base}/commit"),
        json!({
            "path": "apps/inner",
            "message": "inner: record the change",
            "paths": ["inner-change.txt"]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    let (_, root_after) = request(&app, "GET", &format!("{base}/status?path=."), Value::Null).await;
    assert_eq!(
        root_after["changedCount"], 1,
        "committing in a nested repository must not touch the root"
    );

    /* --------------------------- commit graph ----------------------------- */

    let (status, history) = request(
        &app,
        "GET",
        &format!("{base}/repository/history?path=apps/inner&reference=HEAD&limit=50"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let commits = history["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0]["subject"], "inner: record the change");
    // The seeded commit carries the identity this test configured; the one the
    // API made carries whatever identity Git is configured with here, so only
    // its presence — which is what the graph row renders — is asserted.
    assert_eq!(commits[1]["authorName"], "API test");
    assert!(!commits[0]["authorName"].as_str().unwrap().is_empty());
    assert!(!commits[0]["authorTime"].as_str().unwrap().is_empty());
    // Ref decorations are what the graph draws as branch/tag badges.
    assert!(
        commits[0]["refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry == "refs/heads/main"),
        "history must carry the ref decorations the badges render: {}",
        commits[0]["refs"]
    );
    let head = commits[0]["oid"].as_str().unwrap().to_owned();
    let parent = commits[1]["oid"].as_str().unwrap().to_owned();
    assert_eq!(commits[0]["parents"][0], parent);

    let (status, detail) = request(
        &app,
        "GET",
        &format!("{base}/repository/commit?path=apps/inner&oid={head}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["baseOid"], parent);
    assert_eq!(detail["files"].as_array().unwrap().len(), 1);
    assert_eq!(detail["files"][0]["path"], "inner-change.txt");
    assert_eq!(detail["files"][0]["status"], "A");
    assert_eq!(detail["files"][0]["additions"], 1);

    // The root commit has no parent, so everything in it is an addition.
    let (status, root_detail) = request(
        &app,
        "GET",
        &format!("{base}/repository/commit?path=apps/inner&oid={parent}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{root_detail}");
    assert!(root_detail["baseOid"].is_null());
    assert_eq!(root_detail["files"][0]["path"], "README.md");

    // "Compare to current" diffs the reviewed commit against the working HEAD
    // rather than against its own parent.
    let (status, against_head) = request(
        &app,
        "GET",
        &format!("{base}/repository/commit?path=apps/inner&oid={parent}&base=HEAD"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{against_head}");
    assert_eq!(against_head["baseOid"], head);
    assert_eq!(against_head["files"][0]["path"], "inner-change.txt");
    assert_eq!(against_head["files"][0]["status"], "D");

    let (status, patch) = request(
        &app,
        "GET",
        &format!("{base}/repository/commit-file?path=apps/inner&oid={head}&file=inner-change.txt"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patch}");
    assert_eq!(patch["truncated"], false);
    assert!(
        patch["patch"].as_str().unwrap().contains("+two"),
        "the patch must carry the added line: {}",
        patch["patch"]
    );

    // A commit that does not exist is a not-found, never an empty diff that
    // reads as "this commit changed nothing".
    let (status, _) = request(
        &app,
        "GET",
        &format!(
            "{base}/repository/commit?path=apps/inner&oid={}",
            "0".repeat(40)
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[cfg(unix)]
#[tokio::test]
async fn discovery_reports_an_unknown_dirty_count_without_an_execution_grant() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    seed(&root, "root");
    std::fs::write(root.join("change.txt"), "one\n").unwrap();

    let pool = db::connect("sqlite::memory:").await.unwrap();
    let workspace = db::create_workspace(&pool, "workspace", root.to_str().unwrap(), None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET permissions_json = ?")
        .bind(r#"{"read":true,"write":false,"execute":false}"#)
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

    let (status, list) = request(
        &app,
        "GET",
        &format!("/api/workspaces/{}/git/repositories", workspace.id),
        Value::Null,
    )
    .await;
    // Discovery itself never needs Git to run, so it still answers…
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(repositories(&list), vec![(".", "root")]);
    assert_eq!(list["repositories"][0]["headBranch"], "main");
    // …but the count that would need `git status` is unknown, not zero. The
    // repository does have a change; reporting 0 here would be a lie.
    assert!(list["repositories"][0]["dirtyCount"].is_null());
}
