//! Tests for migration export: schema validation, asset copying and the
//! reference scanner.

use super::assets::{copy_asset, copy_asset_checked, managed_relative};
use super::files::hash_file;
use super::references::{legacy_asset_url, scan_json};
use super::*;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteJournalMode, SqlitePoolOptions};
use tempfile::TempDir;

const WHITEBOARD: &str =
    "{\"store\":{\"画笔\":{\"typeName\":\"shape\",\"props\":{\"text\":\"原始白板 🖌\"}}}}";
const NOTE: &str = "原始备注\n保留空白  与 emoji 🐈";

async fn migrate_to(pool: &SqlitePool, version: i64) {
    let all = sqlx::migrate!("./migrations");
    let prefix = sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(
            all.iter()
                .filter(|migration| migration.version <= version)
                .cloned()
                .collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    prefix.run(pool).await.unwrap();
}
async fn fixture() -> (TempDir, SqlitePool) {
    fixture_version(4).await
}
async fn fixture_version(version: i64) -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("live.sqlite"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await
        .unwrap();
    migrate_to(&pool, version.min(2)).await;
    seed(&pool, dir.path()).await;
    migrate_to(&pool, version).await;
    (dir, pool)
}

async fn seed(pool: &SqlitePool, root: &Path) {
    sqlx::query("INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES ('workspace','测试',?,'created-original','updated-original')")
            .bind(root.to_string_lossy().as_ref()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO boards (id,workspace_id,name,whiteboard_json,kanban_json,created_at,updated_at) VALUES ('canvas','workspace','画布',?,'{\"columns\":[\"保留\"]}','created-original','updated-original')")
            .bind(WHITEBOARD).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO nodes (id,board_id,type,x,y,labels_json,note,data_json,created_at,updated_at) VALUES ('node','canvas','sticky',1,2,'[\"旧标签\"]',?,'{\"text\":\"保留正文\"}','created-original','updated-original')")
            .bind(NOTE).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO terminal_sessions (id,workspace_id,cwd,shell,status,attach_state,created_at,generation) VALUES ('session','workspace','/original','/bin/sh','running','live','created-original',9007199254740993)")
            .execute(pool).await.unwrap();
}

#[tokio::test]
async fn export_preserves_original_data_and_builds_protobuf_inventory() {
    let (dir, pool) = fixture().await;
    let mut old_reader = pool.begin().await.unwrap();
    let original_name: String = sqlx::query_scalar("SELECT name FROM workspaces")
        .fetch_one(&mut *old_reader)
        .await
        .unwrap();
    assert_eq!(original_name, "测试");
    sqlx::query("UPDATE workspaces SET name='最新已提交' WHERE id='workspace'")
        .execute(&pool)
        .await
        .unwrap();
    let package = export_package(&pool, &dir.path().join("package"), ExportOptions::default())
        .await
        .unwrap();
    old_reader.rollback().await.unwrap();
    let manifest = MigrationExportManifest::decode(
        fs::read(package.path.join("manifest.pb"))
            .unwrap()
            .as_slice(),
    )
    .unwrap();
    assert_eq!(manifest, package.manifest);
    assert!(!manifest.ownership_switch_allowed);
    assert!(manifest.assets_complete);
    assert_eq!(manifest.migrations.len(), 4);
    assert_eq!(
        manifest.canvases[0].whiteboard_sha256,
        Sha256::digest(WHITEBOARD.as_bytes()).to_vec()
    );
    assert_eq!(
        manifest.canvases[0].whiteboard_bytes,
        WHITEBOARD.len() as u64
    );
    assert_eq!(
        manifest.canvases[0].kanban_json,
        "{\"columns\":[\"保留\"]}".as_bytes()
    );
    assert_eq!(manifest.annotations[0].note_utf8, NOTE.as_bytes());
    assert_eq!(
        manifest.annotations[0].labels_json,
        "[\"旧标签\"]".as_bytes()
    );
    for table in ["workspaces", "boards", "nodes", "terminal_sessions"] {
        assert_eq!(
            manifest
                .identities
                .iter()
                .find(|ids| ids.table == table)
                .unwrap()
                .ids
                .len(),
            1
        );
        assert_eq!(
            manifest
                .tables
                .iter()
                .find(|stats| stats.name == table)
                .unwrap()
                .row_count,
            1
        );
    }
    assert_eq!(
        hash_file(&package.path.join("source.sqlite")).unwrap(),
        (manifest.database_bytes, manifest.database_sha256)
    );
    let mut snapshot = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(package.path.join("source.sqlite"))
            .read_only(true),
    )
    .await
    .unwrap();
    let preserved: (String, String, String, i64) =
        sqlx::query_as("SELECT status,attach_state,created_at,generation FROM terminal_sessions")
            .fetch_one(&mut snapshot)
            .await
            .unwrap();
    assert_eq!(
        preserved,
        (
            "running".into(),
            "live".into(),
            "created-original".into(),
            9_007_199_254_740_993
        )
    );
    let row: (String, String) = sqlx::query_as("SELECT name,updated_at FROM workspaces")
        .fetch_one(&mut snapshot)
        .await
        .unwrap();
    assert_eq!(row, ("最新已提交".into(), "updated-original".into()));
    let original: (String, String, String, i64) =
        sqlx::query_as("SELECT status,attach_state,created_at,generation FROM terminal_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(original, preserved);
    snapshot.close().await.unwrap();
    assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("legacy")
    }));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&package.path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(package.path.join("manifest.pb"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    pool.close().await;
}

#[tokio::test]
async fn known_older_schema_is_preserved_without_implicit_upgrade() {
    let (dir, pool) = fixture_version(1).await;
    let package = export_package(&pool, &dir.path().join("v1"), ExportOptions::default())
        .await
        .unwrap();
    assert_eq!(package.manifest.migrations.len(), 1);
    assert!(
        package
            .manifest
            .tables
            .iter()
            .all(|table| table.name != "agent_mailbox")
    );
    let migrations: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(migrations, 1);
    pool.close().await;
}

#[tokio::test]
async fn unknown_dirty_checksum_and_unknown_schema_refuse_completion() {
    for change in [
        "UPDATE _sqlx_migrations SET version=999 WHERE version=2",
        "UPDATE _sqlx_migrations SET success=0 WHERE version=2",
        "UPDATE _sqlx_migrations SET checksum=x'00' WHERE version=2",
        "CREATE TABLE unexpected (secret TEXT)",
        "DROP TABLE _sqlx_migrations",
        "ALTER TABLE _sqlx_migrations ADD COLUMN unexpected TEXT",
    ] {
        let (dir, pool) = fixture().await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(change))
            .execute(&pool)
            .await
            .unwrap();
        let target = dir.path().join("refused");
        let error = export_package(&pool, &target, ExportOptions::default())
            .await
            .unwrap_err();
        assert!(
            matches!(error, AppError::BadRequest(_) | AppError::Database(_)),
            "{error}"
        );
        assert!(!target.join("manifest.pb").exists());
        let note: String = sqlx::query_scalar("SELECT note FROM nodes")
            .fetch_one(&pool)
            .await
            .unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM terminal_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(note, NOTE);
        assert_eq!(status, "running");
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("legacy")
        }));
        pool.close().await;
    }
}

#[tokio::test]
async fn in_memory_source_and_existing_destination_are_safe() {
    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    migrate_to(&pool, 2).await;
    seed(&pool, dir.path()).await;
    migrate_to(&pool, 3).await;
    let destination = dir.path().join("memory-export");
    export_package(&pool, &destination, ExportOptions::default())
        .await
        .unwrap();
    let original = fs::read(destination.join("manifest.pb")).unwrap();
    assert!(matches!(
        export_package(&pool, &destination, ExportOptions::default()).await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(fs::read(destination.join("manifest.pb")).unwrap(), original);
    let empty = dir.path().join("existing-empty");
    fs::create_dir(&empty).unwrap();
    assert!(
        export_package(&pool, &empty, ExportOptions::default())
            .await
            .is_err()
    );
    assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    pool.close().await;
}

#[tokio::test]
async fn managed_assets_are_deduplicated_copied_and_hashed() {
    let (dir, pool) = fixture().await;
    fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
    fs::write(
        dir.path().join(".armadra/assets/image.png"),
        b"original image bytes",
    )
    .unwrap();
    sqlx::query("UPDATE boards SET whiteboard_json=?")
            .bind(r#"{"store":{"asset":{"meta":{"armadra":{"path":".armadra/assets/image.png"}},"props":{"src":"http://old-origin/api/workspaces/workspace/assets/image.png"}}}}"#).execute(&pool).await.unwrap();
    sqlx::query("UPDATE nodes SET data_json=?")
        .bind(r#"{"path":".armadra/assets/image.png"}"#)
        .execute(&pool)
        .await
        .unwrap();
    let package = export_package(
        &pool,
        &dir.path().join("assets-copy"),
        ExportOptions::default(),
    )
    .await
    .unwrap();
    assert!(package.manifest.assets_complete);
    assert_eq!(package.manifest.assets.len(), 1);
    let asset = &package.manifest.assets[0];
    assert!(asset.copied);
    assert_eq!(asset.referenced_by.len(), 2);
    assert_eq!(
        fs::read(package.path.join(&asset.bundle_path)).unwrap(),
        b"original image bytes"
    );
    assert_eq!(
        asset.sha256,
        Sha256::digest(b"original image bytes").to_vec()
    );
    assert_eq!(asset.bytes, 20);
    assert!(
        package
            .manifest
            .issues
            .iter()
            .all(|issue| issue.code != "external_reference")
    );
    pool.close().await;
}

#[tokio::test]
async fn missing_escaping_and_external_assets_are_reported_without_reading_them() {
    let (dir, pool) = fixture().await;
    sqlx::query("UPDATE nodes SET data_json=?").bind(r#"{"files":[{"path":".armadra/assets/missing.png"},{"path":".armadra/assets/../../../secret"},{"path":"/external/credentials"},{"path":"https://example.invalid/private"}]}"#).execute(&pool).await.unwrap();
    let package = export_package(&pool, &dir.path().join("issues"), ExportOptions::default())
        .await
        .unwrap();
    assert!(!package.manifest.assets_complete);
    assert!(
        package
            .manifest
            .assets
            .iter()
            .all(|asset| !asset.copied && asset.bundle_path.is_empty())
    );
    for code in ["asset_missing", "unsafe_asset_path", "external_reference"] {
        assert!(
            package
                .manifest
                .issues
                .iter()
                .any(|issue| issue.code == code),
            "missing {code}"
        );
    }
    assert!(!package.path.join("assets").exists());
    pool.close().await;
}

#[tokio::test]
async fn invalid_json_is_preserved_but_cannot_claim_complete_assets() {
    let (dir, pool) = fixture().await;
    sqlx::query("UPDATE boards SET whiteboard_json='{ broken'")
        .execute(&pool)
        .await
        .unwrap();
    let result = export_package(
        &pool,
        &dir.path().join("invalid-json"),
        ExportOptions::default(),
    )
    .await
    .unwrap();
    assert!(!result.manifest.assets_complete);
    assert!(
        result
            .manifest
            .issues
            .iter()
            .any(|issue| issue.code == "invalid_json" && issue.severity == "error")
    );
    assert_eq!(
        result.manifest.canvases[0].whiteboard_sha256,
        Sha256::digest(b"{ broken").to_vec()
    );
    pool.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_assets_never_copy_external_bytes() {
    use std::os::unix::fs::symlink;
    let (dir, pool) = fixture().await;
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), b"do not copy").unwrap();
    fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
    symlink(
        outside.path().join("secret"),
        dir.path().join(".armadra/assets/link"),
    )
    .unwrap();
    symlink(outside.path(), dir.path().join(".armadra/imports")).unwrap();
    sqlx::query("UPDATE nodes SET data_json=?")
        .bind(r#"{"paths":[".armadra/assets/link",".armadra/imports/secret"]}"#)
        .execute(&pool)
        .await
        .unwrap();
    let package = export_package(&pool, &dir.path().join("symlink"), ExportOptions::default())
        .await
        .unwrap();
    assert!(!package.manifest.assets_complete);
    assert!(package.manifest.assets.iter().all(|asset| !asset.copied));
    assert!(!package.path.join("assets").exists());
    pool.close().await;
}

#[test]
fn managed_paths_and_limits_are_explicit() {
    for raw in [
        "../secret",
        ".armadra/../secret",
        ".armadra/assets/../../secret",
        ".armadra/assets//x",
        ".armadra/assets/./x",
        ".armadra/assets/C:stream",
        ".armadra/assets/line\nfile",
        ".armadra\\assets\\x",
        ".armadra/credentials/token",
        ".armadra/assets/NUL.txt",
        ".armadra/assets/LPT1",
        ".armadra/assets/file.",
        ".armadra/assets/file ",
    ] {
        assert!(managed_relative(raw).is_none(), "{raw}");
    }
    for raw in [
        ".armadra/assets/a.png",
        ".armadra/imports/batch/中文 file.txt",
        ".armadra/exports/a.png",
    ] {
        assert!(managed_relative(raw).is_some());
    }
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
    fs::write(dir.path().join(".armadra/assets/a"), b"1234").unwrap();
    assert_eq!(
        copy_asset(
            dir.path(),
            Path::new(".armadra/assets/a"),
            &dir.path().join("out"),
            3
        )
        .unwrap_err()
        .0,
        "asset_size_limit"
    );
    assert!(!dir.path().join("out").exists());
    assert_eq!(
        copy_asset(
            Path::new("relative-root"),
            Path::new(".armadra/assets/a"),
            &dir.path().join("out"),
            100
        )
        .unwrap_err()
        .0,
        "unsafe_workspace_root"
    );
}

#[tokio::test]
async fn ordinary_workspace_references_require_mapping_but_are_not_missing_managed_assets() {
    let (dir, pool) = fixture().await;
    sqlx::query("UPDATE nodes SET data_json=?")
        .bind(r#"{"path":"src/main.rs"}"#)
        .execute(&pool)
        .await
        .unwrap();
    let package = export_package(
        &pool,
        &dir.path().join("source-reference"),
        ExportOptions::default(),
    )
    .await
    .unwrap();
    assert!(package.manifest.assets_complete);
    assert!(package.manifest.assets.is_empty());
    assert!(
        package
            .manifest
            .issues
            .iter()
            .any(|issue| issue.code == "external_reference")
    );
    pool.close().await;
}

#[test]
fn asset_mutation_is_reported_and_existing_output_is_never_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let relative = Path::new(".armadra/assets/file");
    fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
    let source = dir.path().join(relative);
    fs::write(&source, b"before").unwrap();
    let target = dir.path().join("copy");
    let result = copy_asset_checked(dir.path(), relative, &target, 100, || {
        fs::write(&source, b"after!").unwrap()
    });
    assert_eq!(result.unwrap_err().0, "asset_changed");
    assert!(!target.exists());
    fs::write(&target, b"existing output must survive").unwrap();
    assert_eq!(
        copy_asset(dir.path(), relative, &target, 100)
            .unwrap_err()
            .0,
        "asset_copy_failed"
    );
    assert_eq!(fs::read(&target).unwrap(), b"existing output must survive");
}

#[test]
fn older_runtime_asset_urls_recover_only_the_same_workspaces_managed_reference() {
    let mut references = References::new();
    let mut manifest = MigrationExportManifest {
        assets_complete: true,
        ..Default::default()
    };
    scan_json(
        r#"{"props":{"src":"http://127.0.0.1:43120/api/workspaces/ws/assets/0123456789abcdef.png"}}"#,
        "ws",
        "canvas",
        &mut references,
        &mut manifest,
    );
    assert!(references.contains_key(&("ws".into(), ".armadra/assets/0123456789abcdef.png".into())));
    for url in [
        "http://localhost/api/workspaces/other/assets/0123456789abcdef.png",
        "http://localhost/api/workspaces/ws/assets/../../secret",
        "http://localhost/api/workspaces/ws/assets/token",
        "http://u:p@localhost/api/workspaces/ws/assets/0123456789abcdef.png",
    ] {
        assert!(legacy_asset_url(url, "ws").is_none());
    }
}
