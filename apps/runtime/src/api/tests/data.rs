//! The data page: the info document and the database backup boundary.

use tempfile::tempdir;

use axum::http::StatusCode;
use serde_json::json;

use super::support::*;
use crate::sqlite_snapshot::{snapshot_database, snapshot_to_target};
use crate::{api::*, error::AppError};
use std::path::Path;

/* ---------------------------------- 数据 -------------------------------- */

#[tokio::test]
async fn the_data_page_reads_an_info_document_and_backs_the_database_up() {
    let (router, directory) = router_fixture("api-data").await;

    // `logs.retentionDays` is normalized like every other known key: the
    // default appears in `GET`, an offered value round-trips, anything else
    // is refused rather than silently snapped.
    let (status, info) = call(&router, "GET", "/api/data/info", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["conversations"], 0);
    assert_eq!(info["boardLogRetentionDays"], 30);
    assert!(info["dataDir"].as_str().is_some_and(|dir| !dir.is_empty()));
    assert!(info["dbBytes"].as_u64().is_some());

    let (status, patched) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "logs": { "retentionDays": 7 } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["logs"]["retentionDays"], 7);
    let (_, info) = call(&router, "GET", "/api/data/info", None).await;
    assert_eq!(info["boardLogRetentionDays"], 7);

    let (status, error) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "logs": { "retentionDays": 5 } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "bad_request");

    // Exercise the real handler: it must use the fixture pool, regardless of
    // global application data-directory configuration.
    let (status, backup) = call(&router, "POST", "/api/data/backup", None).await;
    assert_eq!(status, StatusCode::OK);
    let path = std::path::Path::new(backup["path"].as_str().unwrap());
    assert_eq!(
        path.parent(),
        Some(
            crate::paths::canonicalize(directory.path())
                .unwrap()
                .as_path()
        )
    );
    assert!(
        path.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("api-data.db.backup-manual-")
    );
    assert!(backup["bytes"].as_u64().unwrap() > 0);
    assert!(path.exists());
}

async fn backup_fixture(name: &str) -> (sqlx::SqlitePool, tempfile::TempDir, std::path::PathBuf) {
    let directory = tempdir().unwrap();
    let source = directory.path().join(name);
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&source)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .pragma("wal_autocheckpoint", "0");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE snapshot_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    (pool, directory, source)
}

async fn snapshot_values(path: &Path) -> Vec<String> {
    use sqlx::Connection;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let values = sqlx::query_scalar("SELECT value FROM snapshot_values ORDER BY id")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    values
}

#[tokio::test]
async fn data_backup_includes_uncheckpointed_wal_with_an_active_reader() {
    let (pool, directory, source) = backup_fixture("custom path ' quoted.db").await;
    let before = std::fs::read(&source).unwrap();
    // Hold an older read snapshot while the committed insert stays in WAL.
    let mut reader = pool.acquire().await.unwrap();
    sqlx::query("BEGIN").execute(&mut *reader).await.unwrap();
    let _: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_values")
        .fetch_one(&mut *reader)
        .await
        .unwrap();
    sqlx::query("INSERT INTO snapshot_values(value) VALUES ('committed in WAL 中文')")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(&source).unwrap(),
        before,
        "fixture must leave the committed row outside the main file"
    );
    assert!(
        std::fs::metadata(source.with_file_name("custom path ' quoted.db-wal"))
            .unwrap()
            .len()
            > 0
    );
    let backup = snapshot_database(&pool, "fixed-second").await.unwrap();
    assert_eq!(
        snapshot_values(Path::new(&backup.path)).await,
        ["committed in WAL 中文"]
    );
    assert_eq!(
        std::fs::read(&source).unwrap(),
        before,
        "VACUUM INTO must not rewrite the source"
    );
    assert_eq!(
        Path::new(&backup.path).parent(),
        Some(
            crate::paths::canonicalize(directory.path())
                .unwrap()
                .as_path()
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&backup.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    sqlx::query("ROLLBACK").execute(&mut *reader).await.unwrap();
    drop(reader);
    pool.close().await;
}

#[tokio::test]
async fn data_backup_same_second_is_unique_and_preserves_previous_snapshot() {
    let (pool, _directory, _) = backup_fixture("same-second.db").await;
    sqlx::query("INSERT INTO snapshot_values(value) VALUES ('first')")
        .execute(&pool)
        .await
        .unwrap();
    let first = snapshot_database(&pool, "20260905-101500").await.unwrap();
    let first_bytes = std::fs::read(&first.path).unwrap();
    sqlx::query("INSERT INTO snapshot_values(value) VALUES ('second')")
        .execute(&pool)
        .await
        .unwrap();
    let (second, third) = tokio::join!(
        snapshot_database(&pool, "20260905-101500"),
        snapshot_database(&pool, "20260905-101500")
    );
    let second = second.unwrap();
    let third = third.unwrap();
    assert_ne!(first.path, second.path);
    assert_ne!(second.path, third.path);
    assert_eq!(std::fs::read(&first.path).unwrap(), first_bytes);
    assert_eq!(snapshot_values(Path::new(&first.path)).await, ["first"]);
    assert_eq!(
        snapshot_values(Path::new(&second.path)).await,
        ["first", "second"]
    );
    pool.close().await;
}

#[tokio::test]
async fn data_backup_failure_cleans_only_its_scratch_and_keeps_source_and_existing_files() {
    let (pool, directory, source) = backup_fixture("failure.db").await;
    sqlx::query("INSERT INTO snapshot_values(value) VALUES ('keep source')")
        .execute(&pool)
        .await
        .unwrap();
    let existing = backup_target(&source, "existing");
    std::fs::write(&existing, b"existing backup must survive").unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert!(matches!(
        snapshot_to_target(&mut connection, &existing).await,
        Err(AppError::Conflict(_))
    ));
    // VACUUM cannot run inside a transaction. This deterministic SQL error
    // occurs after private output creation and must not leave partial output.
    sqlx::query("BEGIN")
        .execute(&mut *connection)
        .await
        .unwrap();
    let failed = backup_target(&source, "failed");
    assert!(snapshot_to_target(&mut connection, &failed).await.is_err());
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .unwrap();
    assert!(!failed.exists());
    assert_eq!(
        std::fs::read(&existing).unwrap(),
        b"existing backup must survive"
    );
    assert!(!std::fs::read_dir(directory.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".partial")
    }));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM snapshot_values WHERE value = 'keep source'")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    assert_eq!(count, 1);
    drop(connection);
    pool.close().await;
}

#[tokio::test]
async fn data_backup_rejects_memory_and_a_missing_connected_file() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    assert!(matches!(
        snapshot_database(&pool, "memory").await,
        Err(AppError::BadRequest(_))
    ));
    pool.close().await;
    #[cfg(unix)]
    {
        let (pool, _directory, source) = backup_fixture("removed.db").await;
        std::fs::remove_file(&source).unwrap();
        assert!(matches!(
            snapshot_database(&pool, "missing").await,
            Err(AppError::BadRequest(_))
        ));
        pool.close().await;
    }
}
