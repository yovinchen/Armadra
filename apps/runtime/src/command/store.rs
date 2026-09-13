use super::*;
use sqlx::{
    Row,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{fs::File, path::Path, time::Duration};

const SCHEMA: &str = "CREATE TABLE metadata(version INTEGER NOT NULL, checksum BLOB NOT NULL, host TEXT NOT NULL, dirty INTEGER NOT NULL CHECK(dirty IN (0,1))); CREATE TABLE roots(id TEXT PRIMARY KEY, body BLOB NOT NULL); CREATE TABLE sessions(id TEXT PRIMARY KEY, body BLOB NOT NULL); CREATE TABLE operations(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request BLOB NOT NULL, receipt BLOB NOT NULL, phase INTEGER NOT NULL CHECK(phase BETWEEN 1 AND 9), pid INTEGER, guardian TEXT, last_retry_sequence INTEGER NOT NULL DEFAULT 0);";

#[derive(Clone)]
pub struct Store {
    pub pool: sqlx::SqlitePool,
}

pub fn private_directory(path: &Path) -> anyhow::Result<PathBuf> {
    if !path.is_absolute() {
        anyhow::bail!("command state directory must be absolute");
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        anyhow::bail!("command state directory must be a real directory");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            anyhow::bail!("command state directory is not private");
        }
    }
    #[cfg(windows)]
    super::platform_windows::verify_private_directory(path)?;
    Ok(crate::paths::canonicalize(path)?)
}
#[cfg(windows)]
pub(crate) fn private_file(path: &Path) -> anyhow::Result<File> {
    Ok(super::platform_windows::open_private_file(path)?)
}
#[cfg(not(windows))]
pub(crate) fn private_file(path: &Path) -> anyhow::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    if let Ok(meta) = std::fs::symlink_metadata(path)
        && (!meta.is_file() || meta.file_type().is_symlink())
    {
        anyhow::bail!("command state file is not regular");
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        anyhow::bail!("command state file is not regular");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 || meta.nlink() != 1
        {
            anyhow::bail!("command state file is not private");
        }
    }
    Ok(file)
}
pub fn lock(path: &Path) -> anyhow::Result<File> {
    let file = private_file(&path.join("worker.lock"))?;
    file.try_lock()
        .map_err(|_| anyhow::anyhow!("command state directory is already in use"))?;
    Ok(file)
}
impl Store {
    pub async fn open(path: &Path, host: &str, initialize: bool) -> anyhow::Result<Self> {
        let db = path.join("worker.db");
        if !initialize && !db.exists() {
            anyhow::bail!("command journal is missing");
        }
        let existed = db.exists();
        let file = private_file(&db)?;
        let empty = file.metadata()?.len() == 0;
        drop(file);
        if empty && existed {
            anyhow::bail!("existing command journal is empty")
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            let p = path.join(format!("worker.db{suffix}"));
            if p.exists() || p.is_symlink() {
                drop(private_file(&p)?);
            }
        }
        if !empty {
            let check = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(SqliteConnectOptions::new().filename(&db).read_only(true))
                .await?;
            let checked = validate_schema(&check, host).await;
            check.close().await;
            checked?;
        }
        let options = SqliteConnectOptions::new()
            .filename(db)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let expected = Sha256::digest(SCHEMA.as_bytes()).to_vec();
        if empty && initialize {
            sqlx::raw_sql(SCHEMA).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO metadata VALUES (1, ?, ?, 0)")
                .bind(&expected)
                .bind(host)
                .execute(&mut *tx)
                .await?;
        } else {
            let rows = sqlx::query("SELECT version, checksum, host, dirty FROM metadata")
                .fetch_all(&mut *tx)
                .await?;
            if rows.len() != 1
                || rows[0].try_get::<i64, _>(0)? != 1
                || rows[0].try_get::<Vec<u8>, _>(1)? != expected
                || rows[0].try_get::<String, _>(2)? != host
                || rows[0].try_get::<i64, _>(3)? != 0
            {
                anyhow::bail!("command journal schema or Host identity mismatch");
            }
        }
        tx.commit().await?;
        let result = Self { pool };
        if initialize {
            result.recover().await?;
        }
        Ok(result)
    }
    pub async fn get<M: Message + Default>(
        &self,
        table: &str,
        id: &str,
    ) -> anyhow::Result<Option<M>> {
        let query = match table {
            "roots" => "SELECT body FROM roots WHERE id=?",
            "sessions" => "SELECT body FROM sessions WHERE id=?",
            "operations" => "SELECT receipt FROM operations WHERE id=?",
            _ => anyhow::bail!("invalid journal table"),
        };
        sqlx::query_scalar::<_, Vec<u8>>(query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(|v| M::decode(v.as_slice()).map_err(Into::into))
            .transpose()
    }
    pub async fn receipt(&self, id: &str) -> anyhow::Result<CommandReceipt> {
        let row = sqlx::query("SELECT receipt,phase,session_id FROM operations WHERE id=?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        let receipt = CommandReceipt::decode(row.try_get::<Vec<u8>, _>(0)?.as_slice())?;
        if receipt.operation_id != id
            || !valid_id(&receipt.operation_id)
            || !valid_id(&receipt.session_id)
            || !valid_id(&receipt.workspace_id)
            || receipt.session_id != row.try_get::<String, _>(2)?
            || receipt.phase != row.try_get::<i32, _>(1)?
            || !(1..=9).contains(&receipt.phase)
            || receipt.generation == 0
            || receipt.sequence == 0
            || receipt.updated_at_unix_ms <= 0
            || receipt.request_sha256.len() != 32
            || receipt.execution_sha256.len() != 32
        {
            anyhow::bail!("command receipt is corrupt")
        }
        Ok(receipt)
    }
    pub async fn session(&self, id: &str) -> anyhow::Result<CommandSession> {
        self.get("sessions", id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("command session not found"))
    }
    pub async fn request(&self, id: &str) -> anyhow::Result<RunCommandRequest> {
        let bytes: Vec<u8> = sqlx::query_scalar("SELECT request FROM operations WHERE id=?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        Ok(RunCommandRequest::decode(bytes.as_slice())?)
    }
    pub async fn change(
        &self,
        id: &str,
        update: impl FnOnce(&mut CommandReceipt),
    ) -> anyhow::Result<CommandReceipt> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let data: Vec<u8> = sqlx::query_scalar("SELECT receipt FROM operations WHERE id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let mut receipt = CommandReceipt::decode(data.as_slice())?;
        update(&mut receipt);
        receipt.sequence = receipt
            .sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("receipt sequence exhausted"))?;
        receipt.updated_at_unix_ms = now();
        sqlx::query("UPDATE operations SET receipt=?, phase=? WHERE id=?")
            .bind(receipt.encode_to_vec())
            .bind(receipt.phase)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if terminal(receipt.phase) && receipt.cleanup_confirmed {
            let body: Vec<u8> = sqlx::query_scalar("SELECT body FROM sessions WHERE id=?")
                .bind(&receipt.session_id)
                .fetch_one(&mut *tx)
                .await?;
            let mut session = CommandSession::decode(body.as_slice())?;
            if session.active_operation_id == id {
                session.active_operation_id.clear();
                sqlx::query("UPDATE sessions SET body=? WHERE id=?")
                    .bind(session.encode_to_vec())
                    .bind(&session.session_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        Ok(receipt)
    }
    async fn recover(&self) -> anyhow::Result<()> {
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM operations WHERE phase IN (1,2,3,6)")
                .fetch_all(&self.pool)
                .await?;
        for id in ids {
            let r = self.receipt(&id).await?;
            if !terminal(r.phase) {
                self.change(&id, |r| {
                    if r.phase == CommandPhase::Prepared as i32 {
                        r.phase = CommandPhase::NotDispatched as i32;
                        r.no_effect_proven = true;
                        r.cleanup_confirmed = true;
                        r.reason_code = "RECOVERED_BEFORE_START".into();
                    } else {
                        r.phase = CommandPhase::Unknown as i32;
                        r.cleanup_confirmed = false;
                        r.reason_code = "INTERRUPTED_EXECUTION".into();
                    }
                })
                .await?;
            }
        }
        Ok(())
    }
}

async fn validate_schema(pool: &sqlx::SqlitePool, host: &str) -> anyhow::Result<()> {
    let rows = sqlx::query("SELECT version, checksum, host, dirty FROM metadata")
        .fetch_all(pool)
        .await?;
    if rows.len() != 1
        || rows[0].try_get::<i64, _>(0)? != 1
        || rows[0].try_get::<Vec<u8>, _>(1)? != Sha256::digest(SCHEMA.as_bytes()).to_vec()
        || rows[0].try_get::<String, _>(2)? != host
        || rows[0].try_get::<i64, _>(3)? != 0
    {
        anyhow::bail!("command journal schema or Host identity mismatch")
    }
    let schemas: Vec<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name")
            .fetch_all(pool)
            .await?;
    let expected: Vec<&str> = SCHEMA
        .split(';')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    if schemas.len() != expected.len() || schemas.iter().any(|s| !expected.contains(&s.as_str())) {
        anyhow::bail!("command journal schema was altered")
    }
    let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(pool)
        .await?;
    if integrity != "ok" {
        anyhow::bail!("command journal integrity check failed")
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn directory() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    }
    #[tokio::test]
    async fn journal_schema_host_and_empty_files_fail_closed() {
        let dir = directory();
        let lock = lock(dir.path()).unwrap();
        let host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let store = Store::open(dir.path(), host, true).await.unwrap();
        sqlx::query("UPDATE metadata SET version=42")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;
        drop(lock);
        let before = std::fs::read(dir.path().join("worker.db")).unwrap();
        assert!(Store::open(dir.path(), host, true).await.is_err());
        assert_eq!(before, std::fs::read(dir.path().join("worker.db")).unwrap());
        let other = directory();
        std::fs::write(other.path().join("worker.db"), []).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                other.path().join("worker.db"),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        assert!(Store::open(other.path(), host, true).await.is_err());
        let third = directory();
        let store = Store::open(third.path(), host, true).await.unwrap();
        store.pool.close().await;
        assert!(
            Store::open(third.path(), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", true)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn schema_changes_and_transaction_rollback_preserve_journal() {
        let dir = directory();
        let store = Store::open(dir.path(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)
            .await
            .unwrap();
        {
            let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            sqlx::query("INSERT INTO roots VALUES ('uncommitted', X'')")
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.rollback().await.unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roots")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        sqlx::query("ALTER TABLE operations ADD COLUMN unexpected TEXT")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;
        assert!(
            Store::open(dir.path(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)
                .await
                .is_err()
        );
    }
    #[test]
    #[cfg(unix)]
    fn private_state_rejects_permissions_links_and_parallel_owners() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = directory();
        let owner = lock(dir.path()).unwrap();
        assert!(lock(dir.path()).is_err());
        drop(owner);
        assert!(lock(dir.path()).is_ok());
        let target = dir.path().join("target");
        std::fs::write(&target, "keep").unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(private_file(&link).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_directory(dir.path()).is_err());
    }
}

#[cfg(all(test, unix))]
mod recovery_tests {
    use super::*;
    #[tokio::test]
    async fn restart_only_proves_prepared_and_preserves_uncertain_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let host = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let store = Store::open(dir.path(), host, true).await.unwrap();
        for (id, phase) in [
            ("safe", CommandPhase::Prepared),
            ("uncertain", CommandPhase::Starting),
        ] {
            let session = CommandSession {
                session_id: id.into(),
                active_operation_id: id.into(),
                generation: 1,
                ..Default::default()
            };
            sqlx::query("INSERT INTO sessions VALUES (?,?)")
                .bind(id)
                .bind(session.encode_to_vec())
                .execute(&store.pool)
                .await
                .unwrap();
            let receipt = CommandReceipt {
                operation_id: id.into(),
                session_id: id.into(),
                phase: phase as i32,
                generation: 1,
                workspace_id: "workspace".into(),
                request_sha256: vec![1; 32],
                execution_sha256: vec![2; 32],
                updated_at_unix_ms: now(),
                sequence: 1,
                ..Default::default()
            };
            sqlx::query(
                "INSERT INTO operations(id,session_id,request,receipt,phase) VALUES (?,?,?,?,?)",
            )
            .bind(id)
            .bind(id)
            .bind(Vec::<u8>::new())
            .bind(receipt.encode_to_vec())
            .bind(receipt.phase)
            .execute(&store.pool)
            .await
            .unwrap();
        }
        store.pool.close().await;
        let reopened = Store::open(dir.path(), host, true).await.unwrap();
        let safe = reopened.receipt("safe").await.unwrap();
        let uncertain = reopened.receipt("uncertain").await.unwrap();
        assert_eq!(safe.phase, CommandPhase::NotDispatched as i32);
        assert!(safe.cleanup_confirmed && safe.no_effect_proven);
        assert!(
            reopened
                .session("safe")
                .await
                .unwrap()
                .active_operation_id
                .is_empty()
        );
        assert_eq!(uncertain.phase, CommandPhase::Unknown as i32);
        assert!(!uncertain.cleanup_confirmed && !uncertain.no_effect_proven);
        assert_eq!(
            reopened
                .session("uncertain")
                .await
                .unwrap()
                .active_operation_id,
            "uncertain"
        );
        reopened.pool.close().await;
        let again = Store::open(dir.path(), host, true).await.unwrap();
        assert_eq!(
            again.receipt("uncertain").await.unwrap().sequence,
            uncertain.sequence
        );
        again.pool.close().await;
    }
}
