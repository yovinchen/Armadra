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
