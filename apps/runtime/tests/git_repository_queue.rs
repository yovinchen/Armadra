//! The per-repository operation queue: ordering, cancellation, listing and
//! shutdown.

#[path = "support/git.rs"]
mod support;

use support::*;

#[tokio::test]
async fn common_directory_queue_can_cancel_without_creating_a_branch_and_rechecks_head() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let cancelled = fixture
        .start(Action::CreateBranch {
            name: "feature/cancelled".into(),
            start_point: None,
            switch: false,
        })
        .await;
    assert_eq!(
        fixture.service.cancel(&cancelled.id).unwrap().state,
        OperationState::Queued
    );
    assert_eq!(
        await_operation(&fixture.service, &cancelled.id).await.state,
        OperationState::Cancelled
    );
    let stale = fixture
        .start(Action::CreateBranch {
            name: "feature/stale".into(),
            start_point: None,
            switch: false,
        })
        .await;
    fixture.commit("changed.txt", "changed outside service");
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &stale.id).await.state,
        OperationState::Failed
    );
    let branches = fixture
        .service
        .branches(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(
        branches
            .branches
            .iter()
            .all(|branch| branch.name != "feature/cancelled" && branch.name != "feature/stale")
    );
}

#[tokio::test]
async fn fifo_create_then_delete_observes_submission_order() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let create = fixture
        .start(Action::CreateBranch {
            name: "feature/ordered".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let delete = fixture
        .start(Action::DeleteBranch {
            name: "feature/ordered".into(),
            expected_oid: oid,
        })
        .await;
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &create.id).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        await_operation(&fixture.service, &delete.id).await.state,
        OperationState::Succeeded
    );
    assert!(
        !fixture
            .service
            .branches(fixture.root(), &fixture.requested())
            .await
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature/ordered")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn running_cancellation_is_unknown_and_does_not_replay_the_mutation() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    fixture
        .success(Action::CreateBranch {
            name: "feature/cancel-hook".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let hook = fixture.repo.join(".git/hooks/post-checkout");
    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf ready > \"$PWD/hook-ready\"\nsleep 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let started = fixture
        .start(Action::SwitchBranch {
            name: "feature/cancel-hook".into(),
            expected_oid: oid,
        })
        .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.repo.join("hook-ready").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.service.cancel(&started.id).unwrap();
    let result = await_operation(&fixture.service, &started.id).await;
    assert_eq!(result.state, OperationState::UnknownOutcome);
    assert!(result.cancellation_requested);
    assert_eq!(
        fixture.head().await.branch.as_deref(),
        Some("feature/cancel-hook")
    );
    assert_eq!(
        fixture.service.operation(&started.id).unwrap().state,
        OperationState::UnknownOutcome
    );
}

#[cfg(unix)]
#[tokio::test]
async fn timed_out_and_excessive_hook_output_have_bounded_unknown_results() {
    use std::os::unix::fs::PermissionsExt;
    for script in [
        "#!/bin/sh\nsleep 2\n",
        "#!/bin/sh\ndd if=/dev/zero bs=65537 count=1 >&2 2>/dev/null\n",
    ] {
        let mut fixture = Fixture::new();
        let oid = fixture.commit("root.txt", "base");
        fixture
            .success(Action::CreateBranch {
                name: "feature/hook".into(),
                start_point: None,
                switch: false,
            })
            .await;
        fixture.service = RepositoryService::with_timeout(Duration::from_millis(500)).unwrap();
        let hook = fixture.repo.join(".git/hooks/post-checkout");
        std::fs::write(&hook, script).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        let start = std::time::Instant::now();
        let op = fixture
            .run(Action::SwitchBranch {
                name: "feature/hook".into(),
                expected_oid: oid,
            })
            .await;
        assert_eq!(op.state, OperationState::UnknownOutcome, "{op:?}");
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(op.message.as_ref().is_some_and(
            |message| message.contains("timed out") || message.contains("bounded budget")
        ));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_queued_request_cannot_follow_a_retargeted_repository_symlink() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "base");
    let outside = Fixture::new();
    outside.commit("root.txt", "other");
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let op = fixture
        .start(Action::CreateBranch {
            name: "feature/no-escape".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let saved = fixture.root().join("moved-original");
    std::fs::rename(&fixture.repo, &saved).unwrap();
    std::os::unix::fs::symlink(&outside.repo, &fixture.repo).unwrap();
    drop(guard);
    assert_eq!(
        await_operation(&fixture.service, &op.id).await.state,
        OperationState::Failed
    );
    assert!(
        !git(&outside.repo, &["branch", "--list", "feature/no-escape"])
            .contains("feature/no-escape")
    );
    std::fs::remove_file(&fixture.repo).unwrap();
    std::fs::rename(saved, &fixture.repo).unwrap();
}

#[tokio::test]
async fn operation_listing_recovers_order_and_enforces_repository_and_workspace_scope() {
    let fixture = Fixture::new();
    fixture.commit("base", "base");
    let first = fixture
        .success(Action::CreateBranch {
            name: "feature/first".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let second = fixture
        .success(Action::CreateBranch {
            name: "feature/second".into(),
            start_point: None,
            switch: false,
        })
        .await;
    let fresh_client = fixture.service.clone();
    let restored = fresh_client
        .list_operations(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert_eq!(
        restored.iter().map(|item| &item.id).collect::<Vec<_>>(),
        vec![&second.id, &first.id]
    );
    assert!(
        restored
            .iter()
            .all(|item| item.state == OperationState::Succeeded)
    );
    // A narrower workspace authorizing the same repository does not inherit
    // records accepted through another workspace boundary.
    assert!(
        fresh_client
            .list_operations(&fixture.repo, ".")
            .await
            .unwrap()
            .is_empty()
    );
    let other = fixture.root().join("other");
    std::fs::create_dir(&other).unwrap();
    git(&other, &["init", "--initial-branch=main"]);
    assert!(
        fresh_client
            .list_operations(fixture.root(), "other")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn shutdown_cancels_queue_waits_for_external_guards_and_closes_admission() {
    let fixture = Fixture::new();
    fixture.commit("base", "base");
    let expected = fixture.head().await;
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    let operation = fixture
        .service
        .start(
            fixture.root().to_owned(),
            fixture.requested(),
            Action::CreateBranch {
                name: "feature/never".into(),
                start_point: None,
                switch: false,
            },
            expected.clone(),
        )
        .await
        .unwrap();
    assert_eq!(operation.state, OperationState::Queued);
    let service = fixture.service.clone();
    let shutdown = tokio::spawn(async move { service.shutdown(Duration::from_secs(3)).await });
    tokio::time::timeout(Duration::from_secs(1), guard.cancelled())
        .await
        .unwrap();
    assert!(guard.cancellation_requested());
    assert!(
        !shutdown.is_finished(),
        "shutdown must wait for an externally held mutation guard"
    );
    assert!(fixture.service.command_lease().is_err());
    assert!(
        fixture
            .service
            .mutation_guard(fixture.root(), &fixture.requested())
            .await
            .is_err()
    );
    assert!(
        fixture
            .service
            .start(
                fixture.root().to_owned(),
                fixture.requested(),
                Action::CreateBranch {
                    name: "feature/late".into(),
                    start_point: None,
                    switch: false
                },
                expected
            )
            .await
            .is_err()
    );
    drop(guard);
    shutdown.await.unwrap().unwrap();
    assert_eq!(
        fixture.service.operation(&operation.id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(git(&fixture.repo, &["branch", "--list", "feature/*"]), "");
}

#[cfg(unix)]
#[tokio::test]
async fn external_command_lease_cancels_and_reaps_owned_child_before_shutdown() {
    use std::process::Stdio;
    let service = RepositoryService::new();
    let lease = service.command_lease().unwrap();
    let mut child = tokio::process::Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    lease.mark_started();
    let actor = tokio::spawn(async move {
        lease.cancelled().await;
        assert!(lease.cancellation_requested());
        child.start_kill().unwrap();
        child.wait().await.unwrap();
        lease.mark_reaped();
        // A deliberately delayed finalization proves the service awaits the
        // lease itself, not merely delivery of the cancellation notification.
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(lease);
    });
    service.shutdown(Duration::from_secs(2)).await.unwrap();
    assert!(actor.is_finished());
    actor.await.unwrap();
}

#[tokio::test]
async fn shutdown_reports_unconfirmed_child_cleanup_and_guard_deadlines() {
    let service = RepositoryService::new();
    let lease = service.command_lease().unwrap();
    lease.mark_started();
    drop(lease);
    assert!(service.shutdown(Duration::from_secs(1)).await.is_err());
    let fixture = Fixture::new();
    let guard = fixture
        .service
        .mutation_guard(fixture.root(), &fixture.requested())
        .await
        .unwrap();
    assert!(
        fixture
            .service
            .shutdown(Duration::from_millis(30))
            .await
            .is_err()
    );
    drop(guard);
    fixture
        .service
        .shutdown(Duration::from_secs(1))
        .await
        .unwrap();
}

#[cfg(unix)]
async fn wait_for_marker(marker: &Path) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_reaps_running_mutation_and_preserves_unknown_outcome() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let oid = fixture.commit("base", "base");
    git(&fixture.repo, &["branch", "feature/shutdown"]);
    let hook = fixture.repo.join(".git/hooks/post-checkout");
    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf ready > \"$PWD/shutdown-ready\"\nexec sleep 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let operation = fixture
        .start(Action::SwitchBranch {
            name: "feature/shutdown".into(),
            expected_oid: oid,
        })
        .await;
    wait_for_marker(&fixture.repo.join("shutdown-ready")).await;
    fixture
        .service
        .shutdown(Duration::from_secs(2))
        .await
        .unwrap();
    let final_state = fixture.service.operation(&operation.id).unwrap();
    assert_eq!(final_state.state, OperationState::UnknownOutcome);
    assert!(final_state.cancellation_requested);
    assert_eq!(
        git(&fixture.repo, &["branch", "--show-current"]),
        "feature/shutdown"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_and_cancelled_http_reads_reap_read_only_git_children() {
    use std::os::unix::fs::PermissionsExt;
    for abort_reader in [false, true] {
        let fixture = Fixture::new();
        fixture.commit("base", "base");
        let hook = fixture.repo.join(".git/hooks/test-fsmonitor");
        std::fs::write(
            &hook,
            "#!/bin/sh\nprintf ready > \"$PWD/read-ready\"\nexec sleep 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        git(
            &fixture.repo,
            &["config", "core.fsmonitor", ".git/hooks/test-fsmonitor"],
        );
        let service = fixture.service.clone();
        let root = fixture.root().to_owned();
        let requested = fixture.requested();
        let reader = tokio::spawn(async move { service.worktrees(&root, &requested).await });
        wait_for_marker(&fixture.repo.join("read-ready")).await;
        if abort_reader {
            reader.abort();
        }
        fixture
            .service
            .shutdown(Duration::from_secs(2))
            .await
            .unwrap();
        if abort_reader {
            assert!(reader.await.unwrap_err().is_cancelled());
        } else {
            assert!(reader.await.unwrap().is_err());
        }
    }
}
