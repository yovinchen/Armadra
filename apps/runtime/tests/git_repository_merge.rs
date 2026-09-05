//! Integration recovery uses local disposable repositories only.
use armadra_runtime::git_repository::{
    ExpectedState, IntegrationSnapshot, OperationSnapshot, OperationState,
    RepositoryAction as Action, RepositoryService,
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tempfile::TempDir;

struct Repo {
    temp: TempDir,
    path: PathBuf,
    service: RepositoryService,
}
fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout)
        .unwrap()
        .trim_end_matches('\n')
        .into()
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("merge repo 空间");
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Integration Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.fsmonitor", "false"),
            ("core.hooksPath", ".git/hooks"),
            ("core.excludesFile", "/dev/null"),
        ] {
            git(&path, &["config", key, value]);
        }
        Self {
            temp,
            path,
            service: RepositoryService::new(),
        }
    }
    fn commit(&self, file: &str, content: &str) -> String {
        std::fs::write(self.path.join(file), content).unwrap();
        git(&self.path, &["add", "-f", "--", file]);
        git(&self.path, &["commit", "-m", "test commit"]);
        git(&self.path, &["rev-parse", "HEAD"])
    }
    async fn status(&self) -> IntegrationSnapshot {
        self.service
            .integration_status(self.temp.path(), self.path.to_str().unwrap())
            .await
            .unwrap()
    }
    async fn run(&self, action: Action, expected: ExpectedState) -> OperationSnapshot {
        let op = self
            .service
            .start(
                self.temp.path().to_owned(),
                self.path.to_str().unwrap().into(),
                action,
                expected,
            )
            .await
            .unwrap();
        wait(&self.service, &op.id).await
    }
    async fn merge(&self, target: &str) -> OperationSnapshot {
        let state = self.status().await;
        self.run(
            Action::StartMerge {
                target_oid: target.into(),
                message: "Explicit merge".into(),
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await
    }
    async fn resume(&self, abort: bool) -> OperationSnapshot {
        let state = self.status().await;
        let id = state
            .session_id
            .unwrap_or_else(|| "11111111-1111-4111-8111-111111111111".into());
        let action = if abort {
            Action::AbortIntegration {
                session_id: id,
                expected_state_token: state.state_token,
            }
        } else {
            Action::ContinueIntegration {
                session_id: id,
                expected_state_token: state.state_token,
            }
        };
        self.run(action, state.head).await
    }
    fn conflict(&self) -> (String, String) {
        self.commit("file", "base\n");
        git(&self.path, &["switch", "-c", "topic"]);
        let target = self.commit("file", "theirs\n");
        git(&self.path, &["switch", "main"]);
        let original = self.commit("file", "ours\n");
        (original, target)
    }
}
async fn wait(service: &RepositoryService, id: &str) -> OperationSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let op = service.operation(id).unwrap();
            if op.state.terminal() {
                return op;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn clean_merge_pauses_for_explicit_commit_and_preserves_both_parents() {
    let repo = Repo::new();
    repo.commit("base", "base");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit("topic", "incoming");
    git(&repo.path, &["switch", "main"]);
    let original = repo.commit("main", "current");
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    let state = repo.status().await;
    assert!(state.owned && state.can_continue && state.conflicts.is_empty());
    assert_eq!(state.head.head_oid.as_deref(), Some(original.as_str()));
    std::fs::write(repo.path.join(".git/MERGE_MSG"), "Reviewed merge message\n").unwrap();
    let stale = repo
        .run(
            Action::ContinueIntegration {
                session_id: state.session_id.clone().unwrap(),
                expected_state_token: state.state_token.clone(),
            },
            state.head.clone(),
        )
        .await;
    assert_eq!(stale.state, OperationState::Failed);
    assert_eq!(
        repo.status().await.message.as_deref(),
        Some("Reviewed merge message\n")
    );
    assert_eq!(repo.resume(false).await.state, OperationState::Succeeded);
    assert_eq!(
        git(&repo.path, &["show", "--format=%s", "--no-patch", "HEAD"]),
        "Reviewed merge message"
    );
    let parents = git(&repo.path, &["show", "--format=%P", "--no-patch", "HEAD"]);
    assert_eq!(parents, format!("{original} {target}"));
    assert_eq!(repo.status().await.kind, "none");
    assert_eq!(
        repo.service
            .operation(state.session_id.as_deref().unwrap())
            .unwrap()
            .state,
        OperationState::Succeeded
    );
}

#[tokio::test]
async fn conflict_sides_and_staging_gate_bind_continue_to_the_new_state() {
    let repo = Repo::new();
    let (_, target) = repo.conflict();
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    let old = repo.status().await;
    assert!(old.owned && !old.can_continue);
    assert_eq!(old.conflicts.len(), 1);
    let file = &old.conflicts[0];
    assert_eq!(file.path, "file");
    assert_eq!(file.base.as_ref().unwrap().preview, "base\n");
    assert_eq!(file.ours.as_ref().unwrap().preview, "ours\n");
    assert_eq!(file.theirs.as_ref().unwrap().preview, "theirs\n");
    assert_eq!(repo.resume(false).await.state, OperationState::Failed);
    std::fs::write(repo.path.join("file"), "resolved\n").unwrap();
    assert!(!repo.status().await.can_continue);
    git(&repo.path, &["add", "file"]);
    assert!(repo.status().await.can_continue);
    let stale = repo
        .run(
            Action::ContinueIntegration {
                session_id: old.session_id.unwrap(),
                expected_state_token: old.state_token,
            },
            old.head,
        )
        .await;
    assert_eq!(stale.state, OperationState::Failed);
    assert_eq!(repo.resume(false).await.state, OperationState::Succeeded);
    assert_eq!(git(&repo.path, &["show", "HEAD:file"]), "resolved");
}

#[tokio::test]
async fn owned_abort_restores_original_and_restarted_service_cannot_claim_ownership() {
    let repo = Repo::new();
    let (original, target) = repo.conflict();
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    let restarted = RepositoryService::new();
    let status = restarted
        .integration_status(repo.temp.path(), repo.path.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(status.kind, "merge");
    assert!(!status.owned);
    assert!(status.session_id.is_none());
    let owned = repo.status().await;
    let owner_id = owned.session_id.clone().unwrap();
    let op = restarted
        .start(
            repo.temp.path().to_owned(),
            repo.path.to_str().unwrap().into(),
            Action::AbortIntegration {
                session_id: owned.session_id.unwrap(),
                expected_state_token: status.state_token,
            },
            status.head,
        )
        .await
        .unwrap();
    assert_eq!(wait(&restarted, &op.id).await.state, OperationState::Failed);
    assert!(repo.path.join(".git/MERGE_HEAD").exists());
    assert_eq!(repo.resume(true).await.state, OperationState::Succeeded);
    assert_eq!(
        repo.service.operation(&owner_id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), original);
    assert_eq!(
        std::fs::read_to_string(repo.path.join("file")).unwrap(),
        "ours\n"
    );
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn externally_replaced_merge_marker_revokes_continue_and_abort() {
    let repo = Repo::new();
    let (_, target) = repo.conflict();
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    let old = repo.status().await;
    git(&repo.path, &["merge", "--abort"]);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let external = Command::new("git")
        .args(["merge", "--no-ff", "--no-commit", &target])
        .current_dir(&repo.path)
        .output()
        .unwrap();
    assert!(!external.status.success());
    let state = repo.status().await;
    assert!(!state.owned);
    assert_eq!(
        repo.service
            .operation(old.session_id.as_deref().unwrap())
            .unwrap()
            .state,
        OperationState::UnknownOutcome
    );
    let op = repo
        .run(
            Action::AbortIntegration {
                session_id: old.session_id.unwrap(),
                expected_state_token: state.state_token,
            },
            state.head,
        )
        .await;
    assert_eq!(op.state, OperationState::Failed);
    assert!(repo.path.join(".git/MERGE_HEAD").exists());
}

#[tokio::test]
async fn merge_keeps_dirty_and_ignored_files_and_refuses_other_repository_mutations_while_paused() {
    let repo = Repo::new();
    repo.commit("base", "base");
    git(&repo.path, &["switch", "-c", "topic"]);
    let target = repo.commit(".env", "incoming secret\n");
    git(&repo.path, &["switch", "main"]);
    std::fs::write(repo.path.join("untracked"), "keep").unwrap();
    assert_eq!(repo.merge(&target).await.state, OperationState::Failed);
    std::fs::remove_file(repo.path.join("untracked")).unwrap();
    std::fs::write(repo.path.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(repo.path.join(".env"), "PRIVATE KEEP\n").unwrap();
    assert_ne!(repo.merge(&target).await.state, OperationState::Succeeded);
    assert_eq!(
        std::fs::read_to_string(repo.path.join(".env")).unwrap(),
        "PRIVATE KEEP\n"
    );
    std::fs::remove_file(repo.path.join(".env")).unwrap();
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    let state = repo.status().await;
    let op = repo
        .run(
            Action::CreateBranch {
                name: "unexpected".into(),
                start_point: None,
                switch: true,
            },
            state.head,
        )
        .await;
    assert_eq!(op.state, OperationState::Failed);
    assert_eq!(git(&repo.path, &["branch", "--show-current"]), "main");
}

#[tokio::test]
async fn abort_never_overwrites_an_ignored_file_recreated_after_merge_deletion() {
    let repo = Repo::new();
    repo.commit(".env", "original\n");
    repo.commit("file", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    git(&repo.path, &["rm", ".env"]);
    let target = repo.commit("file", "theirs\n");
    git(&repo.path, &["switch", "main"]);
    repo.commit("file", "ours\n");
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    assert!(!repo.path.join(".env").exists());
    std::fs::write(repo.path.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(repo.path.join(".env"), "new ignored secret\n").unwrap();
    assert_eq!(repo.resume(true).await.state, OperationState::Failed);
    assert_eq!(
        std::fs::read_to_string(repo.path.join(".env")).unwrap(),
        "new ignored secret\n"
    );
    assert!(repo.status().await.owned);
    std::fs::remove_file(repo.path.join(".env")).unwrap();
    assert_eq!(repo.resume(true).await.state, OperationState::Succeeded);
    assert_eq!(
        std::fs::read_to_string(repo.path.join(".env")).unwrap(),
        "original\n"
    );
}

#[tokio::test]
async fn binary_and_large_conflict_sides_keep_oids_and_paths_without_unbounded_previews() {
    let repo = Repo::new();
    repo.commit("binary\nfile", "base\0bytes");
    repo.commit("large", "base\n");
    git(&repo.path, &["switch", "-c", "topic"]);
    repo.commit("binary\nfile", "their\0bytes");
    let target = repo.commit("large", &"t".repeat(70_000));
    git(&repo.path, &["switch", "main"]);
    repo.commit("binary\nfile", "ours\0bytes");
    repo.commit("large", &"o".repeat(70_000));
    assert_eq!(
        repo.merge(&target).await.state,
        OperationState::AwaitingResolution
    );
    let state = repo.status().await;
    let binary = state
        .conflicts
        .iter()
        .find(|file| file.path == "binary\nfile")
        .unwrap();
    assert_eq!(binary.theirs.as_ref().unwrap().binary, Some(true));
    assert!(binary.theirs.as_ref().unwrap().preview.is_empty());
    let large = state
        .conflicts
        .iter()
        .find(|file| file.path == "large")
        .unwrap();
    assert!(large.ours.as_ref().unwrap().truncated);
    assert!(large.ours.as_ref().unwrap().preview.is_empty());
    assert_eq!(large.ours.as_ref().unwrap().size, 70_000);
    assert_eq!(large.ours.as_ref().unwrap().oid.len(), 40);
}

#[path = "git_repository_merge/cherry_pick.rs"]
mod cherry_pick;
