//! Canvas write ownership (host protocol design §4, step 5).
//!
//! Exactly one process writes the canvas domain. The Runtime starts as the
//! owner, and a handoff moves the domain to the Go Host under a monotonic
//! epoch. From then on the Runtime refuses canvas writes with the stable code
//! `ownership_moved` while every read keeps answering, which is what makes the
//! switch reversible: handing the epoch back re-enables writes without a
//! second migration or a database swap.
//!
//! Terminals, files, Git and hooks are deliberately absent from this record.
//! They stay with the Runtime whoever owns the canvas.

use armadra_protocol::v1::CanvasOwnershipOwner;
use axum::{Json, extract::State};
use chrono::Utc;
use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

/// The only domain this version knows. A handoff naming anything else comes
/// from a newer peer and is refused rather than stored, so a domain this
/// Runtime does not understand can never be created behind its back.
pub const CANVAS_DOMAIN: &str = "canvas";

/// Reason codes are stable localizable keys ("ownership.switch.verified"), not
/// sentences and never paths; the bound and the alphabet keep an operator's
/// filesystem out of a row the UI renders.
const MAX_REASON_CODE: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteOwner {
    Runtime,
    Host,
}

impl WriteOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Host => "host",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "runtime" => Ok(Self::Runtime),
            "host" => Ok(Self::Host),
            // The migration constrains the column, so anything else means the
            // file was written outside Armadra. Guessing an owner here would
            // hand writes to a process that may not hold them.
            _ => Err(AppError::Internal(
                "Stored write ownership names an unknown owner".into(),
            )),
        }
    }

    /// `CanvasOwnershipOwner` as it arrives on the wire. Zero (unspecified) and
    /// any value a newer peer introduced stay refused: reading an unknown owner
    /// as `Runtime` would silently take ownership back.
    pub fn from_wire(value: i32) -> AppResult<Self> {
        match CanvasOwnershipOwner::try_from(value) {
            Ok(CanvasOwnershipOwner::Runtime) => Ok(Self::Runtime),
            Ok(CanvasOwnershipOwner::Host) => Ok(Self::Host),
            _ => Err(AppError::BadRequest(
                "Write ownership owner is unspecified or unknown".into(),
            )),
        }
    }

    /// The `CanvasOwnershipOwner` number for this owner.
    pub fn to_wire(self) -> i32 {
        match self {
            Self::Runtime => CanvasOwnershipOwner::Runtime as i32,
            Self::Host => CanvasOwnershipOwner::Host as i32,
        }
    }
}

/// One stored ownership row. `GET /api/ownership` serializes exactly this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOwnership {
    pub domain: String,
    pub owner: WriteOwner,
    /// A decimal **string** on the wire. The epoch is a u64 and a JSON number
    /// stops being exact above 2^53, so the web client parses this with
    /// `BigInt` rather than silently rounding an epoch it then compares.
    #[serde(serialize_with = "serialize_epoch")]
    pub epoch: u64,
    pub reason_code: String,
    pub updated_at: String,
}

fn serialize_epoch<S: serde::Serializer>(epoch: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(epoch)
}

/// One epoch handoff. `expected_epoch` is the epoch the caller believes is
/// stored, which is what makes a repeat harmless and a stale request visible.
#[derive(Debug, Clone)]
pub struct OwnershipHandoff {
    pub domain: String,
    pub owner: WriteOwner,
    pub epoch: u64,
    pub expected_epoch: u64,
    pub reason_code: String,
}

/// SQLite stores integers signed. An epoch past `i64::MAX` is refused rather
/// than wrapped into a negative row that would then read back as damage.
fn storable_epoch(epoch: u64) -> AppResult<i64> {
    i64::try_from(epoch).map_err(|_| {
        AppError::BadRequest("Write ownership epoch exceeds the supported range".into())
    })
}

async fn fetch<'e, E>(executor: E, domain: &str) -> AppResult<WriteOwnership>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let row = sqlx::query(
        "SELECT domain, owner, epoch, reason_code, updated_at FROM write_ownership WHERE domain = ?",
    )
    .bind(domain)
    .fetch_optional(executor)
    .await?
    // The migration seeds the canvas row. A missing one is damage, and an
    // absent record must never be read as "the Runtime still owns it".
    .ok_or_else(|| AppError::NotFound("Write ownership record is missing".into()))?;
    let epoch: i64 = row.try_get("epoch")?;
    Ok(WriteOwnership {
        domain: row.try_get("domain")?,
        owner: WriteOwner::parse(row.try_get::<String, _>("owner")?.as_str())?,
        epoch: u64::try_from(epoch)
            .map_err(|_| AppError::Internal("Stored write ownership epoch is invalid".into()))?,
        reason_code: row.try_get("reason_code")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn read(pool: &SqlitePool, domain: &str) -> AppResult<WriteOwnership> {
    fetch(pool, domain).await
}

/// The write guard. Reads are never gated by it: a Runtime that handed the
/// canvas over still has to answer `load_board`, so the UI can show the board
/// it no longer owns instead of an error page.
pub async fn require_local_write(pool: &SqlitePool, domain: &str) -> AppResult<()> {
    let record = read(pool, domain).await?;
    match record.owner {
        WriteOwner::Runtime => Ok(()),
        WriteOwner::Host => Err(AppError::OwnershipMoved(format!(
            "Write ownership of {} moved to the Host at epoch {}",
            record.domain, record.epoch
        ))),
    }
}

/// Applies one handoff, or returns the stored row when that exact handoff has
/// already been applied.
///
/// Everything happens inside one `BEGIN IMMEDIATE` transaction: the row a
/// decision was made against is the row that gets updated, so a concurrent
/// handoff cannot slip between the read and the write and leave two processes
/// believing they hold the same epoch.
pub async fn apply(pool: &SqlitePool, request: OwnershipHandoff) -> AppResult<WriteOwnership> {
    if request.domain != CANVAS_DOMAIN {
        return Err(AppError::BadRequest(
            "Write ownership only covers the canvas domain".into(),
        ));
    }
    // The migration's CHECK refuses it too; refusing here keeps the reason a
    // request error instead of a database error the caller cannot act on.
    if request.epoch == 0 {
        return Err(AppError::BadRequest(
            "Write ownership epoch must be greater than zero".into(),
        ));
    }
    if request.reason_code.len() > MAX_REASON_CODE
        || !request
            .reason_code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(AppError::BadRequest(
            "Write ownership reason code is invalid".into(),
        ));
    }
    let epoch = storable_epoch(request.epoch)?;
    storable_epoch(request.expected_epoch)?;
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let stored = fetch(&mut *transaction, &request.domain).await?;
    // An exact replay is the Host retrying a request whose answer it lost.
    // Returning the stored row keeps the retry harmless; failing it would
    // strand a switch that already happened.
    if stored.owner == request.owner && stored.epoch == request.epoch {
        transaction.rollback().await?;
        return Ok(stored);
    }
    if request.expected_epoch != stored.epoch {
        return Err(AppError::Conflict(
            "Write ownership epoch does not match the stored one".into(),
        ));
    }
    if request.epoch <= stored.epoch {
        return Err(AppError::Conflict(
            "Write ownership epoch must move forward".into(),
        ));
    }
    let updated_at = Utc::now().to_rfc3339();
    let stored_epoch = storable_epoch(stored.epoch)?;
    let changed = sqlx::query(
        "UPDATE write_ownership SET owner = ?, epoch = ?, reason_code = ?, updated_at = ? \
         WHERE domain = ? AND epoch = ?",
    )
    .bind(request.owner.as_str())
    .bind(epoch)
    .bind(&request.reason_code)
    .bind(&updated_at)
    .bind(&request.domain)
    .bind(stored_epoch)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(AppError::Conflict(
            "Write ownership changed while it was being handed over".into(),
        ));
    }
    let applied = fetch(&mut *transaction, &request.domain).await?;
    transaction.commit().await?;
    Ok(applied)
}

/// `GET /api/ownership` — who may write the canvas domain right now.
pub async fn current(State(state): State<AppState>) -> AppResult<Json<WriteOwnership>> {
    Ok(Json(read(&state.pool, CANVAS_DOMAIN).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    async fn pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let pool = db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("ownership.db").display()
        ))
        .await
        .unwrap();
        (pool, directory)
    }

    fn handoff(owner: WriteOwner, epoch: u64, expected: u64) -> OwnershipHandoff {
        OwnershipHandoff {
            domain: CANVAS_DOMAIN.into(),
            owner,
            epoch,
            expected_epoch: expected,
            reason_code: "ownership.switch.verified".into(),
        }
    }

    #[tokio::test]
    async fn a_migrated_runtime_owns_the_canvas_and_may_write_it() {
        let (pool, _directory) = pool().await;
        let record = read(&pool, CANVAS_DOMAIN).await.unwrap();
        assert_eq!(record.owner, WriteOwner::Runtime);
        assert_eq!(record.epoch, 1);
        assert_eq!(record.reason_code, "ownership.initial");
        require_local_write(&pool, CANVAS_DOMAIN).await.unwrap();
    }

    #[tokio::test]
    async fn handoff_is_monotonic_cas_checked_and_idempotent_on_replay() {
        let (pool, _directory) = pool().await;
        let moved = apply(&pool, handoff(WriteOwner::Host, 2, 1)).await.unwrap();
        assert_eq!(moved.owner, WriteOwner::Host);
        assert_eq!(moved.epoch, 2);
        assert!(matches!(
            require_local_write(&pool, CANVAS_DOMAIN).await,
            Err(AppError::OwnershipMoved(_))
        ));
        // The exact same handoff again is the Host retrying a lost answer.
        let replay = apply(&pool, handoff(WriteOwner::Host, 2, 1)).await.unwrap();
        assert_eq!(replay, moved);
        // Even a replay that names the new epoch as expected stays harmless.
        assert_eq!(
            apply(&pool, handoff(WriteOwner::Host, 2, 2)).await.unwrap(),
            moved
        );
        for stale in [
            handoff(WriteOwner::Runtime, 2, 2),
            handoff(WriteOwner::Runtime, 1, 1),
            handoff(WriteOwner::Runtime, 3, 1),
        ] {
            assert!(matches!(
                apply(&pool, stale).await,
                Err(AppError::Conflict(_))
            ));
        }
        // Nothing above touched the row it was refused against.
        assert_eq!(read(&pool, CANVAS_DOMAIN).await.unwrap(), moved);
    }

    #[tokio::test]
    async fn a_refused_handoff_leaves_the_stored_row_untouched() {
        let (pool, _directory) = pool().await;
        let before = read(&pool, CANVAS_DOMAIN).await.unwrap();
        for refused in [
            OwnershipHandoff {
                domain: "terminal".into(),
                ..handoff(WriteOwner::Host, 2, 1)
            },
            OwnershipHandoff {
                epoch: 0,
                ..handoff(WriteOwner::Host, 0, 1)
            },
            OwnershipHandoff {
                reason_code: "/Users/someone/secret".into(),
                ..handoff(WriteOwner::Host, 2, 1)
            },
            handoff(WriteOwner::Host, u64::MAX, 1),
            handoff(WriteOwner::Host, 2, 7),
        ] {
            assert!(apply(&pool, refused).await.is_err());
            assert_eq!(read(&pool, CANVAS_DOMAIN).await.unwrap(), before);
        }
        // An unspecified or newer-than-known owner never reaches the store.
        for value in [0, 3, 999, -1] {
            assert!(matches!(
                WriteOwner::from_wire(value),
                Err(AppError::BadRequest(_))
            ));
        }
    }

    #[tokio::test]
    async fn ownership_can_be_handed_back_to_the_runtime() {
        let (pool, _directory) = pool().await;
        apply(&pool, handoff(WriteOwner::Host, 2, 1)).await.unwrap();
        let back = apply(
            &pool,
            OwnershipHandoff {
                reason_code: "ownership.rollback".into(),
                ..handoff(WriteOwner::Runtime, 3, 2)
            },
        )
        .await
        .unwrap();
        assert_eq!(back.owner, WriteOwner::Runtime);
        assert_eq!(back.epoch, 3);
        require_local_write(&pool, CANVAS_DOMAIN).await.unwrap();
    }

    #[tokio::test]
    async fn a_missing_row_is_damage_rather_than_an_assumed_runtime_owner() {
        let (pool, _directory) = pool().await;
        sqlx::query("DELETE FROM write_ownership")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            read(&pool, CANVAS_DOMAIN).await,
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            require_local_write(&pool, CANVAS_DOMAIN).await,
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn the_epoch_is_reported_as_a_decimal_string() {
        let body = serde_json::to_value(WriteOwnership {
            domain: CANVAS_DOMAIN.into(),
            owner: WriteOwner::Host,
            epoch: 9_007_199_254_740_993,
            reason_code: "ownership.switch.verified".into(),
            updated_at: "2026-09-06T00:00:00Z".into(),
        })
        .unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "domain": "canvas",
                "owner": "host",
                "epoch": "9007199254740993",
                "reasonCode": "ownership.switch.verified",
                "updatedAt": "2026-09-06T00:00:00Z",
            })
        );
    }
}
