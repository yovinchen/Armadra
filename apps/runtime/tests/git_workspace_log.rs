// Every case in this file drives the real `git` CLI over a POSIX
// temporary tree and a Unix-socket Runtime; there is nothing left to run on
// Windows, so the whole file compiles away instead of leaving dead helpers.
#![cfg(unix)]

//! The Git window's workspace-level log and branch tree (Git 工具窗口设计 §3.1).
//!
//! Everything here runs against repositories this test creates in a temporary
//! directory, with every commit's author and committer time pinned. Nothing
//! contacts a network, and no repository outside the temporary workspace is
//! touched.
//!
//! The claims under test are the ones a reader of the merged graph depends on:
//!
//! * two repositories that committed inside the same second still produce **one**
//!   order, and the same order on every request;
//! * a page cursor belongs to the filters it was taken under, and a cursor
//!   offered back under different filters is refused by name;
//! * the search box's two switches — regex and case — and the path filter run on
//!   the server, not on the rows the client already has;
//! * a ref only one repository has narrows the graph to that repository instead
//!   of failing the other one's read.

use armadra_runtime::{
    AppState, db, events::EventHub, hook::HookService, router_with_state, settings::SettingsStore,
    terminal::TerminalManager, usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::path::Path;
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

/// `git` with the operator's own configuration kept out of the way, and with
/// both timestamps pinned: the merge is ordered by committer time, so a test
/// about the order must decide the times rather than observe them.
fn git_at(root: &Path, when: Option<&str>, args: &[&str]) {
    let mut command = std::process::Command::new("git");
    command
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.excludesFile=/dev/null",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "user.name=Log test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    if let Some(when) = when {
        command.env("GIT_AUTHOR_DATE", when);
        command.env("GIT_COMMITTER_DATE", when);
    }
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn git(root: &Path, args: &[&str]) {
    git_at(root, None, args);
}

/// One commit whose message and timestamp the test chose.
fn commit(root: &Path, file: &str, message: &str, when: &str) {
    let path = root.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("{message}\n")).unwrap();
    git(root, &["add", "-A"]);
    git_at(root, Some(when), &["commit", "-m", message]);
}

fn seed(root: &Path, name: &str, when: &str) {
    std::fs::create_dir_all(root).unwrap();
    git(root, &["init", "-b", "main"]);
    commit(root, "README.md", &format!("seed {name}"), when);
}

fn subjects(page: &Value) -> Vec<(String, String)> {
    page["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| {
            (
                commit["repositoryPath"].as_str().unwrap().to_owned(),
                commit["subject"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

async fn workspace_app(root: &Path, scratch: &Path) -> (axum::Router, String) {
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
            scratch.to_owned(),
        ),
        hooks: HookService::new(scratch.to_owned(), None),
        usage: UsageService::new(settings),
    });
    (app, workspace.id)
}

/// The workspace both tests below use: the root repository and one independent
/// nested repository, whose commits share a timestamp on purpose.
///
/// `2026-03-01T09:00:00Z` for everything but the two newest commits, which sit
/// a second later — so the merge has both a real ordering decision and a real
/// tie to break.
fn two_repositories(root: &Path) {
    let early = "2026-03-01T09:00:00+0000";
    let late = "2026-03-01T09:00:01+0000";
    seed(root, "root", early);
    commit(root, "apps/web/main.rs", "Fix login", late);
    seed(&root.join("nested"), "nested", early);
    commit(&root.join("nested"), "lib.rs", "fix logout", late);
}

#[tokio::test]
async fn merges_every_repository_into_one_ordered_page_and_binds_the_cursor_to_the_filters() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    two_repositories(&root);

    let (app, id) = workspace_app(&root, directory.path()).await;
    let log = format!("/api/workspaces/{id}/git/log");

    /* ---------------------- one graph, one order ---------------------- */

    let (status, page) = request(&app, "POST", &log, json!({ "limit": 10 })).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    // Newest first by committer time; the two `09:00:01` commits tie, and the
    // tie is broken by the repository's place in the discovery list — the root
    // first — then by each repository's own order.
    assert_eq!(
        subjects(&page),
        vec![
            (".".to_owned(), "Fix login".to_owned()),
            ("nested".to_owned(), "fix logout".to_owned()),
            (".".to_owned(), "seed root".to_owned()),
            ("nested".to_owned(), "seed nested".to_owned()),
        ],
        "{page}"
    );
    assert_eq!(page["nextCursor"], Value::Null);
    assert_eq!(page["truncated"], json!(false));
    // The colour is the checkout's position in the discovery list, so the
    // stripe beside a row is the same colour whatever the log is narrowed to.
    assert_eq!(
        page["repositories"],
        json!([{ "path": ".", "color": 0 }, { "path": "nested", "color": 1 }]),
        "{page}"
    );

    // Asking again returns the identical order: nothing here depends on which
    // `git` process answered first.
    let (_, again) = request(&app, "POST", &log, json!({ "limit": 10 })).await;
    assert_eq!(subjects(&again), subjects(&page));

    /* --------------------------- paging ------------------------------- */

    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    for _ in 0..4 {
        let (status, page) = request(
            &app,
            "POST",
            &log,
            json!({ "limit": 1, "cursor": cursor.clone() }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        seen.extend(subjects(&page));
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(
        seen,
        subjects(&page),
        "paging one row at a time sees the same sequence"
    );
    assert_eq!(cursor, Value::Null, "the last page has no cursor");

    /* ------------------- a cursor belongs to its filters --------------- */

    let (_, first) = request(&app, "POST", &log, json!({ "limit": 1 })).await;
    let cursor = first["nextCursor"].clone();
    assert!(cursor.is_string(), "{first}");
    // The same cursor under a filter it was not taken under: `--skip` counts
    // commits that passed the filter, so continuing here would skip a set
    // nobody has seen. It is refused by name, because the repair — drop the
    // cursor, read the first page — is automatic.
    let (status, refused) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 1, "cursor": cursor.clone(), "authors": ["nobody"] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["code"], json!("invalid_cursor"), "{refused}");
    // Narrowing to one repository is a filter change too.
    let (status, refused) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 1, "cursor": cursor.clone(), "repositories": ["nested"] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["code"], json!("invalid_cursor"));
    // The unchanged filters still continue.
    let (status, second) =
        request(&app, "POST", &log, json!({ "limit": 1, "cursor": cursor })).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(
        subjects(&second),
        vec![("nested".to_owned(), "fix logout".to_owned())]
    );
}

#[tokio::test]
async fn filters_the_graph_on_the_server_and_keeps_the_colour_when_narrowed() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    two_repositories(&root);
    // A branch only the root repository has, so a named-ref filter has to leave
    // the other repository out rather than fail its read.
    git(&root, &["checkout", "-q", "-b", "release"]);
    commit(
        &root,
        "release.txt",
        "Release 1.0",
        "2026-03-01T09:00:02+0000",
    );
    git(&root, &["checkout", "-q", "main"]);

    let (app, id) = workspace_app(&root, directory.path()).await;
    let log = format!("/api/workspaces/{id}/git/log");

    /* ------------------------ text, regex, case ----------------------- */

    async fn matched(app: &axum::Router, log: &str, text: Value) -> Vec<(String, String)> {
        let (status, page) = request(
            app,
            "POST",
            log,
            json!({ "limit": 10, "refs": { "kind": "all" }, "text": text }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        subjects(&page)
    }
    // A plain substring, case-insensitively: both spellings of "fix".
    assert_eq!(
        matched(
            &app,
            &log,
            json!({ "query": "fix", "regex": false, "matchCase": false })
        )
        .await,
        vec![
            (".".to_owned(), "Fix login".to_owned()),
            ("nested".to_owned(), "fix logout".to_owned()),
        ]
    );
    // With the case switch on, only the lowercase one.
    assert_eq!(
        matched(
            &app,
            &log,
            json!({ "query": "fix", "regex": false, "matchCase": true })
        )
        .await,
        vec![("nested".to_owned(), "fix logout".to_owned())]
    );
    // A regular expression anchors; the same text read literally would match
    // nothing, which is what makes this switch observable.
    assert_eq!(
        matched(
            &app,
            &log,
            json!({ "query": "^Fix log", "regex": true, "matchCase": true })
        )
        .await,
        vec![(".".to_owned(), "Fix login".to_owned())]
    );
    assert_eq!(
        matched(
            &app,
            &log,
            json!({ "query": "^Fix log", "regex": false, "matchCase": true })
        )
        .await,
        vec![]
    );
    // A pattern Git cannot compile is a named refusal, not an empty page.
    let (status, refused) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 10, "text": { "query": "(unclosed", "regex": true } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");

    /* ---------------------------- paths ------------------------------- */

    let (status, page) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 10, "paths": ["apps"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        subjects(&page),
        vec![(".".to_owned(), "Fix login".to_owned())],
        "only the commit that touched apps/ survives, in either repository"
    );

    /* -------------------------- named refs ---------------------------- */

    let (status, page) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 10, "refs": { "kind": "named", "names": ["release"] } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    // `release` exists only in the root repository. The nested one contributes
    // nothing instead of failing, and both are still listed with their colours.
    assert_eq!(
        subjects(&page),
        vec![
            (".".to_owned(), "Release 1.0".to_owned()),
            (".".to_owned(), "Fix login".to_owned()),
            (".".to_owned(), "seed root".to_owned()),
        ]
    );
    assert_eq!(
        page["repositories"],
        json!([{ "path": ".", "color": 0 }, { "path": "nested", "color": 1 }])
    );

    /* ------------------- narrowing keeps the colour ------------------- */

    let (status, page) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 10, "repositories": ["nested"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        page["repositories"],
        json!([{ "path": "nested", "color": 1 }]),
        "the second repository stays colour 1 when it is the only one shown"
    );
    assert_eq!(
        subjects(&page),
        vec![
            ("nested".to_owned(), "fix logout".to_owned()),
            ("nested".to_owned(), "seed nested".to_owned()),
        ]
    );

    // A checkout discovery did not find has no colour, so it is refused rather
    // than merged in without one.
    let (status, refused) = request(
        &app,
        "POST",
        &log,
        json!({ "limit": 10, "repositories": ["not-a-repository"] }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
}

#[tokio::test]
async fn the_branch_tree_answers_for_every_repository_at_once() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let remote = directory.path().join("remote.git");
    two_repositories(&root);

    // A bare remote on this machine, so `origin/main` and an ahead count are
    // real rather than simulated.
    std::fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "--bare", "-b", "main"]);
    git(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&root, &["push", "-u", "origin", "main"]);
    commit(&root, "ahead.txt", "One ahead", "2026-03-01T09:00:03+0000");
    git(&root, &["tag", "-a", "v1.0", "-m", "release"]);
    git(&root, &["branch", "feature/login"]);
    git(&root, &["worktree", "add", "-b", "spike", "trees/spike"]);
    std::fs::write(root.join("dirty.txt"), "dirty\n").unwrap();
    git(&root, &["add", "dirty.txt"]);
    git(&root, &["stash", "push", "-m", "wip"]);

    let (app, id) = workspace_app(&root, directory.path()).await;
    let (status, tree) = request(
        &app,
        "GET",
        &format!("/api/workspaces/{id}/git/refs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tree}");
    let repositories = tree.as_array().unwrap();
    let paths: Vec<&str> = repositories
        .iter()
        .map(|entry| entry["repositoryPath"].as_str().unwrap())
        .collect();
    // The root, the linked worktree it created, and the independent nested
    // repository — one answer for the whole tree.
    assert!(paths.contains(&"."), "{paths:?}");
    assert!(paths.contains(&"nested"), "{paths:?}");
    assert!(paths.contains(&"trees/spike"), "{paths:?}");

    let main = &repositories[paths.iter().position(|path| *path == ".").unwrap()];
    assert_eq!(main["kind"], json!("root"));
    assert_eq!(main["head"]["branch"], json!("main"));
    assert!(main["head"]["oid"].is_string(), "{main}");
    assert_eq!(main["stashCount"], json!(1), "{main}");

    // The stash group is a menu, not a badge: applying, popping or dropping one
    // names the object it observed, because the `stash@{n}` selector moves the
    // moment another stash is pushed.
    let stashes = main["stashes"].as_array().unwrap();
    assert_eq!(stashes.len(), 1, "{stashes:?}");
    assert_eq!(stashes[0]["index"], json!(0), "{stashes:?}");
    assert!(
        stashes[0]["oid"].as_str().unwrap().len() >= 40,
        "{stashes:?}"
    );
    assert!(
        stashes[0]["message"].as_str().unwrap().contains("wip"),
        "{stashes:?}"
    );
    assert!(stashes[0]["createdAt"].is_string(), "{stashes:?}");

    let branches = main["branches"].as_array().unwrap();
    let current = branches
        .iter()
        .find(|branch| branch["name"] == json!("main"))
        .unwrap();
    assert_eq!(current["current"], json!(true));
    assert_eq!(current["upstream"], json!("origin/main"), "{current}");
    // One commit made after the push, and nothing fetched since.
    assert_eq!(current["ahead"], json!(1), "{current}");
    assert_eq!(current["behind"], json!(0), "{current}");
    let untracked = branches
        .iter()
        .find(|branch| branch["name"] == json!("feature/login"))
        .unwrap();
    // No upstream is `null`, never zero: "nothing to push" and "nowhere to
    // push" are different answers.
    assert_eq!(untracked["upstream"], Value::Null, "{untracked}");
    assert_eq!(untracked["ahead"], Value::Null);
    assert_eq!(untracked["behind"], Value::Null);
    assert_eq!(untracked["current"], json!(false));

    let origin = main["remotes"].as_array().unwrap();
    assert_eq!(origin.len(), 1, "{origin:?}");
    assert_eq!(origin[0]["name"], json!("origin"));
    assert_eq!(
        origin[0]["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|branch| branch["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["main"]
    );

    let tags = main["tags"].as_array().unwrap();
    assert_eq!(tags.len(), 1, "{tags:?}");
    assert_eq!(tags[0]["name"], json!("v1.0"));
    assert_eq!(tags[0]["annotated"], json!(true));
    // An annotated tag reports the commit it names, not its own object: that is
    // what a tree node navigates to.
    assert_eq!(tags[0]["oid"], main["head"]["oid"], "{tags:?}");

    let worktrees = main["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 2, "{worktrees:?}");
    assert!(
        worktrees
            .iter()
            .any(|worktree| worktree["branch"] == json!("spike")),
        "{worktrees:?}"
    );
    assert!(
        worktrees
            .iter()
            .all(|worktree| worktree["locked"] == json!(false))
    );

    let nested = &repositories[paths.iter().position(|path| *path == "nested").unwrap()];
    assert_eq!(nested["kind"], json!("nested"));
    assert_eq!(nested["stashCount"], json!(0), "{nested}");
    assert_eq!(nested["stashes"], json!([]), "{nested}");
    assert_eq!(nested["remotes"], json!([]));
    assert_eq!(nested["tags"], json!([]));
}

/// The identity a commit from a checkout would carry.
///
/// It is asked of Git rather than inferred, and it is asked *per checkout*: the
/// nested repository below is configured with a different address, which is
/// exactly the case one workspace-wide guess gets wrong.
#[tokio::test]
async fn each_checkout_reports_the_identity_it_would_commit_as() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    two_repositories(&root);
    // Written into each repository's own config rather than relied on from the
    // machine's: this test must answer the same on every machine.
    git(&root, &["config", "user.name", "Root Author"]);
    git(&root, &["config", "user.email", "root@example.test"]);
    git(
        &root.join("nested"),
        &["config", "user.email", "nested@example.test"],
    );
    let (app, id) = workspace_app(&root, directory.path()).await;

    let (status, identity) = request(
        &app,
        "GET",
        &format!("/api/workspaces/{id}/git/identity?path=."),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{identity}");
    assert_eq!(identity["name"], json!("Root Author"), "{identity}");
    assert_eq!(identity["email"], json!("root@example.test"), "{identity}");

    let (status, nested) = request(
        &app,
        "GET",
        &format!("/api/workspaces/{id}/git/identity?path=nested"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{nested}");
    assert_eq!(nested["email"], json!("nested@example.test"), "{nested}");
}
