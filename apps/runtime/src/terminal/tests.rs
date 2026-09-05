use std::time::Duration;

use tempfile::TempDir;

use super::*;
use crate::{db, events::EventHub};

/// A manager whose data directory is a temporary one, so a tmux run never
/// touches the developer's own socket or configuration.
async fn manager_with(backend: &str) -> (TerminalManager, TempDir, String, EventHub) {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("runtime.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let events = EventHub::new();
    let settings = SettingsStore::in_memory(serde_json::json!({
        "terminal": { "backend": backend }
    }));
    let manager = TerminalManager::with_config(
        pool,
        events.clone(),
        settings,
        directory.path().to_path_buf(),
    );
    (manager, directory, workspace.id, events)
}

async fn manager() -> (TerminalManager, TempDir, String, EventHub) {
    manager_with("direct").await
}

/// Polls until the stored status matches. A fixed sleep would be a bet on how
/// busy the machine is when the suite runs in parallel.
async fn wait_for_status(manager: &TerminalManager, session_id: &str, expected: &str) -> String {
    for _ in 0..100 {
        let status = manager.session(session_id).await.unwrap().status;
        if status == expected {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    manager.session(session_id).await.unwrap().status
}

/// Everything the socket would have shown: the snapshot the attach carried,
/// then the live stream, until `needle` appears.
async fn wait_for(attach: &mut AttachSession, needle: &str, seconds: u64) -> String {
    let mut decoder = Utf8Decoder::default();
    let start = attach.snapshot.clone().unwrap_or_default();
    if start.contains(needle) {
        return start;
    }
    tokio::time::timeout(Duration::from_secs(seconds), async {
        let mut seen = start;
        loop {
            match attach.output.recv().await {
                Ok(chunk) => {
                    seen.push_str(&decoder.push(&chunk));
                    if seen.contains(needle) {
                        return seen;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return seen,
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}"))
}

/* ------------------------------ direct backend ---------------------------- */

#[tokio::test]
async fn streams_real_pty_output_without_reader_thread_panic() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "printf canvas-ready; sleep 0.2".into()],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    assert_eq!(session.backend, "direct");
    assert_eq!(session.generation, 1);
    assert_eq!(session.session_key, session.id);
    assert_eq!(session.attach_state, "detached");

    let mut attach = manager.attach(&session.id, 80, 24).await.unwrap();
    let received = wait_for(&mut attach, "canvas-ready", 2).await;
    assert!(received.contains("canvas-ready"), "got {received:?}");
}

#[tokio::test]
async fn command_starts_in_the_requested_project_directory() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: project.to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/pwd".into()),
            args: vec![],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    let mut attach = manager.attach(&session.id, 80, 24).await.unwrap();
    let expected = project.to_string_lossy().into_owned();
    let received = wait_for(&mut attach, &expected, 2).await;
    assert!(received.contains(&expected));
    assert_eq!(session.cwd, project.to_string_lossy());
}

#[tokio::test]
async fn termination_is_not_overwritten_by_exit_watcher() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 5".into()],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    manager
        .terminate(&session.id, TerminateMode::Process)
        .await
        .unwrap();
    // The exit watcher fires right after the kill; `terminated` must survive it.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let stored = manager.session(&session.id).await.unwrap();
    assert_eq!(stored.status, "terminated");
    assert_eq!(stored.attach_state, "exited");
    assert!(stored.pid.is_none());
}

/// Ending a process must end what it started. The shell is only ever the root
/// of the tree; the agent CLI the user actually cares about is a child of it.
#[tokio::test]
async fn ending_a_process_ends_its_whole_tree() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            // `&  wait` rather than a bare `sleep`: a shell `exec`s a single
            // command and there would be no tree to speak of.
            args: vec!["-c".into(), "sleep 300 & wait".into()],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    let root = session.pid.expect("the direct backend knows its pid");

    let mut grandchild = None;
    for _ in 0..40 {
        let tree = crate::terminal::backend::process_tree(root);
        if let Some(pid) = tree.iter().find(|pid| **pid != root) {
            grandchild = Some(*pid);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let grandchild = grandchild.expect("the shell should have spawned a sleep");

    manager
        .terminate(&session.id, TerminateMode::Process)
        .await
        .unwrap();
    for _ in 0..40 {
        if !crate::terminal::backend::process_table().contains_key(&grandchild) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("pid {grandchild} outlived the terminate that was supposed to kill its tree");
}

#[tokio::test]
async fn completed_sessions_replay_their_final_status() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "exit 7".into()],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    assert_eq!(
        wait_for_status(&manager, &session.id, "exited").await,
        "exited"
    );

    let attach = manager.attach(&session.id, 80, 24).await.unwrap();
    assert!(!attach.alive);
    let status = attach
        .current_status
        .expect("a finished session reports why");
    assert_eq!(status.status, "exited");
    assert_eq!(status.exit_code, Some(7));
    let stored = manager.session(&session.id).await.unwrap();
    assert_eq!(stored.status, "exited");
    assert_eq!(stored.exit_code, Some(7));
}

#[tokio::test]
async fn agent_terminals_carry_the_hook_environment_and_announce_their_exit() {
    let (manager, directory, workspace_id, events) = manager().await;
    let mut workspace_events = events.subscribe(&workspace_id);
    let node_id = Uuid::now_v7().to_string();
    let session = manager
        .spawn(SpawnRequest {
            workspace_id: workspace_id.clone(),
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            args: vec![
                "-c".into(),
                "printf %s \"$ARMADRA_NODE_ID/$ARMADRA_AGENT_ID/$ARMADRA_CANVAS_CONTROL/$ARMADRA_SESSION_ID/$ARMADRA_SESSION_GENERATION\"; exit 3"
                    .into(),
            ],
            kind: "terminal".into(),
            owner_node_id: Some(node_id.clone()),
            agent_id: Some("claude".into()),
            env: agent_environment(&node_id, "claude"),
        })
        .await
        .unwrap();
    // The node is the logical key, so the session survives a node rebuild.
    assert_eq!(session.session_key, node_id);

    let mut attach = manager.attach(&session.id, 80, 24).await.unwrap();
    let expected = format!("{node_id}/claude/1/{}/1", session.id);
    let received = wait_for(&mut attach, &expected, 2).await;
    assert!(received.contains(&expected), "got {received:?}");

    let exit = tokio::time::timeout(Duration::from_secs(3), workspace_events.recv())
        .await
        .expect("terminal.exit timed out")
        .unwrap();
    match exit {
        WorkspaceEvent::TerminalExit {
            session_id,
            node_id: owner,
            exit_code,
        } => {
            assert_eq!(session_id, session.id);
            assert_eq!(owner.as_deref(), Some(node_id.as_str()));
            assert_eq!(exit_code, Some(3));
        }
        other => panic!("unexpected event {other:?}"),
    }
}

#[tokio::test]
async fn the_direct_backend_snapshots_and_captures_its_replay_buffer() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            args: vec![
                "-c".into(),
                "printf '\\033[32mcolour-me\\033[0m\\n'; sleep 2".into(),
            ],
            kind: "terminal".into(),
            owner_node_id: None,
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    let mut attach = manager.attach(&session.id, 80, 24).await.unwrap();
    wait_for(&mut attach, "colour-me", 2).await;

    let plain = manager.capture(&session.id, 50, false).await.unwrap();
    assert!(plain.data.contains("colour-me"));
    assert!(!plain.data.contains('\u{1b}'), "escapes leaked: {plain:?}");
    assert_eq!(plain.generation, 1);

    let raw = manager.capture(&session.id, 50, true).await.unwrap();
    assert!(raw.data.contains('\u{1b}'));

    // A second socket attaches to the same session and gets the replay.
    let second = manager.attach(&session.id, 80, 24).await.unwrap();
    assert!(second.snapshot.unwrap().contains("colour-me"));
}

#[tokio::test]
async fn bracketed_paste_reaches_the_shell_without_running_by_itself() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest::plain(
            workspace_id,
            directory.path().to_string_lossy().into_owned(),
        ))
        .await
        .unwrap();
    let mut attach = manager.attach(&session.id, 80, 24).await.unwrap();
    manager
        .paste(&session.id, "echo pasted-line", true)
        .await
        .unwrap();
    let received = wait_for(&mut attach, "pasted-line", 3).await;
    assert!(received.contains("pasted-line"), "got {received:?}");
}

#[tokio::test]
async fn a_write_from_an_old_generation_is_rejected() {
    let (manager, directory, workspace_id, _events) = manager().await;
    let session = manager
        .spawn(SpawnRequest::plain(
            workspace_id,
            directory.path().to_string_lossy().into_owned(),
        ))
        .await
        .unwrap();
    assert!(manager.write(&session.id, 1, "echo one\n").await.is_ok());

    let recycled = manager.recycle(&session.id).await.unwrap();
    assert_eq!(recycled.generation, 2);
    assert_eq!(recycled.session_key, session.session_key);
    assert_eq!(recycled.id, session.id);
    assert_eq!(manager.generation(&session.id).await, Some(2));

    let stale = manager.write(&session.id, 1, "echo two\n").await;
    assert!(
        matches!(stale, Err(AppError::Conflict(_))),
        "a stale write must not reach the terminal: {stale:?}"
    );
    assert!(matches!(
        manager.resize(&session.id, 1, 100, 40).await,
        Err(AppError::Conflict(_))
    ));
    assert!(manager.write(&session.id, 2, "echo two\n").await.is_ok());
}

#[tokio::test]
async fn the_backend_report_matches_the_configured_choice() {
    let (manager, _directory, _workspace_id, _events) = manager().await;
    let info = manager.backend_info();
    assert_eq!(info.effective, BackendKind::Direct);
    assert_eq!(info.configured, "direct");
    assert!(info.tmux_socket.is_none());
    assert!(info.reason.is_some());
}

#[test]
fn output_split_across_chunks_never_becomes_a_replacement_character() {
    let mut decoder = Utf8Decoder::default();
    let text = "终端";
    let bytes = text.as_bytes();
    let mut assembled = String::new();
    for chunk in bytes.chunks(2) {
        assembled.push_str(&decoder.push(chunk));
    }
    assert_eq!(assembled, text);
    // An invalid byte is replaced rather than stalling the stream.
    let mut decoder = Utf8Decoder::default();
    assert_eq!(decoder.push(&[0xff, b'a']), "\u{fffd}");
    assert_eq!(decoder.push(b"b"), "ab");
}

/* ------------------------------- tmux backend ----------------------------- */

/// tmux is optional on a developer machine and absent on plenty of CI images.
/// These tests skip themselves rather than fail there.
fn tmux_available() -> bool {
    tmux::detect().usable
}

#[tokio::test]
async fn tmux_sessions_run_capture_paste_and_destroy() {
    if !tmux_available() {
        eprintln!("skipping: tmux >= 3.2 is not on PATH");
        return;
    }
    let (manager, directory, workspace_id, _events) = manager_with("tmux").await;
    let info = manager.backend_info();
    assert_eq!(info.effective, BackendKind::Tmux);
    assert!(
        info.tmux_socket
            .unwrap()
            .starts_with(directory.path().to_string_lossy().trim_end_matches('/'))
    );

    let node_id = Uuid::now_v7().to_string();
    let session = manager
        .spawn(SpawnRequest {
            workspace_id: workspace_id.clone(),
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: Some("/bin/sh".into()),
            command: None,
            args: vec![],
            kind: "terminal".into(),
            owner_node_id: Some(node_id.clone()),
            agent_id: Some("claude".into()),
            env: agent_environment(&node_id, "claude"),
        })
        .await
        .unwrap();
    assert_eq!(session.backend, "tmux");
    assert_eq!(session.generation, 1);
    assert!(session.pid.is_some(), "the pane pid should be known");

    let mut attach = manager.attach(&session.id, 100, 30).await.unwrap();
    assert!(
        attach.snapshot.is_none(),
        "the tmux client redraws; the runtime must not also replay"
    );
    manager
        .write(
            &session.id,
            session.generation as u64,
            "echo hi-$ARMADRA_AGENT_ID\r",
        )
        .await
        .unwrap();
    let seen = wait_for(&mut attach, "hi-claude", 6).await;
    assert!(seen.contains("hi-claude"), "got {seen:?}");

    let captured = manager.capture(&session.id, 50, false).await.unwrap();
    assert!(
        captured.data.contains("hi-claude"),
        "capture-pane missed it: {:?}",
        captured.data
    );
    assert!(!captured.data.contains('\u{1b}'));
    assert!(captured.lines > 0);

    manager
        .paste(&session.id, "echo pasted-here", true)
        .await
        .unwrap();
    let seen = wait_for(&mut attach, "pasted-here", 6).await;
    assert!(seen.contains("pasted-here"), "got {seen:?}");

    let foreground = manager.foreground(&session.id).await.unwrap();
    assert!(foreground.pid.is_some());

    manager
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
    assert_eq!(
        wait_for_status(&manager, &session.id, "terminated").await,
        "terminated"
    );
}

/// Plan §18.5: the wheel bridge scrolls the pane's history, and typing
/// afterwards must land in the shell rather than being eaten by copy-mode.
#[tokio::test]
async fn scrolling_enters_copy_mode_and_typing_leaves_it() {
    if !tmux_available() {
        eprintln!("skipping: tmux >= 3.2 is not on PATH");
        return;
    }
    let (manager, directory, workspace_id, _events) = manager_with("tmux").await;
    let node_id = Uuid::now_v7().to_string();
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: Some("/bin/sh".into()),
            command: None,
            args: vec![],
            kind: "terminal".into(),
            owner_node_id: Some(node_id.clone()),
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    let mut attach = manager.attach(&session.id, 80, 10).await.unwrap();

    // Fill the history so there is something above the visible screen.
    manager
        .write(
            &session.id,
            session.generation as u64,
            "for i in 1 2 3 4 5 6 7 8 9 0; do echo history-line-$i; done\r",
        )
        .await
        .unwrap();
    let seen = wait_for(&mut attach, "history-line-0", 6).await;
    assert!(seen.contains("history-line-0"), "got {seen:?}");

    // Scrolling down with nothing below is a no-op, not an error.
    manager.scroll(&session.id, -3).await.unwrap();

    manager.scroll(&session.id, 5).await.unwrap();
    let scrolled = manager.capture(&session.id, 0, false).await.unwrap();
    assert!(
        scrolled.data.contains("history-line-1"),
        "the pane should be scrolled back into its history: {:?}",
        scrolled.data
    );

    // Typing must cancel copy-mode; if it did not, the shell would never see
    // this command and the marker would never appear.
    manager
        .write(
            &session.id,
            session.generation as u64,
            "echo after-scroll-marker\r",
        )
        .await
        .unwrap();
    let seen = wait_for(&mut attach, "after-scroll-marker", 6).await;
    assert!(
        seen.contains("after-scroll-marker"),
        "typing did not leave copy-mode: {seen:?}"
    );

    manager
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
}

/// The direct backend has no tmux history: xterm keeps its own scrollback, so
/// the bridge must simply do nothing rather than fail.
#[tokio::test]
async fn scrolling_a_direct_session_is_a_no_op() {
    let (manager, directory, workspace_id, _events) = manager_with("direct").await;
    let session = manager
        .spawn(SpawnRequest {
            workspace_id,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: Some("/bin/sh".into()),
            command: None,
            args: vec![],
            kind: "terminal".into(),
            owner_node_id: Some(Uuid::now_v7().to_string()),
            agent_id: None,
            env: vec![],
        })
        .await
        .unwrap();
    manager.scroll(&session.id, 12).await.unwrap();
    manager.scroll(&session.id, -12).await.unwrap();
    assert!(
        manager
            .scroll("00000000-0000-0000-0000-000000000000", 1)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_tmux_session_survives_the_runtime_and_is_reattached() {
    if !tmux_available() {
        eprintln!("skipping: tmux >= 3.2 is not on PATH");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("runtime.db").display()
    );
    let workspace_id;
    let session_id;
    {
        let pool = db::connect(&database_url).await.unwrap();
        let workspace = db::create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        workspace_id = workspace.id.clone();
        let manager = TerminalManager::with_config(
            pool,
            EventHub::new(),
            SettingsStore::in_memory(serde_json::json!({ "terminal": { "backend": "tmux" } })),
            directory.path().to_path_buf(),
        );
        let session = manager
            .spawn(SpawnRequest {
                workspace_id: workspace.id,
                cwd: directory.path().to_string_lossy().into_owned(),
                shell: Some("/bin/sh".into()),
                command: None,
                args: vec![],
                kind: "terminal".into(),
                owner_node_id: None,
                agent_id: None,
                env: vec![],
            })
            .await
            .unwrap();
        session_id = session.id.clone();
        let mut attach = manager.attach(&session.id, 100, 30).await.unwrap();
        manager
            .write(&session.id, 1, "echo before-restart\r")
            .await
            .unwrap();
        wait_for(&mut attach, "before-restart", 6).await;
        // A hard stop: no shutdown, no detach, the process simply goes away.
        drop(attach);
        drop(manager);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A second runtime over the same data directory and database.
    let pool = db::connect(&database_url).await.unwrap();
    let manager = TerminalManager::with_config(
        pool,
        EventHub::new(),
        SettingsStore::in_memory(serde_json::json!({ "terminal": { "backend": "tmux" } })),
        directory.path().to_path_buf(),
    );
    let report = manager.reconcile().await.unwrap();
    assert_eq!(
        report.detached, 1,
        "the session should have been re-adopted"
    );
    assert_eq!(report.orphans_destroyed, 0);

    let restored = manager.session(&session_id).await.unwrap();
    assert_eq!(restored.status, "running");
    assert_eq!(restored.attach_state, "detached");
    assert_eq!(restored.workspace_id, workspace_id);

    // Re-attaching shows the scrollback the first runtime left behind.
    let mut attach = manager.attach(&session_id, 100, 30).await.unwrap();
    let seen = wait_for(&mut attach, "before-restart", 6).await;
    assert!(seen.contains("before-restart"), "got {seen:?}");
    let captured = manager.capture(&session_id, 100, false).await.unwrap();
    assert!(captured.data.contains("before-restart"));

    drop(attach);
    manager
        .terminate(&session_id, TerminateMode::Session)
        .await
        .unwrap();
}

#[tokio::test]
async fn an_orphan_tmux_session_is_destroyed_on_reconcile() {
    if !tmux_available() {
        eprintln!("skipping: tmux >= 3.2 is not on PATH");
        return;
    }
    let (manager, directory, _workspace_id, _events) = manager_with("tmux").await;
    let (notices, _receiver) = mpsc::unbounded_channel();
    let backend = tmux::TmuxBackend::with_data_dir(directory.path(), notices).unwrap();
    // A session with no database row at all: left over from an older run.
    backend
        .create(TerminalSpec {
            session_key: SessionKey::new("orphaned-key"),
            workspace_id: "orphan-workspace".into(),
            generation: 1,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: "/bin/sh".into(),
            command: None,
            args: vec![],
            env: vec![],
            size: PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
        })
        .await
        .unwrap();
    assert_eq!(backend.list_alive().await.unwrap().len(), 1);

    let report = manager.reconcile().await.unwrap();
    assert_eq!(report.orphans_destroyed, 1);
    assert!(backend.list_alive().await.unwrap().is_empty());
}
