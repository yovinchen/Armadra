//! `armadra-runtime import-host-export` — the offline half of §2.12.
//!
//! The online path is the Worker action: a Host that is running drives the
//! rollback over its private channel. This command is what an operator uses
//! when the Host cannot start, or when a package has to be applied by hand and
//! inspected afterwards. It is the same code either way; only the transport
//! differs.
//!
//! Like `export`, it starts no listener, no hook endpoint, no indexer and no
//! PTY, and it does not migrate the database: a database that has not already
//! been migrated by this build is refused rather than upgraded by a
//! maintenance command. The Runtime must not be serving — SQLite's write lock
//! is what enforces that, and a busy database fails the command instead of
//! waiting behind a live writer.

use std::{io::Write, path::PathBuf};

use armadra_protocol::{Message, v1::ApplyReverseExportRequest};

use crate::{
    error::{AppError, AppResult},
    ownership::import,
};

pub const USAGE: &str = "Usage: armadra-runtime import-host-export --package DIRECTORY \
     [--database FILE] [--domain canvas] [--expected-epoch N] [--index-sha256 HEX] \
     [--import-id ID] [--output json|protobuf]";

#[derive(Debug)]
struct Options {
    database: Option<PathBuf>,
    package: PathBuf,
    domain: String,
    expected_epoch: u64,
    index_sha256: Vec<u8>,
    import_id: String,
    protobuf: bool,
}

fn parse(args: &[String]) -> AppResult<Options> {
    let mut values: std::collections::BTreeMap<&str, String> = Default::default();
    let mut index = 0;
    // A bare directory is accepted as `--package`, because that is how the
    // command reads out loud and how the design writes it.
    if args.first().is_some_and(|first| !first.starts_with("--")) {
        values.insert("--package", args[0].clone());
        index = 1;
    }
    while index < args.len() {
        let name = args[index].as_str();
        if !matches!(
            name,
            "--database"
                | "--package"
                | "--domain"
                | "--expected-epoch"
                | "--index-sha256"
                | "--import-id"
                | "--output"
        ) {
            return Err(AppError::BadRequest(format!(
                "Unknown import option {name}"
            )));
        }
        let value = args
            .get(index + 1)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::BadRequest("Import option requires a value".into()))?;
        if values.insert(name, value.clone()).is_some() {
            return Err(AppError::BadRequest("Duplicate import option".into()));
        }
        index += 2;
    }
    let output = values
        .get("--output")
        .cloned()
        .unwrap_or_else(|| "json".into());
    if output != "json" && output != "protobuf" {
        return Err(AppError::BadRequest(
            "Import output must be json or protobuf".into(),
        ));
    }
    let package = values
        .get("--package")
        .ok_or_else(|| AppError::BadRequest("Import requires --package DIRECTORY".into()))?;
    let expected_epoch = match values.get("--expected-epoch") {
        None => 0,
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| AppError::BadRequest("--expected-epoch must be a whole number".into()))?,
    };
    let index_sha256 = match values.get("--index-sha256") {
        None => Vec::new(),
        Some(value) => import::parse_digest(value)?,
    };
    Ok(Options {
        database: values.get("--database").map(PathBuf::from),
        package: PathBuf::from(package),
        domain: values
            .get("--domain")
            .cloned()
            .unwrap_or_else(|| import::CANVAS_DOMAIN.into()),
        expected_epoch,
        index_sha256,
        import_id: values.get("--import-id").cloned().unwrap_or_default(),
        protobuf: output == "protobuf",
    })
}

pub async fn run(args: &[String]) -> AppResult<()> {
    if args == ["--help"] || args == ["-h"] {
        println!("{USAGE}");
        return Ok(());
    }
    let options = parse(args)?;
    let package = std::fs::canonicalize(&options.package)?;
    if !package.is_dir() {
        return Err(AppError::BadRequest(
            "The import package must be a directory".into(),
        ));
    }
    let database = match options.database {
        Some(path) => std::fs::canonicalize(path)?,
        None => crate::paths::data_dir().join("canvas.db"),
    };
    let pool = crate::worker::open_canvas_database(&database)
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))?;

    // The identifier defaults to the package's own index digest, so re-running
    // the identical command is an exact replay rather than a second import.
    let import_id = if options.import_id.is_empty() {
        import::default_import_id(&package)?
    } else {
        options.import_id
    };
    let result = import::apply(
        &pool,
        &ApplyReverseExportRequest {
            domain: options.domain,
            package_path: package.to_string_lossy().into_owned(),
            index_sha256: options.index_sha256,
            expected_epoch: options.expected_epoch,
            import_id,
        },
    )
    .await;
    pool.close().await;
    let report = result?;
    let bytes = if options.protobuf {
        report.encode_to_vec()
    } else {
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "importId": report.import_id,
            "domain": report.domain,
            "epoch": report.epoch.to_string(),
            "indexSha256": import::format_digest(&report.index_sha256),
            "entityCount": report.entity_count,
            "replayed": report.replayed,
            "appliedAtUnixMs": report.applied_at_unix_ms,
            "reexported": report.reexported.iter().map(|file| serde_json::json!({
                "workspaceId": file.workspace_id,
                "contentSha256": import::format_digest(&file.content_sha256),
                "entityCount": file.entity_count,
            })).collect::<Vec<_>>(),
            "tables": report.tables.iter().map(|table| serde_json::json!({
                "name": table.name, "rowCount": table.row_count,
            })).collect::<Vec<_>>(),
            // Applying a package is not a handoff. The epoch comes back over
            // the ownership command, and only after the Host has compared the
            // digests above with the package it wrote.
            "ownershipSwitchAllowed": false,
        }))
        .map_err(|error| AppError::Internal(error.to_string()))?;
        bytes.push(b'\n');
        bytes
    };
    std::io::stdout().lock().write_all(&bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(arguments: &[&str]) -> AppResult<Options> {
        parse(
            &arguments
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn a_bare_directory_is_the_package_and_the_defaults_are_the_canvas_domain() {
        let options = parsed(&["/data/reverse-export"]).unwrap();
        assert_eq!(options.package, PathBuf::from("/data/reverse-export"));
        assert_eq!(options.domain, "canvas");
        assert_eq!(options.expected_epoch, 0);
        assert!(options.index_sha256.is_empty() && options.import_id.is_empty());
        assert!(!options.protobuf);
        assert!(options.database.is_none());
    }

    #[test]
    fn every_option_is_read_and_none_may_be_repeated_or_invented() {
        let options = parsed(&[
            "--package",
            "/data/reverse-export",
            "--database",
            "/data/canvas.db",
            "--expected-epoch",
            "7",
            "--index-sha256",
            &"ab".repeat(32),
            "--import-id",
            "rollback-1",
            "--output",
            "protobuf",
        ])
        .unwrap();
        assert_eq!(options.database, Some(PathBuf::from("/data/canvas.db")));
        assert_eq!(options.expected_epoch, 7);
        assert_eq!(options.index_sha256, vec![0xab; 32]);
        assert_eq!(options.import_id, "rollback-1");
        assert!(options.protobuf);
        for arguments in [
            vec![],
            vec!["--package"],
            vec!["--package", "/a", "--package", "/b"],
            vec!["--package", "/a", "--output", "yaml"],
            vec!["--package", "/a", "--expected-epoch", "later"],
            vec!["--package", "/a", "--index-sha256", "not-a-digest"],
            vec!["--package", "/a", "--wipe-everything", "yes"],
        ] {
            assert!(
                parsed(&arguments).is_err(),
                "{arguments:?} should have failed"
            );
        }
    }
}
