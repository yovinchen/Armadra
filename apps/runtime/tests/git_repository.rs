//! Real local Git repositories only. No test pushes to a network remote.
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use armadra_runtime::git_repository::{
    ExpectedState, HistoryRequest, OperationSnapshot, OperationState, RepositoryAction as Action,
    RepositoryService,
};
use tempfile::TempDir;

struct Fixture {
    directory: TempDir,
    repo: PathBuf,
    service: RepositoryService,
}

fn git(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(arguments)
        .current_dir(directory)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches('\n')
        .into()
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo with 空格");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--initial-branch=main"]);
        git(&repo, &["config", "user.name", "测试 Author"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "core.hooksPath", ".git/hooks"]);
        git(&repo, &["config", "core.fsmonitor", "false"]);
        git(&repo, &["config", "core.excludesFile", "/dev/null"]);
        Self {
            directory,
            repo,
            service: RepositoryService::new(),
        }
    }
    fn root(&self) -> &Path {
        self.directory.path()
    }
    fn requested(&self) -> String {
        self.repo
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
    fn commit(&self, name: &str, text: &str) -> String {
        std::fs::write(self.repo.join(name), text).unwrap();
        git(&self.repo, &["add", "--", name]);
        git(&self.repo, &["commit", "-m", text]);
        git(&self.repo, &["rev-parse", "HEAD"])
    }
    async fn head(&self) -> ExpectedState {
        self.service
            .branches(self.root(), &self.requested())
            .await
            .unwrap()
            .head
    }
    async fn start(&self, action: Action) -> OperationSnapshot {
        self.service
            .start(
                self.root().to_owned(),
                self.requested(),
                action,
                self.head().await,
            )
            .await
            .unwrap()
    }
    async fn run(&self, action: Action) -> OperationSnapshot {
        let operation = self.start(action).await;
        await_operation(&self.service, &operation.id).await
    }
    async fn success(&self, action: Action) -> OperationSnapshot {
        let result = self.run(action).await;
        assert_eq!(result.state, OperationState::Succeeded, "{result:?}");
        result
    }
    fn remote(&self) -> PathBuf {
        let remote = self.root().join("remote bare.git");
        git(
            self.root(),
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        );
        git(
            &self.repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        // Assert Git's actual configured push target is this local directory,
        // even if the machine has URL rewrite configuration.
        let push = git(&self.repo, &["remote", "get-url", "--push", "origin"]);
        assert_eq!(
            Path::new(&push).canonicalize().unwrap(),
            remote.canonicalize().unwrap()
        );
        remote
    }
}

async fn await_operation(service: &RepositoryService, id: &str) -> OperationSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = service.operation(id).unwrap();
            if snapshot.state.terminal() {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Git operation did not finish")
}

#[tokio::test]
async fn branches_support_unborn_unicode_checkout_safety_and_expected_refs() {
    let fixture = Fixture::new();
    let empty = fixture
        .service
        .branches(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(
        empty.head,
        ExpectedState {
            head_oid: None,
            branch: Some("main".into())
        }
    );
    assert!(empty.branches.is_empty());
    assert!(
        fixture
            .service
            .history(
                fixture.root(),
                &fixture.requested(),
                HistoryRequest::default()
            )
            .await
            .unwrap()
            .commits
            .is_empty()
    );
    let initial = fixture.commit("文件 with spaces.txt", "first");
    fixture
        .success(Action::CreateBranch {
            name: "feature/分支".into(),
            start_point: Some(initial.clone()),
            switch: true,
        })
        .await;
    assert_eq!(fixture.head().await.branch.as_deref(), Some("feature/分支"));
    fixture
        .success(Action::SwitchBranch {
            name: "main".into(),
            expected_oid: initial.clone(),
        })
        .await;
    let bad = fixture
        .run(Action::SwitchBranch {
            name: "feature/分支".into(),
            expected_oid: "a".repeat(40),
        })
        .await;
    assert_eq!(bad.state, OperationState::Failed);
    fixture
        .success(Action::DeleteBranch {
            name: "feature/分支".into(),
            expected_oid: initial.clone(),
        })
        .await;
    assert!(
        !fixture
            .service
            .branches(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature/分支")
    );
    for name in [
        "--force",
        "bad..name",
        "@{-1}",
        "bad\nname",
        "refs/heads/extra",
    ] {
        assert!(
            fixture
                .service
                .start(
                    fixture.root().to_owned(),
                    fixture.requested(),
                    Action::CreateBranch {
                        name: name.into(),
                        start_point: None,
                        switch: false
                    },
                    fixture.head().await
                )
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn history_pins_commit_anchor_across_new_heads_and_keeps_merge_parents_and_refs() {
    let fixture = Fixture::new();
    let first = fixture.commit("root.txt", "first");
    fixture
        .success(Action::CreateBranch {
            name: "feature/history".into(),
            start_point: None,
            switch: true,
        })
        .await;
    let feature = fixture.commit("feature.txt", "功能提交 📚");
    fixture
        .success(Action::SwitchBranch {
            name: "main".into(),
            expected_oid: first.clone(),
        })
        .await;
    fixture.commit("main.txt", "main line");
    git(
        &fixture.repo,
        &["merge", "--no-ff", "-m", "merge", "feature/history"],
    );
    let merge = git(&fixture.repo, &["rev-parse", "HEAD"]);
    git(&fixture.repo, &["tag", "-a", "v1", "-m", "release"]);
    let page = fixture
        .service
        .history(
            fixture.root(),
            &fixture.requested(),
            HistoryRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.anchor_oid.as_deref(), Some(merge.as_str()));
    assert_eq!(page.commits[0].parents.len(), 2);
    assert!(page.commits[0].refs.contains(&"refs/tags/v1".into()));
    let cursor = page.next_cursor.unwrap();
    let newer = fixture.commit("newer.txt", "newer");
    let page = fixture
        .service
        .history(
            fixture.root(),
            &fixture.requested(),
            HistoryRequest {
                limit: 100,
                cursor: Some(cursor.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.anchor_oid.as_deref(), Some(merge.as_str()));
    assert!(
        !page
            .commits
            .iter()
            .any(|commit| commit.oid == newer || commit.oid == merge)
    );
    assert!(page.commits.iter().any(|commit| commit.oid == feature
        && commit.subject == "功能提交 📚"
        && commit.author_name == "测试 Author"));
    assert!(page.commits.iter().any(|commit| commit.oid == first));
    assert!(
        fixture
            .service
            .history(
                fixture.root(),
                &fixture.requested(),
                HistoryRequest {
                    reference: "feature/history".into(),
                    cursor: Some(cursor),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn worktree_create_list_dirty_locked_and_main_removal_guards() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "first");
    std::fs::create_dir(fixture.root().join("worktrees")).unwrap();
    fixture
        .success(Action::CreateWorktree {
            path: "worktrees/review 空格".into(),
            branch: "feature/review".into(),
            create_branch: true,
            expected_oid: None,
            start_point: Some(oid.clone()),
        })
        .await;
    let worktree = fixture.root().join("worktrees/review 空格");
    let rows = fixture
        .service
        .worktrees(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].is_main);
    assert!(!rows[1].is_main);
    assert_eq!(rows[1].branch.as_deref(), Some("feature/review"));
    assert_eq!(rows[1].dirty, Some(false));
    let remove = || Action::RemoveWorktree {
        path: "worktrees/review 空格".into(),
        expected_oid: oid.clone(),
        allow_unpublished: true,
    };
    std::fs::write(worktree.join("untracked.txt"), "do not delete").unwrap();
    assert_eq!(fixture.run(remove()).await.state, OperationState::Failed);
    assert_eq!(
        std::fs::read_to_string(worktree.join("untracked.txt")).unwrap(),
        "do not delete"
    );
    std::fs::remove_file(worktree.join("untracked.txt")).unwrap();
    git(
        &fixture.repo,
        &[
            "worktree",
            "lock",
            "--reason",
            "in use",
            worktree.to_str().unwrap(),
        ],
    );
    assert_eq!(fixture.run(remove()).await.state, OperationState::Failed);
    git(
        &fixture.repo,
        &["worktree", "unlock", worktree.to_str().unwrap()],
    );
    assert_eq!(
        fixture
            .run(Action::RemoveWorktree {
                path: fixture.requested(),
                expected_oid: oid.clone(),
                allow_unpublished: true
            })
            .await
            .state,
        OperationState::Failed
    );
    assert_eq!(
        fixture
            .run(Action::RemoveWorktree {
                path: "worktrees/review 空格".into(),
                expected_oid: oid.clone(),
                allow_unpublished: false
            })
            .await
            .state,
        OperationState::Failed
    );
    fixture.success(remove()).await;
    assert!(!worktree.exists());
    assert!(fixture.repo.exists());
    assert_eq!(
        git(&fixture.repo, &["rev-parse", "refs/heads/feature/review"]),
        oid
    );
}

#[tokio::test]
async fn local_remote_fetch_ff_only_pull_push_and_upstream_counts() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
        })
        .await;
    let other = fixture.root().join("second clone");
    git(
        fixture.root(),
        &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Remote Author"]);
    git(&other, &["config", "user.email", "remote@example.invalid"]);
    std::fs::write(other.join("remote.txt"), "remote").unwrap();
    git(&other, &["add", "remote.txt"]);
    git(&other, &["commit", "-m", "remote commit"]);
    git(&other, &["push", "origin", "main"]);
    fixture
        .success(Action::Fetch {
            remote: "origin".into(),
            prune: false,
        })
        .await;
    let state = fixture
        .service
        .branches(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let main = state.branches.iter().find(|branch| branch.current).unwrap();
    assert_eq!((main.ahead, main.behind), (Some(0), Some(1)));
    assert!(
        state
            .branches
            .iter()
            .any(|branch| branch.remote && branch.name == "origin/main")
    );
    fixture
        .success(Action::Pull {
            remote: "origin".into(),
            branch: "main".into(),
        })
        .await;
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("remote.txt")).unwrap(),
        "remote"
    );
    let oid = fixture.commit("local.txt", "local commit");
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
        })
        .await;
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), oid);
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::Fetch {
                    remote: "--all".into(),
                    prune: true
                },
                fixture.head().await
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn common_directory_queue_can_cancel_without_creating_a_branch_and_rechecks_head() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let cancelled = fixture
        .start(Action::CreateBranch {
            name: "feature/cancelled".into(),
            start_point: None,
            switch: false,
        })
        .await;
    assert_eq!(
        fixture.service.cancel(&cancelled.id).unwrap().state,
        OperationState::Queued
    );
    assert_eq!(
        await_operation(&fixture.service, &cancelled.id).await.state,
        OperationState::Cancelled
    );
    let stale = fixture
        .start(Action::CreateBranch {
            name: "feature/stale".into(),
            start_point: None,
            switch: false,
        })
        .await;
    fixture.commit("changed.txt", "changed outside service");
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &stale.id).await.state,
        OperationState::Failed
    );
    let branches = fixture
        .service
        .branches(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(
        branches
            .branches
            .iter()
            .all(|branch| branch.name != "feature/cancelled" && branch.name != "feature/stale")
    );
}

#[tokio::test]
async fn checkout_keeps_dirty_files_and_delete_never_forces_unmerged_commits() {
    let fixture = Fixture::new();
    let main = fixture.commit("shared.txt", "base");
    fixture
        .success(Action::CreateBranch {
            name: "feature/unmerged".into(),
            start_point: None,
            switch: true,
        })
        .await;
    let unmerged = fixture.commit("shared.txt", "branch change");
    fixture
        .success(Action::SwitchBranch {
            name: "main".into(),
            expected_oid: main,
        })
        .await;
    std::fs::write(fixture.repo.join("shared.txt"), "local unsaved edits").unwrap();
    let result = fixture
        .run(Action::SwitchBranch {
            name: "feature/unmerged".into(),
            expected_oid: unmerged.clone(),
        })
        .await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("shared.txt")).unwrap(),
        "local unsaved edits"
    );
    assert_eq!(fixture.head().await.branch.as_deref(), Some("main"));
    assert_ne!(
        fixture
            .run(Action::DeleteBranch {
                name: "feature/unmerged".into(),
                expected_oid: unmerged.clone()
            })
            .await
            .state,
        OperationState::Succeeded
    );
    assert_eq!(
        git(&fixture.repo, &["rev-parse", "refs/heads/feature/unmerged"]),
        unmerged
    );
}

#[tokio::test]
async fn pull_divergence_and_push_configuration_never_force_remote_history() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
        })
        .await;
    let other = fixture.root().join("other");
    git(
        fixture.root(),
        &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Other"]);
    git(&other, &["config", "user.email", "other@example.invalid"]);
    std::fs::write(other.join("other.txt"), "remote diverges").unwrap();
    git(&other, &["add", "other.txt"]);
    git(&other, &["commit", "-m", "remote diverges"]);
    git(&other, &["push", "origin", "main"]);
    let remote_oid = git(&remote, &["rev-parse", "main"]);
    let local_oid = fixture.commit("local.txt", "local diverges");
    let result = fixture
        .run(Action::Pull {
            remote: "origin".into(),
            branch: "main".into(),
        })
        .await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(
        fixture.head().await.head_oid.as_deref(),
        Some(local_oid.as_str())
    );
    assert!(!fixture.repo.join(".git/MERGE_HEAD").exists());
    git(&fixture.repo, &["config", "remote.origin.mirror", "true"]);
    git(
        &fixture.repo,
        &["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"],
    );
    let result = fixture
        .run(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
        })
        .await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(git(&remote, &["rev-parse", "main"]), remote_oid);
    assert!(
        serde_json::from_value::<Action>(
            serde_json::json!({"kind":"push","remote":"origin","branch":"main","force":true})
        )
        .is_err()
    );
}

#[tokio::test]
async fn worktree_guards_share_common_queue_and_protect_ignored_content_and_metadata() {
    let fixture = Fixture::new();
    let oid = fixture.commit(".gitignore", "private.env\n");
    std::fs::create_dir(fixture.root().join("trees")).unwrap();
    fixture
        .success(Action::CreateWorktree {
            path: "trees/review".into(),
            branch: "feature/review".into(),
            create_branch: true,
            expected_oid: None,
            start_point: None,
        })
        .await;
    let linked = fixture.root().join("trees/review");
    let main_guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let pending = fixture
        .service
        .start(
            fixture.root().to_owned(),
            "trees/review".into(),
            Action::CreateBranch {
                name: "feature/from-worktree".into(),
                start_point: None,
                switch: false,
            },
            ExpectedState {
                head_oid: Some(oid.clone()),
                branch: Some("feature/review".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.service.operation(&pending.id).unwrap().state,
        OperationState::Queued
    );
    drop(main_guard);
    assert_eq!(
        await_operation(&fixture.service, &pending.id).await.state,
        OperationState::Succeeded
    );
    std::fs::write(linked.join("private.env"), "keep local secret").unwrap();
    assert_eq!(
        fixture
            .run(Action::RemoveWorktree {
                path: "trees/review".into(),
                expected_oid: oid,
                allow_unpublished: true
            })
            .await
            .state,
        OperationState::Failed
    );
    assert!(linked.join("private.env").exists());
    let unsafe_path = format!("{}/.git/objects/new-checkout", fixture.requested());
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::CreateWorktree {
                    path: unsafe_path,
                    branch: "feature/unsafe".into(),
                    create_branch: true,
                    expected_oid: None,
                    start_point: None
                },
                fixture.head().await
            )
            .await
            .is_err()
    );
    assert!(!fixture.repo.join(".git/objects/new-checkout").exists());
}

#[tokio::test]
async fn fifo_create_then_delete_observes_submission_order() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let create = fixture
        .start(Action::CreateBranch {
            name: "feature/ordered".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let delete = fixture
        .start(Action::DeleteBranch {
            name: "feature/ordered".into(),
            expected_oid: oid,
        })
        .await;
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &create.id).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        await_operation(&fixture.service, &delete.id).await.state,
        OperationState::Succeeded
    );
    assert!(
        !fixture
            .service
            .branches(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature/ordered")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn running_cancellation_is_unknown_and_does_not_replay_the_mutation() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    fixture
        .success(Action::CreateBranch {
            name: "feature/cancel-hook".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let hook = fixture.repo.join(".git/hooks/post-checkout");
    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf ready > \"$PWD/hook-ready\"\nsleep 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let started = fixture
        .start(Action::SwitchBranch {
            name: "feature/cancel-hook".into(),
            expected_oid: oid,
        })
        .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.repo.join("hook-ready").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.service.cancel(&started.id).unwrap();
    let result = await_operation(&fixture.service, &started.id).await;
    assert_eq!(result.state, OperationState::UnknownOutcome);
    assert!(result.cancellation_requested);
    assert_eq!(
        fixture.head().await.branch.as_deref(),
        Some("feature/cancel-hook")
    );
    assert_eq!(
        fixture.service.operation(&started.id).unwrap().state,
        OperationState::UnknownOutcome
    );
}

#[cfg(unix)]
#[tokio::test]
async fn worktree_nul_records_preserve_newline_paths_and_authority() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    let newline = fixture.root().join("review\n工作树");
    git(
        &fixture.repo,
        &[
            "worktree",
            "add",
            "-b",
            "feature/newline",
            newline.to_str().unwrap(),
            &oid,
        ],
    );
    let records = fixture
        .service
        .worktrees(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let expected_path = newline.canonicalize().unwrap();
    assert!(
        records
            .iter()
            .any(|row| Path::new(&row.path) == expected_path
                && row.accessible
                && row.dirty == Some(false)),
        "{records:?}"
    );
    let outside = tempfile::tempdir().unwrap();
    let forbidden = outside.path().join("checkout");
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::CreateWorktree {
                    path: forbidden.to_str().unwrap().into(),
                    branch: "feature/outside".into(),
                    create_branch: true,
                    expected_oid: None,
                    start_point: None
                },
                fixture.head().await
            )
            .await
            .is_err()
    );
    assert!(!forbidden.exists());
    std::fs::create_dir(fixture.repo.join("subdir")).unwrap();
    assert!(
        fixture
            .service
            .context(&fixture.repo.join("subdir"), ".")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn detached_and_shallow_history_are_explicit() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    fixture.commit("next.txt", "next");
    git(&fixture.repo, &["checkout", "--detach", &oid]);
    assert_eq!(fixture.head().await.branch, None);
    let remote = fixture.remote();
    git(
        &fixture.repo,
        &["push", "origin", "refs/heads/main:refs/heads/main"],
    );
    let shallow = fixture.root().join("shallow");
    git(
        fixture.root(),
        &[
            "clone",
            "--depth=1",
            &format!("file://{}", remote.display()),
            shallow.to_str().unwrap(),
        ],
    );
    let page = fixture
        .service
        .history(fixture.root(), "shallow", HistoryRequest::default())
        .await
        .unwrap();
    assert!(page.shallow);
    assert_eq!(page.commits.len(), 1);
}

#[tokio::test]
async fn managed_worktree_parent_creation_and_private_exclusion_prevent_stage_all() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let exclude = fixture.repo.join(".git/info/exclude");
    std::fs::write(
        &exclude,
        b"# preserve this exact original without final newline",
    )
    .unwrap();
    let inside = format!("{}/.armadra/worktrees/review space", fixture.requested());
    fixture
        .success(Action::CreateWorktree {
            path: inside.clone(),
            branch: "feature/inside".into(),
            create_branch: true,
            start_point: None,
            expected_oid: None,
        })
        .await;
    let target = fixture.root().join(&inside);
    assert!(target.join("root.txt").is_file());
    let excluded = std::fs::read(&exclude).unwrap();
    assert!(excluded.starts_with(b"# preserve this exact original without final newline\n"));
    assert!(
        String::from_utf8(excluded)
            .unwrap()
            .contains("/.armadra/worktrees/")
    );
    git(&fixture.repo, &["add", "--", "."]);
    assert!(git(&fixture.repo, &["diff", "--cached", "--name-only"]).is_empty());
    // Creating a sibling from a linked worktree still protects the main tree.
    let branch = fixture
        .service
        .branches(fixture.root(), &inside)
        .await
        .unwrap();
    let second = format!("{}/.armadra/worktrees/another", fixture.requested());
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            inside,
            Action::CreateWorktree {
                path: second,
                branch: "feature/another".into(),
                create_branch: true,
                start_point: None,
                expected_oid: None,
            },
            branch.head,
        )
        .await
        .unwrap();
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Succeeded
    );
    git(&fixture.repo, &["add", "--", "."]);
    assert!(git(&fixture.repo, &["diff", "--cached", "--name-only"]).is_empty());
}

#[tokio::test]
async fn existing_branch_worktree_create_has_an_independent_ref_precondition() {
    let fixture = Fixture::new();
    let base = fixture.commit("root.txt", "base");
    fixture
        .success(Action::CreateBranch {
            name: "feature/existing".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let newer = fixture.commit("newer.txt", "newer");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let op = fixture
        .start(Action::CreateWorktree {
            path: "new parents/review".into(),
            branch: "feature/existing".into(),
            create_branch: false,
            start_point: None,
            expected_oid: Some(base),
        })
        .await;
    git(
        &fixture.repo,
        &["update-ref", "refs/heads/feature/existing", &newer],
    );
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert!(!fixture.root().join("new parents").exists());
    fixture
        .success(Action::CreateWorktree {
            path: "new parents/review".into(),
            branch: "feature/existing".into(),
            create_branch: false,
            start_point: None,
            expected_oid: Some(newer),
        })
        .await;
    assert!(fixture.root().join("new parents/review/root.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn exclude_symlinks_are_rejected_without_changing_the_target() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let elsewhere = fixture.root().join("do-not-edit");
    std::fs::write(&elsewhere, "original").unwrap();
    let exclude = fixture.repo.join(".git/info/exclude");
    std::fs::remove_file(&exclude).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &exclude).unwrap();
    let path = format!("{}/.armadra/worktrees/review", fixture.requested());
    let op = fixture
        .run(Action::CreateWorktree {
            path: path.clone(),
            branch: "feature/rejected".into(),
            create_branch: true,
            start_point: None,
            expected_oid: None,
        })
        .await;
    assert_eq!(op.state, OperationState::Failed);
    assert_eq!(std::fs::read_to_string(elsewhere).unwrap(), "original");
    assert!(!fixture.root().join(path).exists());
}

#[cfg(unix)]
#[tokio::test]
async fn timed_out_and_excessive_hook_output_have_bounded_unknown_results() {
    use std::os::unix::fs::PermissionsExt;
    for script in [
        "#!/bin/sh\nsleep 2\n",
        "#!/bin/sh\ndd if=/dev/zero bs=65537 count=1 >&2 2>/dev/null\n",
    ] {
        let mut fixture = Fixture::new();
        let oid = fixture.commit("root.txt", "base");
        fixture
            .success(Action::CreateBranch {
                name: "feature/hook".into(),
                start_point: None,
                switch: false,
            })
            .await;
        fixture.service = RepositoryService::with_timeout(Duration::from_millis(500)).unwrap();
        let hook = fixture.repo.join(".git/hooks/post-checkout");
        std::fs::write(&hook, script).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        let start = std::time::Instant::now();
        let op = fixture
            .run(Action::SwitchBranch {
                name: "feature/hook".into(),
                expected_oid: oid,
            })
            .await;
        assert_eq!(op.state, OperationState::UnknownOutcome, "{op:?}");
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(op.message.as_ref().is_some_and(
            |message| message.contains("timed out") || message.contains("bounded budget")
        ));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_queued_request_cannot_follow_a_retargeted_repository_symlink() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let outside = Fixture::new();
    outside.commit("root.txt", "other");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let op = fixture
        .start(Action::CreateBranch {
            name: "feature/no-escape".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let saved = fixture.root().join("moved-original");
    std::fs::rename(&fixture.repo, &saved).unwrap();
    std::os::unix::fs::symlink(&outside.repo, &fixture.repo).unwrap();
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert!(
        !git(&outside.repo, &["branch", "--list", "feature/no-escape"])
            .contains("feature/no-escape")
    );
    std::fs::remove_file(&fixture.repo).unwrap();
    std::fs::rename(saved, &fixture.repo).unwrap();
}

#[tokio::test]
async fn operation_listing_recovers_order_and_enforces_repository_and_workspace_scope() {
    let fixture = Fixture::new();
    fixture.commit("base", "base");
    let first = fixture
        .success(Action::CreateBranch {
            name: "feature/first".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let second = fixture
        .success(Action::CreateBranch {
            name: "feature/second".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let fresh_client = fixture.service.clone();
    let restored = fresh_client
        .list_operations(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(
        restored.iter().map(|item| &item.id).collect::<Vec<_>>(),
        vec![&second.id, &first.id]
    );
    assert!(
        restored
            .iter()
            .all(|item| item.state == OperationState::Succeeded)
    );
    // A narrower workspace authorizing the same repository does not inherit
    // records accepted through another workspace boundary.
    assert!(
        fresh_client
            .list_operations(&fixture.repo, ".")
            .await
            .unwrap()
            .is_empty()
    );
    let other = fixture.root().join("other");
    std::fs::create_dir(&other).unwrap();
    git(&other, &["init", "--initial-branch=main"]);
    assert!(
        fresh_client
            .list_operations(fixture.root(), "other")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn shutdown_cancels_queue_waits_for_external_guards_and_closes_admission() {
    let fixture = Fixture::new();
    fixture.commit("base", "base");
    let expected = fixture.head().await;
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let operation = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::CreateBranch {
                name: "feature/never".into(),
                start_point: None,
                switch: false,
            },
            expected.clone(),
        )
        .await
        .unwrap();
    assert_eq!(operation.state, OperationState::Queued);
    let service = fixture.service.clone();
    let shutdown = tokio::spawn(async move { service.shutdown(Duration::from_secs(3)).await });
    tokio::time::timeout(Duration::from_secs(1), guard.cancelled())
        .await
        .unwrap();
    assert!(guard.cancellation_requested());
    assert!(
        !shutdown.is_finished(),
        "shutdown must wait for an externally held mutation guard"
    );
    assert!(fixture.service.command_lease().is_err());
    assert!(
        fixture
            .service
            .mutation_guard(fixture.root(), &fixture.requested())
            .await
            .is_err()
    );
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::CreateBranch {
                    name: "feature/late".into(),
                    start_point: None,
                    switch: false
                },
                expected
            )
            .await
            .is_err()
    );
    drop(guard);
    shutdown.await.unwrap().unwrap();
    assert_eq!(
        fixture.service.operation(&operation.id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(git(&fixture.repo, &["branch", "--list", "feature/*"]), "");
}

#[cfg(unix)]
#[tokio::test]
async fn external_command_lease_cancels_and_reaps_owned_child_before_shutdown() {
    use std::process::Stdio;
    let service = RepositoryService::new();
    let lease = service.command_lease().unwrap();
    let mut child = tokio::process::Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    lease.mark_started();
    let actor = tokio::spawn(async move {
        lease.cancelled().await;
        assert!(lease.cancellation_requested());
        child.start_kill().unwrap();
        child.wait().await.unwrap();
        lease.mark_reaped();
        // A deliberately delayed finalization proves the service awaits the
        // lease itself, not merely delivery of the cancellation notification.
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(lease);
    });
    service.shutdown(Duration::from_secs(2)).await.unwrap();
    assert!(actor.is_finished());
    actor.await.unwrap();
}

#[tokio::test]
async fn shutdown_reports_unconfirmed_child_cleanup_and_guard_deadlines() {
    let service = RepositoryService::new();
    let lease = service.command_lease().unwrap();
    lease.mark_started();
    drop(lease);
    assert!(service.shutdown(Duration::from_secs(1)).await.is_err());
    let fixture = Fixture::new();
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(
        fixture
            .service
            .shutdown(Duration::from_millis(30))
            .await
            .is_err()
    );
    drop(guard);
    fixture
        .service
        .shutdown(Duration::from_secs(1))
        .await
        .unwrap();
}

#[cfg(unix)]
async fn wait_for_marker(marker: &Path) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_reaps_running_mutation_and_preserves_unknown_outcome() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let oid = fixture.commit("base", "base");
    git(&fixture.repo, &["branch", "feature/shutdown"]);
    let hook = fixture.repo.join(".git/hooks/post-checkout");
    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf ready > \"$PWD/shutdown-ready\"\nexec sleep 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let operation = fixture
        .start(Action::SwitchBranch {
            name: "feature/shutdown".into(),
            expected_oid: oid,
        })
        .await;
    wait_for_marker(&fixture.repo.join("shutdown-ready")).await;
    fixture
        .service
        .shutdown(Duration::from_secs(2))
        .await
        .unwrap();
    let final_state = fixture.service.operation(&operation.id).unwrap();
    assert_eq!(final_state.state, OperationState::UnknownOutcome);
    assert!(final_state.cancellation_requested);
    assert_eq!(
        git(&fixture.repo, &["branch", "--show-current"]),
        "feature/shutdown"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_and_cancelled_http_reads_reap_read_only_git_children() {
    use std::os::unix::fs::PermissionsExt;
    for abort_reader in [false, true] {
        let fixture = Fixture::new();
        fixture.commit("base", "base");
        let hook = fixture.repo.join(".git/hooks/test-fsmonitor");
        std::fs::write(
            &hook,
            "#!/bin/sh\nprintf ready > \"$PWD/read-ready\"\nexec sleep 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        git(
            &fixture.repo,
            &["config", "core.fsmonitor", ".git/hooks/test-fsmonitor"],
        );
        let service = fixture.service.clone();
        let root = fixture.root().to_owned();
        let requested = fixture.requested();
        let reader = tokio::spawn(async move { service.worktrees(&root, &requested).await });
        wait_for_marker(&fixture.repo.join("read-ready")).await;
        if abort_reader {
            reader.abort();
        }
        fixture
            .service
            .shutdown(Duration::from_secs(2))
            .await
            .unwrap();
        if abort_reader {
            assert!(reader.await.unwrap_err().is_cancelled());
        } else {
            assert!(reader.await.unwrap().is_err());
        }
    }
}

#[tokio::test]
async fn fast_forward_pull_preserves_ignored_local_files_and_cleans_private_fetch_ref() {
    let fixture = Fixture::new();
    let base = fixture.commit("base", "base");
    fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
        })
        .await;
    let author = fixture.root().join("remote-author");
    git(
        fixture.root(),
        &[
            "clone",
            fixture.root().join("remote bare.git").to_str().unwrap(),
            author.to_str().unwrap(),
        ],
    );
    git(&author, &["config", "user.name", "Test"]);
    git(&author, &["config", "user.email", "test@example.invalid"]);
    std::fs::write(author.join(".env"), "REMOTE=1\n").unwrap();
    git(&author, &["add", "-f", "--", ".env"]);
    git(&author, &["commit", "-m", "Add environment example"]);
    git(&author, &["push", "origin", "main"]);
    std::fs::write(fixture.repo.join(".git/info/exclude"), "/.env\n").unwrap();
    std::fs::write(fixture.repo.join(".env"), "LOCAL_SECRET=keep\n").unwrap();
    let result = fixture
        .run(Action::Pull {
            remote: "origin".into(),
            branch: "main".into(),
        })
        .await;
    assert_eq!(result.state, OperationState::UnknownOutcome);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(".env")).unwrap(),
        "LOCAL_SECRET=keep\n"
    );
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        git(
            &fixture.repo,
            &["for-each-ref", "--format=%(refname)", "refs/armadra/pull/"]
        ),
        ""
    );
}

async fn stash_action(
    fixture: &Fixture,
    kind: &str,
    oid: Option<&str>,
    include: bool,
) -> OperationSnapshot {
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let token = observed.state_token;
    let action = match kind {
        "create" => Action::CreateStash {
            message: "保存 Unicode 工作".into(),
            include_untracked: include,
            expected_state_token: token,
        },
        "apply" => Action::ApplyStash {
            oid: oid.unwrap().into(),
            reinstate_index: include,
            expected_state_token: token,
        },
        "pop" => Action::PopStash {
            oid: oid.unwrap().into(),
            reinstate_index: include,
            expected_state_token: token,
        },
        "drop" => Action::DropStash {
            oid: oid.unwrap().into(),
            expected_state_token: token,
        },
        _ => panic!("unknown action"),
    };
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            action,
            observed.head,
        )
        .await
        .unwrap();
    await_operation(&fixture.service, &op.id).await
}

#[tokio::test]
async fn stash_create_details_apply_index_pop_and_drop_use_observed_objects() {
    let fixture = Fixture::new();
    fixture.commit("tracked.txt", "base\n");
    std::fs::write(fixture.repo.join("tracked.txt"), "staged\n").unwrap();
    git(&fixture.repo, &["add", "tracked.txt"]);
    std::fs::write(fixture.repo.join("tracked.txt"), "unstaged\n").unwrap();
    std::fs::write(fixture.repo.join("空 格.txt"), "untracked content\n").unwrap();
    std::fs::write(fixture.repo.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(fixture.repo.join(".env"), "keep ignored\n").unwrap();
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!fixture.repo.join("空 格.txt").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(".env")).unwrap(),
        "keep ignored\n"
    );
    let list = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(list.stashes.len(), 1);
    assert!(list.stashes[0].subject.contains("保存 Unicode 工作"));
    let oid = &list.stashes[0].oid;
    let detail = fixture
        .service
        .stash_detail(fixture.root(), &fixture.requested(), oid)
        .await
        .unwrap();
    assert_eq!(detail.parents.len(), 3);
    assert!(detail.patch.contains("+unstaged"));
    assert!(detail.untracked_patch.contains("+untracked content"));
    assert_eq!(
        stash_action(&fixture, "apply", Some(oid), true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(git(&fixture.repo, &["show", ":tracked.txt"]), "staged");
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("tracked.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("空 格.txt")).unwrap(),
        "untracked content\n"
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        1
    );
    assert_eq!(
        stash_action(&fixture, "drop", Some(oid), false).await.state,
        OperationState::Succeeded
    );
    assert!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .is_empty()
    );
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    let fresh = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(
        stash_action(&fixture, "pop", Some(&fresh.stashes[0].oid), true)
            .await
            .state,
        OperationState::Succeeded
    );
    assert!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .is_empty()
    );
}

#[tokio::test]
async fn stash_conflicted_pop_keeps_object_and_reports_actual_conflict() {
    let fixture = Fixture::new();
    fixture.commit("file", "base\n");
    std::fs::write(fixture.repo.join("file"), "stashed\n").unwrap();
    assert_eq!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Succeeded
    );
    let saved = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    fixture.commit("file", "different committed\n");
    let result = stash_action(&fixture, "pop", Some(&saved.stashes[0].oid), false).await;
    assert_eq!(result.state, OperationState::UnknownOutcome);
    let after = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(after.has_conflicts);
    assert_eq!(after.stashes[0].oid, saved.stashes[0].oid);
    assert!(!git(&fixture.repo, &["ls-files", "--unmerged"]).is_empty());
    assert_eq!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Failed
    );
}

#[tokio::test]
async fn stash_cas_detects_same_status_content_edits_and_reflog_reordering() {
    let fixture = Fixture::new();
    fixture.commit("file", "base");
    std::fs::write(fixture.repo.join("file"), "dirty one").unwrap();
    std::fs::write(fixture.repo.join("new file"), "first").unwrap();
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    std::fs::write(fixture.repo.join("new file"), "other").unwrap();
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::CreateStash {
                message: "old confirmation".into(),
                include_untracked: true,
                expected_state_token: observed.state_token,
            },
            observed.head,
        )
        .await
        .unwrap();
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    std::fs::write(fixture.repo.join("file"), "newer work").unwrap();
    git(
        &fixture.repo,
        &["stash", "push", "-m", "external newer stash"],
    );
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::DropStash {
                oid: observed.stashes[0].oid.clone(),
                expected_state_token: observed.state_token,
            },
            observed.head,
        )
        .await
        .unwrap();
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        2
    );
}

#[tokio::test]
async fn stash_untracked_option_is_explicit_and_unknown_oid_never_drops_latest() {
    let fixture = Fixture::new();
    fixture.commit("file", "base");
    std::fs::write(fixture.repo.join("new"), "untracked").unwrap();
    assert_ne!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Succeeded
    );
    assert!(fixture.repo.join("new").exists());
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        stash_action(&fixture, "drop", Some(&"a".repeat(40)), false)
            .await
            .state,
        OperationState::Failed
    );
    let list = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(list.stashes.len(), 1);
    std::fs::write(fixture.repo.join("file"), "intermediate stash").unwrap();
    git(&fixture.repo, &["stash", "push", "-m", "intermediate"]);
    git(
        &fixture.repo,
        &["stash", "store", "-m", "duplicate", &list.stashes[0].oid],
    );
    assert_eq!(
        stash_action(&fixture, "drop", Some(&list.stashes[0].oid), false)
            .await
            .state,
        OperationState::Failed
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        3
    );
}

#[tokio::test]
async fn stash_apply_refuses_overwriting_ignored_collision() {
    let fixture = Fixture::new();
    fixture.commit("base", "base");
    std::fs::write(fixture.repo.join(".env"), "saved content\n").unwrap();
    git(&fixture.repo, &["add", "-f", ".env"]);
    assert_eq!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Succeeded
    );
    let saved = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    std::fs::write(fixture.repo.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(fixture.repo.join(".env"), "PRIVATE KEEP\n").unwrap();
    let result = stash_action(&fixture, "pop", Some(&saved.stashes[0].oid), false).await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(".env")).unwrap(),
        "PRIVATE KEEP\n"
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        1
    );
}
