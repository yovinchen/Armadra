//! Soft, mixed and hard resets, including the recovery stash.

#[path = "support/git.rs"]
mod support;

use support::*;

/* ---------------------------------- reset --------------------------------- */

async fn reset(
    fixture: &Fixture,
    mode: armadra_runtime::git_repository::ResetMode,
    target: &str,
    discard: bool,
) -> OperationSnapshot {
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let operation = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::Reset {
                mode,
                target_oid: target.into(),
                expected_state_token: observed.state_token,
                discard_changes: discard,
            },
            observed.head,
        )
        .await
        .unwrap();
    await_operation(&fixture.service, &operation.id).await
}

#[tokio::test]
async fn soft_and_mixed_reset_move_the_ref_without_touching_the_worktree() {
    use armadra_runtime::git_repository::ResetMode;
    let fixture = Fixture::new();
    let base = fixture.commit("file.txt", "base\n");
    fixture.commit("file.txt", "second\n");
    std::fs::write(fixture.repo.join("file.txt"), "local edit\n").unwrap();

    assert_eq!(
        reset(&fixture, ResetMode::Soft, &base, false).await.state,
        OperationState::Succeeded
    );
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("file.txt")).unwrap(),
        "local edit\n",
        "a soft reset never touches the worktree"
    );
    // Soft keeps the difference between the old head and the new one staged.
    assert!(!git(&fixture.repo, &["diff", "--cached", "--name-only"]).is_empty());

    assert_eq!(
        reset(&fixture, ResetMode::Mixed, &base, false).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        git(&fixture.repo, &["diff", "--cached", "--name-only"]),
        "",
        "a mixed reset clears the index"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("file.txt")).unwrap(),
        "local edit\n",
        "and still keeps the worktree"
    );
}

#[tokio::test]
async fn hard_reset_needs_acknowledgement_and_leaves_a_recovery_stash() {
    use armadra_runtime::git_repository::ResetMode;
    let fixture = Fixture::new();
    let base = fixture.commit("file.txt", "base\n");
    let second = fixture.commit("file.txt", "second\n");
    std::fs::write(fixture.repo.join("file.txt"), "uncommitted\n").unwrap();
    std::fs::write(fixture.repo.join("new.txt"), "untracked\n").unwrap();

    // Without the acknowledgement nothing moves and nothing is stashed.
    let refused = reset(&fixture, ResetMode::Hard, &base, false).await;
    assert_eq!(refused.state, OperationState::Failed);
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), second);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("file.txt")).unwrap(),
        "uncommitted\n"
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
        reset(&fixture, ResetMode::Hard, &base, true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("file.txt")).unwrap(),
        "base\n"
    );
    assert!(!fixture.repo.join("new.txt").exists());
    // The discarded work is recoverable from the snapshot the reset recorded.
    let stashes = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap()
        .stashes;
    assert_eq!(stashes.len(), 1);
    assert!(
        stashes[0].subject.contains("before hard reset"),
        "{}",
        stashes[0].subject
    );
    let detail = fixture
        .service
        .stash_detail(fixture.root(), &fixture.requested(), &stashes[0].oid)
        .await
        .unwrap();
    assert!(detail.patch.contains("uncommitted"));
    assert!(detail.untracked_patch.contains("untracked"));
}

#[tokio::test]
async fn a_clean_hard_reset_needs_no_stash_and_a_stale_token_is_refused() {
    use armadra_runtime::git_repository::ResetMode;
    let fixture = Fixture::new();
    let base = fixture.commit("file.txt", "base\n");
    let second = fixture.commit("file.txt", "second\n");

    assert_eq!(
        reset(&fixture, ResetMode::Hard, &base, false).await.state,
        OperationState::Succeeded,
        "a clean worktree loses nothing, so no acknowledgement is required"
    );
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), base);
    assert!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .is_empty(),
        "nothing was discarded, so nothing was stashed"
    );

    // A state token from another observation is refused outright.
    let stale = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::Reset {
                mode: ResetMode::Hard,
                target_oid: second.clone(),
                expected_state_token: "0".repeat(64),
                discard_changes: true,
            },
            fixture.head().await,
        )
        .await
        .unwrap();
    assert_eq!(
        await_operation(&fixture.service, &stale.id).await.state,
        OperationState::Failed
    );
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), base);
}
