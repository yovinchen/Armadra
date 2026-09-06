//! Applying a Host session package back into `canvas.db`
//! (Go Host 业务所有权迁移 §2.12, session row of §3.3).
//!
//! It is the same four gates every reverse import passes — the ledger exists,
//! the Host is the settled owner, the epoch matches, an already-used identifier
//! replays — and then `terminal_sessions` is rewritten inside one transaction
//! and read straight back.
//!
//! What it deliberately does *not* do is create a session. A session the Host
//! opened while it held the domain has no row here, and its row would reference
//! a `workspaces` row the canvas domain owns and rolls back after this one;
//! inventing one would leave that rollback with a session nobody exported. It
//! is reported as an error issue and blocks the handback instead.
//!
//! A tombstone does the opposite and deletes. The Host closed that session, and
//! restoring the row would resurrect a terminal the user removed — which is the
//! one direction a rollback must never quietly take.

use std::path::{Path, PathBuf};

use armadra_protocol::v1::{ApplyReverseExportRequest, ReverseImportReport};
use sqlx::SqlitePool;

use super::import::{
    self, PackageFile, PackageIndex, format_digest, read_raw, record_import, replayed,
    require_host_epoch, require_ledger, valid_import_id,
};
use super::session::{self, DOMAIN, PackageSessions};
use crate::error::{AppError, AppResult};

/// The package's sessions after every self-description has been checked: the
/// index, the digest of the index bytes, and one group per file.
struct Package {
    index: PackageIndex,
    index_sha256: Vec<u8>,
    files: Vec<(PackageFile, PackageSessions)>,
}

fn invalid(detail: impl Into<String>) -> AppError {
    AppError::BadRequest(format!("reverse.package_invalid: {}", detail.into()))
}

/// Reads and verifies a session package. Every check happens before the
/// transaction opens, so a package that does not describe itself is refused
/// rather than partially understood.
fn read(directory: &Path) -> AppResult<Package> {
    let raw = read_raw(directory, DOMAIN)?;
    let mut files = Vec::with_capacity(raw.files.len());
    let mut entities = 0u64;
    for (file, payload) in raw.files {
        let records = import::decode_records(&payload)?;
        // The canonical digest is what the Host compares the re-read against.
        // Checking it here means a package whose index and records disagree is
        // refused before anything is written, rather than surfacing as an
        // unexplained mismatch after the transaction.
        if format_digest(&session::content_digest(&records)) != file.content_sha256 {
            return Err(invalid(format!(
                "the records in {} are not the ones the index describes",
                file.name
            )));
        }
        if file.entity_count != records.len() as u64 {
            return Err(invalid(format!(
                "{} claims {} entities and holds {}",
                file.name,
                file.entity_count,
                records.len()
            )));
        }
        let package = session::from_records(records)?;
        // A file the index attributes to one workspace must hold that
        // workspace's sessions. A mismatch here means the package's own
        // description of itself is wrong, and applying it would write rows
        // under a workspace nobody named.
        for stored in &package.sessions {
            if stored.workspace_id != file.workspace_id {
                return Err(invalid(format!(
                    "{} holds a session from a different workspace than the index names",
                    file.name
                )));
            }
        }
        // A run has to belong to a session in the same file, or the generation
        // it describes belongs to nothing.
        for run in &package.runs {
            if !package
                .sessions
                .iter()
                .any(|stored| stored.session_id == run.session_id)
            {
                return Err(invalid(format!(
                    "{} holds a run whose session it does not carry",
                    file.name
                )));
            }
        }
        entities = entities.saturating_add(file.entity_count);
        files.push((file, package));
    }
    if entities != raw.index.entity_count {
        return Err(invalid("the index entity count does not match its files"));
    }
    Ok(Package {
        index: raw.index,
        index_sha256: raw.index_sha256,
        files,
    })
}

pub async fn apply(
    pool: &SqlitePool,
    request: &ApplyReverseExportRequest,
) -> AppResult<ReverseImportReport> {
    if !valid_import_id(&request.import_id) {
        return Err(invalid("the import identifier is missing or not portable"));
    }
    require_ledger(pool).await?;
    let package = read(&PathBuf::from(&request.package_path))?;
    if !request.index_sha256.is_empty() && request.index_sha256 != package.index_sha256 {
        return Err(AppError::Conflict(
            "reverse.index_mismatch: the package index is not the one the controller asked for"
                .into(),
        ));
    }

    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    require_host_epoch(
        &mut transaction,
        super::domains::OwnershipDomain::Session,
        request,
        package.index.epoch,
    )
    .await?;
    if let Some(report) = replayed(&mut transaction, request, &package.index_sha256).await? {
        transaction.rollback().await?;
        return Ok(report);
    }

    let files = package
        .files
        .iter()
        .map(|(file, sessions)| {
            (
                file.name.clone(),
                PackageSessions {
                    sessions: sessions.sessions.clone(),
                    runs: sessions.runs.clone(),
                },
            )
        })
        .collect::<Vec<_>>();
    let (mut report, mut issues) =
        session::apply_sessions(&mut transaction, request, &files).await?;
    for (file, _) in &package.files {
        let Some(back) = report
            .reexported
            .iter()
            .find(|entry| entry.name == file.name)
        else {
            continue;
        };
        if format_digest(&back.content_sha256) != file.content_sha256 {
            issues.push(armadra_protocol::v1::ExportIssue {
                code: "reverse.reexport_differs".into(),
                severity: "error".into(),
                entity: format!("terminal_sessions/{}", file.workspace_id),
                detail: "the rows read back are not the ones the package describes".into(),
            });
        }
    }
    if !issues.is_empty() {
        // The transaction is dropped without a commit, so nothing was applied.
        // The first issue names the case, because "something differed" is not
        // something an operator can act on.
        let first = issues.remove(0);
        return Err(AppError::Conflict(format!(
            "{}: {}",
            first.code, first.detail
        )));
    }

    report.epoch = package.index.epoch;
    report.index_sha256 = package.index_sha256.clone();
    report.entity_count = package.index.entity_count;
    record_import(
        &mut transaction,
        DOMAIN,
        request,
        &package.index,
        &package.index_sha256,
        &report,
    )
    .await?;
    transaction.commit().await?;
    Ok(report)
}
