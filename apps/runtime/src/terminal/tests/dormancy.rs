//! T03, design §7.2: a session nothing is attached to keeps its process and
//! its replay buffer, and gives up only the delivery cadence.

use super::super::*;

async fn fixture(dormant_after: u64) -> (TerminalManager, tempfile::TempDir, String) {
    let directory = tempfile::tempdir().unwrap();
    let pool = crate::db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("dormancy.db").display()
    ))
    .await
    .unwrap();
    let workspace = crate::db::create_workspace(
        &pool,
        "dormancy project",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let settings = SettingsStore::in_memory(serde_json::json!({
        "terminal": { "backend": "direct", "dormantAfterSeconds": dormant_after }
    }));
    let manager =
        TerminalManager::with_config(pool, EventHub::new(), settings, directory.path().to_owned());
    (manager, directory, workspace.id)
}

fn request(workspace: &str, directory: &std::path::Path) -> SpawnRequest {
    let mut request =
        SpawnRequest::plain(workspace.into(), directory.to_string_lossy().into_owned());
    request.command = Some("/bin/sh".into());
    request.args = vec!["-c".into(), "sleep 60".into()];
    request
}

/// The whole promise in one test: a session goes dormant on its own, wakes
/// on attach, and is the *same process* on the other side.
#[tokio::test]
async fn an_unwatched_session_sleeps_and_wakes_without_restarting_its_process() {
    let (manager, directory, workspace) = fixture(5).await;
    let session = manager
        .spawn(request(&workspace, directory.path()))
        .await
        .unwrap();
    let pid = manager.pid(&session.id).await.expect("a running pid");

    // Freshly created and never attached: eligible, but not yet due.
    manager.apply_dormancy().await;
    assert!(!manager.is_dormant(&session.id));

    // Pretend the idle period has passed rather than sleeping through it.
    manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
    manager.apply_dormancy().await;
    assert!(manager.is_dormant(&session.id));

    let attach = manager.attach(&session.id, 80, 24).await.unwrap();
    assert!(
        !manager.is_dormant(&session.id),
        "attaching wakes the session"
    );
    assert_eq!(manager.attached_sockets(&session.id), 1);
    assert_eq!(
        manager.pid(&session.id).await,
        Some(pid),
        "waking must never be a create"
    );
    assert!(attach.alive);

    drop(attach);
    assert_eq!(manager.attached_sockets(&session.id), 0);
    // Still awake: the clock restarts from this detach, not from the last one.
    manager.apply_dormancy().await;
    assert!(!manager.is_dormant(&session.id));

    let _ = manager.terminate(&session.id, TerminateMode::Session).await;
}

/// Two sockets on one terminal: the first to leave must not put a session
/// somebody else is still watching to sleep.
#[tokio::test]
async fn one_socket_leaving_does_not_sleep_a_session_another_is_watching() {
    // Below MIN_DORMANT_AFTER_SECONDS the setting is rejected, so the
    // shortest honest deadline is what the test drives.
    let (manager, directory, workspace) = fixture(5).await;
    let session = manager
        .spawn(request(&workspace, directory.path()))
        .await
        .unwrap();
    let first = manager.attach(&session.id, 80, 24).await.unwrap();
    let second = manager.attach(&session.id, 80, 24).await.unwrap();
    assert_eq!(manager.attached_sockets(&session.id), 2);

    drop(first);
    manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
    manager.apply_dormancy().await;
    assert!(
        !manager.is_dormant(&session.id),
        "one socket is still attached"
    );

    drop(second);
    manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
    manager.apply_dormancy().await;
    assert!(manager.is_dormant(&session.id));

    let _ = manager.terminate(&session.id, TerminateMode::Session).await;
}

/// `dormantAfterSeconds: 0` is off, not "immediately".
#[tokio::test]
async fn dormancy_can_be_turned_off() {
    let (manager, directory, workspace) = fixture(0).await;
    let session = manager
        .spawn(request(&workspace, directory.path()))
        .await
        .unwrap();
    manager.backdate_idle_for_test(&session.id, Duration::from_secs(86_400));
    manager.apply_dormancy().await;
    assert!(!manager.is_dormant(&session.id));
    let _ = manager.terminate(&session.id, TerminateMode::Session).await;
}

/// A session that has already ended is not worth a backend round trip, and
/// must not linger in the attachment table.
#[tokio::test]
async fn an_exited_session_is_dropped_instead_of_slept() {
    // Below MIN_DORMANT_AFTER_SECONDS the setting is rejected, so the
    // shortest honest deadline is what the test drives.
    let (manager, directory, workspace) = fixture(5).await;
    let mut done = request(&workspace, directory.path());
    done.args = vec!["-c".into(), "exit 0".into()];
    let session = manager.spawn(done).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while manager.session(&session.id).await.unwrap().status == "running" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    manager.backdate_idle_for_test(&session.id, Duration::from_secs(30));
    manager.apply_dormancy().await;
    assert!(!manager.is_dormant(&session.id));
    assert_eq!(manager.attached_sockets(&session.id), 0);
}
