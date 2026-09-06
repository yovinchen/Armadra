//! Reads the read-only snapshot: validates the migration ledger and schema
//! against the known prefix, then inventories tables, identities and canvases.

use std::path::PathBuf;

use armadra_protocol::v1::*;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection};

use crate::error::AppResult;

use super::{
    References, WorkspaceRoots, check_manifest_size, invalid, issue, quote_identifier,
    references::scan_json,
};

pub(super) async fn inspect_snapshot(
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
