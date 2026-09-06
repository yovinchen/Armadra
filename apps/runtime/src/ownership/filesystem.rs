//! The filesystem domain's rows, and the reverse import that puts them back
//! (Go Host 业务所有权迁移 §2.5, §2.12, §3.3 filesystem row).
//!
//! This domain has no table of its own here. Where a workspace's files are and
//! what may be done with them are three columns of `workspaces` —
//! `root_path`, `execution_host_id` and `permissions_json` — and a switch moves
//! the *decision* about them, never the files. So both directions are narrow:
//!
//!   * reading (`roots`) turns those columns into the `WorkspaceRoot` records
//!     the Host compares its own registrations against, and
//!   * applying (`apply`) writes them back into existing rows, in one
//!     transaction, and re-reads them so the Host can compare what this Runtime
//!     actually holds with the package it wrote.
//!
//! A workspace the package names and this database does not have is reported as
//! an issue rather than created. The `workspaces` row belongs to the canvas
//! domain, which rolls back *after* this one; inventing a row here would leave
//! the canvas rollback with a workspace nobody exported.
//!
//! The canonical digest — the one the Host compares against — clears every
//! field this Runtime has nowhere to store: the Host's `revision`, its
//! registration proof, and its own registration timestamps. Those are facts
//! about the Host's record, not about where the files are, and including them
//! would make the comparison that decides whether a rollback landed permanently
//! false.

use armadra_protocol::v1::{
    ApplyReverseExportRequest, CanvasWorkspacePermissions, ExportIssue, ExportTable,
    ReverseExportFile, ReverseExportRecord, ReverseImportReport, WorkspaceRoot,
    reverse_export_record::Entity,
};
use sqlx::{Row, SqlitePool};

use super::records::{self, digest, encode_records};
use crate::error::AppResult;

/// The domain name in the package index and on the Worker channel.
pub const DOMAIN: &str = super::domains::OwnershipDomain::Filesystem.as_str();

/// The tables a filesystem reverse import writes.
pub const TOUCHED_TABLES: [&str; 1] = ["workspaces"];

/// Reads every workspace's root as the contract sees it, ordered by identifier
/// so two readings of an unchanged database produce identical bytes.
pub async fn roots<'e, E>(executor: E) -> AppResult<Vec<WorkspaceRoot>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let rows = sqlx::query(
        "SELECT id, root_path, execution_host_id, permissions_json, created_at, updated_at \
         FROM workspaces ORDER BY id",
    )
    .fetch_all(executor)
    .await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let permissions_json: String = row.try_get("permissions_json")?;
        // An unreadable permission document is not read as "everything
        // allowed": the stored default is what the workspace row means when it
        // was written before the column existed, and it is the same default
        // `db::workspaces` applies on every other read.
        let permissions =
            serde_json::from_str::<crate::model::WorkspacePermissions>(&permissions_json)
                .unwrap_or_default();
        result.push(WorkspaceRoot {
            workspace_id: row.try_get("id")?,
            execution_host_id: row.try_get("execution_host_id")?,
            canonical_path: row.try_get("root_path")?,
            proof_sha256: Vec::new(),
            permissions: Some(CanvasWorkspacePermissions {
                read: permissions.read,
                write: permissions.write,
                execute: permissions.execute,
            }),
            registered_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            revision: 0,
            deleted: false,
        });
    }
    Ok(result)
}

/// One root in the form both sides hash. Everything the Runtime cannot store is
/// cleared here, in one place, so the Host's writer and this reader cannot
/// disagree about what is being compared.
pub fn canonical(root: &WorkspaceRoot) -> WorkspaceRoot {
    WorkspaceRoot {
        workspace_id: root.workspace_id.clone(),
        execution_host_id: root.execution_host_id.clone(),
        canonical_path: root.canonical_path.clone(),
        proof_sha256: Vec::new(),
        permissions: root.permissions,
        registered_at_unix_ms: 0,
        updated_at_unix_ms: 0,
        revision: 0,
        deleted: false,
    }
}

/// The digest of one root's entity file in canonical form.
pub fn content_digest(root: &WorkspaceRoot) -> Vec<u8> {
    digest(&encode_records(&[ReverseExportRecord {
        entity: Some(Entity::WorkspaceRoot(canonical(root))),
    }]))
}

/// Groups one entity file's records into the single root it must contain. A
/// file that carries a canvas entity, two roots, or nothing at all is a package
/// this reader refuses rather than one it reads half of.
pub fn root_from_records(records: Vec<ReverseExportRecord>) -> AppResult<WorkspaceRoot> {
    let mut found: Option<WorkspaceRoot> = None;
    for record in records {
        match record.entity {
            Some(Entity::WorkspaceRoot(root)) => {
                if found.replace(root).is_some() {
                    return Err(records::corrupt("an entity file names two roots"));
                }
            }
            Some(_) => {
                return Err(records::unsupported(
                    "a filesystem package carries an entity that is not a workspace root",
                ));
            }
            None => {
                return Err(records::unsupported(
                    "an entity record names no known entity",
                ));
            }
        }
    }
    found.ok_or_else(|| records::corrupt("an entity file carries no workspace root"))
}

/// Applies one package's roots inside the caller's transaction and reports what
/// the rows say afterwards.
///
/// The read-back is the point. A report assembled from the records that were
/// about to be written would prove only that this process can hash its own
/// buffer; the digests below come from a fresh read of the rows.
pub async fn apply_roots(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    request: &ApplyReverseExportRequest,
    files: &[(String, WorkspaceRoot)],
) -> AppResult<(ReverseImportReport, Vec<ExportIssue>)> {
    let mut written = 0u64;
    let mut issues = Vec::new();
    for (name, root) in files {
        let permissions = records::permissions_json(root.permissions.as_ref());
        let affected = sqlx::query(
            "UPDATE workspaces SET root_path = ?, execution_host_id = ?, permissions_json = ? \
             WHERE id = ?",
        )
        .bind(&root.canonical_path)
        .bind(&root.execution_host_id)
        .bind(&permissions)
        .bind(&root.workspace_id)
        .execute(&mut **transaction)
        .await?
        .rows_affected();
        if affected == 0 {
            // The workspace row belongs to the canvas domain, which rolls back
            // after this one. Creating it here would leave that rollback with a
            // workspace nobody exported.
            issues.push(ExportIssue {
                code: "reverse.missing_workspace".into(),
                severity: "error".into(),
                entity: format!("workspaces/{}", root.workspace_id),
                detail: format!("{name} names a workspace this database does not have"),
            });
            continue;
        }
        written += affected;
    }

    let stored = roots(&mut **transaction).await?;
    let mut reexported = Vec::with_capacity(files.len());
    for (name, root) in files {
        let Some(back) = stored
            .iter()
            .find(|value| value.workspace_id == root.workspace_id)
        else {
            continue;
        };
        reexported.push(ReverseExportFile {
            name: name.clone(),
            workspace_id: root.workspace_id.clone(),
            bytes: 0,
            sha256: Vec::new(),
            content_sha256: content_digest(back),
            entity_count: 1,
        });
    }
    let report = ReverseImportReport {
        import_id: request.import_id.clone(),
        domain: DOMAIN.into(),
        epoch: 0,
        index_sha256: Vec::new(),
        entity_count: reexported.len() as u64,
        replayed: false,
        reexported,
        tables: vec![ExportTable {
            name: TOUCHED_TABLES[0].into(),
            row_count: written,
            readable: true,
            schema_sha256: Vec::new(),
        }],
        issues: Vec::new(),
        applied_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    };
    Ok((report, issues))
}

/// The Worker channel's read (worker.proto action 26). It is the same reader
/// the import uses, so the Host compares a handback against exactly the rows a
/// switch would have been verified against.
pub async fn worker_roots(pool: &SqlitePool) -> AppResult<Vec<WorkspaceRoot>> {
    roots(pool).await
}
