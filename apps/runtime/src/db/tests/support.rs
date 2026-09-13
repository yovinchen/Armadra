//! Shared fixtures for the database tests: a throwaway pool, the migration
//! ledger helpers and the node builders the document tests reuse.

use sqlx::SqlitePool;
use tempfile::tempdir;

use crate::db::*;
use crate::model::*;
use uuid::Uuid;

/// Every checked-in migration, counted from the embedded set rather than
/// written out: a literal here would have to be edited by hand on every
/// new migration, and the number is not what these tests are about.
pub(super) fn migration_count() -> i64 {
    sqlx::migrate!("./migrations").migrations.len() as i64
}

pub(super) async fn fixture(name: &str) -> (SqlitePool, tempfile::TempDir, Workspace) {
    let directory = tempdir().unwrap();
    let database_url = database_url(&directory.path().join(format!("{name}.db")));
    let pool = connect(&database_url).await.unwrap();
    let workspace = create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    (pool, directory, workspace)
}

/// Writes a `_sqlx_migrations` ledger and a table that only that build knew
/// about, so the file on disk looks exactly like one written by an older
/// version of this binary.
pub(super) async fn seed_foreign_database(database_url: &str, version: i64, checksum: &[u8]) {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE _sqlx_migrations ( \
           version BIGINT PRIMARY KEY, \
           description TEXT NOT NULL, \
           installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
           success BOOLEAN NOT NULL, \
           checksum BLOB NOT NULL, \
           execution_time BIGINT NOT NULL )",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?, 'from another build', TRUE, ?, 0)",
    )
    .bind(version)
    .bind(checksum)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("CREATE TABLE canvases (id TEXT PRIMARY KEY, strokes_json TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO canvases VALUES ('kept', '{\"strokes\":[1,2,3]}')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

/// The same URL `main.rs` builds. Never SQLx's own `to_url_lossy`: that one
/// runs the filename through a URL parser, which turns `C:\Users\…` into the
/// host `C` and the path `/\Users\…` — the database then "cannot be opened" on
/// Windows and nowhere else.
pub(super) fn database_url(path: &std::path::Path) -> String {
    crate::paths::sqlite_file_url(path)
}

pub(super) fn assert_no_legacy(directory: &std::path::Path) {
    assert!(
        !std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".legacy-"))
    );
}

pub(super) async fn assert_foreign_data_preserved(url: &str) {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .unwrap();
    let payload: String = sqlx::query_scalar("SELECT strokes_json FROM canvases WHERE id = 'kept'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(payload, "{\"strokes\":[1,2,3]}");
    pool.close().await;
}

pub(super) async fn default_board(pool: &SqlitePool, workspace_id: &str) -> Board {
    list_boards(pool, workspace_id)
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap()
}

pub(super) fn sticky_node(board_id: &str) -> CanvasNode {
    let now = Utc::now().to_rfc3339();
    CanvasNode {
        id: Uuid::now_v7().to_string(),
        board_id: board_id.to_owned(),
        node_type: "sticky".into(),
        title: "Sticky".into(),
        color: crate::model::DEFAULT_NODE_COLOR.into(),
        position: Position { x: 0.0, y: 0.0 },
        size: Some(Size {
            width: 240.0,
            height: 200.0,
        }),
        collapsed: None,
        expanded_height: None,
        parent_id: None,
        labels: Vec::new(),
        note: String::new(),
        data: serde_json::json!({ "kind": "sticky", "content": "hello" }),
        created_at: now.clone(),
        updated_at: now,
    }
}
