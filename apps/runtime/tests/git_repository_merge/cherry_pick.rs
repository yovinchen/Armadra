use super::*;
impl Repo {
    async fn pick(
        &self,
        target: &str,
        mainline: Option<u32>,
        record_origin: bool,
    ) -> OperationSnapshot {
        let state = self.status().await;
        self.run(
            Action::StartCherryPick {
                target_oid: target.into(),
                mainline,
                record_origin,
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
    }
    async fn skip_pick(&self) -> OperationSnapshot {
        let state = self.status().await;
        self.run(
            Action::SkipIntegration {
                session_id: state.session_id.unwrap(),
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
    }
}

#[tokio::test]
async fn cherry_pick_clean_commit_keeps_source_author_and_optional_origin() {
    let repo = Repo::new();
    let original = repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    git(&repo.path, &["config", "user.name", "Source Author"]);
    git(
        &repo.path,
        &["config", "user.email", "source@example.invalid"],
    );
    let target = repo.commit("新 file", "source change\n");
    git(&repo.path, &["switch", "main"]);
    git(&repo.path, &["config", "user.name", "Current Committer"]);
    git(
        &repo.path,
        &["config", "user.email", "current@example.invalid"],
    );
    let preview = repo
        .service
        .cherry_pick_preview(repo.temp.path(), repo.path.to_str().unwrap(), &target, None)
        .await
        .unwrap();
    assert_eq!(preview.target_oid, target);
    assert_eq!(preview.parents, vec![original.clone()]);
    assert_eq!(preview.author_name, "Source Author");
    assert!(preview.patch.unwrap().contains("+source change"));
    assert_eq!(
        repo.pick(&target.to_uppercase(), None, true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        git(&repo.path, &["show", "--format=%P", "--no-patch", "HEAD"]),
        original
    );
    assert_eq!(
        git(
            &repo.path,
            &["show", "--format=%an <%ae>", "--no-patch", "HEAD"]
        ),
        "Source Author <source@example.invalid>"
    );
    assert_eq!(
        git(&repo.path, &["show", "--format=%cn", "--no-patch", "HEAD"]),
        "Current Committer"
    );
    assert!(git(&repo.path, &["show", "--format=%B", "--no-patch", "HEAD"]).contains(&target));
    assert_eq!(repo.status().await.kind, "none");
}

#[tokio::test]
async fn cherry_pick_conflict_owns_marker_despite_stale_orig_head_and_requires_staging() {
    let repo = Repo::new();
    let (original, target) = repo.conflict();
    git(&repo.path, &["update-ref", "ORIG_HEAD", &target]);
    let start = repo.pick(&target, None, false).await;
    assert_eq!(start.state, OperationState::AwaitingResolution);
    let state = repo.status().await;
    assert_eq!(state.kind, "cherryPick");
    assert!(state.owned);
    assert!(!state.empty && !state.can_skip);
    assert_eq!(state.original_head.as_deref(), Some(original.as_str()));
    assert_eq!(state.target_oid.as_deref(), Some(target.as_str()));
    assert_eq!(state.conflicts[0].ours.as_ref().unwrap().preview, "ours\n");
    assert_eq!(repo.skip_pick().await.state, OperationState::Failed);
    assert!(repo.path.join(".git/CHERRY_PICK_HEAD").exists());
    std::fs::write(repo.path.join("file"), "resolved pick\n").unwrap();
    assert_eq!(repo.resume(false).await.state, OperationState::Failed);
    git(&repo.path, &["add", "file"]);
    assert_eq!(repo.resume(false).await.state, OperationState::Succeeded);
    assert_eq!(git(&repo.path, &["show", "HEAD:file"]), "resolved pick");
    assert_eq!(
        git(&repo.path, &["show", "--format=%P", "--no-patch", "HEAD"]),
        original
    );
    assert_eq!(
        repo.service.operation(&start.id).unwrap().state,
        OperationState::Succeeded
    );
}

#[tokio::test]
async fn cherry_pick_abort_restores_original_and_retains_untracked_local_work() {
    let repo = Repo::new();
    let (original, target) = repo.conflict();
    let start = repo.pick(&target, None, false).await;
    assert_eq!(start.state, OperationState::AwaitingResolution);
    std::fs::write(repo.path.join("new local"), "preserve\n").unwrap();
    assert_eq!(repo.resume(true).await.state, OperationState::Succeeded);
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), original);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "ours\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join("new local")).unwrap(),
        "preserve\n"
    );
    assert_eq!(
        repo.service.operation(&start.id).unwrap().state,
        OperationState::Cancelled
    );
}

#[tokio::test]
async fn cherry_pick_empty_requires_explicit_skip_and_never_creates_an_implicit_commit() {
    let repo = Repo::new();
    repo.commit("base", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("picked", "content\n");
    git(&repo.path, &["switch", "main"]);
    assert_eq!(
        repo.pick(&target, None, false).await.state,
        OperationState::Succeeded
    );
    let original = git(&repo.path, &["rev-parse", "HEAD"]);
    let start = repo.pick(&target, None, false).await;
    assert_eq!(start.state, OperationState::AwaitingResolution);
    let state = repo.status().await;
    assert!(state.owned && state.empty && state.can_skip && !state.can_continue);
    assert_eq!(repo.resume(false).await.state, OperationState::Failed);
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), original);
    std::fs::write(repo.path.join("base"), "unstaged local work").unwrap();
    assert_eq!(repo.skip_pick().await.state, OperationState::Failed);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("base")).unwrap(),
        "unstaged local work"
    );
    std::fs::write(repo.path.join("base"), "base\n").unwrap();
    std::fs::write(repo.path.join("new local"), "preserve").unwrap();
    assert_eq!(repo.skip_pick().await.state, OperationState::Succeeded);
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), original);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("new local")).unwrap(),
        "preserve"
    );
    assert_eq!(repo.status().await.kind, "none");
    let history = repo.service.operation(&start.id).unwrap();
    assert_eq!(history.state, OperationState::Succeeded);
    assert!(history.message.unwrap().contains("skipped"));
    std::fs::remove_file(repo.path.join("new local")).unwrap();
    git(&repo.path, &["switch", "-c", "empty-source"]);
    git(
        &repo.path,
        &["commit", "--allow-empty", "-m", "intentional empty"],
    );
    let empty_target = git(&repo.path, &["rev-parse", "HEAD"]);
    git(&repo.path, &["switch", "main"]);
    assert_eq!(
        repo.pick(&empty_target, None, false).await.state,
        OperationState::AwaitingResolution
    );
    assert!(repo.status().await.can_skip);
    assert_eq!(repo.skip_pick().await.state, OperationState::Succeeded);
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), original);
}

#[tokio::test]
async fn cherry_pick_root_and_merge_commits_use_true_parents_and_explicit_mainline() {
    let repo = Repo::new();
    repo.commit("base", "base");
    git(&repo.path, &["switch", "--orphan", "root-topic"]);
    let root = repo.commit("root-file", "root incoming\n");
    git(&repo.path, &["switch", "main"]);
    let preview = repo
        .service
        .cherry_pick_preview(repo.temp.path(), repo.path.to_str().unwrap(), &root, None)
        .await
        .unwrap();
    assert!(preview.parents.is_empty());
    assert!(preview.patch.unwrap().contains("+root incoming"));
    assert_eq!(
        repo.pick(&root, None, false).await.state,
        OperationState::Succeeded
    );
    git(&repo.path, &["switch", "-c", "topic"]);
    repo.commit("topic-file", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    let before = repo.commit("main-file", "current\n");
    git(
        &repo.path,
        &["merge", "--no-ff", "-m", "merge topic", "topic"],
    );
    let merge = git(&repo.path, &["rev-parse", "HEAD"]);
    git(&repo.path, &["switch", "-c", "destination", &before]);
    let preview = repo
        .service
        .cherry_pick_preview(repo.temp.path(), repo.path.to_str().unwrap(), &merge, None)
        .await
        .unwrap();
    assert_eq!(preview.parents.len(), 2);
    assert!(preview.patch.is_none());
    let first = repo
        .service
        .cherry_pick_preview(
            repo.temp.path(),
            repo.path.to_str().unwrap(),
            &merge,
            Some(1),
        )
        .await
        .unwrap();
    let second = repo
        .service
        .cherry_pick_preview(
            repo.temp.path(),
            repo.path.to_str().unwrap(),
            &merge,
            Some(2),
        )
        .await
        .unwrap();
    assert!(first.patch.unwrap().contains("+incoming"));
    assert!(second.patch.unwrap().contains("+current"));
    assert_eq!(
        repo.pick(&merge, None, false).await.state,
        OperationState::Failed
    );
    assert_eq!(
        repo.pick(&merge, Some(3), false).await.state,
        OperationState::Failed
    );
    assert_eq!(
        repo.pick(&merge, Some(1), false).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join("topic-file")).unwrap(),
        "incoming\n"
    );
}

#[tokio::test]
async fn cherry_pick_external_restart_or_replaced_marker_never_grants_control() {
    let repo = Repo::new();
    let (_, target) = repo.conflict();
    let start = repo.pick(&target, None, false).await;
    assert_eq!(start.state, OperationState::AwaitingResolution);
    let restarted = RepositoryService::new();
    assert!(
        !restarted
            .integration_status(repo.temp.path(), repo.path.to_str().unwrap())
            .await
            .unwrap()
            .owned
    );
    git(&repo.path, &["cherry-pick", "--abort"]);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let external = Command::new("git")
        .args(["cherry-pick", &target])
        .current_dir(&repo.path)
        .output()
        .unwrap();
    assert!(!external.status.success());
    let state = repo.status().await;
    assert!(!state.owned);
    assert_eq!(
        repo.service.operation(&start.id).unwrap().state,
        OperationState::UnknownOutcome
    );
    assert_eq!(
        repo.run(
            Action::AbortIntegration {
                session_id: start.id,
                expected_state_token: state.state_token
            },
            state.head
        )
        .await
        .state,
        OperationState::Failed
    );
    assert!(repo.path.join(".git/CHERRY_PICK_HEAD").exists());
}

#[tokio::test]
async fn cherry_pick_preserves_ignored_collision_and_rejects_noncommit_targets() {
    let repo = Repo::new();
    repo.commit("base", "base");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit(".env", "incoming\n");
    git(&repo.path, &["switch", "main"]);
    std::fs::write(repo.path.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(repo.path.join(".env"), "PRIVATE KEEP\n").unwrap();
    assert_eq!(
        repo.pick(&target, None, false).await.state,
        OperationState::Failed
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join(".env")).unwrap(),
        "PRIVATE KEEP\n"
    );
    git(
        &repo.path,
        &[
            "-c",
            "tag.gpgsign=false",
            "tag",
            "-a",
            "preview-tag",
            "-m",
            "annotated",
            &target,
        ],
    );
    let tag = git(&repo.path, &["rev-parse", "preview-tag"]);
    assert!(
        repo.service
            .cherry_pick_preview(repo.temp.path(), repo.path.to_str().unwrap(), &tag, None)
            .await
            .is_err()
    );
}
