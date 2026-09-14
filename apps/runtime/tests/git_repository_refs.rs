//! Tags and remotes against a local disposable repository and a local bare
//! remote. Nothing here talks to a network host.
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use armadra_runtime::git_repository::{
    ExpectedState, OperationSnapshot, OperationState, RepositoryAction as Action, RepositoryService,
};
use tempfile::TempDir;

struct Repo {
    temp: TempDir,
    path: PathBuf,
    service: RepositoryService,
}

fn git(root: &Path, arguments: &[&str]) -> String {
    let result = Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(arguments)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{arguments:?}: {}",
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
        let path = temp.path().join("refs repo");
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Refs Test"),
            ("user.email", "refs@example.invalid"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.fsmonitor", "false"),
            ("core.hooksPath", ".git/hooks"),
            ("core.excludesFile", "/dev/null"),
            ("core.autocrlf", "false"),
        ] {
            git(&path, &["config", key, value]);
        }
        Self {
            temp,
            path,
            service: RepositoryService::new(),
        }
    }
    fn requested(&self) -> String {
        self.path.to_str().unwrap().to_owned()
    }
    fn commit(&self, file: &str, content: &str) -> String {
        std::fs::write(self.path.join(file), content).unwrap();
        git(&self.path, &["add", "--", file]);
        git(&self.path, &["commit", "-m", content]);
        git(&self.path, &["rev-parse", "HEAD"])
    }
    async fn head(&self) -> ExpectedState {
        self.service
            .branches(self.temp.path(), &self.requested())
            .await
            .unwrap()
            .head
    }
    async fn run(&self, action: Action) -> OperationSnapshot {
        let head = self.head().await;
        let operation = self
            .service
            .start(self.temp.path().to_owned(), self.requested(), action, head)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = self.service.operation(&operation.id).unwrap();
                if snapshot.state.terminal() {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("operation did not finish")
    }
    fn bare_remote(&self, name: &str) -> PathBuf {
        let remote = self.temp.path().join(format!("{name}.git"));
        git(
            self.temp.path(),
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        );
        git(
            &self.path,
            &["remote", "add", name, remote.to_str().unwrap()],
        );
        remote
    }
}

#[tokio::test]
async fn lightweight_and_annotated_tags_are_listed_created_and_deleted_by_object() {
    let repo = Repo::new();
    let first = repo.commit("file", "one\n");
    let second = repo.commit("file", "two\n");

    assert!(
        repo.service
            .tags(repo.temp.path(), &repo.requested())
            .await
            .unwrap()
            .tags
            .is_empty()
    );

    assert_eq!(
        repo.run(Action::CreateTag {
            name: "v1.0".into(),
            target_oid: first.clone(),
            message: None,
        })
        .await
        .state,
        OperationState::Succeeded
    );
    assert_eq!(
        repo.run(Action::CreateTag {
            name: "版本-2".into(),
            target_oid: second.clone(),
            message: Some("Second release".into()),
        })
        .await
        .state,
        OperationState::Succeeded
    );

    let listed = repo
        .service
        .tags(repo.temp.path(), &repo.requested())
        .await
        .unwrap();
    let lightweight = listed.tags.iter().find(|tag| tag.name == "v1.0").unwrap();
    assert!(!lightweight.annotated);
    // A lightweight tag names the commit directly, so both IDs agree.
    assert_eq!(lightweight.oid, first);
    assert_eq!(lightweight.target_oid, first);
    let annotated = listed.tags.iter().find(|tag| tag.name == "版本-2").unwrap();
    assert!(annotated.annotated);
    assert_ne!(annotated.oid, second, "the tag object is its own object");
    assert_eq!(annotated.target_oid, second);
    assert_eq!(annotated.subject.as_deref(), Some("Second release"));
    assert!(annotated.tagger_name.is_some());

    // Creating the same name again is refused rather than forced.
    let duplicate = repo
        .run(Action::CreateTag {
            name: "v1.0".into(),
            target_oid: second.clone(),
            message: None,
        })
        .await;
    assert_eq!(duplicate.state, OperationState::Failed);
    assert_eq!(git(&repo.path, &["rev-parse", "v1.0"]), first);

    // Deleting confirms the object the caller reviewed.
    let stale = repo
        .run(Action::DeleteTag {
            name: "v1.0".into(),
            expected_oid: second.clone(),
        })
        .await;
    assert_eq!(stale.state, OperationState::Failed);
    assert_eq!(git(&repo.path, &["rev-parse", "v1.0"]), first);
    assert_eq!(
        repo.run(Action::DeleteTag {
            name: "v1.0".into(),
            expected_oid: first.clone(),
        })
        .await
        .state,
        OperationState::Succeeded
    );
    let remaining = repo
        .service
        .tags(repo.temp.path(), &repo.requested())
        .await
        .unwrap();
    assert_eq!(remaining.tags.len(), 1);
    assert_eq!(remaining.tags[0].name, "版本-2");

    for name in ["-force", "bad..name", "refs/tags/extra", "a\nb", "@{0}"] {
        assert!(
            repo.service
                .start(
                    repo.temp.path().to_owned(),
                    repo.requested(),
                    Action::CreateTag {
                        name: name.into(),
                        target_oid: first.clone(),
                        message: None,
                    },
                    repo.head().await,
                )
                .await
                .is_err(),
            "{name} must be refused"
        );
    }
}

#[tokio::test]
async fn pushing_a_tag_never_overwrites_a_different_published_object() {
    let repo = Repo::new();
    let first = repo.commit("file", "one\n");
    let second = repo.commit("file", "two\n");
    let remote = repo.bare_remote("origin");
    git(&repo.path, &["tag", "release", &first]);

    assert_eq!(
        repo.run(Action::PushTag {
            remote: "origin".into(),
            name: "release".into(),
            expected_oid: first.clone(),
        })
        .await
        .state,
        OperationState::Succeeded
    );
    assert_eq!(git(&remote, &["rev-parse", "refs/tags/release"]), first);

    // Re-point the tag locally, then try to publish it over the old object.
    git(&repo.path, &["tag", "-f", "release", &second]);
    let forced = repo
        .run(Action::PushTag {
            remote: "origin".into(),
            name: "release".into(),
            expected_oid: second.clone(),
        })
        .await;
    // A push that Git started but rejected is an unknown outcome by design;
    // what matters is that nothing on the remote moved.
    assert_ne!(
        forced.state,
        OperationState::Succeeded,
        "a published tag is never overwritten"
    );
    assert_eq!(
        git(&remote, &["rev-parse", "refs/tags/release"]),
        first,
        "the remote still names the original object"
    );

    // A stale expectation is refused before Git is asked to push at all.
    let stale = repo
        .run(Action::PushTag {
            remote: "origin".into(),
            name: "release".into(),
            expected_oid: first.clone(),
        })
        .await;
    assert_eq!(stale.state, OperationState::Failed);
}

#[tokio::test]
async fn remotes_are_added_renamed_retargeted_and_removed_with_credentials_hidden() {
    let repo = Repo::new();
    repo.commit("file", "one\n");

    assert!(
        repo.service
            .remote_records(repo.temp.path(), &repo.requested())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        repo.run(Action::AddRemote {
            name: "origin".into(),
            url: "https://example.invalid/team/repo.git".into(),
        })
        .await
        .state,
        OperationState::Succeeded
    );
    let listed = repo
        .service
        .remote_records(repo.temp.path(), &repo.requested())
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "origin");
    assert_eq!(listed[0].fetch_url, "https://example.invalid/team/repo.git");
    assert!(!listed[0].redacted);

    // A URL carrying credentials is never echoed back verbatim.
    assert_eq!(
        repo.run(Action::SetRemoteUrl {
            name: "origin".into(),
            url: "https://user:secret@example.invalid/team/repo.git".into(),
        })
        .await
        .state,
        OperationState::Succeeded
    );
    let hidden = repo
        .service
        .remote_records(repo.temp.path(), &repo.requested())
        .await
        .unwrap();
    assert!(hidden[0].redacted);
    assert!(!hidden[0].fetch_url.contains("secret"));
    assert!(!hidden[0].push_url.contains("secret"));
    assert!(hidden[0].fetch_url.contains("example.invalid"));

    assert_eq!(
        repo.run(Action::RenameRemote {
            name: "origin".into(),
            new_name: "upstream".into(),
        })
        .await
        .state,
        OperationState::Succeeded
    );
    let renamed = repo
        .service
        .remote_records(repo.temp.path(), &repo.requested())
        .await
        .unwrap();
    assert_eq!(renamed.len(), 1);
    assert_eq!(renamed[0].name, "upstream");

    // A name that already exists is refused rather than merged.
    git(
        &repo.path,
        &[
            "remote",
            "add",
            "second",
            "https://example.invalid/other.git",
        ],
    );
    let clash = repo
        .run(Action::RenameRemote {
            name: "upstream".into(),
            new_name: "second".into(),
        })
        .await;
    assert_eq!(clash.state, OperationState::Failed);

    assert_eq!(
        repo.run(Action::RemoveRemote {
            name: "second".into(),
        })
        .await
        .state,
        OperationState::Succeeded
    );
    let left = repo
        .service
        .remote_records(repo.temp.path(), &repo.requested())
        .await
        .unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].name, "upstream");
}

#[tokio::test]
async fn remote_urls_and_names_use_the_same_allow_list_as_clone() {
    let repo = Repo::new();
    repo.commit("file", "one\n");
    for url in [
        "file:///tmp/repo.git",
        "/tmp/repo.git",
        "ext::sh -c whoami",
        "--upload-pack=touch /tmp/pwned",
        "http://example.invalid/repo.git",
    ] {
        assert!(
            repo.service
                .start(
                    repo.temp.path().to_owned(),
                    repo.requested(),
                    Action::AddRemote {
                        name: "origin".into(),
                        url: url.into(),
                    },
                    repo.head().await,
                )
                .await
                .is_err(),
            "{url} must be refused"
        );
    }
    for name in ["-origin", "with/slash", "with:colon", ""] {
        assert!(
            repo.service
                .start(
                    repo.temp.path().to_owned(),
                    repo.requested(),
                    Action::AddRemote {
                        name: name.into(),
                        url: "https://example.invalid/team/repo.git".into(),
                    },
                    repo.head().await,
                )
                .await
                .is_err(),
            "{name:?} must be refused"
        );
    }
    assert!(
        repo.service
            .remote_records(repo.temp.path(), &repo.requested())
            .await
            .unwrap()
            .is_empty()
    );
}
