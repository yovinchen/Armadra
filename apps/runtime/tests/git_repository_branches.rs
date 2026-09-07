//! Branch listing, checkout and deletion against real local repositories.

#[path = "support/git.rs"]
mod support;

use support::*;

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

/// Renaming a branch: the ref moves, the object does not, and a name that is
/// already taken is refused rather than overwritten.
#[tokio::test]
async fn rename_moves_the_branch_and_refuses_a_name_already_taken() {
    let fixture = Fixture::new();
    let base = fixture.commit("a.txt", "base");
    fixture
        .success(Action::CreateBranch {
            name: "feature/旧名".into(),
            start_point: Some(base.clone()),
            switch: false,
        })
        .await;
    fixture
        .success(Action::RenameBranch {
            name: "feature/旧名".into(),
            new_name: "feature/新名".into(),
            expected_oid: base.clone(),
        })
        .await;
    let branches = fixture
        .service
        .branches(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(
        branches
            .branches
            .iter()
            .any(|branch| branch.name == "feature/新名" && branch.oid == base)
    );
    assert!(
        !branches
            .branches
            .iter()
            .any(|branch| branch.name == "feature/旧名")
    );

    // The current branch renames too, and it stays the current one.
    fixture
        .success(Action::RenameBranch {
            name: "main".into(),
            new_name: "trunk".into(),
            expected_oid: base.clone(),
        })
        .await;
    assert_eq!(fixture.head().await.branch.as_deref(), Some("trunk"));

    // A destination something already holds is Git's refusal, not a silent
    // overwrite of the branch that was there.
    assert_ne!(
        fixture
            .run(Action::RenameBranch {
                name: "trunk".into(),
                new_name: "feature/新名".into(),
                expected_oid: base.clone(),
            })
            .await
            .state,
        OperationState::Succeeded
    );
    assert_eq!(
        git(&fixture.repo, &["rev-parse", "refs/heads/trunk"]),
        base.clone()
    );

    // A branch that moved since the tree was drawn is a conflict, not a rename
    // of whatever it points at now.
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::RenameBranch {
                    name: "trunk".into(),
                    new_name: "trunk".into(),
                    expected_oid: base.clone(),
                },
                fixture.head().await,
            )
            .await
            .is_err(),
        "renaming a branch to its own name is refused before anything runs"
    );
    assert_ne!(
        fixture
            .run(Action::RenameBranch {
                name: "feature/新名".into(),
                new_name: "feature/更新".into(),
                expected_oid: "a".repeat(40),
            })
            .await
            .state,
        OperationState::Succeeded
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
