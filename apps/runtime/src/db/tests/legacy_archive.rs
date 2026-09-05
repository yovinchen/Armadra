//! The kanban retirement: the raw rows survive, stay read-only, and a fresh
//! canvas has no writable board state.

use std::borrow::Cow;

use sqlx::sqlite::SqlitePoolOptions;

use crate::db::*;
use crate::model::*;
use uuid::Uuid;

const RAW: &str = " {\n \"columns\": [{\"id\":\"old\",\"title\":\"原始列\"}], \"cards\": {\"shape:orphan\":{\"columnId\":\"missing\",\"order\":1.25}}, \"unknown\":true }\n";
const LABELS: &str = "[ \"旧标签\", \"needs review\" ]";
const NOTE: &str = "原始备注\n  保留空白";
const DRAWING: &str = "{ \"records\": [{\"id\":\"shape:ink\",\"type\":\"draw\"}] }";

async fn before_retirement() -> (SqlitePool, String, String, String) {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let all = sqlx::migrate!("./migrations");
    let old = sqlx::migrate::Migrator {
        migrations: Cow::Owned(
            all.iter()
                .filter(|migration| migration.version <= 2)
                .cloned()
                .collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    old.run(&pool).await.unwrap();
    let (workspace, canvas, node) = (
        Uuid::now_v7().to_string(),
        Uuid::now_v7().to_string(),
        Uuid::now_v7().to_string(),
    );
    sqlx::query("INSERT INTO workspaces(id,name,root_path,created_at,updated_at) VALUES(?,'Original workspace','/archive-fixture','2026-09-05T01:02:03.004+08:00','2026-09-05T01:02:04.005+08:00')").bind(&workspace).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO boards(id,workspace_id,name,kanban_json,whiteboard_json,created_at,updated_at) VALUES(?,?,'Original canvas',?,?,'2026-09-05T01:02:03.004+08:00','2026-09-05T01:02:04.005+08:00')").bind(&canvas).bind(&workspace).bind(RAW).bind(DRAWING).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO nodes(id,board_id,type,x,y,title,labels_json,note,data_json,created_at,updated_at) VALUES(?,?,'sticky',1,2,'Original node',?,?, '{\"kind\":\"sticky\",\"content\":\"content\"}','2026-09-05T01:02:03.004+08:00','2026-09-05T01:02:04.005+08:00')").bind(&node).bind(&canvas).bind(LABELS).bind(NOTE).execute(&pool).await.unwrap();
    (pool, workspace, canvas, node)
}

#[tokio::test]
async fn retirement_preserves_raw_data_and_survives_live_deletion() {
    let (pool, workspace, canvas, node) = before_retirement().await;
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let archive = get_legacy_kanban_archive(&pool, &canvas).await.unwrap();
    assert_eq!(archive.kanban_json, RAW);
    assert_eq!(archive.summary.workspace_name, "Original workspace");
    assert_eq!(archive.summary.canvas_name, "Original canvas");
    assert_eq!(archive.canvas_created_at, "2026-09-05T01:02:03.004+08:00");
    assert_eq!(archive.labels[0].node_id, node);
    assert_eq!(archive.labels[0].labels_json, LABELS);
    assert_eq!(archive.labels[0].note, NOTE);
    assert_eq!(archive.labels[0].archived_at, archive.summary.archived_at);
    let board = get_board(&pool, &workspace, &canvas).await.unwrap();
    assert_eq!(board.whiteboard, DRAWING);
    // Deleting every live node must neither prune task-card references nor
    // rewrite the old JSON into a newly normalized representation.
    save_board(
        &pool,
        &workspace,
        &canvas,
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
    let raw: String = sqlx::query_scalar("SELECT kanban_json FROM boards WHERE id=?")
        .bind(&canvas)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(raw, RAW);
    assert_eq!(
        get_board(&pool, &workspace, &canvas)
            .await
            .unwrap()
            .whiteboard,
        DRAWING
    );
    sqlx::query("DELETE FROM workspaces WHERE id=?")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    let archived = get_legacy_kanban_archive(&pool, &canvas).await.unwrap();
    assert_eq!(archived.kanban_json, RAW);
    assert_eq!(archived.labels[0].note, NOTE);
    assert_eq!(
        list_legacy_kanban_archives(&pool, None, 50)
            .await
            .unwrap()
            .archives
            .len(),
        1
    );
}

#[tokio::test]
async fn old_column_and_archive_rows_are_write_protected() {
    let (pool, _, canvas, _) = before_retirement().await;
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    assert!(
        sqlx::query("UPDATE boards SET kanban_json='{}' WHERE id=?")
            .bind(&canvas)
            .execute(&pool)
            .await
            .is_err()
    );
    for query in [
        "UPDATE legacy_kanban_archives SET canvas_name='changed'",
        "DELETE FROM legacy_kanban_archives",
        "INSERT INTO legacy_kanban_archives SELECT * FROM legacy_kanban_archives",
        "UPDATE legacy_node_label_archives SET note='changed'",
        "DELETE FROM legacy_node_label_archives",
        "INSERT INTO legacy_node_label_archives SELECT * FROM legacy_node_label_archives",
    ] {
        assert!(
            sqlx::query(sqlx::AssertSqlSafe(query))
                .execute(&pool)
                .await
                .is_err(),
            "{query}"
        );
    }
    assert_eq!(
        get_legacy_kanban_archive(&pool, &canvas)
            .await
            .unwrap()
            .kanban_json,
        RAW
    );
}

#[tokio::test]
async fn fresh_canvases_have_no_writable_board_state_and_notes_remain_editable() {
    let (pool, workspace, canvas, _) = before_retirement().await;
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let before = get_legacy_kanban_archive(&pool, &canvas).await.unwrap();
    let mut document = load_board(&pool, &workspace, &canvas).await.unwrap();
    document.nodes[0].note = "Updated live note".into();
    document.nodes[0].labels = vec!["current label".into()];
    let saved = save_board(
        &pool,
        &workspace,
        &canvas,
        SaveBoardRequest {
            expected_updated_at: &document.board.updated_at,
            nodes: &document.nodes,
            edges: &document.edges,
            viewport: document.board.viewport,
            whiteboard: Some("new drawing"),
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.nodes[0].note, "Updated live note");
    assert_eq!(saved.board.whiteboard, "new drawing");
    assert_eq!(
        get_legacy_kanban_archive(&pool, &canvas)
            .await
            .unwrap()
            .labels[0]
            .note,
        before.labels[0].note
    );
    let fresh = create_board(&pool, &workspace, "Fresh canvas")
        .await
        .unwrap();
    assert!(
        serde_json::to_value(&fresh)
            .unwrap()
            .get("kanban")
            .is_none()
    );
    let inert: String = sqlx::query_scalar("SELECT kanban_json FROM boards WHERE id=?")
        .bind(&fresh.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(inert, "{}");
    assert_eq!(
        list_legacy_kanban_archives(&pool, None, 50)
            .await
            .unwrap()
            .archives
            .len(),
        1
    );
    assert!(sqlx::query("INSERT INTO boards(id,workspace_id,name,kanban_json,created_at,updated_at) VALUES('old-writer',?,'Old writer',?,'t','t')").bind(&workspace).bind(RAW).execute(&pool).await.is_err());
}
