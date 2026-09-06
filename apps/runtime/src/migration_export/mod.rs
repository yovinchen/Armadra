//! Offline, read-only migration packages. `manifest.pb` is the completion marker.
//! A consistent database snapshot is not a lease on the running Runtime, nor an
//! atomic snapshot of its external files. Export never transfers process ownership.

mod assets;
mod files;
mod references;
mod snapshot;
#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use armadra_protocol::{Message, v1::*};
use sqlx::{Connection, SqliteConnection, SqlitePool, sqlite::SqliteConnectOptions};

use crate::error::{AppError, AppResult};

use self::{
    assets::collect_assets,
    files::{hash_file, private_directory, private_file, sync_directory},
    snapshot::inspect_snapshot,
};

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

type References = BTreeMap<(String, String), BTreeSet<String>>;
type WorkspaceRoots = BTreeMap<String, PathBuf>;

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub include_assets: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_assets: true,
        }
    }
}

#[derive(Debug)]
pub struct ExportResult {
    pub path: PathBuf,
    pub manifest: MigrationExportManifest,
}

/// Creates a new package directory; an existing file, directory or symlink is
/// never replaced. Cancellation of the caller does not cancel SQLite's worker:
/// an owned task finishes the export. A process crash may leave an incomplete
/// directory without `manifest.pb`, which an importer must refuse.
pub async fn export_package(
    pool: &SqlitePool,
    destination: &Path,
    options: ExportOptions,
) -> AppResult<ExportResult> {
    let pool = pool.clone();
    let destination = destination.to_owned();
    tokio::spawn(async move { export_owned(&pool, &destination, options).await }).await?
}

async fn export_owned(
    pool: &SqlitePool,
    destination: &Path,
    options: ExportOptions,
) -> AppResult<ExportResult> {
    // This is exclusive, including for an existing empty directory. Do not
    // recursively delete partial packages: they may contain the only backup.
    private_directory(destination)?;
    let destination = fs::canonicalize(destination)?;
    let database = destination.join("source.sqlite");
    crate::sqlite_snapshot::snapshot_to(pool, &database).await?;
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&database)
            .read_only(true),
    )
    .await?;
    let inspected = inspect_snapshot(&mut connection).await;
    connection.close().await?;
    let (mut manifest, workspaces, references) = inspected?;
    let database_for_hash = database.clone();
    let (bytes, hash) =
        tokio::task::spawn_blocking(move || hash_file(&database_for_hash)).await??;
    manifest.database_file = "source.sqlite".into();
    manifest.database_bytes = bytes;
    manifest.database_sha256 = hash;
    let destination_for_assets = destination.clone();
    manifest = tokio::task::spawn_blocking(move || {
        collect_assets(
            manifest,
            &destination_for_assets,
            &workspaces,
            references,
            options.include_assets,
        )
    })
    .await??;
    check_manifest_size(&manifest)?;
    let encoded = manifest.encode_to_vec();
    let mut marker = private_file(&destination.join("manifest.pb.partial"))?;
    marker.write_all(&encoded)?;
    marker.sync_all()?;
    // Hard-link publication is atomic and cannot replace an existing marker.
    fs::hard_link(
        destination.join("manifest.pb.partial"),
        destination.join("manifest.pb"),
    )?;
    fs::remove_file(destination.join("manifest.pb.partial"))?;
    sync_directory(&destination)?;
    Ok(ExportResult {
        path: destination,
        manifest,
    })
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn invalid(reason: &str) -> AppError {
    AppError::BadRequest(format!("Migration export refused: {reason}"))
}
fn check_manifest_size(manifest: &MigrationExportManifest) -> AppResult<()> {
    if manifest.encoded_len() > MAX_MANIFEST_BYTES {
        Err(invalid("manifest exceeds 64 MiB limit"))
    } else {
        Ok(())
    }
}
fn issue(
    manifest: &mut MigrationExportManifest,
    code: &str,
    severity: &str,
    entity: &str,
    detail: &str,
) {
    let value = ExportIssue {
        code: code.into(),
        severity: severity.into(),
        entity: entity.into(),
        detail: detail.into(),
    };
    if !manifest.issues.contains(&value) {
        manifest.issues.push(value);
    }
}
