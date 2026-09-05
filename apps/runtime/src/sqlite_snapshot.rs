//! Consistent SQLite snapshots shared by manual backups and migration export.
use crate::error::{AppError, AppResult};
use std::path::Path;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub path: String,
    pub bytes: u64,
}

/// Export a snapshot to an explicit destination, including across volumes.
/// Cancellation of the caller must not unlink output while SQLite is writing.
pub async fn snapshot_to(pool: &sqlx::SqlitePool, target: &Path) -> AppResult<SnapshotInfo> {
    let pool = pool.clone();
    let target = target.to_path_buf();
    tokio::spawn(async move {
        let name = target
            .file_name()
            .ok_or_else(|| AppError::BadRequest("Snapshot destination must name a file".into()))?;
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let target = std::fs::canonicalize(parent)?.join(name);
        let mut connection = pool.acquire().await?;
        snapshot_to_target(&mut connection, &target).await
    })
    .await?
}

/// The timestamp is supplemented with a random suffix by snapshot_database.
pub fn backup_target(source: &Path, stamp: &str) -> std::path::PathBuf {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("canvas.db");
    source.with_file_name(format!("{name}.backup-manual-{stamp}"))
}

async fn connected_database_file(
    connection: &mut sqlx::SqliteConnection,
) -> AppResult<std::path::PathBuf> {
    let databases: Vec<(i64, String, String)> = sqlx::query_as("PRAGMA database_list")
        .fetch_all(&mut *connection)
        .await?;
    let filename = databases
        .into_iter()
        .find(|(_, name, _)| name == "main")
        .map(|(_, _, file)| file)
        .filter(|file| !file.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest(
                "In-memory or temporary databases cannot be backed up to a sibling file".into(),
            )
        })?;
    let source = std::fs::canonicalize(filename).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::BadRequest("The connected database file no longer exists".into())
        } else {
            AppError::Io(error)
        }
    })?;
    if !std::fs::metadata(&source)?.is_file() {
        return Err(AppError::BadRequest(
            "The connected database is not a regular file".into(),
        ));
    }
    Ok(source)
}

pub(crate) async fn snapshot_database(
    pool: &sqlx::SqlitePool,
    stamp: &str,
) -> AppResult<SnapshotInfo> {
    let mut connection = pool.acquire().await?;
    let source = connected_database_file(&mut connection).await?;
    let target = backup_target(
        &source,
        &format!("{stamp}-{}", uuid::Uuid::new_v4().simple()),
    );
    snapshot_to_target(&mut connection, &target).await
}

/// All unpublished output is confined to a newly created private directory.
/// Deliberately no Drop cleanup: runtime shutdown may cancel this future while
/// SQLite's worker still owns the file. An interrupted partial directory is
/// safer than unlinking a live SQLite output; it is never returned as a backup.
struct BackupScratch {
    directory: std::path::PathBuf,
    database: std::path::PathBuf,
    file: std::fs::File,
}

impl BackupScratch {
    fn create(parent: &Path) -> AppResult<Self> {
        let directory = parent.join(format!(
            ".armadra-backup-{}.partial",
            uuid::Uuid::new_v4().simple()
        ));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        let database = directory.join("snapshot.db");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&database) {
            Ok(file) => Ok(Self {
                directory,
                database,
                file,
            }),
            Err(error) => {
                // remove_dir refuses a nonempty/replaced directory. Never recurse.
                let _ = std::fs::remove_dir(&directory);
                Err(error.into())
            }
        }
    }

    fn cleanup(self) {
        drop(self.file);
        // Only paths inside this operation's exclusively created directory.
        // Unknown files are left alone; remove_dir then refuses to remove them.
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let path = self.directory.join(format!("snapshot.db{suffix}"));
            if let Err(error) = std::fs::remove_file(&path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(%error, "Could not remove a completed backup scratch file");
            }
        }
        if let Err(error) = std::fs::remove_dir(&self.directory) {
            tracing::warn!(%error, "Could not remove the backup scratch directory");
        }
    }
}

pub(crate) async fn snapshot_to_target(
    connection: &mut sqlx::SqliteConnection,
    target: &Path,
) -> AppResult<SnapshotInfo> {
    match std::fs::symlink_metadata(target) {
        Ok(_) => {
            return Err(AppError::Conflict(
                "Backup destination already exists".into(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::BadRequest("Database has no backup directory".into()))?;
    let scratch = BackupScratch::create(parent)?;
    let result: AppResult<()> = async {
        let filename = scratch
            .database
            .to_str()
            .ok_or_else(|| AppError::BadRequest("Backup path must be valid UTF-8".into()))?;
        // SQLite carries SQLITE_OPEN_MEMORY into VACUUM's ATTACH, so a plain
        // destination name can otherwise remain in RAM. An explicit URI mode
        // overrides that flag. Ordinary file-backed sources retain native paths.
        let main_path: String =
            sqlx::query_scalar("SELECT file FROM pragma_database_list WHERE name = 'main'")
                .fetch_one(&mut *connection)
                .await?;
        let destination = if main_path.is_empty() {
            let mut url = reqwest::Url::from_file_path(&scratch.database).map_err(|_| {
                AppError::BadRequest(
                    "Snapshot destination cannot be represented as a file URI".into(),
                )
            })?;
            url.set_query(Some("mode=rwc"));
            if let Some(server) = url.host_str() {
                // Empty URI authority, retaining the UNC path for Windows SQLite.
                format!("file:////{server}{}?mode=rwc", url.path())
            } else {
                url.to_string()
            }
        } else {
            filename.to_owned()
        };
        // INTO accepts a scalar expression; binding avoids quoting path text as SQL.
        sqlx::query("VACUUM main INTO ?")
            .bind(destination)
            .execute(&mut *connection)
            .await?;
        use sqlx::Connection;
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&scratch.database)
            .read_only(true)
            .create_if_missing(false);
        let mut verification = sqlx::SqliteConnection::connect_with(&options).await?;
        let checks: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_all(&mut verification)
            .await;
        let closed = verification.close().await;
        let checks = checks?;
        closed?;
        if checks != ["ok"] {
            return Err(AppError::Internal(
                "The database backup did not pass SQLite integrity verification".into(),
            ));
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        // SQL and verification have finished before their output is removed.
        scratch.cleanup();
        return Err(error);
    }
    let target = target.to_owned();
    tokio::task::spawn_blocking(move || {
        let result = (|| -> AppResult<SnapshotInfo> {
            // Explicit flush is required even when the source connection uses
            // synchronous=OFF; VACUUM INTO's own flush depends on that setting.
            scratch.file.sync_all()?;
            let bytes = scratch.file.metadata()?.len();
            if bytes == 0 {
                return Err(AppError::Internal("SQLite produced an empty backup".into()));
            }
            // Same-directory hard-link publication is atomic and never overwrites
            // an existing path. Unsupported filesystems fail without destructive
            // rename/copy fallbacks or publishing a partially written backup.
            std::fs::hard_link(&scratch.database, &target).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::Conflict("Backup destination already exists".into())
                } else {
                    AppError::Io(error)
                }
            })?;
            #[cfg(unix)]
            std::fs::File::open(target.parent().expect("snapshot has a parent"))?.sync_all()?;
            Ok(SnapshotInfo {
                path: target.display().to_string(),
                bytes,
            })
        })();
        scratch.cleanup();
        result
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Row};

    #[tokio::test]
    async fn explicit_snapshot_uses_destination_directory_and_preserves_source() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(source.path().join("original.db"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE preserved(id INTEGER PRIMARY KEY, content TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO preserved VALUES(42, '原数据📦')")
            .execute(&pool)
            .await
            .unwrap();
        let target = destination.path().join("source.sqlite");
        let result = snapshot_to(&pool, &target).await.unwrap();
        assert_eq!(
            result.path,
            std::fs::canonicalize(&target).unwrap().to_string_lossy()
        );
        assert!(result.bytes > 0);
        let mut snapshot = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&target)
                .read_only(true),
        )
        .await
        .unwrap();
        let row = sqlx::query("SELECT id, content FROM preserved")
            .fetch_one(&mut snapshot)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("id"), 42);
        assert_eq!(row.get::<String, _>("content"), "原数据📦");
        snapshot.close().await.unwrap();
        assert!(matches!(
            snapshot_to(&pool, &target).await,
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM preserved")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
        pool.close().await;
    }

    #[tokio::test]
    async fn explicit_destination_supports_a_memory_database() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE contents(value BLOB)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO contents VALUES(x'00ff')")
            .execute(&pool)
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("memory.sqlite");
        snapshot_to(&pool, &target).await.unwrap();
        let mut snapshot = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&target)
                .read_only(true),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, Vec<u8>>("SELECT value FROM contents")
                .fetch_one(&mut snapshot)
                .await
                .unwrap(),
            [0, 255]
        );
        snapshot.close().await.unwrap();
        pool.close().await;
    }
}
