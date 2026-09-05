//! Linked worktrees: creation, listing, guards and removal.

#[path = "support/git.rs"]
mod support;

use support::*;

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
