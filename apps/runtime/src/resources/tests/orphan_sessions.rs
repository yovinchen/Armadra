//! Sessions whose node was deleted: listing them, adopting them back, and
//! terminating one without touching the others.

use super::*;

/// A session whose node was deleted is listed as an orphan, can be given the
/// same node identity back, and disappears from the list once it has one.
#[tokio::test(flavor = "multi_thread")]
async fn an_orphaned_session_can_be_adopted_and_then_stops_being_one() {
    let fixture = fixture().await;
    let node_id = uuid::Uuid::now_v7().to_string();
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            owner_node_id: Some(node_id.clone()),
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();

    // No `nodes` row exists for that id: the board was never saved with it,
    // which is exactly the state a deleted node leaves behind.
    let listed = orphans::list(fixture.pool(), fixture.terminals(), &fixture.workspace_id)
        .await
        .unwrap();
    let orphan = listed
        .iter()
        .find(|orphan| orphan.session_id.as_deref() == Some(session.id.as_str()))
        .expect("a session with no node is an orphan");
    assert_eq!(orphan.reason, orphans::OrphanReason::NoNode);
    assert!(orphan.adoptable);
    assert_eq!(orphan.id, format!("session:{}", session.id));

    let adopted = orphans::adopt(fixture.pool(), &fixture.workspace_id, &session.id)
        .await
        .unwrap();
    // The node id handed back is the session's own key, so the restored node
    // owns exactly the session it used to.
    assert_eq!(adopted.node_id, node_id);
    assert_eq!(adopted.workspace_id, fixture.workspace_id);

    // Saving the board is what creates the row; simulate that much.
    insert_node(fixture.pool(), &fixture.workspace_id, &node_id).await;
    let listed = orphans::list(fixture.pool(), fixture.terminals(), &fixture.workspace_id)
        .await
        .unwrap();
    assert!(
        !listed
            .iter()
            .any(|orphan| orphan.session_id.as_deref() == Some(session.id.as_str())),
        "a session with a node is not an orphan"
    );

    let _ = fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await;
}

/// Terminating an orphan ends that session and nothing else.
#[tokio::test(flavor = "multi_thread")]
async fn terminating_an_orphan_ends_only_that_session() {
    let fixture = fixture().await;
    let keep = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    let doomed = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();

    orphans::terminate(
        fixture.pool(),
        fixture.terminals(),
        &fixture.workspace_id,
        &format!("session:{}", doomed.id),
    )
    .await
    .unwrap();

    assert!(!fixture.terminals().is_alive(&doomed.id).await);
    assert!(fixture.terminals().is_alive(&keep.id).await);

    // A malformed handle is refused rather than interpreted.
    assert!(
        orphans::terminate(
            fixture.pool(),
            fixture.terminals(),
            &fixture.workspace_id,
            "12345"
        )
        .await
        .is_err()
    );

    let _ = fixture
        .terminals()
        .terminate(&keep.id, TerminateMode::Session)
        .await;
}

async fn insert_node(pool: &sqlx::SqlitePool, workspace_id: &str, node_id: &str) {
    let board_id: String = sqlx::query_scalar("SELECT id FROM boards WHERE workspace_id = ?")
        .bind(workspace_id)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO nodes (id, board_id, type, title, x, y, labels_json, note, data_json, \
         created_at, updated_at) VALUES (?, ?, 'terminal', 'Terminal', 0, 0, '[]', '', \
         '{\"kind\":\"terminal\"}', ?, ?)",
    )
    .bind(node_id)
    .bind(&board_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}
