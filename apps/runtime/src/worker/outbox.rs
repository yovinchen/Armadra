//! The Worker's durable queue of unacknowledged upcalls (Go Host business
//! migration §2.9, "上行可靠性").
//!
//! An upcall is a report about something that already happened on this machine
//! — a turn ended, an approval appeared. The Host cannot re-derive it, so
//! losing the frame loses the fact. Every upcall is therefore committed here
//! *before* it is written to the channel and removed only when the Host's reply
//! acknowledges it. A Worker killed mid-flight replays from the lowest
//! unacknowledged sequence on its next connection, and the Host deduplicates by
//! `(worker_instance_id, sequence)`.
//!
//! This is a separate SQLite file rather than a table in the command journal
//! (`worker.db`). That journal validates its schema against a checksum of one
//! constant string, so adding a table to it would make every existing journal
//! refuse to open — a compatibility break for a feature that needs none.
//!
//! Two properties are load-bearing:
//!
//!   * **A sequence is never reused.** The counter lives in its own table and
//!     is not touched by acknowledgement, so retiring frames 1–9 does not let
//!     the next frame be numbered 1 again. Reuse would make the Host's
//!     deduplication silently drop a new event as a duplicate.
//!   * **Sequences are per Worker *process*, not per file.** A restarted Worker
//!     gets a new instance id and starts again at one; the rows an earlier
//!     instance left behind keep their own instance id and are replayed under
//!     it, so two lives of the same file never collide in the Host's window.

use std::path::{Path, PathBuf};

use armadra_protocol::{Message, v1::WorkerUpcall};
use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

/// `outbox` holds one row per unacknowledged frame; `attempt` is durable so a
/// replay is visibly a replay even after the process that first sent it is
/// gone. `outbox_sequence` is the monotonic counter acknowledgement never
/// touches.
const SCHEMA: &str = "CREATE TABLE outbox_meta(version INTEGER NOT NULL, checksum BLOB NOT NULL); \
CREATE TABLE outbox_sequence(instance_id TEXT PRIMARY KEY, highest INTEGER NOT NULL) WITHOUT ROWID; \
CREATE TABLE outbox(instance_id TEXT NOT NULL, sequence INTEGER NOT NULL, frame BLOB NOT NULL, attempt INTEGER NOT NULL, queued_at_ms INTEGER NOT NULL, PRIMARY KEY(instance_id, sequence)) WITHOUT ROWID;";

/// The Worker refuses to queue more than this many unacknowledged frames. A
/// Host that has stopped reading must cost bounded memory and bounded disk, and
/// the refusal is visible to the producer instead of silently dropping events.
pub const MAX_UNACKNOWLEDGED: u32 = 1024;

/// `<state-dir>/worker-upcalls.db`.
pub fn path(state_dir: &Path) -> PathBuf {
    state_dir.join("worker-upcalls.db")
}

pub struct Outbox {
    pool: SqlitePool,
    instance_id: String,
}

/// A frame as it should go on the wire, with the identity it was stored under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Queued {
    pub instance_id: String,
    pub sequence: u64,
    pub frame: WorkerUpcall,
}

fn signed(value: u64) -> anyhow::Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("upcall sequence exceeds the storage range"))
}

impl Outbox {
    /// Opens (creating if needed) the outbox beside the command journal.
    ///
    /// The caller has already proven the directory private; this only creates
    /// the file with the same 0600 discipline the command journal uses.
    pub async fn open(state_dir: &Path, instance_id: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            state_dir.is_absolute(),
            "upcall outbox directory must be absolute"
        );
        anyhow::ensure!(
            !instance_id.is_empty(),
            "upcall outbox needs an instance id"
        );
        let file = path(state_dir);
        // The command journal's private-file discipline: 0600, no symlink, no
        // hard link, owned by this user.
        let handle = crate::command::store::private_file(&file)?;
        let empty = handle.metadata()?.len() == 0;
        drop(handle);
        for suffix in ["-wal", "-shm", "-journal"] {
            let side = state_dir.join(format!("worker-upcalls.db{suffix}"));
            if side.exists() || side.is_symlink() {
                drop(crate::command::store::private_file(&side)?);
            }
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&file)
                    .create_if_missing(false)
                    .journal_mode(SqliteJournalMode::Wal)
                    // An upcall that is only in the page cache when the machine
                    // loses power is an upcall that was never durable.
                    .synchronous(SqliteSynchronous::Full)
                    .busy_timeout(std::time::Duration::from_secs(5)),
            )
            .await?;
        let expected = Sha256::digest(SCHEMA.as_bytes()).to_vec();
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        if empty {
            sqlx::raw_sql(SCHEMA).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO outbox_meta VALUES (1, ?)")
                .bind(&expected)
                .execute(&mut *tx)
                .await?;
        } else {
            let rows = sqlx::query("SELECT version, checksum FROM outbox_meta")
                .fetch_all(&mut *tx)
                .await?;
            // An outbox this build cannot read is damage, not a reason to start
            // over: dropping it would silently discard reports the Host never
            // saw. Refusing keeps the file for an operator.
            anyhow::ensure!(
                rows.len() == 1
                    && rows[0].try_get::<i64, _>(0)? == 1
                    && rows[0].try_get::<Vec<u8>, _>(1)? == expected,
                "upcall outbox schema is not the one this build wrote"
            );
        }
        // Counters for instances that are gone and owe nothing are dead weight.
        // The current instance is spared even though it owes nothing yet.
        sqlx::query(
            "DELETE FROM outbox_sequence WHERE instance_id<>? AND instance_id NOT IN (SELECT instance_id FROM outbox)",
        )
        .bind(instance_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Self {
            pool,
            instance_id: instance_id.to_owned(),
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// The highest sequence this instance has ever handed out, whether or not
    /// the frame is still pending. Zero means it has queued nothing.
    pub async fn highest_sequence(&self) -> anyhow::Result<u64> {
        let value: Option<i64> =
            sqlx::query_scalar("SELECT highest FROM outbox_sequence WHERE instance_id=?")
                .bind(&self.instance_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(value.unwrap_or(0).max(0) as u64)
    }

    /// How many frames, across every instance, still await acknowledgement.
    pub async fn unacknowledged(&self) -> anyhow::Result<u32> {
        let value: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox")
            .fetch_one(&self.pool)
            .await?;
        Ok(u32::try_from(value.max(0)).unwrap_or(u32::MAX))
    }

    /// Commits one upcall and returns it with its assigned sequence.
    ///
    /// The sequence is allocated inside the same transaction that stores the
    /// row, so two concurrent producers cannot be handed the same number and a
    /// crash between allocation and storage cannot leave a gap.
    pub async fn queue(&self, mut frame: WorkerUpcall) -> anyhow::Result<Queued> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox")
            .fetch_one(&mut *tx)
            .await?;
        anyhow::ensure!(
            pending < i64::from(MAX_UNACKNOWLEDGED),
            "upcall outbox is full; the controller is not acknowledging"
        );
        let next: i64 = sqlx::query_scalar(
            "INSERT INTO outbox_sequence(instance_id,highest) VALUES(?,1) ON CONFLICT(instance_id) DO UPDATE SET highest=highest+1 RETURNING highest",
        )
        .bind(&self.instance_id)
        .fetch_one(&mut *tx)
        .await?;
        anyhow::ensure!(next > 0, "upcall sequence space is exhausted");
        frame.worker_instance_id = self.instance_id.clone();
        frame.sequence = next as u64;
        frame.attempt = 1;
        if frame.emitted_at_unix_ms == 0 {
            frame.emitted_at_unix_ms = chrono::Utc::now().timestamp_millis();
        }
        let encoded = frame.encode_to_vec();
        anyhow::ensure!(
            !encoded.is_empty() && encoded.len() <= super::MAX_FRAME,
            "upcall does not fit in one channel frame"
        );
        sqlx::query(
            "INSERT INTO outbox(instance_id,sequence,frame,attempt,queued_at_ms) VALUES(?,?,?,1,?)",
        )
        .bind(&self.instance_id)
        .bind(next)
        .bind(&encoded)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Queued {
            instance_id: self.instance_id.clone(),
            sequence: frame.sequence,
            frame,
        })
    }

    /// Everything still unacknowledged, oldest first, across every instance
    /// that ever wrote to this file.
    ///
    /// The attempt counter is bumped as the rows are read, so what goes on the
    /// wire says how many times it has now been sent. A row whose stored frame
    /// no longer decodes, or whose body disagrees with its key, is dropped: it
    /// cannot be delivered, and keeping it would wedge the replay behind it.
    pub async fn replay(&self) -> anyhow::Result<Vec<Queued>> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let rows = sqlx::query(
            "SELECT instance_id,sequence,frame,attempt FROM outbox ORDER BY queued_at_ms,instance_id,sequence",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut queued = Vec::with_capacity(rows.len());
        let mut corrupt: Vec<(String, i64)> = Vec::new();
        for row in rows {
            let instance_id: String = row.try_get(0)?;
            let sequence: i64 = row.try_get(1)?;
            let bytes: Vec<u8> = row.try_get(2)?;
            let attempt: i64 = row.try_get(3)?;
            let readable = WorkerUpcall::decode(bytes.as_slice()).ok().filter(|frame| {
                sequence > 0
                    && frame.sequence == sequence as u64
                    && frame.worker_instance_id == instance_id
            });
            let Some(mut frame) = readable else {
                corrupt.push((instance_id, sequence));
                continue;
            };
            frame.attempt = u32::try_from(attempt.saturating_add(1)).unwrap_or(u32::MAX);
            sqlx::query("UPDATE outbox SET attempt=? WHERE instance_id=? AND sequence=?")
                .bind(i64::from(frame.attempt))
                .bind(&instance_id)
                .bind(sequence)
                .execute(&mut *tx)
                .await?;
            queued.push(Queued {
                instance_id,
                sequence: sequence as u64,
                frame,
            });
        }
        for (instance_id, sequence) in &corrupt {
            tracing::warn!(
                sequence,
                "discarding an unreadable upcall row rather than blocking the replay"
            );
            sqlx::query("DELETE FROM outbox WHERE instance_id=? AND sequence=?")
                .bind(instance_id)
                .bind(sequence)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(queued)
    }

    /// Retires every frame of `instance_id` at or below `through`.
    ///
    /// The Host acknowledges the highest *contiguous* sequence it accepted, so
    /// one reply can retire a whole replay burst. Acknowledging a sequence that
    /// was never queued is not an error: a duplicate reply after a reconnect
    /// must be harmless.
    pub async fn acknowledge(&self, instance_id: &str, through: u64) -> anyhow::Result<u64> {
        if through == 0 {
            return Ok(0);
        }
        let deleted = sqlx::query("DELETE FROM outbox WHERE instance_id=? AND sequence<=?")
            .bind(instance_id)
            .bind(signed(through)?)
            .execute(&self.pool)
            .await?;
        Ok(deleted.rows_affected())
    }

    /// Retires exactly one frame, for a reply the Host refused. A rejected
    /// frame is dropped rather than replayed forever; the Host has already
    /// recorded why it would not take it.
    pub async fn discard(&self, instance_id: &str, sequence: u64) -> anyhow::Result<bool> {
        let deleted = sqlx::query("DELETE FROM outbox WHERE instance_id=? AND sequence=?")
            .bind(instance_id)
            .bind(signed(sequence)?)
            .execute(&self.pool)
            .await?;
        Ok(deleted.rows_affected() == 1)
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}
