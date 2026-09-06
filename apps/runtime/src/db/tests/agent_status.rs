//! Agent status, approvals, context links and deliveries, plus the column
//! defaults they decode from.

use super::support::*;
use crate::db::*;
use crate::model::*;
use uuid::Uuid;

#[tokio::test]
async fn agent_status_approvals_links_and_deliveries_round_trip() {
    let (pool, _directory, workspace) = fixture("agent-tables").await;
    let node_id = Uuid::now_v7().to_string();

    let status = upsert_agent_status(
        &pool,
        AgentStatusPatch {
            node_id: node_id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("working".into()),
            state_source: None,
            unread: false,
            session_id: Some("s-1".into()),
            pending_id: None,
            verified: true,
            transcript_path: None,
            session_phase: None,
            errored: None,
            interrupted: None,
            last_event_at: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(status.state.as_deref(), Some("working"));
    assert!(status.verified);
    assert!(!status.restored);

    let blocked = upsert_agent_status(
        &pool,
        AgentStatusPatch {
            node_id: node_id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("blocked".into()),
            state_source: None,
            unread: true,
            session_id: Some("s-1".into()),
            pending_id: Some("p-1".into()),
            verified: true,
            transcript_path: None,
            session_phase: None,
            errored: None,
            interrupted: None,
            last_event_at: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(blocked.pending_id.as_deref(), Some("p-1"));
    assert!(blocked.unread);
    assert_eq!(
        list_agent_status(&pool, &workspace.id).await.unwrap().len(),
        1
    );
    assert!(matches!(
        upsert_agent_status(
            &pool,
            AgentStatusPatch {
                node_id: node_id.clone(),
                workspace_id: workspace.id.clone(),
                agent_id: "claude".into(),
                state: Some("thinking".into()),
                state_source: None,
                unread: false,
                session_id: None,
                pending_id: None,
                verified: false,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: None,
            },
        )
        .await,
        Err(AppError::BadRequest(_))
    ));

    // 0013: the source travels with the row, and the vocabulary is closed for
    // the same reason the states are — an unrecognised value would read as "not
    // a report" to every gate and as a label to the header.
    assert!(blocked.state_source.is_none());
    let reported = upsert_agent_status(
        &pool,
        AgentStatusPatch {
            node_id: node_id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("done".into()),
            state_source: Some("hook".into()),
            unread: true,
            session_id: Some("s-1".into()),
            pending_id: None,
            verified: true,
            transcript_path: None,
            session_phase: None,
            errored: Some(false),
            interrupted: Some(false),
            last_event_at: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(reported.state_source.as_deref(), Some("hook"));
    assert!(matches!(
        upsert_agent_status(
            &pool,
            AgentStatusPatch {
                node_id: node_id.clone(),
                workspace_id: workspace.id.clone(),
                agent_id: "claude".into(),
                state: Some("done".into()),
                state_source: Some("telepathy".into()),
                unread: false,
                session_id: None,
                pending_id: None,
                verified: false,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: None,
            },
        )
        .await,
        Err(AppError::BadRequest(_))
    ));

    // The observation door (§3.4): it annotates the source and leaves the state
    // alone, which is what stops a quiet terminal from being read as a finished
    // turn. It reports whether anything changed, and never invents a row.
    assert!(
        set_agent_state_source(&pool, &node_id, "observed")
            .await
            .unwrap()
    );
    let observed = get_agent_status(&pool, &node_id).await.unwrap().unwrap();
    assert_eq!(observed.state_source.as_deref(), Some("observed"));
    assert_eq!(
        observed.state.as_deref(),
        Some("done"),
        "an observation must not rewrite the reduced state"
    );
    assert!(
        !set_agent_state_source(&pool, &node_id, "observed")
            .await
            .unwrap(),
        "saying the same thing twice is not a change to broadcast"
    );
    assert!(
        !set_agent_state_source(&pool, &Uuid::now_v7().to_string(), "observed")
            .await
            .unwrap(),
        "a node nothing has reported for has no row to annotate"
    );
    assert!(matches!(
        set_agent_state_source(&pool, &node_id, "telepathy").await,
        Err(AppError::BadRequest(_))
    ));
    // Back to a real report, so the rest of this test sees the row it expects.
    assert!(
        set_agent_state_source(&pool, &node_id, "hook")
            .await
            .unwrap()
    );

    assert_eq!(mark_agent_status_restored(&pool).await.unwrap(), 1);
    assert!(
        get_agent_status(&pool, &node_id)
            .await
            .unwrap()
            .unwrap()
            .restored
    );

    let approval = insert_approval(
        &pool,
        "p-1",
        &node_id,
        &workspace.id,
        &serde_json::json!({ "tool": "Bash", "command": "rm -rf /" }),
    )
    .await
    .unwrap();
    assert_eq!(approval.request["tool"], "Bash");
    assert!(approval.answer.is_none());
    let answered = answer_approval(&pool, "p-1", "deny", Some("user"))
        .await
        .unwrap();
    assert_eq!(answered.answer.as_deref(), Some("deny"));
    assert!(answered.answered_at.is_some());
    assert!(matches!(
        answer_approval(&pool, "p-1", "allow", None).await,
        Err(AppError::Conflict(_))
    ));
    assert!(matches!(
        answer_approval(&pool, "p-1", "maybe", None).await,
        Err(AppError::BadRequest(_))
    ));

    let target = Uuid::now_v7().to_string();
    let links = vec![ContextLink {
        id: target.clone(),
        title: "Codex".into(),
        kind: "terminal".into(),
        content: None,
    }];
    let document = put_context_links(&pool, &workspace.id, &node_id, &links)
        .await
        .unwrap();
    assert_eq!(document.links.len(), 1);
    assert_eq!(document.links[0].title, "Codex");
    assert_eq!(
        get_context_links(&pool, &node_id).await.unwrap().links[0].id,
        target
    );
    assert!(
        get_context_links(&pool, "unlinked-node")
            .await
            .unwrap()
            .links
            .is_empty()
    );
    assert!(matches!(
        put_context_links(
            &pool,
            &workspace.id,
            &node_id,
            &[ContextLink {
                id: "not-a-uuid".into(),
                title: "x".into(),
                kind: "terminal".into(),
                content: None,
            }],
        )
        .await,
        Err(AppError::BadRequest(_))
    ));

    insert_delivery(
        &pool,
        DeliveryRecord {
            trace_id: "t-1",
            workspace_id: &workspace.id,
            source_node_id: &node_id,
            target_node_id: &target,
            outcome: "delivered",
            receipt: Some("newTurn"),
            body_chars: 42,
        },
    )
    .await
    .unwrap();
    let deliveries = list_deliveries(&pool, &workspace.id, 10).await.unwrap();
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].outcome, "delivered");
    assert_eq!(deliveries[0].body_chars, 42);

    upsert_hook_install(&pool, "claude", 1, Some("/home/u/.claude/settings.json"))
        .await
        .unwrap();
    upsert_hook_install(&pool, "claude", 2, None).await.unwrap();
    let installs = list_hook_installs(&pool).await.unwrap();
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].client_revision, 2);
    remove_hook_install(&pool, "claude").await.unwrap();
    assert!(list_hook_installs(&pool).await.unwrap().is_empty());
}

/* ------------------------ kanban / labels / note ---------------------- */

#[tokio::test]
async fn labels_and_notes_still_round_trip_after_board_retirement() {
    let (pool, _directory, workspace) = fixture("annotations").await;
    let board = default_board(&pool, &workspace.id).await;
    let mut node = sticky_node(&board.id);
    node.labels = vec!["ship".into(), "P0".into()];
    node.note = "保留节点备注".into();
    let saved = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: std::slice::from_ref(&node),
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.nodes[0].labels, ["ship", "P0"]);
    assert_eq!(saved.nodes[0].note, "保留节点备注");
    assert!(
        serde_json::to_value(saved.board)
            .unwrap()
            .get("kanban")
            .is_none()
    );
}

/// Existing node annotation defaults still decode without extra writes.
#[tokio::test]
async fn the_column_defaults_decode_as_empty() {
    let (pool, _directory, workspace) = fixture("phase4-defaults").await;
    let board = default_board(&pool, &workspace.id).await;
    let node = sticky_node(&board.id);
    save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: std::slice::from_ref(&node),
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    // Put the pre-0008 literals back and read the document again.
    sqlx::query("UPDATE boards SET kanban_json = '{}' WHERE id = ?")
        .bind(&board.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE nodes SET labels_json = '[]', note = '' WHERE board_id = ?")
        .bind(&board.id)
        .execute(&pool)
        .await
        .unwrap();
    let document = load_board(&pool, &workspace.id, &board.id).await.unwrap();
    assert!(
        serde_json::to_value(&document.board)
            .unwrap()
            .get("kanban")
            .is_none()
    );
    assert!(document.nodes[0].labels.is_empty());
    assert!(document.nodes[0].note.is_empty());
    // And the whole document still passes the v3 validator.
    assert!(validate_document(&board.id, &document.nodes, &document.edges).is_ok());
}
