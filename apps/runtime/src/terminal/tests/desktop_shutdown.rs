use super::super::*;

async fn fixture(backend: &str) -> (TerminalManager, tempfile::TempDir, String) {
    let directory = tempfile::tempdir().unwrap();
    let pool = crate::db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("quit.db").display()
    ))
    .await
    .unwrap();
    let workspace = crate::db::create_workspace(
        &pool,
        "keep project",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let board: String = sqlx::query_scalar("SELECT id FROM boards WHERE workspace_id = ?")
        .bind(&workspace.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO nodes(id, board_id, type, x, y, data_json, created_at, updated_at) VALUES ('keep-node', ?, 'sticky', 0, 0, '{}', 'now', 'now')").bind(board).execute(&pool).await.unwrap();
    let settings = SettingsStore::in_memory(serde_json::json!({"terminal":{"backend":backend}}));
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

#[tokio::test]
async fn desktop_shutdown_direct_process_exit_and_creation_gate() {
    let (manager, directory, workspace) = fixture("direct").await;
    let mut histories = Vec::new();
    for failed in [false, true] {
        let mut done = request(&workspace, directory.path());
        done.args = vec!["-c".into(), "exit 0".into()];
        let finished = manager.spawn(done).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager.session(&finished.id).await.unwrap().status == "running" {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        if failed {
            sqlx::query("UPDATE terminal_sessions SET status = 'failed' WHERE id = ?")
                .bind(&finished.id)
                .execute(&manager.inner.pool)
                .await
                .unwrap();
        }
        let saved = manager.session(&finished.id).await.unwrap();
        histories.push((saved.id, saved.status, saved.ended_at, saved.exit_code));
    }
    let session = manager
        .spawn(request(&workspace, directory.path()))
        .await
        .unwrap();
    let gate = manager.inner.creation_gate.read().await;
    let worker = manager.clone();
    let shutdown = tokio::spawn(async move { worker.shutdown_owned_sessions().await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !manager.is_shutting_down() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let worker = manager.clone();
    let next = request(&workspace, directory.path());
    let mut racing = tokio::spawn(async move { worker.spawn(next).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut racing)
            .await
            .is_err()
    );
    drop(gate);
    tokio::time::timeout(Duration::from_secs(7), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(racing.await.unwrap(), Err(AppError::Conflict(_))));
    assert!(matches!(
        manager.recycle(&session.id).await,
        Err(AppError::Conflict(_))
    ));
    assert!(matches!(
        manager.attach(&session.id, 80, 24).await,
        Err(AppError::Conflict(_))
    ));
    // Simulate an old connection's delayed detach after explicit shutdown.
    manager.set_attach_state(&session.id, "detached").await;
    assert_eq!(
        manager.session(&session.id).await.unwrap().attach_state,
        "exited"
    );
    assert!(!manager.is_alive(&session.id).await);
    assert_eq!(
        manager.session(&session.id).await.unwrap().status,
        "terminated"
    );
    let node: i64 = sqlx::query_scalar("SELECT count(*) FROM nodes WHERE id = 'keep-node'")
        .fetch_one(&manager.inner.pool)
        .await
        .unwrap();
    assert_eq!(node, 1);
    assert!(
        crate::db::get_workspace(&manager.inner.pool, &workspace)
            .await
            .is_ok()
    );
    for (id, status, ended_at, exit_code) in histories {
        let saved = manager.session(&id).await.unwrap();
        assert_eq!(
            (saved.status, saved.ended_at, saved.exit_code),
            (status, ended_at, exit_code),
            "Quit must not rewrite completed session history"
        );
    }
}

#[tokio::test]
async fn desktop_shutdown_still_stops_owned_children_when_metadata_is_unavailable() {
    let (manager, directory, workspace) = fixture("direct").await;
    let session = manager
        .spawn(request(&workspace, directory.path()))
        .await
        .unwrap();
    let pid = manager.pid(&session.id).await.unwrap();
    manager.inner.pool.close().await;
    let result = tokio::time::timeout(Duration::from_secs(7), manager.shutdown_owned_sessions())
        .await
        .unwrap();
    assert!(
        result.is_err(),
        "failed metadata must not be reported as complete shutdown"
    );
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[tokio::test]
async fn desktop_shutdown_tmux_preserves_on_restart_then_quit_removes_owned_session() {
    if !tmux::detect().usable {
        eprintln!("tmux unavailable; real tmux shutdown test skipped");
        return;
    }
    let (manager, directory, workspace) = fixture("tmux").await;
    let session = manager
        .spawn(request(&workspace, directory.path()))
        .await
        .unwrap();
    assert_eq!(session.backend, "tmux");
    let backend = manager.inner.tmux.as_ref().unwrap();
    let before = backend.list_alive().await.unwrap();
    assert_eq!(before.len(), 1);
    manager.shutdown_all().await;
    assert_eq!(
        backend.list_alive().await.unwrap().len(),
        1,
        "ordinary Runtime restart preserves tmux"
    );
    tokio::time::timeout(Duration::from_secs(7), manager.shutdown_owned_sessions())
        .await
        .unwrap()
        .unwrap();
    assert!(backend.list_alive().await.unwrap().is_empty());
    assert_eq!(
        manager.session(&session.id).await.unwrap().status,
        "terminated"
    );
    assert!(
        crate::db::get_workspace(&manager.inner.pool, &workspace)
            .await
            .is_ok()
    );
}
