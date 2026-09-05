use super::*;
impl Repo {
    async fn rebase(&self, onto: &str) -> OperationSnapshot {
        let state = self.status().await;
        self.run(
            Action::StartRebase {
                onto: onto.into(),
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
    }
}

#[tokio::test]
async fn clean_rebase_replays_onto_the_target_and_keeps_the_original_branch() {
    let repo = Repo::new();
    let base = repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("topic", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    let original = repo.commit("main", "local\n");
    assert_eq!(repo.rebase(&target).await.state, OperationState::Succeeded);
    let head = repo.status().await;
    assert_eq!(head.kind, "none");
    assert_eq!(head.head.branch.as_deref(), Some("main"));
    let replayed = head.head.head_oid.unwrap();
    assert_ne!(replayed, original);
    assert_eq!(
        git(&repo.path, &["rev-parse", &format!("{replayed}^")]),
        target
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join("main")).unwrap(),
        "local\n"
    );
    assert_eq!(
        git(
            &repo.path,
            &["rev-list", "--count", &format!("{base}..HEAD")]
        ),
        "2"
    );
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn conflicted_rebase_reports_its_branch_and_continues_only_after_staging() {
    let repo = Repo::new();
    let (original, target) = repo.conflict();
    assert_eq!(
        repo.rebase(&target).await.state,
        OperationState::AwaitingResolution
    );
    let paused = repo.status().await;
    assert_eq!(paused.kind, "rebase");
    assert!(paused.owned);
    // The replay detaches HEAD, so the branch has to come from the sequence.
    assert_eq!(paused.head.branch, None);
    assert_eq!(paused.head.head_oid.as_deref(), Some(target.as_str()));
    assert_eq!(paused.original_branch.as_deref(), Some("main"));
    assert_eq!(paused.original_head.as_deref(), Some(original.as_str()));
    assert_eq!(paused.target_oid.as_deref(), Some(target.as_str()));
    assert!(!paused.can_continue && !paused.can_skip);
    assert_eq!(paused.conflicts.len(), 1);
    assert_eq!(paused.conflicts[0].path, "file");
    assert_eq!(
        paused.conflicts[0].theirs.as_ref().unwrap().preview,
        "ours\n"
    );
    assert_eq!(repo.resume(false).await.state, OperationState::Failed);
    std::fs::write(repo.path.join("file"), "resolved\n").unwrap();
    assert!(!repo.status().await.can_continue);
    git(&repo.path, &["add", "file"]);
    let staged = repo.status().await;
    assert!(staged.can_continue);
    let stale = repo
        .run(
            Action::ContinueIntegration {
                session_id: paused.session_id.unwrap(),
                expected_state_token: paused.state_token,
            },
            paused.head,
        )
        .await;
    assert_eq!(stale.state, OperationState::Failed);
    let owner = staged.session_id.clone().unwrap();
    assert_eq!(repo.resume(false).await.state, OperationState::Succeeded);
    let done = repo.status().await;
    assert_eq!(done.kind, "none");
    assert_eq!(done.head.branch.as_deref(), Some("main"));
    assert_eq!(git(&repo.path, &["show", "HEAD:file"]), "resolved");
    assert_eq!(
        git(&repo.path, &["rev-parse", "HEAD^"]),
        target,
        "the replayed commit must sit on the confirmed target"
    );
    assert_eq!(
        repo.service.operation(&owner).unwrap().state,
        OperationState::Succeeded
    );
}

#[tokio::test]
async fn rebase_abort_restores_the_original_branch_and_external_sequences_stay_read_only() {
    let repo = Repo::new();
    let (original, target) = repo.conflict();
    assert_eq!(
        repo.rebase(&target).await.state,
        OperationState::AwaitingResolution
    );
    let owned = repo.status().await;
    let owner = owned.session_id.clone().unwrap();
    let restarted = RepositoryService::new();
    let external = restarted
        .integration_status(repo.temp.path(), repo.path.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(external.kind, "rebase");
    assert!(!external.owned);
    assert!(external.session_id.is_none());
    // A restarted service still reads the branch Git recorded, but cannot act.
    assert_eq!(external.original_branch.as_deref(), Some("main"));
    let refused = restarted
        .start(
            repo.temp.path().to_owned(),
            repo.path.to_str().unwrap().into(),
            Action::AbortIntegration {
                session_id: owner.clone(),
                expected_state_token: external.state_token,
            },
            external.head,
        )
        .await
        .unwrap();
    assert_eq!(
        wait(&restarted, &refused.id).await.state,
        OperationState::Failed
    );
    assert!(repo.path.join(".git/rebase-merge").exists());
    assert_eq!(repo.resume(true).await.state, OperationState::Succeeded);
    let after = repo.status().await;
    assert_eq!(after.kind, "none");
    assert_eq!(after.head.branch.as_deref(), Some("main"));
    assert_eq!(after.head.head_oid.as_deref(), Some(original.as_str()));
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "ours\n"
    );
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "");
    assert_eq!(
        repo.service.operation(&owner).unwrap().state,
        OperationState::Cancelled
    );
}

#[tokio::test]
async fn rebase_refuses_a_dirty_worktree_and_an_unrelated_history() {
    let repo = Repo::new();
    let (_, target) = repo.conflict();
    std::fs::write(repo.path.join("file"), "uncommitted\n").unwrap();
    assert_eq!(repo.rebase(&target).await.state, OperationState::Failed);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "uncommitted\n"
    );
    assert!(!repo.path.join(".git/rebase-merge").exists());
    git(&repo.path, &["checkout", "--", "file"]);
    let orphan = git(
        &repo.path,
        &[
            "commit-tree",
            "-m",
            "unrelated",
            &format!("{target}^{{tree}}"),
        ],
    );
    let unrelated = repo.rebase(&orphan).await;
    assert_eq!(unrelated.state, OperationState::Failed);
    assert!(
        unrelated
            .message
            .as_deref()
            .is_some_and(|message| message.contains("share no history")),
        "{unrelated:?}"
    );
    assert_eq!(repo.status().await.kind, "none");
}
