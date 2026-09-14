//! Real local Git repositories only. No test pushes to a network remote.
//!
//! Shared fixture for the `git_repository_*` integration suites: a disposable
//! checkout, the `git` shell helper and the operation-completion await.
#![allow(dead_code, unused_imports)]

pub use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub use armadra_runtime::git_repository::{
    ExpectedState, ForceWithLease, HistoryRequest, OperationSnapshot, OperationState,
    RepositoryAction as Action, RepositoryService,
};
pub use tempfile::TempDir;

pub struct Fixture {
    pub directory: TempDir,
    pub repo: PathBuf,
    pub service: RepositoryService,
}

pub fn git(directory: &Path, arguments: &[&str]) -> String {
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
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo with 空格");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--initial-branch=main"]);
        git(&repo, &["config", "user.name", "测试 Author"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "core.hooksPath", ".git/hooks"]);
        git(&repo, &["config", "core.fsmonitor", "false"]);
        git(&repo, &["config", "core.excludesFile", "/dev/null"]);
        // Git for Windows' system config turns on `core.autocrlf`; the tests
        // compare working-tree bytes with what they wrote.
        git(&repo, &["config", "core.autocrlf", "false"]);
        Self {
            directory,
            repo,
            service: RepositoryService::new(),
        }
    }
    pub fn root(&self) -> &Path {
        self.directory.path()
    }
    pub fn requested(&self) -> String {
        self.repo
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
    pub fn commit(&self, name: &str, text: &str) -> String {
        std::fs::write(self.repo.join(name), text).unwrap();
        git(&self.repo, &["add", "--", name]);
        git(&self.repo, &["commit", "-m", text]);
        git(&self.repo, &["rev-parse", "HEAD"])
    }
    pub async fn head(&self) -> ExpectedState {
        self.service
            .branches(self.root(), &self.requested())
            .await
            .unwrap()
            .head
    }
    pub async fn start(&self, action: Action) -> OperationSnapshot {
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
    pub async fn run(&self, action: Action) -> OperationSnapshot {
        let operation = self.start(action).await;
        await_operation(&self.service, &operation.id).await
    }
    pub async fn success(&self, action: Action) -> OperationSnapshot {
        let result = self.run(action).await;
        assert_eq!(result.state, OperationState::Succeeded, "{result:?}");
        result
    }
    pub fn remote(&self) -> PathBuf {
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

pub async fn await_operation(service: &RepositoryService, id: &str) -> OperationSnapshot {
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
