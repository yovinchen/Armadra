//! Startup preflight: an unknown, dirty or corrupt database is preserved
//! rather than reset, and a compatible one upgrades in place.

use tempfile::tempdir;

use super::support::*;
use crate::db::*;
use uuid::Uuid;

/// Rejected histories are left in place, including their ledger and data.
#[tokio::test]
async fn incompatible_database_preflight_preserves_data_and_ledger() {
    for (version, checksum) in [
        (1_i64, b"not our checksum".to_vec()),
        (999_i64, vec![0_u8; 48]),
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("canvas.db");
        let url = database_url(&path);
        seed_foreign_database(&url, version, &checksum).await;
        assert!(connect(&url).await.is_err());
        assert!(path.exists());
        assert_no_legacy(directory.path());
        assert_foreign_data_preserved(&url).await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let ledger: Vec<(i64, Vec<u8>, i64)> =
            sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(ledger, vec![(version, checksum, 1)]);
        let new_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('workspaces', 'agent_mailbox')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(new_tables, 0);
        pool.close().await;
    }
}

#[tokio::test]
async fn dirty_or_malformed_ledger_is_never_treated_as_empty() {
    let migrator = sqlx::migrate!("./migrations");
    for statement in [
        "UPDATE _sqlx_migrations SET success = FALSE",
        "UPDATE _sqlx_migrations SET success = 2",
        "UPDATE _sqlx_migrations SET version = 'broken'",
        "UPDATE _sqlx_migrations SET checksum = 'not a blob'",
        "ALTER TABLE _sqlx_migrations DROP COLUMN checksum",
        "DELETE FROM _sqlx_migrations",
        "DROP TABLE _sqlx_migrations",
    ] {
        let directory = tempdir().unwrap();
        let url = database_url(&directory.path().join("ledger.db"));
        seed_foreign_database(&url, 1, migrator.iter().next().unwrap().checksum.as_ref()).await;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(&pool)
            .await
            .unwrap();
        let schema_before: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        pool.close().await;
        let bytes_before = std::fs::read(directory.path().join("ledger.db")).unwrap();
        assert!(connect(&url).await.is_err(), "accepted {statement}");
        assert_foreign_data_preserved(&url).await;
        assert_no_legacy(directory.path());
        // This quiet DELETE-journal fixture should not change even at the
        // byte level; live WAL recovery is not covered by this assertion.
        assert_eq!(
            std::fs::read(directory.path().join("ledger.db")).unwrap(),
            bytes_before
        );
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let schema_after: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(schema_after, schema_before);
        pool.close().await;
    }
}

#[tokio::test]
async fn unknown_schema_without_ledger_and_unreadable_ledger_are_preserved() {
    for view_ledger in [false, true] {
        let directory = tempdir().unwrap();
        let url = database_url(&directory.path().join("unknown.db"));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE foreign_data (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO foreign_data VALUES ('keep me')")
            .execute(&pool)
            .await
            .unwrap();
        if view_ledger {
            sqlx::query("CREATE VIEW _sqlx_migrations AS SELECT * FROM missing_table")
                .execute(&pool)
                .await
                .unwrap();
        }
        pool.close().await;
        assert!(connect(&url).await.is_err());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM foreign_data")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "keep me"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='_sqlx_migrations'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        pool.close().await;
        assert_no_legacy(directory.path());
    }
}

#[tokio::test]
async fn corrupt_database_is_not_replaced() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("corrupt.db");
    let original = b"this file is not a SQLite database";
    std::fs::write(&path, original).unwrap();
    assert!(connect(&database_url(&path)).await.is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_no_legacy(directory.path());
}

#[tokio::test]
async fn compatible_old_migration_prefix_upgrades_without_resetting_data() {
    let directory = tempdir().unwrap();
    let url = database_url(&directory.path().join("old.db"));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("./migrations")
        .run_to(1, &pool)
        .await
        .unwrap();
    let workspace = create_workspace(
        &pool,
        "kept project",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let first_checksum: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    pool.close().await;
    let upgraded = connect(&url).await.unwrap();
    assert_eq!(
        get_workspace(&upgraded, &workspace.id).await.unwrap().name,
        "kept project"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        migration_count()
    );
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT checksum FROM _sqlx_migrations WHERE version=1")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        first_checksum
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_mailbox")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        0
    );
    upgraded.close().await;
    assert_no_legacy(directory.path());
}

#[tokio::test]
async fn migration_history_gaps_fail_before_missing_migrations_run() {
    let directory = tempdir().unwrap();
    let url = database_url(&directory.path().join("gap.db"));
    let migrator = sqlx::migrate!("./migrations");
    let second = migrator
        .iter()
        .find(|migration| migration.version == 2)
        .unwrap();
    seed_foreign_database(&url, second.version, second.checksum.as_ref()).await;
    assert!(connect(&url).await.is_err());
    assert_foreign_data_preserved(&url).await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_schema WHERE name='workspaces'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    pool.close().await;
    assert_no_legacy(directory.path());
}

#[tokio::test]
async fn rejected_preflight_does_not_reconcile_running_sessions() {
    let directory = tempdir().unwrap();
    let url = database_url(&directory.path().join("sessions.db"));
    let pool = connect(&url).await.unwrap();
    let workspace = create_workspace(
        &pool,
        "keep running",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, status, attach_state, created_at) VALUES ('session', ?, '/tmp', '/bin/sh', 'running', 'attached', '2026-09-05')")
        .bind(&workspace.id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET success = 0 WHERE version = 1")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    assert!(connect(&url).await.is_err());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let session: (String, String, Option<String>) = sqlx::query_as(
        "SELECT status, attach_state, ended_at FROM terminal_sessions WHERE id='session'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(session, ("running".into(), "attached".into(), None));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT success FROM _sqlx_migrations WHERE version=1")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    pool.close().await;
    assert_no_legacy(directory.path());
}

#[tokio::test]
async fn rejected_preflight_preserves_committed_wal_data_without_retiring_files() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("wal.db");
    let url = database_url(&path);
    seed_foreign_database(&url, 999, &[0; 48]).await;
    let keeper = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&keeper)
        .await
        .unwrap();
    sqlx::query("UPDATE canvases SET strokes_json = 'committed in WAL' WHERE id='kept'")
        .execute(&keeper)
        .await
        .unwrap();
    assert!(directory.path().join("wal.db-wal").exists());
    assert!(connect(&url).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT strokes_json FROM canvases WHERE id='kept'")
            .fetch_one(&keeper)
            .await
            .unwrap(),
        "committed in WAL"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations")
            .fetch_one(&keeper)
            .await
            .unwrap(),
        999
    );
    assert!(path.exists());
    assert!(directory.path().join("wal.db-wal").exists());
    assert_no_legacy(directory.path());
    keeper.close().await;
}

#[tokio::test]
async fn later_startup_failure_rolls_back_new_migrations_and_releases_lock() {
    let directory = tempdir().unwrap();
    let url = database_url(&directory.path().join("incomplete.db"));
    let migrator = sqlx::migrate!("./migrations");
    seed_foreign_database(&url, 1, migrator.iter().next().unwrap().checksum.as_ref()).await;
    // Ledger itself is known, but its original business tables are missing.
    // Migration 2 can run; subsequent session recovery must fail atomically.
    assert!(connect(&url).await.is_err());
    assert_foreign_data_preserved(&url).await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    sqlx::query("PRAGMA busy_timeout = 100")
        .execute(&pool)
        .await
        .unwrap();
    let mut lock = pool.begin_with("BEGIN EXCLUSIVE").await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&mut *lock)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name='agent_mailbox'"
        )
        .fetch_one(&mut *lock)
        .await
        .unwrap(),
        0
    );
    lock.rollback().await.unwrap();
    pool.close().await;
    assert_no_legacy(directory.path());
}

#[tokio::test]
async fn sqlx_encoded_filenames_and_memory_urls_use_the_same_preflight() {
    let directory = tempdir().unwrap();
    // `?` is not a character a Windows filename may contain, so the name that
    // exercises the URL escaping is the one the filesystem under the test can
    // hold. `#`, the space and the non-ASCII run everywhere.
    #[cfg(unix)]
    let path = directory.path().join("canvas ?# 空间.db");
    #[cfg(not(unix))]
    let path = directory.path().join("canvas # 空间.db");
    let url = database_url(&path);
    let pool = connect(&url).await.unwrap();
    pool.close().await;
    assert!(path.is_file());
    for url in ["sqlite::memory:", "sqlite://:memory:?cache=shared"] {
        let pool = connect(url).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            migration_count()
        );
        pool.close().await;
    }
    let memory_url = format!(
        "sqlite://file:memory-{}?mode=memory&cache=shared",
        Uuid::new_v4()
    );
    let keeper = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&memory_url)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE foreign_data (value TEXT)")
        .execute(&keeper)
        .await
        .unwrap();
    sqlx::query("INSERT INTO foreign_data VALUES ('kept in memory')")
        .execute(&keeper)
        .await
        .unwrap();
    assert!(connect(&memory_url).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM foreign_data")
            .fetch_one(&keeper)
            .await
            .unwrap(),
        "kept in memory"
    );
    keeper.close().await;
}

/// The complement: a database this build itself wrote is opened as it is.
#[tokio::test]
async fn a_database_written_by_this_build_is_reopened_untouched() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("canvas.db");
    let database_url = database_url(&path);
    let pool = connect(&database_url).await.unwrap();
    let workspace = create_workspace(
        &pool,
        "kept",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    pool.close().await;

    let pool = connect(&database_url).await.unwrap();
    assert_eq!(
        get_workspace(&pool, &workspace.id).await.unwrap().name,
        "kept"
    );
    assert!(
        !std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".legacy-"))
    );
}
