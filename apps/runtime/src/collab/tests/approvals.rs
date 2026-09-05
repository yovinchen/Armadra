//! Permission answers: the file a waiting client polls, and the sweep.

use super::support::*;

/* -------------------------------- approvals ------------------------------- */

#[tokio::test]
async fn answering_writes_the_file_the_waiting_client_polls() {
    let fixture = fixture("collab-approve").await;
    let pending_dir = approvals::pending_dir(&fixture.state);
    std::fs::create_dir_all(&pending_dir).unwrap();
    let pending_id = format!("{}-1730000000000-4242", fixture.caller_id);
    std::fs::write(
        pending_dir.join(format!("{pending_id}.json")),
        r#"{"tool":"Bash"}"#,
    )
    .unwrap();
    db::insert_approval(
        &fixture.state.pool,
        &pending_id,
        &fixture.caller_id,
        &fixture.workspace_id,
        &json!({ "tool": "Bash" }),
    )
    .await
    .unwrap();

    let mut events = fixture.state.events.subscribe(&fixture.workspace_id);
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/approvals/{pending_id}/answer"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"decision":"allow"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["route"], "file");
    assert_eq!(body["answer"], "allow");

    let answer = pending_dir.join(format!("{pending_id}.answer"));
    assert_eq!(std::fs::read_to_string(&answer).unwrap(), "allow");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&answer).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // No temporary file is left behind.
    assert!(
        !pending_dir
            .join(format!(".{pending_id}.answer.tmp"))
            .exists()
    );

    let event = events.recv().await.unwrap();
    match event {
        crate::events::WorkspaceEvent::AgentApproval { request, .. } => {
            assert_eq!(request["resolved"], true);
            assert_eq!(request["decision"], "allow");
            assert_eq!(request["route"], "file");
        }
        other => panic!("unexpected event {other:?}"),
    }

    // The first answer is the one the CLI acted on; a second is a conflict.
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/approvals/{pending_id}/answer"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"decision":"deny"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn an_answer_with_nobody_waiting_falls_back_to_the_terminal() {
    let fixture = fixture("collab-approve-keys").await;
    let pending_id = format!("{}-1730000000001-99", fixture.caller_id);
    db::insert_approval(
        &fixture.state.pool,
        &pending_id,
        &fixture.caller_id,
        &fixture.workspace_id,
        &json!({ "tool": "Bash" }),
    )
    .await
    .unwrap();

    // No pending file and no live PTY: the answer is still recorded, and the
    // reply says plainly that nothing could be delivered.
    let (approval, route) = approvals::answer(&fixture.state, &pending_id, "deny")
        .await
        .unwrap();
    assert_eq!(approval.answer.as_deref(), Some("deny"));
    assert_eq!(route, "none");
    assert_eq!(approvals::answer_keys("claude", "allow"), "1\r");
    assert_eq!(approvals::answer_keys("claude", "deny"), "3\r");
    assert_eq!(approvals::answer_keys("codex", "allow"), "y\r");
    assert_eq!(approvals::answer_keys("gemini", "deny"), "n\r");
}

#[test]
fn a_pending_id_can_never_escape_the_pending_directory() {
    assert!(approvals::valid_pending_id("node-1730000000000-42"));
    assert!(!approvals::valid_pending_id("../../etc/passwd"));
    assert!(!approvals::valid_pending_id("a/b"));
    assert!(!approvals::valid_pending_id(""));
    assert!(!approvals::valid_pending_id(&"x".repeat(201)));

    let directory = tempfile::tempdir().unwrap();
    assert!(matches!(
        approvals::write_answer_file(directory.path(), "../escape", "allow"),
        Err(crate::error::AppError::BadRequest(_))
    ));
    // A well-formed id with no request file writes nothing.
    assert!(!approvals::write_answer_file(directory.path(), "node-1-2", "allow").unwrap());
    assert!(!directory.path().join("node-1-2.answer").exists());
}

#[test]
fn the_orphan_sweep_clears_only_what_went_stale() {
    let directory = tempfile::tempdir().unwrap();
    let fresh = directory.path().join("fresh-1-2.json");
    let stale = directory.path().join("stale-1-2.json");
    let foreign = directory.path().join("notes.txt");
    for path in [&fresh, &stale, &foreign] {
        std::fs::write(path, "{}").unwrap();
    }
    // Nothing is old enough yet.
    assert_eq!(
        approvals::sweep_orphans(directory.path(), std::time::Duration::from_secs(600)),
        0
    );
    // With a zero window everything of ours goes, and nothing else does.
    assert_eq!(
        approvals::sweep_orphans(directory.path(), std::time::Duration::ZERO),
        2
    );
    assert!(!fresh.exists());
    assert!(!stale.exists());
    assert!(foreign.exists());
}
