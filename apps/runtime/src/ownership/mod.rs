//! Write ownership per business domain (host protocol design §4, step 5;
//! Go Host 业务所有权迁移 §2.2).
//!
//! Exactly one process writes each domain. The Runtime starts as the owner of
//! all six, and a handoff moves one domain at a time to the Go Host under a
//! monotonic epoch. From then on the Runtime refuses that domain's writes with
//! the stable code `ownership_moved` while every read keeps answering, which is
//! what makes the switch reversible: handing the epoch back re-enables writes
//! without a second migration or a database swap.
//!
//! Terminals, files, Git and hooks are deliberately absent from this record.
//! They stay with the Runtime whoever owns the canvas.
//!
//! [`import`] is the other half of that reversibility: handing the epoch back
//! is only half a rollback, and the Host's reverse export has to be applied to
//! this database before the epoch moves.
//!
//! The domains are independent. Handing the canvas over says nothing about
//! terminals, files or Git; each has its own row, its own epoch and its own
//! guard, and only the canvas guard is wired into routes today.
//!
//! Execution stays here whoever owns a domain: PTYs, the filesystem, Git
//! commands and Hook endpoints are not ownership, they are the machine.

pub mod domains;
pub mod filesystem;
pub mod filesystem_import;
pub mod import;
pub mod import_cli;
pub mod records;

use armadra_protocol::v1::CanvasOwnershipOwner;
use axum::{Json, extract::State};
use chrono::Utc;
use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

pub use domains::OwnershipDomain;

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
    pub domain: OwnershipDomain,
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
    pub domain: OwnershipDomain,
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

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> AppResult<WriteOwnership> {
    let epoch: i64 = row.try_get("epoch")?;
    Ok(WriteOwnership {
        domain: OwnershipDomain::parse_stored(row.try_get::<String, _>("domain")?.as_str())?,
        owner: WriteOwner::parse(row.try_get::<String, _>("owner")?.as_str())?,
        epoch: u64::try_from(epoch)
            .map_err(|_| AppError::Internal("Stored write ownership epoch is invalid".into()))?,
        reason_code: row.try_get("reason_code")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn fetch<'e, E>(executor: E, domain: OwnershipDomain) -> AppResult<WriteOwnership>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let row = sqlx::query(
        "SELECT domain, owner, epoch, reason_code, updated_at FROM write_ownership WHERE domain = ?",
    )
    .bind(domain.as_str())
    .fetch_optional(executor)
    .await?
    // The migrations seed one row per domain. A missing one is damage, and an
    // absent record must never be read as "the Runtime still owns it".
    .ok_or_else(|| AppError::NotFound("Write ownership record is missing".into()))?;
    row_to_record(row)
}

pub async fn read(pool: &SqlitePool, domain: OwnershipDomain) -> AppResult<WriteOwnership> {
    fetch(pool, domain).await
}

/// The same read against an open transaction. A reverse import decides on the
/// record inside the transaction it is going to write in, so the owner it
/// checked cannot change between the check and the write.
pub async fn read_in<'e, E>(executor: E, domain: OwnershipDomain) -> AppResult<WriteOwnership>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    fetch(executor, domain).await
}

/// Every domain, in switch order. A domain whose row is missing is reported as
/// damage for the whole read: a shorter list would look like a domain that
/// simply does not exist here, which is the one thing this record must never
/// be read as.
pub async fn read_all(pool: &SqlitePool) -> AppResult<Vec<WriteOwnership>> {
    let mut records = Vec::with_capacity(OwnershipDomain::ALL.len());
    for domain in OwnershipDomain::ALL {
        records.push(fetch(pool, domain).await?);
    }
    Ok(records)
}

/// The write guard. Reads are never gated by it: a Runtime that handed the
/// canvas over still has to answer `load_board`, so the UI can show the board
/// it no longer owns instead of an error page.
///
/// The guard is per domain. A route protected for one domain stays open when a
/// different domain moves, because that is exactly what independent epochs
/// mean.
pub async fn require_local_write(pool: &SqlitePool, domain: OwnershipDomain) -> AppResult<()> {
    let record = read(pool, domain).await?;
    match record.owner {
        WriteOwner::Runtime => Ok(()),
        WriteOwner::Host => Err(AppError::OwnershipMoved(format!(
            "Write ownership of {} moved to the Host at epoch {}",
            record.domain.as_str(),
            record.epoch
        ))),
    }
}

/// The same question asked by something that has an answer either way.
///
/// Probe caches are the one thing that writes the settings document outside the
/// settings routes: a read route refreshes an agent or language-server probe
/// and persists it as a side effect. Gating those like a route would make the
/// read itself fail once the Host owns the domain, which is the opposite of
/// what the guard is for; writing them anyway would leave two processes
/// editing one file. Skipping the persist costs exactly one re-probe, which is
/// what the call sites already tolerate when a write fails.
///
/// A record that cannot be read answers `false`. Who may write is then
/// unknown, and a cache is never worth resolving that in favour of writing.
pub async fn local_write_allowed(pool: &SqlitePool, domain: OwnershipDomain) -> bool {
    matches!(
        read(pool, domain).await,
        Ok(WriteOwnership {
            owner: WriteOwner::Runtime,
            ..
        })
    )
}

/// Applies one handoff, or returns the stored row when that exact handoff has
/// already been applied.
///
/// Everything happens inside one `BEGIN IMMEDIATE` transaction: the row a
/// decision was made against is the row that gets updated, so a concurrent
/// handoff cannot slip between the read and the write and leave two processes
/// believing they hold the same epoch.
pub async fn apply(pool: &SqlitePool, request: OwnershipHandoff) -> AppResult<WriteOwnership> {
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
    let stored = fetch(&mut *transaction, request.domain).await?;
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
    .bind(request.domain.as_str())
    .bind(stored_epoch)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(AppError::Conflict(
            "Write ownership changed while it was being handed over".into(),
        ));
    }
    let applied = fetch(&mut *transaction, request.domain).await?;
    transaction.commit().await?;
    Ok(applied)
}

/// `GET /api/ownership` — who may write the canvas domain right now. The shape
/// is unchanged from the single-domain phase; clients that only ever cared
/// about the canvas keep reading exactly this.
pub async fn current(State(state): State<AppState>) -> AppResult<Json<WriteOwnership>> {
    Ok(Json(read(&state.pool, OwnershipDomain::Canvas).await?))
}

/// `GET /api/ownership/domains` — all six records, in switch order. This is
/// what a client renders "who writes what" from; it is a list because there is
/// no domain whose owner may be inferred from another's.
pub async fn all(State(state): State<AppState>) -> AppResult<Json<Vec<WriteOwnership>>> {
    Ok(Json(read_all(&state.pool).await?))
}

#[cfg(test)]
mod filesystem_tests;
#[cfg(test)]
mod tests;
