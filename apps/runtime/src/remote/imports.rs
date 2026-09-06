//! Importing files into a workspace that lives on an execution host.
//!
//! Locally an import stages everything under `.armadra/imports/.pending-<id>/`
//! and renames the whole directory into place, so a batch is all-or-nothing.
//! Remotely each file is published atomically by the Worker's own upload
//! commit, but the *batch* is not: an interrupted import can leave the files
//! that already arrived under `.armadra/imports/<id>/`. That is a real and
//! deliberate difference — the alternative is a second staging protocol whose
//! only job is to rename a directory — and it is bounded: the destination is a
//! fresh UUID directory that nothing else writes to, so a partial import is
//! visible and disposable rather than mixed into the project.
//!
//! The bytes travel from the controller in both entry points. A multipart
//! upload is already in the controller's memory; a by-path import comes from
//! the desktop shell's drag-and-drop, which reports paths on the machine the
//! person is sitting at.

use std::path::Path;

use armadra_protocol::v1::WorkerServiceOperation;

use crate::{
    error::{AppError, AppResult},
    imports::{self, ImportManifest, ImportResult},
    model::Workspace,
    remote::{client::RemoteWorker, service::PathPayload, upload},
};

/// Where an import lands, matching the local layout so a client sees the same
/// `path` whichever machine ran it.
const DIRECTORY: &str = ".armadra/imports";

/// Receive a multipart import and stream every file to the execution host.
pub async fn receive(
    worker: &RemoteWorker,
    workspace: &Workspace,
    multipart: &mut axum::extract::Multipart,
    manifest: &ImportManifest,
) -> AppResult<ImportResult> {
    let relative = format!("{DIRECTORY}/{}", uuid::Uuid::new_v4());
    let mut written = Vec::new();
    let mut total = 0usize;
    let mut received = std::collections::HashSet::new();
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest("Incomplete file upload".into()))?
    {
        let index: usize = field
            .name()
            .and_then(|name| name.parse().ok())
            .filter(|index| *index < manifest.paths.len())
            .ok_or_else(|| AppError::BadRequest("Unexpected imported file".into()))?;
        if !received.insert(index) {
            return Err(AppError::BadRequest("Duplicate imported file".into()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| AppError::BadRequest("Incomplete file upload".into()))?
        {
            if bytes.len().saturating_add(chunk.len()) > imports::MAX_FILE_BYTES {
                return Err(AppError::BadRequest(
                    "A file exceeds the 16 MiB import limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        total = total.saturating_add(bytes.len());
        if total > imports::MAX_BATCH_BYTES || written.len() >= imports::MAX_FILES {
            return Err(AppError::BadRequest(
                "Import exceeds the file count or size limit".into(),
            ));
        }
        let path = imports::relative_path(&manifest.paths[index])?;
        written.push(send(worker, workspace, &relative, &path, &bytes).await?);
    }
    if received.len() != manifest.paths.len() {
        return Err(AppError::BadRequest(
            "Some imported files are missing".into(),
        ));
    }
    describe(worker, workspace, relative, written).await
}

/// Copy files named by absolute path on the controller into a remote
/// workspace. Names collide the same way they do locally: the first file to
/// claim a name keeps it and later ones get an ordinal.
pub async fn copy_paths(
    worker: &RemoteWorker,
    workspace: &Workspace,
    paths: Vec<String>,
) -> AppResult<ImportResult> {
    let relative = format!("{DIRECTORY}/{}", uuid::Uuid::new_v4());
    let mut written: Vec<String> = Vec::new();
    let mut total = 0usize;
    for requested in paths {
        let source = Path::new(&requested);
        if !source.is_absolute() {
            return Err(AppError::BadRequest(
                "Import paths must be absolute on the machine that has the files".into(),
            ));
        }
        let bytes = tokio::task::spawn_blocking({
            let source = source.to_owned();
            move || read_source(&source)
        })
        .await??;
        total = total.saturating_add(bytes.len());
        if total > imports::MAX_BATCH_BYTES {
            return Err(AppError::BadRequest(
                "Import exceeds the file count or size limit".into(),
            ));
        }
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::BadRequest("Invalid file name".into()))?;
        let name = available_name(name, &written)?;
        written.push(send(worker, workspace, &relative, &name, &bytes).await?);
    }
    describe(worker, workspace, relative, written).await
}

fn read_source(source: &Path) -> AppResult<Vec<u8>> {
    use std::io::Read;

    let mut bytes = Vec::new();
    std::fs::File::open(source)?
        .take(imports::MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > imports::MAX_FILE_BYTES {
        return Err(AppError::BadRequest(
            "A file exceeds the 16 MiB import limit".into(),
        ));
    }
    Ok(bytes)
}

async fn send(
    worker: &RemoteWorker,
    workspace: &Workspace,
    relative: &str,
    path: &str,
    bytes: &[u8],
) -> AppResult<String> {
    let destination = format!("{relative}/{path}");
    upload::upload(
        worker,
        &workspace.id,
        &workspace.root_path,
        &destination,
        bytes,
        // Create-only: a UUID destination that already holds this name means
        // two imports collided, which is a conflict rather than a replacement.
        None,
    )
    .await
    .map(|uploaded| uploaded.path)
}

/// The answer's per-file metadata comes from the execution host, because the
/// MIME guess and the preview class are decided by what is actually on that
/// disk.
async fn describe(
    worker: &RemoteWorker,
    workspace: &Workspace,
    relative: String,
    written: Vec<String>,
) -> AppResult<ImportResult> {
    let mut files = Vec::with_capacity(written.len());
    for path in written {
        let (status, body) = worker
            .service(
                &workspace.id,
                &workspace.root_path,
                WorkerServiceOperation::FileInfo,
                serde_json::to_vec(&PathPayload { path })
                    .map_err(|_| AppError::Internal("Request could not be encoded".into()))?,
                false,
                false,
            )
            .await?;
        if status != 200 {
            return Err(AppError::Internal(
                "The execution host could not describe an imported file".into(),
            ));
        }
        files.push(serde_json::from_slice(&body).map_err(|_| {
            AppError::Internal("The execution host answered with an unreadable body".into())
        })?);
    }
    Ok(ImportResult {
        path: relative,
        files,
    })
}

/// The local batch allocates names against the staging directory; here the
/// only names that can collide are the ones this batch already sent, because
/// the destination directory is a fresh UUID.
fn available_name(name: &str, taken: &[String]) -> AppResult<String> {
    imports::relative_path(name)?;
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = path.extension().and_then(|value| value.to_str());
    let mut candidate = name.to_owned();
    let mut ordinal = 2;
    while taken
        .iter()
        .any(|existing| existing.rsplit('/').next() == Some(candidate.as_str()))
    {
        candidate = match extension {
            Some(extension) => format!("{stem}-{ordinal}.{extension}"),
            None => format!("{stem}-{ordinal}"),
        };
        ordinal += 1;
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A desktop drop can carry two files with the same name from different
    /// folders, and neither may overwrite the other.
    #[test]
    fn equally_named_files_each_get_their_own_destination() {
        let taken = vec![
            ".armadra/imports/1/photo.png".to_owned(),
            ".armadra/imports/1/photo-2.png".to_owned(),
        ];
        assert_eq!(available_name("photo.png", &taken).unwrap(), "photo-3.png");
        assert_eq!(available_name("other.png", &taken).unwrap(), "other.png");
    }

    #[test]
    fn a_traversing_name_is_refused_before_it_reaches_the_execution_host() {
        assert!(available_name("../escape", &[]).is_err());
        assert!(available_name("a/../b", &[]).is_err());
    }
}
