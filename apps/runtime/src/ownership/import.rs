//! Applying a Host reverse export package back into `canvas.db`
//! (Go Host 业务所有权迁移 §2.12).
//!
//! Writing the package was the first phase's whole rollback: the Host produced
//! a directory and an operator accepted, in one explicit flag, that whatever it
//! held only existed there. This is the reader that flag was standing in for.
//!
//! Four properties are the point of the file:
//!
//!   - **One transaction.** Every workspace in the package is applied inside a
//!     single `BEGIN IMMEDIATE`. A failure on the last row leaves the database
//!     exactly as it was, so a refused rollback is never a half rollback.
//!   - **Verified before applied.** The index digest, each file's digest, each
//!     file's canonical digest and the package's internal references are all
//!     checked before the transaction opens. A package that does not describe
//!     itself is refused rather than partially understood.
//!   - **Idempotent.** `host_imports` records what was applied. The same
//!     `import_id` with the same index digest replays the original report and
//!     writes nothing; with a different digest it is refused.
//!   - **Re-read afterwards.** The report carries the Runtime's own digest of
//!     the rows it now holds, taken after the write. The Host compares that
//!     with the package it produced, and only then hands the epoch back.
//!
//! Rows the package does not describe are not invented and not destroyed:
//! `execution_host_id` and the retired `kanban_json` are execution-host and
//! historical facts with no place in a canvas entity, so existing rows are
//! updated in place rather than deleted and recreated. Objects the package no
//! longer names are removed; workspaces it does not mention at all are left
//! alone, because deleting one would cascade into terminals and links that
//! never belonged to the canvas domain.

use std::path::{Path, PathBuf};

use armadra_protocol::{
    Message,
    v1::{
        ApplyReverseExportRequest, ExportIssue, ExportTable, ReverseExportFile, ReverseImportReport,
    },
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

pub use super::records::decode_records;
use super::records::{self, ApplyPlan, WorkspaceRecords};
use crate::error::{AppError, AppResult};

/// The only package format this build applies. Version 1 had no reader at all,
/// so there is nothing to be compatible with; a version 1 directory is named in
/// the refusal so an operator knows to re-export rather than to retry.
pub const PACKAGE_FORMAT_VERSION: u32 = 2;
pub const INDEX_FILE: &str = "export.json";
/// The reverse import is the rollback of the canvas domain. Other domains get
/// their own record and their own reader; naming one here is refused.
pub const CANVAS_DOMAIN: &str = super::domains::OwnershipDomain::Canvas.as_str();

const MAX_INDEX_BYTES: u64 = 8 << 20;
const MAX_FILE_BYTES: u64 = 512 << 20;
const MAX_FILES: usize = 4096;

/// `export.json`, as the Host writes it. Digests are hexadecimal so the file
/// stays readable without a decoder, which is the reason the index is JSON at
/// all. Unknown members are rejected: a field this build silently ignored
/// would be a package property nobody verified.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageFile {
    pub name: String,
    pub workspace_id: String,
    pub bytes: u64,
    pub sha256: String,
    pub content_sha256: String,
    pub entity_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageIndex {
    pub format_version: u32,
    pub host_id: String,
    pub epoch: u64,
    pub event_sequence: u64,
    pub domain: String,
    pub entity_count: u64,
    pub files: Vec<PackageFile>,
}

fn invalid(detail: impl Into<String>) -> AppError {
    AppError::BadRequest(format!("reverse.package_invalid: {}", detail.into()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A sha256 as an operator types it. Anything that is not exactly 32 bytes of
/// hexadecimal is refused rather than padded or truncated.
pub fn parse_digest(value: &str) -> AppResult<Vec<u8>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("a digest is not a sha256"));
    }
    (0..32)
        .map(|index| u8::from_str_radix(&value[index * 2..index * 2 + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| invalid("a digest is not a sha256"))
}

pub fn format_digest(bytes: &[u8]) -> String {
    hex(bytes)
}

/// The identifier an operator gets when they do not name one: the digest of
/// the package's own index. Running the identical command twice is then a
/// replay by construction rather than a second import of the same bytes.
pub fn default_import_id(directory: &Path) -> AppResult<String> {
    let raw = std::fs::read(directory.join(INDEX_FILE))?;
    if raw.len() as u64 > MAX_INDEX_BYTES {
        return Err(invalid(
            "the package index is larger than any package needs",
        ));
    }
    Ok(hex(&records::digest(&raw)))
}

/// A package file name may only name a file in the package directory. No
/// separators, no parent references, no absolute paths: a rollback package can
/// come from another machine and must not be able to point at one of ours.
fn package_member(directory: &Path, name: &str) -> AppResult<PathBuf> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name == INDEX_FILE
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(invalid("a package file name is not a plain file name"));
    }
    Ok(directory.join(name))
}

/// The package as it was read from disk: the index bytes it was described by,
/// and every workspace's records already decoded and digest-checked.
pub struct Package {
    pub index: PackageIndex,
    pub index_sha256: Vec<u8>,
    pub workspaces: Vec<(PackageFile, WorkspaceRecords)>,
}

/// The package as it sits on disk, before any domain has read its records: the
/// index, the digest of the index bytes, and each file's verified bytes.
///
/// Splitting the read here is what lets two domains share one format without
/// sharing a reader. Everything a package promises *about itself* — the format
/// version, the domain it names, the epoch, that no workspace appears twice,
/// that each file's bytes hash to what the index says — is checked once, and
/// the domain then only has to understand its own records.
pub struct RawPackage {
    pub index: PackageIndex,
    pub index_sha256: Vec<u8>,
    pub files: Vec<(PackageFile, Vec<u8>)>,
}

pub fn read_raw(directory: &Path, domain: &str) -> AppResult<RawPackage> {
    if !directory.is_absolute() {
        return Err(invalid("a package directory must be absolute"));
    }
    let index_path = directory.join(INDEX_FILE);
    let size = std::fs::metadata(&index_path)?.len();
    if size > MAX_INDEX_BYTES {
        return Err(invalid(
            "the package index is larger than any package needs",
        ));
    }
    let raw = std::fs::read(&index_path)?;
    let index_sha256 = records::digest(&raw);
    let index: PackageIndex = serde_json::from_slice(&raw)
        .map_err(|error| invalid(format!("the package index cannot be read: {error}")))?;
    if index.format_version != PACKAGE_FORMAT_VERSION {
        return Err(invalid(format!(
            "package format version {} cannot be applied; this Runtime reads version {PACKAGE_FORMAT_VERSION}",
            index.format_version
        )));
    }
    // A package is applied to the domain it names, never to the one the caller
    // happened to ask for: applying a filesystem package as a canvas would
    // rewrite rows nobody exported.
    if index.domain != domain {
        return Err(invalid(format!(
            "package domain {:?} is not the {domain} domain",
            index.domain
        )));
    }
    if index.epoch == 0 {
        return Err(invalid("the package names no epoch"));
    }
    if index.files.len() > MAX_FILES {
        return Err(invalid("the package names more files than one domain has"));
    }
    let mut files = Vec::with_capacity(index.files.len());
    let mut seen = std::collections::BTreeSet::new();
    for file in &index.files {
        if !seen.insert(file.workspace_id.clone()) {
            return Err(invalid("the package names one workspace twice"));
        }
        let path = package_member(directory, &file.name)?;
        if std::fs::metadata(&path)?.len() > MAX_FILE_BYTES {
            return Err(invalid("a package file is larger than any domain needs"));
        }
        let payload = std::fs::read(&path)?;
        if payload.len() as u64 != file.bytes || hex(&records::digest(&payload)) != file.sha256 {
            return Err(invalid(format!(
                "the bytes of {} are not the ones the index describes",
                file.name
            )));
        }
        files.push((file.clone(), payload));
    }
    Ok(RawPackage {
        index,
        index_sha256,
        files,
    })
}

pub fn read(directory: &Path) -> AppResult<Package> {
    let raw = read_raw(directory, CANVAS_DOMAIN)?;
    let index = raw.index;
    let index_sha256 = raw.index_sha256;
    let mut workspaces = Vec::with_capacity(index.files.len());
    let mut entities = 0u64;
    for (file, payload) in raw.files {
        let file = &file;
        let payload = &payload;
        let mut decoded = WorkspaceRecords::from_records(records::decode_records(payload)?)?;
        decoded.sort();
        // The canonical digest is what the Host will compare the re-read
        // against. Checking it here means a package whose index and records
        // disagree is refused before anything is written, rather than surfacing
        // as an unexplained mismatch after the transaction.
        if hex(&decoded.content_digest()) != file.content_sha256 {
            return Err(invalid(format!(
                "the records in {} are not the ones the index describes",
                file.name
            )));
        }
        if decoded.entity_count() != file.entity_count {
            return Err(invalid(format!(
                "{} holds {} entities, not the {} the index claims",
                file.name,
                decoded.entity_count(),
                file.entity_count
            )));
        }
        let workspace_id = decoded
            .workspace
            .as_ref()
            .map(|workspace| workspace.workspace_id.as_str())
            .unwrap_or_default();
        if workspace_id != file.workspace_id {
            return Err(invalid(format!(
                "{} holds a different workspace than the index names",
                file.name
            )));
        }
        entities = entities.saturating_add(decoded.entity_count());
        workspaces.push((file.clone(), decoded));
    }
    if entities != index.entity_count {
        return Err(invalid("the index entity count does not match its files"));
    }
    Ok(Package {
        index,
        index_sha256,
        workspaces,
    })
}

/// The tables this import writes, in the order they are reported.
const TOUCHED_TABLES: [&str; 4] = ["workspaces", "boards", "nodes", "edges"];

/// Applies one package to the domain the request names.
///
/// Every domain reaches its rows through the same four gates, which is why they
/// are checked here rather than in each importer: the ledger has to exist, this
/// Host has to be the settled owner, the epoch has to be the one the package
/// was taken at, and an identifier that was already used has to replay instead
/// of writing a second time. Only the rows differ.
pub async fn apply(
    pool: &SqlitePool,
    request: &ApplyReverseExportRequest,
) -> AppResult<ReverseImportReport> {
    match request.domain.as_str() {
        CANVAS_DOMAIN => apply_canvas(pool, request).await,
        super::filesystem::DOMAIN => super::filesystem_import::apply(pool, request).await,
        super::session::DOMAIN => super::session_import::apply(pool, request).await,
        super::agent::DOMAIN => super::agent_import::apply(pool, request).await,
        _ => Err(invalid("that domain has no reverse importer")),
    }
}

/// The identifier a replay is recognised by. It is bounded and portable
/// because it is also a primary key in the ledger and a path-free token in
/// operator commands.
pub fn valid_import_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// The ledger is what makes a retry harmless. A database that predates it is
/// refused rather than imported without one, because an unrecorded import
/// cannot be told apart from an unstarted one.
pub async fn require_ledger(pool: &SqlitePool) -> AppResult<()> {
    let ledger: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .bind("host_imports")
            .fetch_one(pool)
            .await?;
    if ledger != 1 {
        return Err(AppError::Conflict(
            "reverse.ledger_missing: this database predates the reverse import ledger".into(),
        ));
    }
    Ok(())
}

/// Checks the ownership record and the epoch inside the transaction the import
/// is going to write in, so the owner that was checked cannot change between
/// the check and the write.
pub async fn require_host_epoch(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    domain: super::domains::OwnershipDomain,
    request: &ApplyReverseExportRequest,
    package_epoch: u64,
) -> AppResult<()> {
    let stored = super::read_in(&mut **transaction, domain).await?;
    if stored.owner != super::WriteOwner::Host {
        return Err(AppError::Conflict(
            "reverse.not_host_owned: a reverse export is only applied while the Host owns writes"
                .into(),
        ));
    }
    if request.expected_epoch != 0 && request.expected_epoch != stored.epoch {
        return Err(AppError::Conflict(
            "reverse.epoch_mismatch: the stored epoch is not the one the package was taken at"
                .into(),
        ));
    }
    if package_epoch != stored.epoch {
        return Err(AppError::Conflict(format!(
            "reverse.epoch_mismatch: the package was taken at epoch {package_epoch} and this database is at {}",
            stored.epoch
        )));
    }
    Ok(())
}

/// A replay answers with what the first run recorded. Re-deriving the digests
/// would report the database as it is now, which is not what the Host verified,
/// and would quietly hide a change made in between.
pub async fn replayed(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    request: &ApplyReverseExportRequest,
    index_sha256: &[u8],
) -> AppResult<Option<ReverseImportReport>> {
    let Some(row) =
        sqlx::query("SELECT index_sha256, report FROM host_imports WHERE import_id = ?")
            .bind(&request.import_id)
            .fetch_optional(&mut **transaction)
            .await?
    else {
        return Ok(None);
    };
    let recorded: Vec<u8> = row.try_get("index_sha256")?;
    if recorded != index_sha256 {
        return Err(AppError::Conflict(
            "reverse.import_id_reused: that import identifier already names a different package"
                .into(),
        ));
    }
    let stored_report: Vec<u8> = row.try_get("report")?;
    let mut report = ReverseImportReport::decode(stored_report.as_slice())
        .map_err(|_| AppError::Internal("A recorded import report cannot be read".into()))?;
    report.replayed = true;
    Ok(Some(report))
}

/// Writes the ledger row that makes the next identical request a replay.
pub async fn record_import(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    domain: &str,
    request: &ApplyReverseExportRequest,
    index: &PackageIndex,
    index_sha256: &[u8],
    report: &ReverseImportReport,
) -> AppResult<()> {
    let epoch = i64::try_from(index.epoch)
        .map_err(|_| invalid("the package epoch exceeds the supported range"))?;
    sqlx::query(
        "INSERT INTO host_imports (import_id, domain, epoch, index_sha256, entity_count, report, applied_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&request.import_id)
    .bind(domain)
    .bind(epoch)
    .bind(index_sha256)
    .bind(i64::try_from(index.entity_count).unwrap_or(i64::MAX))
    .bind(report.encode_to_vec())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Applies one canvas package. The database must already record the Host as the
/// owner of the canvas domain: importing a Host package while this Runtime is
/// the writer would overwrite rows the Runtime is still serving.
async fn apply_canvas(
    pool: &SqlitePool,
    request: &ApplyReverseExportRequest,
) -> AppResult<ReverseImportReport> {
    if !valid_import_id(&request.import_id) {
        return Err(invalid("the import identifier is missing or not portable"));
    }
    require_ledger(pool).await?;
    let directory = PathBuf::from(&request.package_path);
    let package = read(&directory)?;
    if !request.index_sha256.is_empty() && request.index_sha256 != package.index_sha256 {
        return Err(AppError::Conflict(
            "reverse.index_mismatch: the package index is not the one the controller asked for"
                .into(),
        ));
    }

    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    require_host_epoch(
        &mut transaction,
        super::domains::OwnershipDomain::Canvas,
        request,
        package.index.epoch,
    )
    .await?;
    if let Some(report) = replayed(&mut transaction, request, &package.index_sha256).await? {
        transaction.rollback().await?;
        return Ok(report);
    }

    let mut written: [u64; 4] = [0; 4];
    for (_, records) in &package.workspaces {
        let plan = records::plan(records.clone(), crate::db::NODE_TYPES)?;
        let counts = write_workspace(&mut transaction, &plan).await?;
        for (slot, count) in written.iter_mut().zip(counts) {
            *slot += count;
        }
    }

    // Read the rows back inside the same transaction. A digest taken from the
    // records that were about to be written would prove only that this process
    // can hash its own buffer.
    let mut reexported = Vec::with_capacity(package.workspaces.len());
    let mut issues = Vec::new();
    for (file, _) in &package.workspaces {
        let stored = records::read_workspace(&mut transaction, &file.workspace_id).await?;
        let content = stored.content_digest();
        if hex(&content) != file.content_sha256 {
            issues.push(ExportIssue {
                code: "reverse.reexport_differs".into(),
                severity: "error".into(),
                entity: format!("workspaces/{}", file.workspace_id),
                detail: "the rows read back are not the ones the package describes".into(),
            });
        }
        reexported.push(ReverseExportFile {
            name: file.name.clone(),
            workspace_id: file.workspace_id.clone(),
            bytes: 0,
            sha256: Vec::new(),
            content_sha256: content,
            entity_count: stored.entity_count(),
        });
    }
    if !issues.is_empty() {
        // The transaction is dropped without a commit, so nothing was applied.
        return Err(AppError::Conflict(
            "reverse.reexport_differs: the rows read back are not the ones the package describes"
                .into(),
        ));
    }

    let report = ReverseImportReport {
        import_id: request.import_id.clone(),
        domain: CANVAS_DOMAIN.into(),
        epoch: package.index.epoch,
        index_sha256: package.index_sha256.clone(),
        entity_count: package.index.entity_count,
        replayed: false,
        reexported,
        tables: TOUCHED_TABLES
            .iter()
            .zip(written)
            .map(|(name, rows)| ExportTable {
                name: (*name).into(),
                row_count: rows,
                readable: true,
                schema_sha256: Vec::new(),
            })
            .collect(),
        issues: Vec::new(),
        applied_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    };
    record_import(
        &mut transaction,
        CANVAS_DOMAIN,
        request,
        &package.index,
        &package.index_sha256,
        &report,
    )
    .await?;
    transaction.commit().await?;
    Ok(report)
}

/// Applies one workspace and returns the rows written per table, in the order
/// of [`TOUCHED_TABLES`].
async fn write_workspace(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    plan: &ApplyPlan,
) -> AppResult<[u64; 4]> {
    let workspace_id = plan.workspace.workspace_id.as_str();
    let created = records::timestamp(plan.workspace.created_at_unix_ms)?;
    let updated = records::timestamp(plan.workspace.updated_at_unix_ms)?;
    let opened = records::optional_timestamp(plan.workspace.last_opened_at_unix_ms)?;
    // Two columns are deliberately absent from the update list.
    //
    // `execution_host_id` is not in a canvas entity and never travelled to the
    // Host, so the row is updated rather than replaced: recreating it would
    // reset the workspace to the local machine and cascade every terminal
    // session and context link away with it.
    //
    // `permissions_json` is the filesystem domain's record (business migration
    // §1.1): read, write and execute are what that domain decides, and the
    // canvas entity carries a display copy of them. The two domains roll back
    // in order — filesystem first, canvas after — so a canvas package that
    // wrote permissions would overwrite the ones the filesystem package had
    // just restored, with a copy that was never updated. It is only ever
    // written on the insert, where the row does not exist yet and the canvas
    // package is the only thing that knows anything about it.
    sqlx::query(
        "INSERT INTO workspaces (id, name, root_path, color, permissions_json, last_opened_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, \
           color = excluded.color, \
           last_opened_at = excluded.last_opened_at, created_at = excluded.created_at, \
           updated_at = excluded.updated_at",
    )
    .bind(workspace_id)
    .bind(&plan.workspace.name)
    .bind(&plan.workspace.root_path)
    .bind(&plan.workspace.color)
    .bind(records::permissions_json(plan.workspace.permissions.as_ref()))
    .bind(&opened)
    .bind(&created)
    .bind(&updated)
    .execute(&mut **transaction)
    .await?;

    for canvas in &plan.canvases {
        let whiteboard = canvas
            .whiteboard
            .as_ref()
            .map(|value| String::from_utf8(value.snapshot.clone()))
            .transpose()
            .map_err(|_| invalid("a whiteboard snapshot is not text"))?
            .unwrap_or_default();
        // `kanban_json` is retired and guarded by a trigger: a new canvas may
        // only be inserted with the inert default, and an existing one's value
        // is historical and must not be rewritten. Neither is a canvas entity
        // field, so neither appears in the update list.
        sqlx::query(
            "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, kanban_json, whiteboard_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, name = excluded.name, \
               sort_order = excluded.sort_order, viewport_json = excluded.viewport_json, \
               whiteboard_json = excluded.whiteboard_json, created_at = excluded.created_at, \
               updated_at = excluded.updated_at",
        )
        .bind(&canvas.canvas_id)
        .bind(workspace_id)
        .bind(&canvas.name)
        .bind(canvas.sort_order)
        .bind(records::viewport_json(canvas.viewport.as_ref()))
        .bind(&whiteboard)
        .bind(records::timestamp(canvas.created_at_unix_ms)?)
        .bind(records::timestamp(canvas.updated_at_unix_ms)?)
        .execute(&mut **transaction)
        .await?;
    }

    for node in &plan.nodes {
        let annotation = plan.annotations.get(&node.node_id);
        let labels = records::labels_json(
            annotation
                .map(|value| value.labels.as_slice())
                .unwrap_or(&[]),
        )?;
        let note = annotation.map(|value| value.note.as_str()).unwrap_or("");
        let position = node
            .position
            .as_ref()
            .expect("planned nodes carry a position");
        sqlx::query(
            "INSERT INTO nodes (id, board_id, type, x, y, width, height, title, color, collapsed, \
                                expanded_height, parent_id, labels_json, note, data_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET board_id = excluded.board_id, type = excluded.type, \
               x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height, \
               title = excluded.title, color = excluded.color, collapsed = excluded.collapsed, \
               expanded_height = excluded.expanded_height, parent_id = excluded.parent_id, \
               labels_json = excluded.labels_json, note = excluded.note, data_json = excluded.data_json, \
               created_at = excluded.created_at, updated_at = excluded.updated_at",
        )
        .bind(&node.node_id)
        .bind(&node.canvas_id)
        .bind(&node.r#type)
        .bind(position.x)
        .bind(position.y)
        .bind(node.size.as_ref().map(|size| size.width))
        .bind(node.size.as_ref().map(|size| size.height))
        .bind(&node.title)
        .bind(&node.color)
        .bind(i64::from(node.collapsed.unwrap_or(false)))
        .bind(node.expanded_height)
        .bind((!node.parent_id.is_empty()).then(|| node.parent_id.clone()))
        .bind(&labels)
        .bind(note)
        .bind(String::from_utf8(node.data_json.clone()).map_err(|_| invalid("a node payload is not text"))?)
        .bind(records::timestamp(node.created_at_unix_ms)?)
        .bind(records::timestamp(node.updated_at_unix_ms)?)
        .execute(&mut **transaction)
        .await?;
    }

    for edge in &plan.edges {
        sqlx::query(
            "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 'link', ?, ?) \
             ON CONFLICT(id) DO UPDATE SET board_id = excluded.board_id, \
               source_node_id = excluded.source_node_id, target_node_id = excluded.target_node_id, \
               kind = excluded.kind, created_at = excluded.created_at, updated_at = excluded.updated_at",
        )
        .bind(&edge.edge_id)
        .bind(&edge.canvas_id)
        .bind(&edge.source_node_id)
        .bind(&edge.target_node_id)
        .bind(records::timestamp(edge.created_at_unix_ms)?)
        .bind(records::timestamp(edge.updated_at_unix_ms)?)
        .execute(&mut **transaction)
        .await?;
    }

    // Whatever the package no longer names inside this workspace is gone from
    // the Host's canvas and has to go from here too, or a rollback would
    // resurrect objects the operator deleted while the Host owned writes.
    let canvas_ids = plan
        .canvases
        .iter()
        .map(|canvas| canvas.canvas_id.as_str())
        .collect::<Vec<_>>();
    let node_ids = plan
        .nodes
        .iter()
        .map(|node| node.node_id.as_str())
        .collect::<Vec<_>>();
    let edge_ids = plan
        .edges
        .iter()
        .map(|edge| edge.edge_id.as_str())
        .collect::<Vec<_>>();
    delete_absent(
        transaction,
        "DELETE FROM edges WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ?)",
        workspace_id,
        &edge_ids,
    )
    .await?;
    delete_absent(
        transaction,
        "DELETE FROM nodes WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ?)",
        workspace_id,
        &node_ids,
    )
    .await?;
    delete_absent(
        transaction,
        "DELETE FROM boards WHERE workspace_id = ?",
        workspace_id,
        &canvas_ids,
    )
    .await?;
    Ok([
        1,
        plan.canvases.len() as u64,
        plan.nodes.len() as u64,
        plan.edges.len() as u64,
    ])
}

/// Deletes the rows of one table inside a workspace whose identifier the
/// package does not name. The identifier list is bound, never interpolated;
/// the `NOT IN (?, ?, …)` list is built from its length alone.
async fn delete_absent(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    statement: &str,
    workspace_id: &str,
    keep: &[&str],
) -> AppResult<u64> {
    let mut sql = String::from(statement);
    if !keep.is_empty() {
        sql.push_str(" AND id NOT IN (");
        for index in 0..keep.len() {
            if index > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push(')');
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(workspace_id);
    for id in keep {
        query = query.bind(*id);
    }
    Ok(query.execute(&mut **transaction).await?.rows_affected())
}
