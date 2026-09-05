//! Revert is the cherry-pick sequence with the patch applied backwards: same
//! ownership binding, same Continue/Abort recovery, no skip.
use super::*;

impl Repo {
    async fn revert(&self, target: &str) -> OperationSnapshot {
        let state = self.status().await;
        self.run(
            Action::Revert {
                target_oid: target.into(),
                mainline: None,
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
    }
}

#[tokio::test]
async fn clean_revert_undoes_the_commit_on_the_same_branch() {
    let repo = Repo::new();
    repo.commit("file", "base\n");
    let target = repo.commit("file", "unwanted\n");
    let before = repo.status().await.head;
    assert_eq!(repo.revert(&target).await.state, OperationState::Succeeded);

    let after = repo.status().await;
    assert_eq!(after.kind, "none");
    assert_eq!(after.head.branch.as_deref(), Some("main"));
    let produced = after.head.head_oid.unwrap();
    // Exactly one new commit, on the confirmed parent.
    assert_eq!(
        git(&repo.path, &["rev-parse", &format!("{produced}^")]),
        before.head_oid.unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "base\n",
        "the reverted content is back"
    );
    // The reverted commit is still in history; nothing was rewritten.
    assert_eq!(
        git(&repo.path, &["cat-file", "-t", &target]),
        "commit",
        "the original commit is untouched"
    );
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn conflicted_revert_is_owned_and_recovers_through_continue() {
    let repo = Repo::new();
    repo.commit("file", "base\n");
    let target = repo.commit("file", "middle\n");
    repo.commit("file", "latest\n");
    let original = repo.status().await.head;

    assert_eq!(
        repo.revert(&target).await.state,
        OperationState::AwaitingResolution
    );
    let paused = repo.status().await;
    assert_eq!(paused.kind, "revert");
    assert!(paused.owned, "the conflicted sequence is ours to recover");
    assert_eq!(paused.conflicts.len(), 1);
    assert_eq!(paused.conflicts[0].path, "file");
    assert!(!paused.can_continue, "conflicts gate the continuation");
    // Skip belongs to an empty cherry-pick only: dropping a revert would leave
    // the change it was meant to undo in place.
    assert!(!paused.can_skip);
    let skipped = repo
        .run(
            Action::SkipIntegration {
                session_id: paused.session_id.clone().unwrap(),
                expected_state_token: paused.state_token.clone(),
            },
            paused.head.clone(),
        )
        .await;
    assert_eq!(skipped.state, OperationState::Failed);
    assert_eq!(repo.status().await.kind, "revert");

    std::fs::write(repo.path.join("file"), "resolved by hand\n").unwrap();
    git(&repo.path, &["add", "--", "file"]);
    let staged = repo.status().await;
    assert!(staged.can_continue);
    assert_eq!(repo.resume(false).await.state, OperationState::Succeeded);

    let finished = repo.status().await;
    assert_eq!(finished.kind, "none");
    assert_eq!(finished.head.branch.as_deref(), Some("main"));
    assert_eq!(
        git(&repo.path, &["rev-parse", "HEAD^"]),
        original.head_oid.unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "resolved by hand\n"
    );
}

#[tokio::test]
async fn aborting_a_revert_restores_the_confirmed_head() {
    let repo = Repo::new();
    repo.commit("file", "base\n");
    let target = repo.commit("file", "middle\n");
    repo.commit("file", "latest\n");
    let original = repo.status().await.head;
    let started = repo.revert(&target).await;
    assert_eq!(started.state, OperationState::AwaitingResolution);
    // The abort itself succeeds; the sequence it recovered is the one that
    // ends up cancelled.
    assert_eq!(repo.resume(true).await.state, OperationState::Succeeded);
    assert_eq!(
        repo.service.operation(&started.id).unwrap().state,
        OperationState::Cancelled
    );
    let after = repo.status().await;
    assert_eq!(after.kind, "none");
    assert_eq!(after.head, original);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "latest\n"
    );
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn revert_refuses_a_dirty_worktree_and_a_stale_state_token() {
    let repo = Repo::new();
    repo.commit("file", "base\n");
    let target = repo.commit("file", "unwanted\n");
    let state = repo.status().await;
    std::fs::write(repo.path.join("file"), "local edit\n").unwrap();
    let dirty = repo
        .run(
            Action::Revert {
                target_oid: target.clone(),
                mainline: None,
                expected_state_token: state.state_token.clone(),
            },
            state.head.clone(),
        )
        .await;
    assert_eq!(dirty.state, OperationState::Failed);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "local edit\n",
        "a refused revert leaves the worktree alone"
    );
    assert_eq!(repo.status().await.kind, "none");

    git(&repo.path, &["checkout", "--", "file"]);
    let stale = repo
        .run(
            Action::Revert {
                target_oid: target,
                mainline: None,
                expected_state_token: "0".repeat(64),
            },
            repo.status().await.head,
        )
        .await;
    assert_eq!(stale.state, OperationState::Failed);
    assert_eq!(repo.status().await.kind, "none");
}

#[tokio::test]
async fn a_merge_commit_needs_an_explicit_mainline_before_it_can_be_reverted() {
    let repo = Repo::new();
    repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    repo.commit("topic", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    repo.commit("main", "local\n");
    git(&repo.path, &["merge", "--no-ff", "-m", "merge", "topic"]);
    let merge = git(&repo.path, &["rev-parse", "HEAD"]);

    let state = repo.status().await;
    let without = repo
        .run(
            Action::Revert {
                target_oid: merge.clone(),
                mainline: None,
                expected_state_token: state.state_token.clone(),
            },
            state.head.clone(),
        )
        .await;
    assert_eq!(without.state, OperationState::Failed);
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), merge);

    let state = repo.status().await;
    assert_eq!(
        repo.run(
            Action::Revert {
                target_oid: merge.clone(),
                mainline: Some(1),
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
        .state,
        OperationState::Succeeded
    );
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD^"]), merge);
    assert!(
        !repo.path.join("topic").exists(),
        "the topic side is undone"
    );
}

#[tokio::test]
async fn detached_checkout_moves_head_to_the_reviewed_commit_only() {
    let repo = Repo::new();
    let first = repo.commit("file", "one\n");
    let second = repo.commit("file", "two\n");
    let state = repo.status().await;
    assert_eq!(
        repo.run(
            Action::CheckoutCommit {
                target_oid: first.clone()
            },
            state.head
        )
        .await
        .state,
        OperationState::Succeeded
    );
    let detached = repo.status().await;
    assert_eq!(detached.head.branch, None, "HEAD is detached");
    assert_eq!(detached.head.head_oid.as_deref(), Some(first.as_str()));
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "one\n"
    );
    // main still points where it did: a checkout moves HEAD, not the branch.
    assert_eq!(git(&repo.path, &["rev-parse", "refs/heads/main"]), second);

    // A commit that does not exist is refused before anything moves.
    let missing = repo
        .run(
            Action::CheckoutCommit {
                target_oid: "b".repeat(40),
            },
            repo.status().await.head,
        )
        .await;
    assert_eq!(missing.state, OperationState::Failed);
    assert_eq!(
        repo.status().await.head.head_oid.as_deref(),
        Some(first.as_str())
    );

    // Creating a branch from the detached commit is the documented way out.
    let state = repo.status().await;
    assert_eq!(
        repo.run(
            Action::CreateBranch {
                name: "rescue".into(),
                start_point: Some(first.clone()),
                switch: true,
            },
            state.head,
        )
        .await
        .state,
        OperationState::Succeeded
    );
    let rescued = repo.status().await;
    assert_eq!(rescued.head.branch.as_deref(), Some("rescue"));
    assert_eq!(rescued.head.head_oid.as_deref(), Some(first.as_str()));
}
