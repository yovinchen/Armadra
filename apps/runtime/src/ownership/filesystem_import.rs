//! Applying a Host filesystem package back into `canvas.db`
//! (Go Host 业务所有权迁移 §2.12, filesystem row of §3.3).
//!
//! It is the same four gates every reverse import passes — the ledger exists,
//! the Host is the settled owner, the epoch matches, an already-used identifier
//! replays — and then three columns of `workspaces` are written inside one
//! transaction and read straight back.
//!
//! What it deliberately does *not* do is create a workspace. The `workspaces`
//! row belongs to the canvas domain, which rolls back after this one; a
//! filesystem package that names a workspace this database does not have is
//! reported as an error issue and blocks the handback, rather than inventing a
//! row the canvas rollback would then have to reconcile with.

use std::path::{Path, PathBuf};

use armadra_protocol::v1::{ApplyReverseExportRequest, ReverseImportReport, WorkspaceRoot};
use sqlx::SqlitePool;

use super::filesystem::{self, DOMAIN};
use super::import::{
    self, PackageFile, PackageIndex, format_digest, read_raw, record_import, replayed,
    require_host_epoch, require_ledger, valid_import_id,
};
use crate::error::{AppError, AppResult};

/// The package's roots after every self-description has been checked: the
/// index, the digest of the index bytes, and one root per file.
struct Package {
    index: PackageIndex,
    index_sha256: Vec<u8>,
    roots: Vec<(PackageFile, WorkspaceRoot)>,
}

fn invalid(detail: impl Into<String>) -> AppError {
    AppError::BadRequest(format!("reverse.package_invalid: {}", detail.into()))
}

/// Reads and verifies a filesystem package. Every check happens before the
/// transaction opens, so a package that does not describe itself is refused
/// rather than partially understood.
fn read(directory: &Path) -> AppResult<Package> {
    let raw = read_raw(directory, DOMAIN)?;
    let mut roots = Vec::with_capacity(raw.files.len());
    let mut entities = 0u64;
    for (file, payload) in raw.files {
        let root = filesystem::root_from_records(import::decode_records(&payload)?)?;
        if root.workspace_id != file.workspace_id {
            return Err(invalid(format!(
                "{} holds a different workspace than the index names",
                file.name
            )));
        }
        // The canonical digest is what the Host compares the re-read against.
        // Checking it here means a package whose index and records disagree is
        // refused before anything is written, rather than surfacing as an
        // unexplained mismatch after the transaction.
        if format_digest(&filesystem::content_digest(&root)) != file.content_sha256 {
            return Err(invalid(format!(
                "the records in {} are not the ones the index describes",
                file.name
            )));
        }
        if file.entity_count != 1 {
            return Err(invalid(format!(
                "{} claims {} entities; a root file holds exactly one",
                file.name, file.entity_count
            )));
        }
        entities = entities.saturating_add(1);
        roots.push((file, root));
    }
    if entities != raw.index.entity_count {
        return Err(invalid("the index entity count does not match its files"));
    }
    Ok(Package {
        index: raw.index,
        index_sha256: raw.index_sha256,
        roots,
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
        super::domains::OwnershipDomain::Filesystem,
        request,
        package.index.epoch,
    )
    .await?;
    if let Some(report) = replayed(&mut transaction, request, &package.index_sha256).await? {
        transaction.rollback().await?;
        return Ok(report);
    }

    let files = package
        .roots
        .iter()
        .map(|(file, root)| (file.name.clone(), root.clone()))
        .collect::<Vec<_>>();
    let (mut report, mut issues) =
        filesystem::apply_roots(&mut transaction, request, &files).await?;
    for (file, _) in &package.roots {
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
                entity: format!("workspaces/{}", file.workspace_id),
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
