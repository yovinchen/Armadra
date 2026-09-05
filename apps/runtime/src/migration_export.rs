//! Offline, read-only migration packages. `manifest.pb` is the completion marker.
//! A consistent database snapshot is not a lease on the running Runtime, nor an
//! atomic snapshot of its external files. Export never transfers process ownership.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use armadra_protocol::{Message, v1::*};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool, sqlite::SqliteConnectOptions};

use crate::error::{AppError, AppResult};

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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

type References = BTreeMap<(String, String), BTreeSet<String>>;
type WorkspaceRoots = BTreeMap<String, PathBuf>;

async fn inspect_snapshot(
    connection: &mut SqliteConnection,
) -> AppResult<(MigrationExportManifest, WorkspaceRoots, References)> {
    let migrations = validate_schema(connection).await?;
    let mut manifest = MigrationExportManifest {
        format_version: 1,
        export_id: uuid::Uuid::new_v4().to_string(),
        exported_at_unix_ms: chrono::Utc::now().timestamp_millis(),
        producer_version: env!("CARGO_PKG_VERSION").into(),
        migrations,
        assets_complete: true,
        ownership_switch_allowed: false,
        ..Default::default()
    };
    let tables = sqlx::query("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
        .fetch_all(&mut *connection).await?;
    for table in tables {
        let name: String = table.try_get("name")?;
        let schema: String = table.try_get("sql")?;
        let query = format!("SELECT count(*) FROM {}", quote_identifier(&name));
        let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
            .fetch_one(&mut *connection)
            .await?;
        manifest.tables.push(ExportTable {
            name,
            row_count: count
                .try_into()
                .map_err(|_| invalid("negative table count"))?,
            readable: true,
            schema_sha256: Sha256::digest(schema.as_bytes()).to_vec(),
        });
    }
    // Original physical table names are kept in the identity index. In the new
    // service `boards` is a canvas, but an exporter must not rewrite old IDs.
    for (table, column) in [
        ("workspaces", "id"),
        ("boards", "id"),
        ("nodes", "id"),
        ("terminal_sessions", "id"),
        ("edges", "id"),
    ] {
        let query = format!(
            "SELECT {} FROM {} ORDER BY {}",
            quote_identifier(column),
            quote_identifier(table),
            quote_identifier(column)
        );
        let ids: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
            .fetch_all(&mut *connection)
            .await?;
        if ids.iter().any(|id| id.is_empty()) {
            return Err(invalid("empty entity identity"));
        }
        manifest.identities.push(ExportIdSet {
            table: table.into(),
            ids,
        });
        check_manifest_size(&manifest)?;
    }
    let workspaces: WorkspaceRoots =
        sqlx::query_as::<_, (String, String)>("SELECT id, root_path FROM workspaces ORDER BY id")
            .fetch_all(&mut *connection)
            .await?
            .into_iter()
            .map(|(id, path)| (id, PathBuf::from(path)))
            .collect();
    let mut references = References::new();
    for row in
        sqlx::query("SELECT id, workspace_id, whiteboard_json, kanban_json FROM boards ORDER BY id")
            .fetch_all(&mut *connection)
            .await?
    {
        let id: String = row.try_get("id")?;
        let workspace: String = row.try_get("workspace_id")?;
        let whiteboard: String = row.try_get("whiteboard_json")?;
        let kanban: String = row.try_get("kanban_json")?;
        scan_json(
            &whiteboard,
            &workspace,
            &format!("boards/{id}/whiteboard_json"),
            &mut references,
            &mut manifest,
        );
        manifest.canvases.push(ExportCanvas {
            canvas_id: id,
            workspace_id: workspace,
            whiteboard_sha256: Sha256::digest(whiteboard.as_bytes()).to_vec(),
            whiteboard_bytes: whiteboard.len() as u64,
            kanban_json: kanban.into_bytes(),
        });
        check_manifest_size(&manifest)?;
    }
    for row in sqlx::query("SELECT n.id, n.board_id, n.labels_json, n.note, n.data_json, b.workspace_id FROM nodes n JOIN boards b ON b.id = n.board_id ORDER BY n.id").fetch_all(&mut *connection).await? {
        let id: String = row.try_get("id")?;
        let workspace: String = row.try_get("workspace_id")?;
        let data: String = row.try_get("data_json")?;
        scan_json(&data, &workspace, &format!("nodes/{id}/data_json"), &mut references, &mut manifest);
        manifest.annotations.push(ExportNodeAnnotation {
            node_id: id, canvas_id: row.try_get("board_id")?,
            labels_json: row.try_get::<String,_>("labels_json")?.into_bytes(),
            note_utf8: row.try_get::<String,_>("note")?.into_bytes(),
        });
        check_manifest_size(&manifest)?;
    }
    for row in
        sqlx::query("SELECT node_id, workspace_id, links_json FROM context_links ORDER BY node_id")
            .fetch_all(&mut *connection)
            .await?
    {
        let node: String = row.try_get("node_id")?;
        scan_json(
            &row.try_get::<String, _>("links_json")?,
            &row.try_get::<String, _>("workspace_id")?,
            &format!("context_links/{node}"),
            &mut references,
            &mut manifest,
        );
    }
    let foreign_errors = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *connection)
        .await?;
    for row in foreign_errors {
        issue(
            &mut manifest,
            "foreign_key_violation",
            "error",
            &row.try_get::<String, _>("table")?,
            "Snapshot contains an unresolved foreign-key reference",
        );
    }
    issue(
        &mut manifest,
        "ownership_not_transferred",
        "warning",
        "runtime",
        "Export is an online database snapshot; Runtime process ownership and external-file atomicity are not transferred",
    );
    Ok((manifest, workspaces, references))
}

/// Check the ledger AND the actual schema against a known prefix, rebuilding
/// only an unrelated memory database. Never migrate or repair the source copy.
async fn validate_schema(connection: &mut SqliteConnection) -> AppResult<Vec<ExportMigration>> {
    let migrator = sqlx::migrate!("./migrations");
    let rows = sqlx::query("SELECT version, description, checksum, success, typeof(version) AS vt, typeof(checksum) AS ct, typeof(success) AS st FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&mut *connection).await.map_err(|_| invalid("unreadable migration ledger"))?;
    if rows.is_empty() {
        return Err(invalid("missing migration history"));
    }
    let known: Vec<_> = migrator
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .collect();
    let mut applied = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let version: i64 = row.try_get("version")?;
        let checksum: Vec<u8> = row.try_get("checksum")?;
        let success: i64 = row.try_get("success")?;
        if row.try_get::<String, _>("vt")? != "integer"
            || row.try_get::<String, _>("ct")? != "blob"
            || row.try_get::<String, _>("st")? != "integer"
            || success != 1
        {
            return Err(invalid("dirty or malformed migration ledger"));
        }
        let Some(expected) = known.get(index) else {
            return Err(invalid("unknown migration version"));
        };
        if expected.version != version || expected.checksum.as_ref() != checksum {
            return Err(invalid(
                "unknown, incomplete or checksum-mismatched migration history",
            ));
        }
        applied.push(ExportMigration {
            version,
            checksum,
            success: true,
            description: row.try_get("description")?,
        });
    }
    let mut expected = SqliteConnection::connect("sqlite::memory:").await?;
    let comparison: AppResult<()> = async {
        for migration in known.iter().take(applied.len()) {
            sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_ref())).execute(&mut expected).await?;
        }
        let query = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '_sqlx_migrations' ORDER BY type, name";
        let source: Vec<(String,String,String,Option<String>)> = sqlx::query_as(query).fetch_all(&mut *connection).await?;
        let target: Vec<(String,String,String,Option<String>)> = sqlx::query_as(query).fetch_all(&mut expected).await?;
        if source != target { return Err(invalid("unknown application schema")); }
        let ledger = sqlx::query("PRAGMA table_info('_sqlx_migrations')").fetch_all(&mut *connection).await?;
        let names = ["version", "description", "installed_on", "success", "checksum", "execution_time"];
        if ledger.len() != names.len() || ledger.iter().zip(names).any(|(col,name)| {
            let kind = col.try_get::<String,_>("type").unwrap_or_default().to_ascii_uppercase();
            let type_ok = match name {
                "version" | "execution_time" => matches!(kind.as_str(), "BIGINT" | "INTEGER" | "INT"),
                "description" => kind == "TEXT",
                "installed_on" => matches!(kind.as_str(), "TIMESTAMP" | "TEXT" | "DATETIME"),
                "success" => matches!(kind.as_str(), "BOOLEAN" | "BOOL" | "INTEGER"),
                "checksum" => kind == "BLOB",
                _ => false,
            };
            !type_ok || col.try_get::<String,_>("name").ok().as_deref()!=Some(name)
                || col.try_get::<i64,_>("pk").ok()!=Some(if name=="version" {1}else{0})
                || (name != "version" && col.try_get::<i64,_>("notnull").ok()!=Some(1))
        }) {
            return Err(invalid("unrecognized migration ledger structure"));
        }
        Ok(())
    }.await;
    expected.close().await?;
    comparison?;
    Ok(applied)
}

fn scan_json(
    raw: &str,
    workspace: &str,
    entity: &str,
    refs: &mut References,
    manifest: &mut MigrationExportManifest,
) {
    if raw.is_empty() {
        return;
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => scan_value(&value, None, workspace, entity, refs, manifest),
        Err(_) => {
            issue(
                manifest,
                "invalid_json",
                "error",
                entity,
                "Original JSON is preserved in source.sqlite but its file references could not be inspected",
            );
            manifest.assets_complete = false;
        }
    }
}

fn scan_value(
    value: &serde_json::Value,
    key: Option<&str>,
    workspace: &str,
    entity: &str,
    refs: &mut References,
    manifest: &mut MigrationExportManifest,
) {
    match value {
        serde_json::Value::Object(object) => {
            // Managed tldraw asset src URLs duplicate meta.armadra.path; the
            // path is authoritative and old localhost origins are not fetched.
            let managed_asset = object
                .get("meta")
                .and_then(|m| m.get("armadra"))
                .and_then(|m| m.get("path"))
                .and_then(|p| p.as_str())
                .is_some_and(|p| p.starts_with(".armadra/"));
            for (key, value) in object {
                if managed_asset && key == "props" {
                    if let Some(props) = value.as_object() {
                        for (key, value) in props {
                            if key != "src" {
                                scan_value(value, Some(key), workspace, entity, refs, manifest);
                            }
                        }
                    }
                } else {
                    scan_value(value, Some(key), workspace, entity, refs, manifest);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                scan_value(value, key, workspace, entity, refs, manifest);
            }
        }
        serde_json::Value::String(path)
            if path.starts_with(".armadra/") || path.starts_with(".armadra\\") =>
        {
            refs.entry((workspace.into(), path.clone()))
                .or_default()
                .insert(entity.into());
        }
        serde_json::Value::String(path)
            if matches!(key, Some("path" | "pngPath" | "src"))
                && !path.is_empty()
                && !path.starts_with("data:") =>
        {
            if key == Some("src")
                && let Some(relative) = legacy_asset_url(path, workspace)
            {
                refs.entry((workspace.into(), relative))
                    .or_default()
                    .insert(entity.into());
                return;
            }
            issue(
                manifest,
                "external_reference",
                "warning",
                entity,
                "A file or URL outside the managed asset directories requires separate workspace mapping; it was not read or fetched",
            );
        }
        _ => {}
    }
}

fn legacy_asset_url(raw: &str, workspace: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path_segments()?.collect();
    if parts.len() != 5
        || parts[0] != "api"
        || parts[1] != "workspaces"
        || parts[2] != workspace
        || parts[3] != "assets"
    {
        return None;
    }
    let (stem, extension) = parts[4].split_once('.')?;
    if stem.len() != 16
        || !stem.bytes().all(|c| c.is_ascii_hexdigit())
        || extension.is_empty()
        || !extension.bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(format!(".armadra/assets/{}", parts[4]))
}

fn collect_assets(
    mut manifest: MigrationExportManifest,
    destination: &Path,
    workspaces: &WorkspaceRoots,
    references: References,
    include: bool,
) -> AppResult<MigrationExportManifest> {
    let mut total = 0;
    for ((workspace, relative), referenced_by) in references {
        let mut asset = ExportAsset {
            workspace_id: workspace.clone(),
            relative_path: relative.clone(),
            referenced_by: referenced_by.into_iter().collect(),
            ..Default::default()
        };
        // Hash the namespace rather than using an untrusted database ID as a
        // directory component. The original workspace identity stays in proto.
        let namespace = format!("{:x}", Sha256::digest(workspace.as_bytes()));
        let outcome = if !include {
            Err((
                "asset_copy_disabled",
                "Asset copying was explicitly disabled",
            ))
        } else if let Some(root) = workspaces.get(&workspace) {
            match managed_relative(&relative) {
                Some(path) => {
                    let bundle = PathBuf::from("assets").join(namespace).join(&path);
                    match copy_asset(
                        root,
                        &path,
                        &destination.join(&bundle),
                        MAX_TOTAL_ASSET_BYTES - total,
                    ) {
                        Ok((bytes, hash)) => {
                            asset.bundle_path = bundle.to_string_lossy().replace('\\', "/");
                            asset.bytes = bytes;
                            asset.sha256 = hash;
                            asset.copied = true;
                            total += bytes;
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                }
                None => Err((
                    "unsafe_asset_path",
                    "Managed asset reference contains an unsupported or escaping path",
                )),
            }
        } else {
            Err(("missing_workspace", "Asset references a missing workspace"))
        };
        if let Err((code, detail)) = outcome {
            manifest.assets_complete = false;
            issue(
                &mut manifest,
                code,
                "error",
                &format!("workspace/{workspace}/{relative}"),
                detail,
            );
        }
        manifest.assets.push(asset);
        check_manifest_size(&manifest)?;
    }
    Ok(manifest)
}

type AssetFailure = (&'static str, &'static str);

fn managed_relative(raw: &str) -> Option<PathBuf> {
    if raw.contains('\\') || raw.chars().any(|c| c.is_control()) {
        return None;
    }
    let parts: Vec<_> = raw.split('/').collect();
    if parts.len() < 3
        || parts[0] != ".armadra"
        || !matches!(parts[1], "assets" | "exports" | "imports")
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || p.contains(':')
                || p.ends_with(['.', ' '])
                || windows_reserved_component(p)
        })
    {
        return None;
    }
    let path = PathBuf::from(raw);
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then_some(path)
}

fn windows_reserved_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

fn copy_asset(
    root: &Path,
    relative: &Path,
    target: &Path,
    remaining: u64,
) -> Result<(u64, Vec<u8>), AssetFailure> {
    copy_asset_checked(root, relative, target, remaining, || {})
}

fn copy_asset_checked(
    root: &Path,
    relative: &Path,
    target: &Path,
    remaining: u64,
    after_copy: impl FnOnce(),
) -> Result<(u64, Vec<u8>), AssetFailure> {
    if !root.is_absolute() {
        return Err((
            "unsafe_workspace_root",
            "Workspace root is not an absolute local path",
        ));
    }
    let mut source = open_managed(root, relative).map_err(asset_open_error)?;
    let before = source
        .metadata()
        .map_err(|_| ("asset_unreadable", "Asset metadata could not be read"))?;
    if !before.is_file() {
        return Err(("unsafe_asset_path", "Asset is not a regular file"));
    }
    if before.len() > MAX_ASSET_BYTES || before.len() > remaining {
        return Err((
            "asset_size_limit",
            "Asset exceeds the per-file or total package byte limit",
        ));
    }
    let mut created = false;
    let result = (|| -> AppResult<(u64, Vec<u8>)> {
        private_ancestors(
            target
                .parent()
                .ok_or_else(|| invalid("asset destination has no parent"))?,
        )?;
        let mut output = private_file(target)?;
        created = true;
        let mut hash = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0; 64 * 1024];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            bytes += read as u64;
            if bytes > MAX_ASSET_BYTES || bytes > remaining {
                return Err(invalid("asset grew beyond limit"));
            }
            output.write_all(&buffer[..read])?;
            hash.update(&buffer[..read]);
        }
        output.sync_all()?;
        after_copy();
        let after = source.metadata()?;
        if bytes != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err(invalid("asset changed during copy"));
        }
        let hash = hash.finalize().to_vec();
        source.seek(SeekFrom::Start(0))?;
        if hash_reader(&mut source, MAX_ASSET_BYTES)?.1 != hash {
            return Err(invalid("asset changed during copy"));
        }
        let mut current = open_managed(root, relative)?;
        if hash_reader(&mut current, MAX_ASSET_BYTES)? != (bytes, hash.clone()) {
            return Err(invalid("asset changed during copy"));
        }
        sync_directory(target.parent().unwrap())?;
        Ok((bytes, hash))
    })();
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            if created {
                let _ = fs::remove_file(target);
            }
            if matches!(&error, AppError::BadRequest(message) if message.ends_with("asset changed during copy"))
            {
                Err((
                    "asset_changed",
                    "Asset changed during copying; no completed asset is advertised",
                ))
            } else {
                Err((
                    "asset_copy_failed",
                    "Asset could not be copied durably; no completed asset is advertised",
                ))
            }
        }
    }
}

fn asset_open_error(error: std::io::Error) -> AssetFailure {
    if error.kind() == std::io::ErrorKind::NotFound {
        ("asset_missing", "Referenced managed asset does not exist")
    } else {
        (
            "asset_unreadable_or_unsafe",
            "Referenced managed asset could not be opened safely",
        )
    }
}

/// Unix walks from a held root descriptor and refuses symlinks at every asset
/// component. A concurrent ancestor rename cannot redirect reads outside root.
#[cfg(unix)]
fn open_managed(root: &Path, relative: &Path) -> std::io::Result<File> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(root)?;
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(std::io::ErrorKind::InvalidInput.into());
        };
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if index + 1 == components.len() {
                0
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: valid held parent fd and NUL-terminated single path component.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a new owned descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_managed(root: &Path, relative: &Path) -> std::io::Result<File> {
    // On Windows retain directory handles without FILE_SHARE_DELETE while
    // walking, and open reparse points themselves instead of following them.
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let root = fs::canonicalize(root)?;
        let mut path = root;
        let mut parents = Vec::new();
        for component in std::iter::once(None).chain(relative.components().map(Some)) {
            if let Some(Component::Normal(name)) = component {
                path.push(name);
            } else if component.is_some() {
                return Err(std::io::ErrorKind::InvalidInput.into());
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(1 | 2)
                .custom_flags(0x02000000 | 0x00200000)
                .open(&path)?;
            if file.metadata()?.file_attributes() & 0x400 != 0 {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            parents.push(file);
        }
        parents
            .pop()
            .ok_or_else(|| std::io::ErrorKind::InvalidInput.into())
    }
    #[cfg(not(windows))]
    {
        let _ = (root, relative);
        Err(std::io::ErrorKind::Unsupported.into())
    }
}

fn hash_file(path: &Path) -> AppResult<(u64, Vec<u8>)> {
    hash_reader(&mut File::open(path)?, u64::MAX)
}

fn hash_reader(file: &mut File, limit: u64) -> AppResult<(u64, Vec<u8>)> {
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| invalid("file too large"))?;
        if bytes > limit {
            return Err(invalid("file exceeds byte limit"));
        }
        hash.update(&buffer[..read]);
    }
    Ok((bytes, hash.finalize().to_vec()))
}

fn private_directory(path: &Path) -> AppResult<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Conflict("Migration export destination already exists".into())
        } else {
            error.into()
        }
    })?;
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        sync_directory(parent)?;
    }
    Ok(())
}

fn private_ancestors(path: &Path) -> AppResult<()> {
    if path.exists() {
        if fs::symlink_metadata(path)?.file_type().is_symlink() || !path.is_dir() {
            return Err(invalid("unsafe package directory"));
        }
        return Ok(());
    }
    private_ancestors(
        path.parent()
            .ok_or_else(|| invalid("missing package ancestor"))?,
    )?;
    private_directory(path)
}

fn private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn sync_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteJournalMode, SqlitePoolOptions};
    use tempfile::TempDir;

    const WHITEBOARD: &str =
        "{\"store\":{\"画笔\":{\"typeName\":\"shape\",\"props\":{\"text\":\"原始白板 🖌\"}}}}";
    const NOTE: &str = "原始备注\n保留空白  与 emoji 🐈";

    async fn migrate_to(pool: &SqlitePool, version: i64) {
        let all = sqlx::migrate!("./migrations");
        let prefix = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                all.iter()
                    .filter(|migration| migration.version <= version)
                    .cloned()
                    .collect(),
            ),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        prefix.run(pool).await.unwrap();
    }
    async fn fixture() -> (TempDir, SqlitePool) {
        fixture_version(3).await
    }
    async fn fixture_version(version: i64) -> (TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("live.sqlite"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(3)
            .connect_with(options)
            .await
            .unwrap();
        migrate_to(&pool, version.min(2)).await;
        seed(&pool, dir.path()).await;
        migrate_to(&pool, version).await;
        (dir, pool)
    }

    async fn seed(pool: &SqlitePool, root: &Path) {
        sqlx::query("INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES ('workspace','测试',?,'created-original','updated-original')")
            .bind(root.to_string_lossy().as_ref()).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO boards (id,workspace_id,name,whiteboard_json,kanban_json,created_at,updated_at) VALUES ('canvas','workspace','画布',?,'{\"columns\":[\"保留\"]}','created-original','updated-original')")
            .bind(WHITEBOARD).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO nodes (id,board_id,type,x,y,labels_json,note,data_json,created_at,updated_at) VALUES ('node','canvas','sticky',1,2,'[\"旧标签\"]',?,'{\"text\":\"保留正文\"}','created-original','updated-original')")
            .bind(NOTE).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO terminal_sessions (id,workspace_id,cwd,shell,status,attach_state,created_at,generation) VALUES ('session','workspace','/original','/bin/sh','running','live','created-original',9007199254740993)")
            .execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn export_preserves_original_data_and_builds_protobuf_inventory() {
        let (dir, pool) = fixture().await;
        let mut old_reader = pool.begin().await.unwrap();
        let original_name: String = sqlx::query_scalar("SELECT name FROM workspaces")
            .fetch_one(&mut *old_reader)
            .await
            .unwrap();
        assert_eq!(original_name, "测试");
        sqlx::query("UPDATE workspaces SET name='最新已提交' WHERE id='workspace'")
            .execute(&pool)
            .await
            .unwrap();
        let package = export_package(&pool, &dir.path().join("package"), ExportOptions::default())
            .await
            .unwrap();
        old_reader.rollback().await.unwrap();
        let manifest = MigrationExportManifest::decode(
            fs::read(package.path.join("manifest.pb"))
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(manifest, package.manifest);
        assert!(!manifest.ownership_switch_allowed);
        assert!(manifest.assets_complete);
        assert_eq!(manifest.migrations.len(), 3);
        assert_eq!(
            manifest.canvases[0].whiteboard_sha256,
            Sha256::digest(WHITEBOARD.as_bytes()).to_vec()
        );
        assert_eq!(
            manifest.canvases[0].whiteboard_bytes,
            WHITEBOARD.len() as u64
        );
        assert_eq!(
            manifest.canvases[0].kanban_json,
            "{\"columns\":[\"保留\"]}".as_bytes()
        );
        assert_eq!(manifest.annotations[0].note_utf8, NOTE.as_bytes());
        assert_eq!(
            manifest.annotations[0].labels_json,
            "[\"旧标签\"]".as_bytes()
        );
        for table in ["workspaces", "boards", "nodes", "terminal_sessions"] {
            assert_eq!(
                manifest
                    .identities
                    .iter()
                    .find(|ids| ids.table == table)
                    .unwrap()
                    .ids
                    .len(),
                1
            );
            assert_eq!(
                manifest
                    .tables
                    .iter()
                    .find(|stats| stats.name == table)
                    .unwrap()
                    .row_count,
                1
            );
        }
        assert_eq!(
            hash_file(&package.path.join("source.sqlite")).unwrap(),
            (manifest.database_bytes, manifest.database_sha256)
        );
        let mut snapshot = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(package.path.join("source.sqlite"))
                .read_only(true),
        )
        .await
        .unwrap();
        let preserved: (String, String, String, i64) = sqlx::query_as(
            "SELECT status,attach_state,created_at,generation FROM terminal_sessions",
        )
        .fetch_one(&mut snapshot)
        .await
        .unwrap();
        assert_eq!(
            preserved,
            (
                "running".into(),
                "live".into(),
                "created-original".into(),
                9_007_199_254_740_993
            )
        );
        let row: (String, String) = sqlx::query_as("SELECT name,updated_at FROM workspaces")
            .fetch_one(&mut snapshot)
            .await
            .unwrap();
        assert_eq!(row, ("最新已提交".into(), "updated-original".into()));
        let original: (String, String, String, i64) = sqlx::query_as(
            "SELECT status,attach_state,created_at,generation FROM terminal_sessions",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(original, preserved);
        snapshot.close().await.unwrap();
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("legacy")
        }));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&package.path).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(package.path.join("manifest.pb"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        pool.close().await;
    }

    #[tokio::test]
    async fn known_older_schema_is_preserved_without_implicit_upgrade() {
        let (dir, pool) = fixture_version(1).await;
        let package = export_package(&pool, &dir.path().join("v1"), ExportOptions::default())
            .await
            .unwrap();
        assert_eq!(package.manifest.migrations.len(), 1);
        assert!(
            package
                .manifest
                .tables
                .iter()
                .all(|table| table.name != "agent_mailbox")
        );
        let migrations: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(migrations, 1);
        pool.close().await;
    }

    #[tokio::test]
    async fn unknown_dirty_checksum_and_unknown_schema_refuse_completion() {
        for change in [
            "UPDATE _sqlx_migrations SET version=999 WHERE version=2",
            "UPDATE _sqlx_migrations SET success=0 WHERE version=2",
            "UPDATE _sqlx_migrations SET checksum=x'00' WHERE version=2",
            "CREATE TABLE unexpected (secret TEXT)",
            "DROP TABLE _sqlx_migrations",
            "ALTER TABLE _sqlx_migrations ADD COLUMN unexpected TEXT",
        ] {
            let (dir, pool) = fixture().await;
            sqlx::raw_sql(sqlx::AssertSqlSafe(change))
                .execute(&pool)
                .await
                .unwrap();
            let target = dir.path().join("refused");
            let error = export_package(&pool, &target, ExportOptions::default())
                .await
                .unwrap_err();
            assert!(
                matches!(error, AppError::BadRequest(_) | AppError::Database(_)),
                "{error}"
            );
            assert!(!target.join("manifest.pb").exists());
            let note: String = sqlx::query_scalar("SELECT note FROM nodes")
                .fetch_one(&pool)
                .await
                .unwrap();
            let status: String = sqlx::query_scalar("SELECT status FROM terminal_sessions")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(note, NOTE);
            assert_eq!(status, "running");
            assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("legacy")
            }));
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn in_memory_source_and_existing_destination_are_safe() {
        let dir = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        migrate_to(&pool, 2).await;
        seed(&pool, dir.path()).await;
        migrate_to(&pool, 3).await;
        let destination = dir.path().join("memory-export");
        export_package(&pool, &destination, ExportOptions::default())
            .await
            .unwrap();
        let original = fs::read(destination.join("manifest.pb")).unwrap();
        assert!(matches!(
            export_package(&pool, &destination, ExportOptions::default()).await,
            Err(AppError::Conflict(_))
        ));
        assert_eq!(fs::read(destination.join("manifest.pb")).unwrap(), original);
        let empty = dir.path().join("existing-empty");
        fs::create_dir(&empty).unwrap();
        assert!(
            export_package(&pool, &empty, ExportOptions::default())
                .await
                .is_err()
        );
        assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
        pool.close().await;
    }

    #[tokio::test]
    async fn managed_assets_are_deduplicated_copied_and_hashed() {
        let (dir, pool) = fixture().await;
        fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
        fs::write(
            dir.path().join(".armadra/assets/image.png"),
            b"original image bytes",
        )
        .unwrap();
        sqlx::query("UPDATE boards SET whiteboard_json=?")
            .bind(r#"{"store":{"asset":{"meta":{"armadra":{"path":".armadra/assets/image.png"}},"props":{"src":"http://old-origin/api/workspaces/workspace/assets/image.png"}}}}"#).execute(&pool).await.unwrap();
        sqlx::query("UPDATE nodes SET data_json=?")
            .bind(r#"{"path":".armadra/assets/image.png"}"#)
            .execute(&pool)
            .await
            .unwrap();
        let package = export_package(
            &pool,
            &dir.path().join("assets-copy"),
            ExportOptions::default(),
        )
        .await
        .unwrap();
        assert!(package.manifest.assets_complete);
        assert_eq!(package.manifest.assets.len(), 1);
        let asset = &package.manifest.assets[0];
        assert!(asset.copied);
        assert_eq!(asset.referenced_by.len(), 2);
        assert_eq!(
            fs::read(package.path.join(&asset.bundle_path)).unwrap(),
            b"original image bytes"
        );
        assert_eq!(
            asset.sha256,
            Sha256::digest(b"original image bytes").to_vec()
        );
        assert_eq!(asset.bytes, 20);
        assert!(
            package
                .manifest
                .issues
                .iter()
                .all(|issue| issue.code != "external_reference")
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn missing_escaping_and_external_assets_are_reported_without_reading_them() {
        let (dir, pool) = fixture().await;
        sqlx::query("UPDATE nodes SET data_json=?").bind(r#"{"files":[{"path":".armadra/assets/missing.png"},{"path":".armadra/assets/../../../secret"},{"path":"/external/credentials"},{"path":"https://example.invalid/private"}]}"#).execute(&pool).await.unwrap();
        let package = export_package(&pool, &dir.path().join("issues"), ExportOptions::default())
            .await
            .unwrap();
        assert!(!package.manifest.assets_complete);
        assert!(
            package
                .manifest
                .assets
                .iter()
                .all(|asset| !asset.copied && asset.bundle_path.is_empty())
        );
        for code in ["asset_missing", "unsafe_asset_path", "external_reference"] {
            assert!(
                package
                    .manifest
                    .issues
                    .iter()
                    .any(|issue| issue.code == code),
                "missing {code}"
            );
        }
        assert!(!package.path.join("assets").exists());
        pool.close().await;
    }

    #[tokio::test]
    async fn invalid_json_is_preserved_but_cannot_claim_complete_assets() {
        let (dir, pool) = fixture().await;
        sqlx::query("UPDATE boards SET whiteboard_json='{ broken'")
            .execute(&pool)
            .await
            .unwrap();
        let result = export_package(
            &pool,
            &dir.path().join("invalid-json"),
            ExportOptions::default(),
        )
        .await
        .unwrap();
        assert!(!result.manifest.assets_complete);
        assert!(
            result
                .manifest
                .issues
                .iter()
                .any(|issue| issue.code == "invalid_json" && issue.severity == "error")
        );
        assert_eq!(
            result.manifest.canvases[0].whiteboard_sha256,
            Sha256::digest(b"{ broken").to_vec()
        );
        pool.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_assets_never_copy_external_bytes() {
        use std::os::unix::fs::symlink;
        let (dir, pool) = fixture().await;
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), b"do not copy").unwrap();
        fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
        symlink(
            outside.path().join("secret"),
            dir.path().join(".armadra/assets/link"),
        )
        .unwrap();
        symlink(outside.path(), dir.path().join(".armadra/imports")).unwrap();
        sqlx::query("UPDATE nodes SET data_json=?")
            .bind(r#"{"paths":[".armadra/assets/link",".armadra/imports/secret"]}"#)
            .execute(&pool)
            .await
            .unwrap();
        let package = export_package(&pool, &dir.path().join("symlink"), ExportOptions::default())
            .await
            .unwrap();
        assert!(!package.manifest.assets_complete);
        assert!(package.manifest.assets.iter().all(|asset| !asset.copied));
        assert!(!package.path.join("assets").exists());
        pool.close().await;
    }

    #[test]
    fn managed_paths_and_limits_are_explicit() {
        for raw in [
            "../secret",
            ".armadra/../secret",
            ".armadra/assets/../../secret",
            ".armadra/assets//x",
            ".armadra/assets/./x",
            ".armadra/assets/C:stream",
            ".armadra/assets/line\nfile",
            ".armadra\\assets\\x",
            ".armadra/credentials/token",
            ".armadra/assets/NUL.txt",
            ".armadra/assets/LPT1",
            ".armadra/assets/file.",
            ".armadra/assets/file ",
        ] {
            assert!(managed_relative(raw).is_none(), "{raw}");
        }
        for raw in [
            ".armadra/assets/a.png",
            ".armadra/imports/batch/中文 file.txt",
            ".armadra/exports/a.png",
        ] {
            assert!(managed_relative(raw).is_some());
        }
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
        fs::write(dir.path().join(".armadra/assets/a"), b"1234").unwrap();
        assert_eq!(
            copy_asset(
                dir.path(),
                Path::new(".armadra/assets/a"),
                &dir.path().join("out"),
                3
            )
            .unwrap_err()
            .0,
            "asset_size_limit"
        );
        assert!(!dir.path().join("out").exists());
        assert_eq!(
            copy_asset(
                Path::new("relative-root"),
                Path::new(".armadra/assets/a"),
                &dir.path().join("out"),
                100
            )
            .unwrap_err()
            .0,
            "unsafe_workspace_root"
        );
    }

    #[tokio::test]
    async fn ordinary_workspace_references_require_mapping_but_are_not_missing_managed_assets() {
        let (dir, pool) = fixture().await;
        sqlx::query("UPDATE nodes SET data_json=?")
            .bind(r#"{"path":"src/main.rs"}"#)
            .execute(&pool)
            .await
            .unwrap();
        let package = export_package(
            &pool,
            &dir.path().join("source-reference"),
            ExportOptions::default(),
        )
        .await
        .unwrap();
        assert!(package.manifest.assets_complete);
        assert!(package.manifest.assets.is_empty());
        assert!(
            package
                .manifest
                .issues
                .iter()
                .any(|issue| issue.code == "external_reference")
        );
        pool.close().await;
    }

    #[test]
    fn asset_mutation_is_reported_and_existing_output_is_never_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let relative = Path::new(".armadra/assets/file");
        fs::create_dir_all(dir.path().join(".armadra/assets")).unwrap();
        let source = dir.path().join(relative);
        fs::write(&source, b"before").unwrap();
        let target = dir.path().join("copy");
        let result = copy_asset_checked(dir.path(), relative, &target, 100, || {
            fs::write(&source, b"after!").unwrap()
        });
        assert_eq!(result.unwrap_err().0, "asset_changed");
        assert!(!target.exists());
        fs::write(&target, b"existing output must survive").unwrap();
        assert_eq!(
            copy_asset(dir.path(), relative, &target, 100)
                .unwrap_err()
                .0,
            "asset_copy_failed"
        );
        assert_eq!(fs::read(&target).unwrap(), b"existing output must survive");
    }

    #[test]
    fn older_runtime_asset_urls_recover_only_the_same_workspaces_managed_reference() {
        let mut references = References::new();
        let mut manifest = MigrationExportManifest {
            assets_complete: true,
            ..Default::default()
        };
        scan_json(
            r#"{"props":{"src":"http://127.0.0.1:43120/api/workspaces/ws/assets/0123456789abcdef.png"}}"#,
            "ws",
            "canvas",
            &mut references,
            &mut manifest,
        );
        assert!(
            references.contains_key(&("ws".into(), ".armadra/assets/0123456789abcdef.png".into()))
        );
        for url in [
            "http://localhost/api/workspaces/other/assets/0123456789abcdef.png",
            "http://localhost/api/workspaces/ws/assets/../../secret",
            "http://localhost/api/workspaces/ws/assets/token",
            "http://u:p@localhost/api/workspaces/ws/assets/0123456789abcdef.png",
        ] {
            assert!(legacy_asset_url(url, "ws").is_none());
        }
    }
}
