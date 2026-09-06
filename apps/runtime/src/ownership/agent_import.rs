//! Applying a Host agent package back into `canvas.db`
//! (Go Host 业务所有权迁移 §2.12, agent row of §3.3).
//!
//! It is the same four gates every reverse import passes — the ledger exists,
//! the Host is the settled owner, the epoch matches, an already-used identifier
//! replays — and then six tables are rewritten inside one transaction and read
//! straight back.
//!
//! Two things it deliberately does not do.
//!
//! It does not create a status, an approval, a message, a delivery or a
//! handoff. A record the Host produced while it held the domain has no row
//! here, and its row would reference a `workspaces` or `nodes` row the canvas
//! domain owns and rolls back *after* this one; inventing one would leave that
//! rollback with a record nobody exported. It is reported and blocks the
//! handback instead.
//!
//! And it does not touch a frozen bundle. `freeze_agent_handoff_bundle` aborts
//! any update that names one, and the writer never names one — which is the
//! point: a rollback restores what moved, and the bundle never moved.

use std::path::{Path, PathBuf};

use armadra_protocol::v1::{ApplyReverseExportRequest, ReverseImportReport};
use sqlx::SqlitePool;

use super::agent::{self, AgentRecords, DOMAIN};
use super::import::{
    self, PackageFile, PackageIndex, format_digest, read_raw, record_import, replayed,
    require_host_epoch, require_ledger, valid_import_id,
};
use crate::error::{AppError, AppResult};

/// The package's records after every self-description has been checked.
struct Package {
    index: PackageIndex,
    index_sha256: Vec<u8>,
    files: Vec<(PackageFile, AgentRecords)>,
}

fn invalid(detail: impl Into<String>) -> AppError {
    AppError::BadRequest(format!("reverse.package_invalid: {}", detail.into()))
}

/// Reads and verifies an agent package. Every check happens before the
/// transaction opens, so a package that does not describe itself is refused
/// rather than partially understood.
fn read(directory: &Path) -> AppResult<Package> {
    let raw = read_raw(directory, DOMAIN)?;
    let mut files = Vec::with_capacity(raw.files.len());
    let mut entities = 0u64;
    for (file, payload) in raw.files {
        let decoded = import::decode_records(&payload)?;
        // The canonical digest is what the Host compares the re-read against.
        // Checking it here means a package whose index and records disagree is
        // refused before anything is written, rather than surfacing as an
        // unexplained mismatch after the transaction.
        if format_digest(&agent::content_digest(&decoded)) != file.content_sha256 {
            return Err(invalid(format!(
                "the records in {} are not the ones the index describes",
                file.name
            )));
        }
        if file.entity_count != decoded.len() as u64 {
            return Err(invalid(format!(
                "{} claims {} entities and holds {}",
                file.name,
                file.entity_count,
                decoded.len()
            )));
        }
        let records = agent::from_records(decoded)?;
        // A file the index attributes to one workspace must hold that
        // workspace's records. A mismatch means the package's own description
        // of itself is wrong, and applying it would write rows under a
        // workspace nobody named.
        let foreign = records
            .statuses
            .iter()
            .map(|value| value.workspace_id.as_str())
            .chain(
                records
                    .approvals
                    .iter()
                    .map(|value| value.workspace_id.as_str()),
            )
            .chain(
                records
                    .messages
                    .iter()
                    .map(|value| value.workspace_id.as_str()),
            )
            .chain(
                records
                    .deliveries
                    .iter()
                    .map(|value| value.workspace_id.as_str()),
            )
            .chain(
                records
                    .handoffs
                    .iter()
                    .map(|value| value.workspace_id.as_str()),
            )
            .chain(
                records
                    .links
                    .iter()
                    .map(|value| value.workspace_id.as_str()),
            )
            .any(|workspace_id| workspace_id != file.workspace_id);
        if foreign {
            return Err(invalid(format!(
                "{} holds a record from a different workspace than the index names",
                file.name
            )));
        }
        entities = entities.saturating_add(file.entity_count);
        files.push((file, records));
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
        super::domains::OwnershipDomain::Agent,
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
        .map(|(file, records)| {
            (
                file.name.clone(),
                file.workspace_id.clone(),
                AgentRecords {
                    statuses: records.statuses.clone(),
                    approvals: records.approvals.clone(),
                    messages: records.messages.clone(),
                    deliveries: records.deliveries.clone(),
                    handoffs: records.handoffs.clone(),
                    links: records.links.clone(),
                },
            )
        })
        .collect::<Vec<_>>();
    let (mut report, mut issues) = agent::apply_records(&mut transaction, request, &files).await?;
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
                entity: format!("agent/{}", file.workspace_id),
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
