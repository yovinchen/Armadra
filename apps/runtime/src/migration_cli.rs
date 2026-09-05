//! Offline export command. It does not start listeners, hooks, indexers or PTYs.
use crate::{
    error::{AppError, AppResult},
    migration_export::{self, ExportOptions},
};
use armadra_protocol::Message;
use std::{io::Write, path::PathBuf};

#[derive(Debug)]
struct Options {
    database: PathBuf,
    destination: PathBuf,
    protobuf: bool,
    assets: bool,
}
fn parse(args: &[String]) -> AppResult<Options> {
    let mut database = None;
    let mut destination = None;
    let mut output = None;
    let mut assets = true;
    let mut index = 0;
    while index < args.len() {
        let name = args[index].as_str();
        if name == "--without-assets" {
            if !assets {
                return Err(AppError::BadRequest("Duplicate export option".into()));
            }
            assets = false;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::BadRequest("Export option requires a value".into()))?;
        let slot = match name {
            "--database" => &mut database,
            "--destination" => &mut destination,
            "--output" => &mut output,
            _ => return Err(AppError::BadRequest("Unknown export option".into())),
        };
        if slot.replace(value.clone()).is_some() {
            return Err(AppError::BadRequest("Duplicate export option".into()));
        }
        index += 2;
    }
    let output = output.as_deref().unwrap_or("json");
    if output != "json" && output != "protobuf" {
        return Err(AppError::BadRequest(
            "Export output must be json or protobuf".into(),
        ));
    }
    Ok(Options {
        database: database
            .ok_or_else(|| AppError::BadRequest("Export requires --database PATH".into()))?
            .into(),
        destination: destination
            .ok_or_else(|| AppError::BadRequest("Export requires --destination DIRECTORY".into()))?
            .into(),
        protobuf: output == "protobuf",
        assets,
    })
}

pub async fn run(args: &[String]) -> AppResult<()> {
    if args == ["--help"] || args == ["-h"] {
        println!(
            "Usage: armadra-runtime export --database FILE --destination NEW_DIRECTORY [--without-assets] [--output json|protobuf]"
        );
        return Ok(());
    }
    let options = parse(args)?;
    let source = std::fs::canonicalize(&options.database)?;
    if !source.is_file() {
        return Err(AppError::BadRequest(
            "Export source must be a database file".into(),
        ));
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(source)
                .read_only(true)
                .create_if_missing(false),
        )
        .await?;
    let result = migration_export::export_package(
        &pool,
        &options.destination,
        ExportOptions {
            include_assets: options.assets,
        },
    )
    .await;
    pool.close().await;
    let result = result?;
    let bytes = if options.protobuf {
        result.manifest.encode_to_vec()
    } else {
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "path":result.path, "exportId":result.manifest.export_id,
            "databaseBytes":result.manifest.database_bytes,
            "assetsComplete":result.manifest.assets_complete,
            "issues":result.manifest.issues.iter().map(|issue| serde_json::json!({"code":issue.code,"severity":issue.severity,"entity":issue.entity,"detail":issue.detail})).collect::<Vec<_>>(),
            "ownershipSwitchAllowed":false
        })).map_err(|error| AppError::Internal(error.to_string()))?;
        bytes.push(b'\n');
        bytes
    };
    std::io::stdout().lock().write_all(&bytes)?;
    Ok(())
}
