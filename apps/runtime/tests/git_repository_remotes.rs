//! Fetch, pull, push and sync against local disposable remotes.

#[path = "support/git.rs"]
mod support;

use support::*;

#[tokio::test]
async fn local_remote_fetch_ff_only_pull_push_and_upstream_counts() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
        })
        .await;
    let other = fixture.root().join("second clone");
    git(
        fixture.root(),
        &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Remote Author"]);
    git(&other, &["config", "user.email", "remote@example.invalid"]);
    std::fs::write(other.join("remote.txt"), "remote").unwrap();
    git(&other, &["add", "remote.txt"]);
    git(&other, &["commit", "-m", "remote commit"]);
    git(&other, &["push", "origin", "main"]);
    fixture
        .success(Action::Fetch {
            remote: "origin".into(),
            prune: false,
        })
        .await;
    let state = fixture
        .service
        .branches(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let main = state.branches.iter().find(|branch| branch.current).unwrap();
    assert_eq!((main.ahead, main.behind), (Some(0), Some(1)));
    assert!(
        state
            .branches
            .iter()
            .any(|branch| branch.remote && branch.name == "origin/main")
    );
    fixture
        .success(Action::Pull {
            remote: "origin".into(),
            branch: "main".into(),
        })
        .await;
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("remote.txt")).unwrap(),
        "remote"
    );
    let oid = fixture.commit("local.txt", "local commit");
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
            force_with_lease: None,
        })
        .await;
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), oid);
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::Fetch {
                    remote: "--all".into(),
                    prune: true
                },
                fixture.head().await
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn pull_divergence_and_push_configuration_never_force_remote_history() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
        })
        .await;
    let other = fixture.root().join("other");
    git(
        fixture.root(),
        &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Other"]);
    git(&other, &["config", "user.email", "other@example.invalid"]);
    std::fs::write(other.join("other.txt"), "remote diverges").unwrap();
    git(&other, &["add", "other.txt"]);
    git(&other, &["commit", "-m", "remote diverges"]);
    git(&other, &["push", "origin", "main"]);
    let remote_oid = git(&remote, &["rev-parse", "main"]);
    let local_oid = fixture.commit("local.txt", "local diverges");
    let result = fixture
        .run(Action::Pull {
            remote: "origin".into(),
            branch: "main".into(),
        })
        .await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(
        fixture.head().await.head_oid.as_deref(),
        Some(local_oid.as_str())
    );
    assert!(!fixture.repo.join(".git/MERGE_HEAD").exists());
    git(&fixture.repo, &["config", "remote.origin.mirror", "true"]);
    git(
        &fixture.repo,
        &["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"],
    );
    let result = fixture
        .run(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
            force_with_lease: None,
        })
        .await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(git(&remote, &["rev-parse", "main"]), remote_oid);
    assert!(
        serde_json::from_value::<Action>(
            serde_json::json!({"kind":"push","remote":"origin","branch":"main","force":true})
        )
        .is_err()
    );
}

#[tokio::test]
async fn fast_forward_pull_preserves_ignored_local_files_and_cleans_private_fetch_ref() {
    let fixture = Fixture::new();
    let base = fixture.commit("base", "base");
    fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
        })
        .await;
    let author = fixture.root().join("remote-author");
    git(
        fixture.root(),
        &[
            "clone",
            fixture.root().join("remote bare.git").to_str().unwrap(),
            author.to_str().unwrap(),
        ],
    );
    git(&author, &["config", "user.name", "Test"]);
    git(&author, &["config", "user.email", "test@example.invalid"]);
    std::fs::write(author.join(".env"), "REMOTE=1\n").unwrap();
    git(&author, &["add", "-f", "--", ".env"]);
    git(&author, &["commit", "-m", "Add environment example"]);
    git(&author, &["push", "origin", "main"]);
    std::fs::write(fixture.repo.join(".git/info/exclude"), "/.env\n").unwrap();
    std::fs::write(fixture.repo.join(".env"), "LOCAL_SECRET=keep\n").unwrap();
    let result = fixture
        .run(Action::Pull {
            remote: "origin".into(),
            branch: "main".into(),
        })
        .await;
    assert_eq!(result.state, OperationState::UnknownOutcome);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(".env")).unwrap(),
        "LOCAL_SECRET=keep\n"
    );
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        git(
            &fixture.repo,
            &["for-each-ref", "--format=%(refname)", "refs/armadra/pull/"]
        ),
        ""
    );
}

/// A second clone of the same local bare remote. Nothing in these tests reaches
/// a network host.
fn coauthor(fixture: &Fixture, remote: &Path, name: &str) -> PathBuf {
    let clone = fixture.root().join(name);
    git(
        fixture.root(),
        &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
    );
    git(&clone, &["config", "user.name", "Remote Author"]);
    git(&clone, &["config", "user.email", "remote@example.invalid"]);
    clone
}
fn publish(clone: &Path, name: &str, text: &str) -> String {
    std::fs::write(clone.join(name), text).unwrap();
    git(clone, &["add", "--", name]);
    git(clone, &["commit", "-m", text]);
    git(clone, &["push", "origin", "main"]);
    git(clone, &["rev-parse", "HEAD"])
}
fn tracking(fixture: &Fixture) -> Option<String> {
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/main",
        ])
        .current_dir(&fixture.repo)
        .output()
        .unwrap();
    output.status.success().then(|| {
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end_matches('\n')
            .into()
    })
}
async fn sync(fixture: &Fixture, expected_remote_oid: Option<String>) -> OperationSnapshot {
    fixture
        .run(Action::Sync {
            remote: "origin".into(),
            branch: "main".into(),
            expected_remote_oid,
        })
        .await
}

#[tokio::test]
async fn sync_fetches_fast_forwards_and_pushes_within_one_operation() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
        })
        .await;
    let author = coauthor(&fixture, &remote, "coauthor");
    let published = publish(&author, "remote.txt", "remote work");
    let observed = tracking(&fixture);
    assert_ne!(observed.as_deref(), Some(published.as_str()));
    let brought_forward = sync(&fixture, observed).await;
    assert_eq!(brought_forward.state, OperationState::Succeeded);
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), published);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("remote.txt")).unwrap(),
        "remote work"
    );
    let local = fixture.commit("local.txt", "local work");
    let pushed = sync(&fixture, tracking(&fixture)).await;
    assert_eq!(pushed.state, OperationState::Succeeded);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), local);
    assert_eq!(
        git(
            &fixture.repo,
            &["for-each-ref", "--format=%(refname)", "refs/armadra/pull/"]
        ),
        ""
    );
}

#[tokio::test]
async fn sync_stops_at_the_diverged_pull_and_reports_the_step_head_and_remote() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
        })
        .await;
    let author = coauthor(&fixture, &remote, "coauthor");
    let published = publish(&author, "remote.txt", "remote diverges");
    let observed = tracking(&fixture);
    let local = fixture.commit("local.txt", "local diverges");
    // A lease-style precondition: the reviewed remote position must still hold.
    let stale = sync(&fixture, Some(published.clone())).await;
    assert_eq!(stale.state, OperationState::Failed);
    assert!(
        stale
            .message
            .as_deref()
            .is_some_and(|message| message.contains("Remote tracking ref changed")),
        "{stale:?}"
    );
    let stopped = sync(&fixture, observed).await;
    assert_ne!(stopped.state, OperationState::Succeeded);
    let message = stopped.message.clone().unwrap_or_default();
    assert!(message.contains("stopped at the pull step"), "{message}");
    assert!(message.contains(&local), "{message}");
    assert!(message.contains(&published), "{message}");
    // Nothing was merged, rebased, or forced to make the three steps agree.
    assert_eq!(git(&fixture.repo, &["rev-parse", "HEAD"]), local);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), published);
    assert!(!fixture.repo.join(".git/MERGE_HEAD").exists());
    assert!(!fixture.repo.join(".git/rebase-merge").exists());
    assert_eq!(
        git(
            &fixture.repo,
            &["for-each-ref", "--format=%(refname)", "refs/armadra/pull/"]
        ),
        ""
    );
}

#[tokio::test]
async fn force_with_lease_overwrites_only_the_reviewed_remote_commit() {
    let fixture = Fixture::new();
    let first = fixture.commit("root.txt", "first");
    fixture.commit("second.txt", "second");
    let remote = fixture.remote();
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
        })
        .await;
    let published = git(&remote, &["rev-parse", "refs/heads/main"]);
    git(&fixture.repo, &["reset", "--hard", &first]);
    let rewritten = fixture.commit("rewritten.txt", "rewritten");
    let refused = fixture
        .run(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
            force_with_lease: None,
        })
        .await;
    assert_ne!(refused.state, OperationState::Succeeded);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), published);
    let expired = fixture
        .run(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
            force_with_lease: Some(ForceWithLease {
                expected_remote_oid: first.clone(),
            }),
        })
        .await;
    assert_ne!(expired.state, OperationState::Succeeded);
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/main"]),
        published,
        "an expired lease must leave the remote commit in place"
    );
    fixture
        .success(Action::Push {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
            force_with_lease: Some(ForceWithLease {
                expected_remote_oid: published.clone(),
            }),
        })
        .await;
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), rewritten);
    // There is no lease-free force, and no lease without a reviewed object ID.
    for request in [
        serde_json::json!({"kind":"push","remote":"origin","branch":"main","force":true}),
        serde_json::json!({"kind":"push","remote":"origin","branch":"main","forceWithLease":{}}),
        serde_json::json!({"kind":"push","remote":"origin","branch":"main","forceWithLease":{"expectedRemoteOid":"HEAD"}}),
    ] {
        assert!(
            serde_json::from_value::<Action>(request.clone()).is_err()
                || fixture
                    .service
                    .start(
                        fixture.root().to_owned(),
                        fixture.requested(),
                        serde_json::from_value::<Action>(request).unwrap(),
                        fixture.head().await,
                    )
                    .await
                    .is_err()
        );
    }
}
