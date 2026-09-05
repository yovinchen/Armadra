//! Stash create, apply, pop and drop against observed objects.

#[path = "support/git.rs"]
mod support;

use support::*;

async fn stash_action(
    fixture: &Fixture,
    kind: &str,
    oid: Option<&str>,
    include: bool,
) -> OperationSnapshot {
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let token = observed.state_token;
    let action = match kind {
        "create" => Action::CreateStash {
            message: "保存 Unicode 工作".into(),
            include_untracked: include,
            expected_state_token: token,
        },
        "apply" => Action::ApplyStash {
            oid: oid.unwrap().into(),
            reinstate_index: include,
            expected_state_token: token,
        },
        "pop" => Action::PopStash {
            oid: oid.unwrap().into(),
            reinstate_index: include,
            expected_state_token: token,
        },
        "drop" => Action::DropStash {
            oid: oid.unwrap().into(),
            expected_state_token: token,
        },
        _ => panic!("unknown action"),
    };
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            action,
            observed.head,
        )
        .await
        .unwrap();
    await_operation(&fixture.service, &op.id).await
}

#[tokio::test]
async fn stash_create_details_apply_index_pop_and_drop_use_observed_objects() {
    let fixture = Fixture::new();
    fixture.commit("tracked.txt", "base\n");
    std::fs::write(fixture.repo.join("tracked.txt"), "staged\n").unwrap();
    git(&fixture.repo, &["add", "tracked.txt"]);
    std::fs::write(fixture.repo.join("tracked.txt"), "unstaged\n").unwrap();
    std::fs::write(fixture.repo.join("空 格.txt"), "untracked content\n").unwrap();
    std::fs::write(fixture.repo.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(fixture.repo.join(".env"), "keep ignored\n").unwrap();
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!fixture.repo.join("空 格.txt").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(".env")).unwrap(),
        "keep ignored\n"
    );
    let list = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(list.stashes.len(), 1);
    assert!(list.stashes[0].subject.contains("保存 Unicode 工作"));
    let oid = &list.stashes[0].oid;
    let detail = fixture
        .service
        .stash_detail(fixture.root(), &fixture.requested(), oid)
        .await
        .unwrap();
    assert_eq!(detail.parents.len(), 3);
    assert!(detail.patch.contains("+unstaged"));
    assert!(detail.untracked_patch.contains("+untracked content"));
    assert_eq!(
        stash_action(&fixture, "apply", Some(oid), true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(git(&fixture.repo, &["show", ":tracked.txt"]), "staged");
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("tracked.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("空 格.txt")).unwrap(),
        "untracked content\n"
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        1
    );
    assert_eq!(
        stash_action(&fixture, "drop", Some(oid), false).await.state,
        OperationState::Succeeded
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
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    let fresh = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(
        stash_action(&fixture, "pop", Some(&fresh.stashes[0].oid), true)
            .await
            .state,
        OperationState::Succeeded
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
}

#[tokio::test]
async fn stash_conflicted_pop_keeps_object_and_reports_actual_conflict() {
    let fixture = Fixture::new();
    fixture.commit("file", "base\n");
    std::fs::write(fixture.repo.join("file"), "stashed\n").unwrap();
    assert_eq!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Succeeded
    );
    let saved = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    fixture.commit("file", "different committed\n");
    let result = stash_action(&fixture, "pop", Some(&saved.stashes[0].oid), false).await;
    assert_eq!(result.state, OperationState::UnknownOutcome);
    let after = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(after.has_conflicts);
    assert_eq!(after.stashes[0].oid, saved.stashes[0].oid);
    assert!(!git(&fixture.repo, &["ls-files", "--unmerged"]).is_empty());
    assert_eq!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Failed
    );
}

#[tokio::test]
async fn stash_cas_detects_same_status_content_edits_and_reflog_reordering() {
    let fixture = Fixture::new();
    fixture.commit("file", "base");
    std::fs::write(fixture.repo.join("file"), "dirty one").unwrap();
    std::fs::write(fixture.repo.join("new file"), "first").unwrap();
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    std::fs::write(fixture.repo.join("new file"), "other").unwrap();
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::CreateStash {
                message: "old confirmation".into(),
                include_untracked: true,
                expected_state_token: observed.state_token,
            },
            observed.head,
        )
        .await
        .unwrap();
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    let observed = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    std::fs::write(fixture.repo.join("file"), "newer work").unwrap();
    git(
        &fixture.repo,
        &["stash", "push", "-m", "external newer stash"],
    );
    let op = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::DropStash {
                oid: observed.stashes[0].oid.clone(),
                expected_state_token: observed.state_token,
            },
            observed.head,
        )
        .await
        .unwrap();
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        2
    );
}

#[tokio::test]
async fn stash_untracked_option_is_explicit_and_unknown_oid_never_drops_latest() {
    let fixture = Fixture::new();
    fixture.commit("file", "base");
    std::fs::write(fixture.repo.join("new"), "untracked").unwrap();
    assert_ne!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Succeeded
    );
    assert!(fixture.repo.join("new").exists());
    assert_eq!(
        stash_action(&fixture, "create", None, true).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        stash_action(&fixture, "drop", Some(&"a".repeat(40)), false)
            .await
            .state,
        OperationState::Failed
    );
    let list = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(list.stashes.len(), 1);
    std::fs::write(fixture.repo.join("file"), "intermediate stash").unwrap();
    git(&fixture.repo, &["stash", "push", "-m", "intermediate"]);
    git(
        &fixture.repo,
        &["stash", "store", "-m", "duplicate", &list.stashes[0].oid],
    );
    assert_eq!(
        stash_action(&fixture, "drop", Some(&list.stashes[0].oid), false)
            .await
            .state,
        OperationState::Failed
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        3
    );
}

#[tokio::test]
async fn stash_apply_refuses_overwriting_ignored_collision() {
    let fixture = Fixture::new();
    fixture.commit("base", "base");
    std::fs::write(fixture.repo.join(".env"), "saved content\n").unwrap();
    git(&fixture.repo, &["add", "-f", ".env"]);
    assert_eq!(
        stash_action(&fixture, "create", None, false).await.state,
        OperationState::Succeeded
    );
    let saved = fixture
        .service
        .stashes(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    std::fs::write(fixture.repo.join(".git/info/exclude"), ".env\n").unwrap();
    std::fs::write(fixture.repo.join(".env"), "PRIVATE KEEP\n").unwrap();
    let result = stash_action(&fixture, "pop", Some(&saved.stashes[0].oid), false).await;
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(".env")).unwrap(),
        "PRIVATE KEEP\n"
    );
    assert_eq!(
        fixture
            .service
            .stashes(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .stashes
            .len(),
        1
    );
}
