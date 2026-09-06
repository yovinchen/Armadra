//! Reading a whole file off an execution host (design §3.1).
//!
//! Downloads reuse the chunked `WorkerReadFileRequest` rather than inventing a
//! second reader: the digest handshake that stops two versions of a file from
//! being spliced together already lives there, and a download wants exactly
//! that property. What differs is only `raw` — a download is bytes, not editor
//! text, so it is not refused for containing a zero byte and not capped at the
//! preview limit.

use crate::{
    error::{AppError, AppResult},
    model::Workspace,
    remote::client::RemoteWorker,
};

pub struct Downloaded {
    /// Workspace-relative, as the execution host resolved it.
    pub path: String,
    pub bytes: Vec<u8>,
}

/// How many chunks one download may take. At 256 KiB a chunk this is the same
/// 16 MiB ceiling the local download enforces, expressed where the loop is.
const MAX_CHUNKS: usize = (crate::imports::MAX_FILE_BYTES / crate::worker::MAX_CHUNK) + 2;

pub async fn fetch(
    worker: &RemoteWorker,
    workspace: &Workspace,
    path: &str,
) -> AppResult<Downloaded> {
    let mut bytes: Vec<u8> = Vec::new();
    let mut version: Option<Vec<u8>> = None;
    let mut relative = String::new();
    for _ in 0..MAX_CHUNKS {
        let chunk = worker
            .read_raw_file(
                &workspace.id,
                &workspace.root_path,
                path,
                bytes.len() as u64,
                version.clone(),
            )
            .await?;
        // From the second chunk on the digest of the first is sent back, so a
        // file rewritten mid-download is a conflict rather than a splice of two
        // versions.
        if version.is_none() {
            version = Some(chunk.sha256.clone());
            relative = chunk.path.clone();
        }
        bytes.extend_from_slice(&chunk.data);
        if chunk.eof {
            return Ok(Downloaded {
                path: relative,
                bytes,
            });
        }
        if chunk.data.is_empty() {
            // No progress and no end: refuse rather than loop forever.
            break;
        }
    }
    Err(AppError::BadRequest(
        "The file on the execution host is larger than the download limit".into(),
    ))
}
