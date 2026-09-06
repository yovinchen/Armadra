//! Worker frame 25: the settings document leaving this Runtime and coming back
//! (Go Host 业务所有权迁移 §2.4, §2.9).
//!
//! One entry point serves both directions because they are one conversation.
//! Taking the domain over reads `settings.json`; handing it back writes it, and
//! a controller that could export with one build and import with another would
//! be free to move a document between two shapes nobody compared.
//!
//! Three properties are the whole of the file:
//!
//!   - **The bytes are the document.** An export reports the file's contents
//!     verbatim and an import writes them verbatim. Parsing and re-serializing
//!     would make the digest every consistency check compares depend on Rust
//!     and Go agreeing about key order, escaping and number formatting.
//!   - **The answer is read back, never echoed.** An import writes, re-reads
//!     the file and reports the re-read. A snapshot built from the request
//!     would only restate what the Runtime was asked to store.
//!   - **An import is idempotent and refused while this Runtime writes.** The
//!     `host_imports` ledger makes a retry harmless, and the settings
//!     ownership row must already name the Host: importing while this Runtime
//!     is the writer would overwrite a document it is still serving.
//!
//! Local settings and execution hosts are projections of the same bytes, taken
//! in the same exchange, so a controller never sees a host list that belongs to
//! a different document than the digest it recorded.

use std::path::{Path, PathBuf};

use armadra_protocol::{Message, v1::*};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

use crate::{
    error::{AppError, AppResult},
    ownership::{self, OwnershipDomain, WriteOwner},
    paths,
    settings::SettingsStore,
    terminal::ssh::SshHost,
};

/// Advertised only when this Worker was given a settings file *and* a canvas
/// database. An import has to read the ownership row before it writes, so a
/// Worker that cannot reach that row must not claim it can import; a
/// capability without the thing behind it is a plan the controller has to
/// abandon halfway.
pub const CAPABILITY: &str = "settings.worker.v1";

/// The ledger and the ownership row both name the domain as a string, and that
/// spelling is contract.
const DOMAIN: &str = OwnershipDomain::Settings.as_str();

/// The document's own shape version. A Host that stores an unrecognised one
/// returns it untouched, but this Runtime refuses to take one back: it would
/// be reading a document written to rules it does not have.
const SCHEMA_VERSION: u32 = 1;

/// The ceiling `settings.proto` states. A settings document is preferences,
/// not a database, and anything larger is a mistake or an attack rather than a
/// user who configured a lot.
const MAX_DOCUMENT_BYTES: usize = 1 << 20;

/// The settings document is one entity, whatever it holds. The ledger's count
/// is what an operator reads back, not a size.
const LEDGER_ENTITY_COUNT: i64 = 1;

fn invalid(detail: &str) -> AppError {
    AppError::BadRequest(format!("reverse.package_invalid: {detail}"))
}

/* ---------------------------------- entry --------------------------------- */

/// Handles one settings frame. `canvas` is absent when the Worker was started
/// without `--canvas-database`, and then an import answers UNSUPPORTED rather
/// than writing a document whose ownership it could not check.
pub async fn handle(
    file: &Path,
    canvas: Option<&SqlitePool>,
    request: WorkerSettingsRequest,
) -> AppResult<worker_response::Result> {
    match WorkerSettingsDirection::try_from(request.direction) {
        Ok(WorkerSettingsDirection::Export) => Ok(worker_response::Result::Settings(export(file)?)),
        Ok(WorkerSettingsDirection::Import) => match canvas {
            Some(pool) => Ok(worker_response::Result::Settings(
                import(file, pool, request).await?,
            )),
            None => Ok(worker_response::Result::Error(ErrorResponse {
                code: "UNSUPPORTED".into(),
                message: "Write ownership is not configured".into(),
            })),
        },
        // Zero is not a direction. Reading it as EXPORT would turn a malformed
        // frame into a silent read, and reading it as IMPORT would turn one
        // into a write over the user's settings.
        _ => Err(AppError::BadRequest(
            "Worker settings direction is unspecified or unknown".into(),
        )),
    }
}

/* --------------------------------- export --------------------------------- */

/// Reads the settings file and reports it. Changes nothing, including the file
/// itself: a missing file stays missing.
pub fn export(file: &Path) -> AppResult<WorkerSettingsSnapshot> {
    let (bytes, updated_at) = match std::fs::metadata(file) {
        // Read verbatim. `SettingsStore` would give a normalized tree, and a
        // digest over that tree re-serialized is not a digest of what is
        // stored — which is the only thing the switch's consistency checks can
        // compare across two languages.
        Ok(metadata) if metadata.len() as usize > MAX_DOCUMENT_BYTES => {
            // Refused here rather than encoded: a snapshot larger than one
            // frame would fail the channel itself, and a controller would see
            // a dead Worker instead of an oversized settings file.
            return Err(invalid(
                "the settings file is larger than one MiB and cannot be exported",
            ));
        }
        Ok(metadata) => (std::fs::read(file)?, modified_unix_ms(&metadata)),
        // A fresh install has never written one. Reporting the document
        // `SettingsStore::patch` would have written for an empty one lets the
        // Host take the domain over from a Runtime nobody has configured yet,
        // instead of failing a switch on the absence of preferences.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (default_document(), chrono::Utc::now().timestamp_millis())
        }
        Err(error) => return Err(error.into()),
    };
    snapshot(bytes, updated_at, false, false)
}

/// What `SettingsStore::patch` writes for an empty document, byte for byte:
/// the same normalization and the same pretty printer, so an export taken
/// before the first patch and the file written by that patch are the same
/// bytes.
fn default_document() -> Vec<u8> {
    serde_json::to_string_pretty(&crate::settings::normalize(&Value::Null))
        .unwrap_or_else(|_| "{}".into())
        .into_bytes()
}

fn modified_unix_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|stamp| stamp.timestamp_millis())
        .unwrap_or_default()
}

/// The snapshot for one set of document bytes.
///
/// `local` and `execution_hosts` are derived from these same bytes rather than
/// from the running Runtime's in-memory store, so everything in the answer
/// describes the one document whose digest it carries.
fn snapshot(
    bytes: Vec<u8>,
    updated_at_unix_ms: i64,
    applied: bool,
    replayed: bool,
) -> AppResult<WorkerSettingsSnapshot> {
    let parsed: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Internal("The settings document is not JSON".into()))?;
    let store = SettingsStore::in_memory(parsed);
    Ok(WorkerSettingsSnapshot {
        document: Some(SettingsDocument {
            // GLOBAL and nothing else: the per-device overlay is a Host
            // concept, and this Runtime holds one file.
            scope: SettingsScope::Global as i32,
            device_id: String::new(),
            sha256: Sha256::digest(&bytes).to_vec(),
            document: bytes,
            schema_version: SCHEMA_VERSION,
            updated_at_unix_ms,
            // The Runtime keeps no revision over the document. Zero states
            // "this has never been written on the Host", which is exactly what
            // a first import from here is.
            revision: 0,
        }),
        local: Some(local_settings(&store)),
        execution_hosts: store
            .ssh_hosts()
            .iter()
            .map(|host| execution_host(host, updated_at_unix_ms))
            .collect(),
        applied,
        replayed,
    })
}

/// The preferences that are facts about this machine rather than about the
/// account, so the Host stores none of them.
fn local_settings(store: &SettingsStore) -> WorkerLocalSettings {
    WorkerLocalSettings {
        terminal_backend: store.terminal().backend.as_str().into(),
        // The configured browser, not a detection scan: a scan
        // (`browser::launch::availability`) would report a binary this
        // execution host was never told to use, and would need the data
        // directory a read-only Worker was not given.
        browser_available: store
            .browser_executable()
            .is_some_and(|path| Path::new(&path).is_file()),
        power_policy: store.power_policy().as_str().into(),
        path_augmented: path_augmented(),
    }
}

/// Whether this execution host's child processes get more than the PATH the
/// Runtime inherited. `agent::agent_path()` adds `~/.local/bin`, the mise
/// shims and the Homebrew prefixes when they exist, and every agent probe and
/// PTY child is looked up on it; when none of them exist it adds nothing and
/// there is nothing to report.
fn path_augmented() -> bool {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let augmented = crate::agent::agent_path();
    std::env::split_paths(&augmented).count() > std::env::split_paths(&inherited).count()
}

/// One `settings.ssh.hosts[]` entry as an entity. The projection carries where
/// the host is and how the Worker is started there, and never a credential:
/// `identity_file` is a path the execution host resolves for itself, and a
/// password has no field to travel in.
///
/// The local machine is not listed. It executes whatever it is asked to and
/// needs no registration, which is why its identifier is the empty string
/// everywhere else in the product.
fn execution_host(host: &SshHost, updated_at_unix_ms: i64) -> ExecutionHost {
    let worker = host.worker.as_ref();
    ExecutionHost {
        execution_host_id: host.id.clone(),
        name: host.name.clone(),
        kind: ExecutionHostKind::Ssh as i32,
        ssh: Some(SshExecutionHost {
            host: host.host.clone(),
            port: host.port.map(u32::from).unwrap_or_default(),
            user: host.user.clone().unwrap_or_default(),
            identity_file: host.identity_file.clone().unwrap_or_default(),
            worker_path: worker.map(|worker| worker.path.clone()).unwrap_or_default(),
            state_dir: worker
                .and_then(|worker| worker.state_dir.clone())
                .unwrap_or_default(),
        }),
        // A host has no timestamp and no revision of its own here: it is a
        // projection, so the document's stamp is the only one that is true of
        // it, and a revision the Runtime does not keep would be invented.
        updated_at_unix_ms,
        revision: 0,
    }
}

/* --------------------------------- import --------------------------------- */

/// Writes a Host document into this Runtime's settings file and reports what
/// the file then holds.
///
/// The ownership row, the ledger and the file write all happen inside one
/// `BEGIN IMMEDIATE`: the owner a decision was made against is the owner at the
/// moment of the write, and a crash between the two cannot leave the ledger
/// claiming an import that never reached the disk.
pub async fn import(
    file: &Path,
    pool: &SqlitePool,
    request: WorkerSettingsRequest,
) -> AppResult<WorkerSettingsSnapshot> {
    let import_id = checked_import_id(&request.import_id)?;
    let bytes = checked_document(request.document.as_ref())?;
    let document_sha256 = Sha256::digest(&bytes).to_vec();

    // A database that predates the ledger is refused rather than imported
    // without one: an unrecorded import cannot be told apart from an unstarted
    // one, and the retry would write again.
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

    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let stored = ownership::read_in(&mut *transaction, OwnershipDomain::Settings).await?;
    if stored.owner != WriteOwner::Host {
        return Err(AppError::Conflict(
            "reverse.not_host_owned: settings are only imported while the Host owns writes".into(),
        ));
    }
    // Zero means the caller stated no epoch at all. Treating a stated epoch
    // that disagrees as "close enough" would apply a document taken from a
    // switch this database is no longer part of.
    if request.expected_epoch != 0 && request.expected_epoch != stored.epoch {
        return Err(AppError::Conflict(
            "reverse.epoch_mismatch: the stored epoch is not the one the document was taken at"
                .into(),
        ));
    }

    if let Some(row) = sqlx::query(
        "SELECT index_sha256, report FROM host_imports WHERE import_id = ? AND domain = ?",
    )
    .bind(import_id)
    .bind(DOMAIN)
    .fetch_optional(&mut *transaction)
    .await?
    {
        let recorded: Vec<u8> = row.try_get("index_sha256")?;
        if recorded != document_sha256 {
            return Err(AppError::Conflict(
                "reverse.import_id_reused: that import identifier already names a different document"
                    .into(),
            ));
        }
        let report: Vec<u8> = row.try_get("report")?;
        transaction.rollback().await?;
        // The recorded answer, not a fresh read: replaying a report derived
        // from the file as it is now would hide a change made in between,
        // which is the one thing the first run's digest is evidence against.
        let mut snapshot = WorkerSettingsSnapshot::decode(report.as_slice())
            .map_err(|_| AppError::Internal("A recorded import report cannot be read".into()))?;
        // "The write happened in this exchange" is false on a replay, however
        // true it was the first time.
        snapshot.applied = false;
        snapshot.replayed = true;
        return Ok(snapshot);
    }

    write_document(file, &bytes)?;

    // Read the file back. A digest of the request would say what this Runtime
    // was asked to store; a digest of the re-read says what it actually holds,
    // and only the second is worth comparing.
    let reread = std::fs::read(file)?;
    let metadata = std::fs::metadata(file)?;
    if reread != bytes {
        // The transaction is dropped without a commit, so the ledger records
        // nothing. The file is already written and is deliberately left as it
        // is: reporting the mismatch stops the controller from handing the
        // epoch back, and rewriting it here would destroy the evidence.
        return Err(AppError::Conflict(
            "reverse.reexport_differs: the settings file read back is not the one that was written"
                .into(),
        ));
    }
    let snapshot = snapshot(reread, modified_unix_ms(&metadata), true, false)?;

    let epoch = i64::try_from(stored.epoch).map_err(|_| {
        AppError::Conflict("reverse.epoch_mismatch: the stored epoch is out of range".into())
    })?;
    sqlx::query(
        "INSERT INTO host_imports (import_id, domain, epoch, index_sha256, entity_count, report, applied_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(import_id)
    .bind(DOMAIN)
    .bind(epoch)
    .bind(&document_sha256)
    .bind(LEDGER_ENTITY_COUNT)
    .bind(snapshot.encode_to_vec())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(snapshot)
}

/// The identifier that namespaces this import in the ledger. The alphabet is
/// the one `ownership::import` already uses: an identifier travels between
/// machines and ends up in an operator's command line, so it stays portable
/// and carries no path.
fn checked_import_id(value: &str) -> AppResult<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(invalid("the import identifier is missing or not portable"));
    }
    Ok(value)
}

/// Structure, not meaning. A JSON object, a size ceiling, a schema version and
/// a digest that matches the bytes it describes; whether a keybinding is
/// reachable or a custom agent coherent is decided by `settings::normalize`
/// when the file is next read, and by one set of rules rather than two.
fn checked_document(document: Option<&SettingsDocument>) -> AppResult<Vec<u8>> {
    // A missing document is a refused import, never an empty file: an import
    // that lost its document on the way would otherwise erase the user's
    // settings and report success.
    let document = document.ok_or_else(|| invalid("an import carries no settings document"))?;
    // A device overlay is a Host concept with no file here, and writing one
    // into `settings.json` would make it the document every device reads. An
    // unstated scope is accepted as the global one because this Runtime holds
    // exactly one file, so there is nothing else it could have meant.
    if document.scope == SettingsScope::Device as i32 || !document.device_id.is_empty() {
        return Err(invalid("only the global settings document is stored here"));
    }
    if document.schema_version != SCHEMA_VERSION {
        return Err(invalid(
            "the settings document was written to a schema this Runtime does not read",
        ));
    }
    if document.document.is_empty() || document.document.len() > MAX_DOCUMENT_BYTES {
        return Err(invalid(
            "the settings document is empty or larger than one MiB",
        ));
    }
    if !serde_json::from_slice::<Value>(&document.document).is_ok_and(|value| value.is_object()) {
        return Err(invalid("the settings document is not a JSON object"));
    }
    if Sha256::digest(&document.document).to_vec() != document.sha256 {
        return Err(invalid(
            "the settings document digest is not the digest of its bytes",
        ));
    }
    Ok(document.document.clone())
}

/// Writes the document through a temporary file in the same directory and
/// renames it into place, with the same hardening `SettingsStore` applies.
///
/// The rename is what keeps a failure from leaving a half-written settings
/// file: the Runtime that reads this file next must find either the old
/// document or the new one, never the first half of the new one.
fn write_document(file: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = file
        .parent()
        .ok_or_else(|| invalid("the settings file has no directory"))?;
    std::fs::create_dir_all(parent)?;
    paths::harden_directory(parent);
    let temporary: PathBuf = parent.join(format!(
        ".{}.{}.tmp",
        file.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings.json"),
        uuid::Uuid::new_v4().simple()
    ));
    let write = std::fs::write(&temporary, bytes).and_then(|()| {
        paths::harden_file(&temporary);
        std::fs::rename(&temporary, file)
    });
    if let Err(error) = write {
        // Nothing partial is left behind under a name anything reads.
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    paths::harden_file(file);
    Ok(())
}
