//! Board documents: the whiteboard snapshot bounds, shape links and the
//! stale-revision rejection.

use super::support::*;
use crate::db::*;
use crate::model::*;
use uuid::Uuid;

/// Migration 0009 plus the `None` = "leave it alone" rule the whiteboard
/// shares with the kanban (tldraw plan §6.1).
#[tokio::test]
async fn a_whiteboard_snapshot_is_kept_overwritten_and_bounded() {
    let (pool, _directory, workspace) = fixture("whiteboard").await;
    let board = default_board(&pool, &workspace.id).await;
    assert_eq!(board.whiteboard, "", "0009 defaults to no whiteboard");

    let snapshot = r#"{"store":{"shape:ink":{"type":"draw"}},"schema":{}}"#;
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

/// A `shape` link carries its own readable payload (tldraw plan §6.3), so
/// it has to survive the round trip through `links_json` — and be bounded.
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
