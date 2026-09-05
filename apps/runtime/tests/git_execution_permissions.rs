#![cfg(unix)]
//! Real repository helpers and loopback-only transports; never real credentials
//! or network remotes. Workspace grants are request capabilities, not a sandbox.
use armadra_runtime::{
    AppState, db, events::EventHub, hook::HookService, router_with_state, settings::SettingsStore,
    terminal::TerminalManager, usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tower::ServiceExt;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .trim_end_matches('\n')
        .into()
}
struct Fixture {
    temp: tempfile::TempDir,
    repo: PathBuf,
    pool: sqlx::SqlitePool,
    app: axum::Router,
    id: String,
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("project");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Permission Test"]);
        git(
            &repo,
            &["config", "user.email", "permission@example.invalid"],
        );
        git(&repo, &["config", "core.hooksPath", ".git/hooks"]);
        git(&repo, &["config", "core.excludesFile", "/dev/null"]);
        std::fs::write(repo.join("file"), "base\n").unwrap();
        git(&repo, &["add", "file"]);
        git(&repo, &["commit", "-m", "base"]);
        let pool = db::connect("sqlite::memory:").await.unwrap();
        let workspace = db::create_workspace(&pool, "project", repo.to_str().unwrap(), None, None)
            .await
            .unwrap();
        let events = EventHub::new();
        let settings = SettingsStore::in_memory(json!({"terminal":{"backend":"direct"}}));
        let app = router_with_state(AppState {
            remote: Default::default(),
            resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
            pool: pool.clone(),
            events: events.clone(),
            settings: settings.clone(),
            terminals: TerminalManager::with_config(
                pool.clone(),
                events,
                settings.clone(),
                temp.path().to_owned(),
            ),
            hooks: HookService::new(temp.path().to_owned(), None),
            usage: UsageService::new(settings),
        });
        Self {
            temp,
            repo,
            pool,
            app,
            id: workspace.id,
        }
    }
    fn base(&self) -> String {
        format!("/api/workspaces/{}/git", self.id)
    }
    async fn permissions(&self, read: bool, write: bool, execute: bool) {
        sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
            .bind(json!({"read":read,"write":write,"execute":execute}).to_string())
            .bind(&self.id)
            .execute(&self.pool)
            .await
            .unwrap();
    }
    async fn call(&self, method: &str, suffix: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("{}{suffix}", self.base()))
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
        let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }
    fn script(&self, name: &str, body: &str) {
        let path = self.repo.join(".git").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn clear(&self, names: &[&str]) {
        for name in names {
            let _ = std::fs::remove_file(self.repo.join(".git").join(name));
        }
    }
    fn marked(&self, name: &str) -> bool {
        self.repo.join(".git").join(name).exists()
    }
    async fn wait(&self, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let (status, value) = self
                    .call("GET", &format!("/repository/operations/{id}"), Value::Null)
                    .await;
                assert_eq!(status, StatusCode::OK, "{value}");
                if !["queued", "running"].contains(&value["state"].as_str().unwrap()) {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
}
fn denied(result: (StatusCode, Value)) {
    assert_eq!(result.0, StatusCode::FORBIDDEN, "{}", result.1);
    assert_eq!(result.1["code"], "git_execution_required", "{}", result.1);
}

#[tokio::test]
async fn no_execute_keeps_object_views_but_never_runs_worktree_helpers_or_signature_tools() {
    let f = Fixture::new().await;
    f.script("monitor", "printf ran > .git/monitor-ran");
    git(&f.repo, &["config", "core.fsmonitor", "sh .git/monitor"]);
    f.script("clean", "printf ran > .git/clean-ran\ntr 'a-z' 'A-Z'");
    git(
        &f.repo,
        &["config", "filter.sentinel.clean", "sh .git/clean"],
    );
    f.script(
        "external",
        "printf ran > .git/external-ran\nprintf 'external diff\\n'",
    );
    git(&f.repo, &["config", "diff.external", "sh .git/external"]);
    f.script("textconv", "printf ran > .git/textconv-ran\ncat \"$1\"");
    git(
        &f.repo,
        &["config", "diff.sentinel.textconv", "sh .git/textconv"],
    );
    std::fs::write(
        f.repo.join(".gitattributes"),
        "file filter=sentinel diff=sentinel\n",
    )
    .unwrap();
    std::fs::write(f.repo.join("file"), "next\n").unwrap();
    git(&f.repo, &["add", "file"]);
    assert!(f.marked("clean-ran"));
    f.clear(&["clean-ran", "monitor-ran", "external-ran", "textconv-ran"]);
    let (code, diff) = f.call("GET", "/diff?scope=staged", Value::Null).await;
    assert_eq!(code, StatusCode::OK, "{diff}");
    assert!(
        diff["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("+NEXT")
    );
    for name in ["clean-ran", "monitor-ran", "external-ran", "textconv-ran"] {
        assert!(!f.marked(name), "restricted staged diff ran {name}");
    }
    for path in [
        "/status",
        "/diff?scope=worktree",
        "/repository/worktrees",
        "/repository/stashes",
        "/repository/integration",
        "/hunks?file=file&scope=staged",
        "/message/source",
        "/message/providers",
    ] {
        denied(f.call("GET", path, Value::Null).await);
    }
    for name in ["clean-ran", "monitor-ran", "external-ran", "textconv-ran"] {
        assert!(!f.marked(name));
    }
    let stash = git(&f.repo, &["stash", "create", "permission fixture"]);
    git(
        &f.repo,
        &["stash", "store", "-m", "permission fixture", &stash],
    );
    f.clear(&["clean-ran", "monitor-ran", "external-ran", "textconv-ran"]);
    let (code, detail) = f
        .call(
            "GET",
            &format!("/repository/stash-detail?oid={stash}"),
            Value::Null,
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{detail}");
    assert!(detail["patch"].as_str().unwrap().contains("+NEXT"));
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    let (code, preview) = f
        .call(
            "GET",
            &format!("/repository/cherry-pick-preview?oid={head}"),
            Value::Null,
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{preview}");
    for name in ["clean-ran", "monitor-ran", "external-ran", "textconv-ran"] {
        assert!(!f.marked(name), "object preview ran {name}");
    }
    // A signature-configured history really can run a custom verifier. Use a
    // synthetic signed commit and a local sentinel, never an actual GPG key.
    f.script("gpg", "printf ran > .git/gpg-ran\nexit 1");
    git(&f.repo, &["config", "gpg.program", ".git/gpg"]);
    git(&f.repo, &["config", "log.showSignature", "true"]);
    let tree = git(&f.repo, &["rev-parse", "HEAD^{tree}"]);
    let parent = git(&f.repo, &["rev-parse", "HEAD"]);
    let content = format!(
        "tree {tree}\nparent {parent}\nauthor Test <test@example.invalid> 1000000000 +0000\ncommitter Test <test@example.invalid> 1000000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n invalid\n -----END PGP SIGNATURE-----\n\nsigned fixture\n"
    );
    let mut command = Command::new("git")
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .current_dir(&f.repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    command
        .stdin
        .take()
        .unwrap()
        .write_all(content.as_bytes())
        .unwrap();
    let out = command.wait_with_output().unwrap();
    assert!(out.status.success());
    let oid = String::from_utf8(out.stdout).unwrap();
    git(&f.repo, &["update-ref", "HEAD", oid.trim()]);
    git(&f.repo, &["log", "-1", "--show-signature"]);
    assert!(f.marked("gpg-ran"));
    f.clear(&["gpg-ran"]);
    let (code, history) = f.call("GET", "/repository/history", Value::Null).await;
    assert_eq!(code, StatusCode::OK, "{history}");
    assert_eq!(history["commits"][0]["subject"], "signed fixture");
    assert!(!f.marked("gpg-ran"));
    let (code, branches) = f.call("GET", "/repository/branches", Value::Null).await;
    assert_eq!(code, StatusCode::OK, "{branches}");
    f.permissions(false, true, true).await;
    for path in ["/status", "/diff?scope=staged", "/repository/history"] {
        assert_eq!(
            f.call("GET", path, Value::Null).await.0,
            StatusCode::FORBIDDEN
        );
    }
    f.pool.close().await;
}

#[tokio::test]
async fn writes_require_execution_and_authorized_filters_hooks_and_smudge_keep_their_semantics() {
    let f = Fixture::new().await;
    f.script("clean", "printf ran > .git/clean-ran\ntr 'a-z' 'A-Z'");
    f.script("smudge", "printf ran > .git/smudge-ran\ntr 'A-Z' 'a-z'");
    f.script("hooks/pre-commit", "printf ran > .git/hook-ran");
    git(
        &f.repo,
        &["config", "filter.sentinel.clean", "sh .git/clean"],
    );
    git(
        &f.repo,
        &["config", "filter.sentinel.smudge", "sh .git/smudge"],
    );
    std::fs::write(f.repo.join(".gitattributes"), "file filter=sentinel\n").unwrap();
    std::fs::write(f.repo.join("file"), "next\n").unwrap();
    let before = std::fs::read(f.repo.join(".git/index")).unwrap();
    for endpoint in ["/stage", "/unstage", "/revert"] {
        denied(f.call("POST", endpoint, json!({"paths":["file"]})).await);
    }
    denied(
        f.call(
            "POST",
            "/commit",
            json!({"message":"not authorized","paths":["file"]}),
        )
        .await,
    );
    denied(f.call("POST","/hunks",json!({"file":"file","scope":"worktree","diffDigest":"a".repeat(64),"hunkId":"b".repeat(64),"action":"stage"})).await);
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), before);
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file")).unwrap(),
        "next\n"
    );
    for name in ["clean-ran", "smudge-ran", "hook-ran"] {
        assert!(!f.marked(name));
    }
    f.permissions(true, true, true).await;
    assert_eq!(
        f.call("POST", "/stage", json!({"paths":["file"]})).await.0,
        StatusCode::OK
    );
    assert!(f.marked("clean-ran"));
    assert_eq!(git(&f.repo, &["show", ":file"]), "NEXT");
    let (code, result) = f
        .call(
            "POST",
            "/commit",
            json!({"message":"authorized","paths":["file"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{result}");
    assert!(f.marked("hook-ran"));
    assert_eq!(git(&f.repo, &["show", "HEAD:file"]), "NEXT");
    f.clear(&["smudge-ran"]);
    std::fs::write(f.repo.join("file"), "other\n").unwrap();
    assert_eq!(
        f.call("POST", "/revert", json!({"paths":["file"]})).await.0,
        StatusCode::OK
    );
    assert!(f.marked("smudge-ran"));
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file")).unwrap(),
        "next\n"
    );
    f.pool.close().await;
}

#[tokio::test]
async fn fetch_helpers_need_execution_but_an_owned_job_can_still_be_cancelled_after_revocation() {
    let f = Fixture::new().await;
    f.script("ssh", "printf ran > .git/ssh-ran\nexit 1");
    git(&f.repo, &["config", "core.sshCommand", "sh .git/ssh"]);
    git(
        &f.repo,
        &["remote", "add", "origin", "ssh://sentinel@127.0.0.1/unused"],
    );
    let (_, branches) = f.call("GET", "/repository/branches", Value::Null).await;
    let fetch = json!({"action":{"kind":"fetch","remote":"origin","prune":false},"expected":branches["head"]});
    denied(
        f.call("POST", "/repository/operations", fetch.clone())
            .await,
    );
    assert!(!f.marked("ssh-ran"));
    f.permissions(true, true, true).await;
    let (code, job) = f.call("POST", "/repository/operations", fetch).await;
    assert_eq!(code, StatusCode::OK, "{job}");
    let finished = f.wait(job["id"].as_str().unwrap()).await;
    assert_ne!(finished["state"], "succeeded");
    assert!(f.marked("ssh-ran"));
    f.script(
        "hooks/post-checkout",
        "printf ran > .git/checkout-ran\nexec sleep 1",
    );
    let (_, branches) = f.call("GET", "/repository/branches", Value::Null).await;
    let (code,job)=f.call("POST","/repository/operations",json!({"action":{"kind":"createBranch","name":"permission-lifecycle","startPoint":null,"switch":true},"expected":branches["head"]})).await;
    assert_eq!(code, StatusCode::OK, "{job}");
    let id = job["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f.marked("checkout-ran") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    f.permissions(true, true, false).await;
    assert_eq!(
        f.call("GET", &format!("/repository/operations/{id}"), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.call(
            "POST",
            &format!("/repository/operations/{id}/cancel"),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(f.wait(id).await["state"], "unknownOutcome");
    assert_eq!(
        f.call("GET", "/repository/operations", Value::Null).await.0,
        StatusCode::OK
    );
    f.pool.close().await;
}

async fn global_request(app: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn clone_destination_obeys_every_registered_ancestor_after_resolving_symlinks() {
    let f = Fixture::new().await;
    let nested = f.repo.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let child = db::create_workspace(&f.pool, "nested", nested.to_str().unwrap(), None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
        .bind(r#"{"read":true,"write":true,"execute":true}"#)
        .bind(&child.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let alias = f.temp.path().join("alias");
    std::os::unix::fs::symlink(&f.repo, &alias).unwrap();
    let body = json!({"url":"ssh://sentinel@127.0.0.1/unused","parent":alias.join("nested"),"name":"new-clone"});
    denied(global_request(&f.app, "/api/git/clone", body.clone()).await);
    assert!(!nested.join("new-clone").exists());
    f.permissions(true, true, true).await;
    sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
        .bind(r#"{"read":true,"write":true,"execute":false}"#)
        .bind(&child.id)
        .execute(&f.pool)
        .await
        .unwrap();
    denied(global_request(&f.app, "/api/git/clone", body.clone()).await);
    sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
        .bind(r#"{"read":true,"write":true,"execute":true}"#)
        .bind(&child.id)
        .execute(&f.pool)
        .await
        .unwrap();
    // Invalid URLs prove the permission checks completed without launching any
    // network job; authorized clone transfer itself has separate runner tests.
    let invalid = json!({"url":"file:///not-supported","parent":nested,"name":"new-clone"});
    assert_eq!(
        global_request(&f.app, "/api/git/clone", invalid).await.0,
        StatusCode::BAD_REQUEST
    );
    let outside = json!({"url":"file:///not-supported","parent":f.temp.path(),"name":"outside"});
    assert_eq!(
        global_request(&f.app, "/api/git/clone", outside).await.0,
        StatusCode::BAD_REQUEST
    );
    f.pool.close().await;
}

#[tokio::test]
async fn restricted_object_reads_do_not_lazily_fetch_missing_promisor_blobs() {
    let f = Fixture::new().await;
    std::fs::write(f.repo.join("picked"), "missing blob fixture\n").unwrap();
    git(&f.repo, &["add", "picked"]);
    git(&f.repo, &["commit", "-m", "missing blob"]);
    let commit = git(&f.repo, &["rev-parse", "HEAD"]);
    let blob = git(&f.repo, &["rev-parse", "HEAD:picked"]);
    f.script("ssh", "printf ran > .git/ssh-ran\nexit 1");
    git(&f.repo, &["config", "core.sshCommand", "sh .git/ssh"]);
    git(
        &f.repo,
        &["remote", "add", "origin", "ssh://sentinel@127.0.0.1/unused"],
    );
    git(&f.repo, &["config", "remote.origin.promisor", "true"]);
    git(&f.repo, &["config", "extensions.partialClone", "origin"]);
    std::fs::remove_file(
        f.repo
            .join(".git/objects")
            .join(&blob[..2])
            .join(&blob[2..]),
    )
    .unwrap();
    let raw = Command::new("git")
        .args(["show", "HEAD:picked"])
        .current_dir(&f.repo)
        .env_remove("GIT_NO_LAZY_FETCH")
        .env_remove("GIT_ALLOW_PROTOCOL")
        .env_remove("GIT_SSH_COMMAND")
        .output()
        .unwrap();
    assert!(!raw.status.success());
    assert!(f.marked("ssh-ran"));
    f.clear(&["ssh-ran"]);
    let fallback = Command::new("git")
        .args(["show", "HEAD:picked"])
        .current_dir(&f.repo)
        .env("GIT_ALLOW_PROTOCOL", "")
        .env_remove("GIT_NO_LAZY_FETCH")
        .env_remove("GIT_SSH_COMMAND")
        .output()
        .unwrap();
    assert!(!fallback.status.success());
    assert!(
        !f.marked("ssh-ran"),
        "protocol deny-list must independently stop lazy fetch helpers"
    );
    let (code, error) = f
        .call(
            "GET",
            &format!("/repository/cherry-pick-preview?oid={commit}"),
            Value::Null,
        )
        .await;
    assert!(!code.is_success(), "{error}");
    assert!(
        !f.marked("ssh-ran"),
        "read-only object inspection invoked a transport helper"
    );
    f.pool.close().await;
}

#[tokio::test]
async fn credential_helpers_are_blocked_before_network_and_work_when_explicitly_authorized() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = [0u8; 8192];
            let _ = stream.read(&mut header).await;
            seen.fetch_add(1, Ordering::SeqCst);
            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"sentinel\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        }
    });
    f.script(
        "credential",
        "printf ran > .git/credential-ran\nprintf 'username=sentinel\\npassword=not-a-secret\\n'",
    );
    git(&f.repo, &["config", "credential.helper", ""]);
    git(
        &f.repo,
        &[
            "config",
            "--add",
            "credential.helper",
            "!sh .git/credential",
        ],
    );
    git(&f.repo, &["config", "http.proxy", ""]);
    git(
        &f.repo,
        &["remote", "add", "origin", &format!("http://{address}/repo")],
    );
    let (_, branches) = f.call("GET", "/repository/branches", Value::Null).await;
    let fetch = json!({"action":{"kind":"fetch","remote":"origin","prune":false},"expected":branches["head"]});
    denied(
        f.call("POST", "/repository/operations", fetch.clone())
            .await,
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(!f.marked("credential-ran"));
    f.permissions(true, true, true).await;
    let (code, job) = f.call("POST", "/repository/operations", fetch).await;
    assert_eq!(code, StatusCode::OK, "{job}");
    let outcome = f.wait(job["id"].as_str().unwrap()).await;
    assert_ne!(outcome["state"], "succeeded");
    assert!(f.marked("credential-ran"));
    assert!(requests.load(Ordering::SeqCst) >= 2);
    server.abort();
    let _ = server.await;
    f.pool.close().await;
}
