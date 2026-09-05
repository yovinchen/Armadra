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

/* --------------------------- interactive rebase --------------------------- */

use armadra_runtime::git_repository::{RebaseTodoCommand, RebaseTodoEntry};

impl Repo {
    async fn todo_preview(&self, onto: &str) -> armadra_runtime::git_repository::RebaseTodoPreview {
        self.service
            .rebase_todo_preview(self.temp.path(), self.path.to_str().unwrap(), onto)
            .await
            .unwrap()
    }
    async fn interactive(&self, onto: &str, todo: Vec<RebaseTodoEntry>) -> OperationSnapshot {
        let state = self.status().await;
        self.run(
            Action::StartInteractiveRebase {
                onto: onto.into(),
                todo,
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
    }
}

fn entry(oid: &str, command: RebaseTodoCommand) -> RebaseTodoEntry {
    RebaseTodoEntry {
        oid: oid.into(),
        command,
    }
}

#[tokio::test]
async fn a_todo_preview_lists_the_replayed_commits_oldest_first() {
    let repo = Repo::new();
    let base = repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("topic", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    let first = repo.commit("one", "one\n");
    let second = repo.commit("two", "two\n");

    let preview = repo.todo_preview(&target).await;
    assert_eq!(preview.onto, target);
    assert_eq!(preview.base, base);
    assert!(!preview.has_merges);
    assert_eq!(
        preview
            .commits
            .iter()
            .map(|commit| commit.oid.clone())
            .collect::<Vec<_>>(),
        vec![first, second],
        "the preview is in replay order, oldest first"
    );
    assert_eq!(preview.head.branch.as_deref(), Some("main"));
}

#[tokio::test]
async fn a_reviewed_todo_reorders_and_drops_exactly_the_listed_commits() {
    let repo = Repo::new();
    repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("topic", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    let first = repo.commit("one", "one\n");
    let second = repo.commit("two", "two\n");
    let third = repo.commit("three", "three\n");

    // Replay second, then first; drop the third entirely.
    assert_eq!(
        repo.interactive(
            &target,
            vec![
                entry(&second, RebaseTodoCommand::Pick),
                entry(&first, RebaseTodoCommand::Pick),
                entry(&third, RebaseTodoCommand::Drop),
            ],
        )
        .await
        .state,
        OperationState::Succeeded
    );
    let after = repo.status().await;
    assert_eq!(after.kind, "none");
    assert_eq!(after.head.branch.as_deref(), Some("main"));
    // The fixture gives every commit the same message, so the replay order is
    // read from the file each replayed commit actually adds.
    let replayed = git(
        &repo.path,
        &["rev-list", "--reverse", &format!("{target}..HEAD")],
    );
    let added: Vec<String> = replayed
        .lines()
        .map(|oid| {
            git(
                &repo.path,
                &["diff-tree", "--no-commit-id", "--name-only", "-r", oid],
            )
        })
        .collect();
    assert_eq!(added, vec!["two".to_owned(), "one".to_owned()]);
    assert!(!repo.path.join("three").exists(), "the drop really dropped");
    assert!(repo.path.join("one").exists());
    assert!(repo.path.join("two").exists());
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "");
    // No sequence editor artefact is left behind in the Git directory.
    let leftovers = std::fs::read_dir(repo.path.join(".git"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("armadra-rebase-todo")
        })
        .count();
    assert_eq!(leftovers, 0);
}

#[tokio::test]
async fn squash_combines_into_the_previous_kept_commit() {
    let repo = Repo::new();
    repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("topic", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    let first = repo.commit("one", "one\n");
    let second = repo.commit("two", "two\n");

    assert_eq!(
        repo.interactive(
            &target,
            vec![
                entry(&first, RebaseTodoCommand::Pick),
                entry(&second, RebaseTodoCommand::Squash),
            ],
        )
        .await
        .state,
        OperationState::Succeeded
    );
    assert_eq!(
        git(
            &repo.path,
            &["rev-list", "--count", &format!("{target}..HEAD")]
        ),
        "1",
        "the two commits became one"
    );
    // Git's own prefilled combined message is kept — both originals are in it
    // — and nothing is invented in its place.
    let message = git(&repo.path, &["log", "-1", "--format=%B"]);
    assert_eq!(message.matches("test commit").count(), 2, "{message}");
    assert!(repo.path.join("one").exists());
    assert!(repo.path.join("two").exists());
}

#[tokio::test]
async fn a_todo_that_does_not_cover_the_range_is_refused_before_anything_moves() {
    let repo = Repo::new();
    repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("topic", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    let first = repo.commit("one", "one\n");
    let second = repo.commit("two", "two\n");
    let before = repo.status().await.head;

    // Leaving a commit out is not a way to drop it.
    let missing = repo
        .interactive(&target, vec![entry(&first, RebaseTodoCommand::Pick)])
        .await;
    assert_eq!(missing.state, OperationState::Failed);
    assert_eq!(repo.status().await.head, before);

    // Nor is naming a commit outside the range.
    let outside = repo
        .interactive(
            &target,
            vec![
                entry(&first, RebaseTodoCommand::Pick),
                entry(&second, RebaseTodoCommand::Pick),
                entry(&target, RebaseTodoCommand::Pick),
            ],
        )
        .await;
    assert_eq!(outside.state, OperationState::Failed);

    // Dropping everything would leave nothing to replay.
    let empty = repo
        .interactive(
            &target,
            vec![
                entry(&first, RebaseTodoCommand::Drop),
                entry(&second, RebaseTodoCommand::Drop),
            ],
        )
        .await;
    assert_eq!(empty.state, OperationState::Failed);

    // A squash with nothing kept before it is refused by validation.
    assert!(
        repo.service
            .start(
                repo.temp.path().to_owned(),
                repo.path.to_str().unwrap().into(),
                Action::StartInteractiveRebase {
                    onto: target.clone(),
                    todo: vec![
                        entry(&first, RebaseTodoCommand::Squash),
                        entry(&second, RebaseTodoCommand::Pick),
                    ],
                    expected_state_token: repo.status().await.state_token,
                },
                before.clone(),
            )
            .await
            .is_err()
    );
    assert_eq!(repo.status().await.head, before);
    assert_eq!(repo.status().await.kind, "none");
}

#[tokio::test]
async fn a_conflicted_interactive_replay_is_owned_and_continues_after_staging() {
    let repo = Repo::new();
    let (original, target) = repo.conflict();
    let preview = repo.todo_preview(&target).await;
    assert_eq!(preview.commits.len(), 1);
    let todo = vec![entry(&preview.commits[0].oid, RebaseTodoCommand::Pick)];

    assert_eq!(
        repo.interactive(&target, todo).await.state,
        OperationState::AwaitingResolution
    );
    let paused = repo.status().await;
    assert_eq!(paused.kind, "rebase");
    assert!(paused.owned, "the paused replay is ours to recover");
    assert!(!paused.can_continue);
    std::fs::write(repo.path.join("file"), "resolved\n").unwrap();
    git(&repo.path, &["add", "--", "file"]);
    assert_eq!(repo.resume(false).await.state, OperationState::Succeeded);
    let finished = repo.status().await;
    assert_eq!(finished.kind, "none");
    assert_eq!(finished.head.branch.as_deref(), Some("main"));
    assert_ne!(finished.head.head_oid.as_deref(), Some(original.as_str()));
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "resolved\n"
    );
}
