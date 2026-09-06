//! Board documents: the whiteboard snapshot bounds, shape links, the
//! stale-revision rejection and the incremental save that keeps a board's
//! mailbox alive.

use sqlx::SqlitePool;

use super::support::*;
use crate::db::*;
use crate::model::*;
use uuid::Uuid;

fn link_edge(board_id: &str, source: &str, target: &str) -> CanvasEdge {
    let now = Utc::now().to_rfc3339();
    CanvasEdge {
        id: Uuid::now_v7().to_string(),
        board_id: board_id.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
        kind: "link".into(),
        created_at: now.clone(),
        updated_at: now,
    }
}

/// A message written the way `collab::mailbox` writes one. Only the two node
/// columns matter here: they are the `ON DELETE CASCADE` foreign keys that a
/// delete-and-reinsert save used to take out.
async fn seed_message(pool: &SqlitePool, workspace_id: &str, source: &str, target: &str) {
    sqlx::query(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, \
                                    message_key, body, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, 'ping', 0, 9999999999)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(workspace_id)
    .bind(source)
    .bind(target)
    .bind(Uuid::now_v7().to_string())
    .execute(pool)
    .await
    .unwrap();
}

async fn count(pool: &SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

/// The regression this module exists for: `agent_mailbox` cascades on `nodes`,
/// so a save that rebuilt the table wiped every message on the board — on a
/// drag, a rename, a colour change or an agent's own `canvas` command.
#[tokio::test]
async fn saving_a_moved_node_keeps_the_mailbox() {
    let (pool, _directory, workspace) = fixture("save-keeps-mailbox").await;
    let board = default_board(&pool, &workspace.id).await;
    let alice = sticky_node(&board.id);
    let bob = sticky_node(&board.id);
    let edge = link_edge(&board.id, &alice.id, &bob.id);
    let saved = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[alice.clone(), bob.clone()],
            edges: std::slice::from_ref(&edge),
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    seed_message(&pool, &workspace.id, &alice.id, &bob.id).await;
    seed_message(&pool, &workspace.id, &bob.id, &alice.id).await;
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM agent_mailbox").await, 2);

    let mut moved = alice.clone();
    moved.position = Position { x: 420.0, y: 96.0 };
    moved.title = "Renamed".into();
    let after = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &saved.board.updated_at,
            nodes: &[moved, bob.clone()],
            edges: std::slice::from_ref(&edge),
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM agent_mailbox").await,
        2,
        "an autosave must not empty the board's inboxes"
    );
    // The move itself still landed, the edge survived, and the board revision
    // moved on so the next CAS is against the new value.
    let alice_after = after
        .nodes
        .iter()
        .find(|node| node.id == alice.id)
        .expect("the moved node is still on the board");
    assert_eq!(alice_after.position.x, 420.0);
    assert_eq!(alice_after.title, "Renamed");
    assert_eq!(after.edges.len(), 1);
    assert_ne!(after.board.updated_at, saved.board.updated_at);

    // A third save changes nothing at all and still must not touch the mailbox.
    save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &after.board.updated_at,
            nodes: &[alice, bob],
            edges: &[edge],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM agent_mailbox").await, 2);
}

/// The cascade is not the bug and stays: a node the document really dropped
/// takes its own messages with it, and only those.
#[tokio::test]
async fn deleting_a_node_cascades_only_its_own_mailbox() {
    let (pool, _directory, workspace) = fixture("delete-cascades").await;
    let board = default_board(&pool, &workspace.id).await;
    let alice = sticky_node(&board.id);
    let bob = sticky_node(&board.id);
    let carol = sticky_node(&board.id);
    let saved = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[alice.clone(), bob.clone(), carol.clone()],
            edges: &[link_edge(&board.id, &alice.id, &bob.id)],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    seed_message(&pool, &workspace.id, &alice.id, &bob.id).await;
    seed_message(&pool, &workspace.id, &bob.id, &carol.id).await;
    seed_message(&pool, &workspace.id, &alice.id, &carol.id).await;
    upsert_agent_status(
        &pool,
        AgentStatusPatch {
            node_id: bob.id.clone(),
            workspace_id: workspace.id.clone(),
            agent_id: "claude".into(),
            state: Some("working".into()),
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
    .await
    .unwrap();

    // Bob leaves the board; his edge goes with him.
    save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &saved.board.updated_at,
            nodes: &[alice.clone(), carol.clone()],
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    let survivors: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_node_id, target_node_id FROM agent_mailbox ORDER BY sequence",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        survivors,
        vec![(alice.id.clone(), carol.id.clone())],
        "only the two messages that touched the deleted node are gone"
    );
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM edges").await, 0);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM nodes").await, 2);
    // `agent_status.node_id` is a plain column, not a foreign key, so nothing
    // cascades there. Pinned so the day it becomes one is a deliberate change.
    assert!(get_agent_status(&pool, &bob.id).await.unwrap().is_some());
}

/// Added, removed and untouched rows in a single save, plus the CAS that has
/// to keep refusing a stale revision without writing anything.
#[tokio::test]
async fn a_save_adds_removes_and_keeps_rows_in_one_pass() {
    let (pool, _directory, workspace) = fixture("save-diff").await;
    let board = default_board(&pool, &workspace.id).await;
    let kept = sticky_node(&board.id);
    let dropped = sticky_node(&board.id);
    let saved = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[kept.clone(), dropped.clone()],
            edges: &[link_edge(&board.id, &kept.id, &dropped.id)],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    let added = sticky_node(&board.id);
    let fresh_edge = link_edge(&board.id, &kept.id, &added.id);
    seed_message(&pool, &workspace.id, &kept.id, &dropped.id).await;

    let after = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &saved.board.updated_at,
            nodes: &[kept.clone(), added.clone()],
            edges: std::slice::from_ref(&fresh_edge),
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM nodes").await, 2);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM edges").await, 1);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM agent_mailbox").await, 0);
    let ids = after
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<std::collections::HashSet<_>>();
    assert!(ids.contains(&kept.id) && ids.contains(&added.id));
    assert_eq!(after.edges[0].id, fresh_edge.id);

    // Stale revision: still a 409, and the board it refused is untouched.
    assert!(matches!(
        save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &saved.board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM nodes").await, 2);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM edges").await, 1);
}

/// Migration 0009 plus the `None` = "leave it alone" rule the whiteboard
/// shares with the kanban (docs/design/canvas-react-flow.md §3.1).
#[tokio::test]
async fn a_whiteboard_snapshot_is_kept_overwritten_and_bounded() {
    let (pool, _directory, workspace) = fixture("whiteboard").await;
    let board = default_board(&pool, &workspace.id).await;
    assert_eq!(board.whiteboard, "", "0009 defaults to no whiteboard");

    let snapshot = r#"{"engine":"armadra-flow","version":2,"items":[{"kind":"ink"}]}"#;
    let saved = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[],
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: Some(snapshot),
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.board.whiteboard, snapshot);
    // It survives a reload, and it is on the board brief too.
    assert_eq!(
        load_board(&pool, &workspace.id, &board.id)
            .await
            .unwrap()
            .board
            .whiteboard,
        snapshot
    );
    assert_eq!(
        list_boards(&pool, &workspace.id).await.unwrap()[0].whiteboard,
        snapshot
    );

    // A client that knows nothing about the whiteboard saves a node and
    // must not wipe the drawing.
    let kept = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &saved.board.updated_at,
            nodes: &[sticky_node(&board.id)],
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(kept.board.whiteboard, snapshot);

    // An explicit empty string is how the client says "I erased it".
    let cleared = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &kept.board.updated_at,
            nodes: &[],
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: Some(""),
        },
    )
    .await
    .unwrap();
    assert_eq!(cleared.board.whiteboard, "");

    let oversized = "x".repeat(MAX_WHITEBOARD_BYTES + 1);
    assert!(matches!(
        save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &cleared.board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: Some(&oversized),
            },
        )
        .await,
        Err(AppError::BadRequest(_))
    ));
}

/// A `shape` link carries its own readable payload
/// (docs/design/canvas-react-flow.md §2.5), so it has to survive the round
/// trip through `links_json` — and be bounded.
#[tokio::test]
async fn shape_links_round_trip_their_content() {
    let (pool, _directory, workspace) = fixture("shape-links").await;
    let node_id = Uuid::now_v7().to_string();
    let shape_id = Uuid::now_v7().to_string();
    let links = vec![ContextLink {
        id: shape_id.clone(),
        title: "架构图".into(),
        kind: "shape".into(),
        content: Some(crate::model::ContextLinkContent {
            text: Some("runtime -> web".into()),
            png_path: Some(".armadra/exports/diagram.png".into()),
            ..Default::default()
        }),
    }];
    put_context_links(&pool, &workspace.id, &node_id, &links)
        .await
        .unwrap();
    let stored = get_context_links(&pool, &node_id).await.unwrap();
    let content = stored.links[0].content.as_ref().unwrap();
    assert_eq!(content.text.as_deref(), Some("runtime -> web"));
    assert_eq!(
        content.png_path.as_deref(),
        Some(".armadra/exports/diagram.png")
    );

    assert!(matches!(
        put_context_links(
            &pool,
            &workspace.id,
            &node_id,
            &[ContextLink {
                id: shape_id,
                title: "太大".into(),
                kind: "shape".into(),
                content: Some(crate::model::ContextLinkContent {
                    text: Some("x".repeat(20_001)),
                    png_path: None,
                    ..Default::default()
                }),
            }],
        )
        .await,
        Err(AppError::BadRequest(_))
    ));
}

#[tokio::test]
async fn rejects_a_stale_board_revision() {
    let (pool, _directory, workspace) = fixture("revision").await;
    let board = default_board(&pool, &workspace.id).await;
    save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[],
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    assert!(matches!(
        save_board(
            &pool,
            &workspace.id,
            &board.id,
            SaveBoardRequest {
                expected_updated_at: &board.updated_at,
                nodes: &[],
                edges: &[],
                viewport: Viewport::default(),
                whiteboard: None,
            },
        )
        .await,
        Err(AppError::Conflict(_))
    ));
}
