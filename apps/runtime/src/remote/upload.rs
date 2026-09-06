//! The controller half of a chunked upload to an execution host (design §3.1).
//!
//! A browser hands the Runtime one blob. The Worker link carries frames of at
//! most one MiB, so the blob is cut into `MAX_CHUNK` pieces and streamed:
//! `begin` with the whole-file digest, then chunks, then `commit`. The digest
//! is what makes this safe to do in pieces — the Worker publishes nothing until
//! the bytes it received hash to the value the controller promised at `begin`,
//! so a truncated or reordered stream ends as a refusal rather than as a
//! half-written file.
//!
//! A failure mid-stream aborts the upload rather than leaving the temporary
//! file behind. An abort that itself fails is not retried: the Worker expires
//! the upload on its own, and hammering an unreachable host is worse than one
//! stale temporary file.

use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    remote::client::RemoteWorker,
    worker::MAX_CHUNK,
};

/// Where an upload landed on the execution host.
pub struct Uploaded {
    /// Workspace-relative, as the Worker resolved it.
    pub path: String,
    /// Lowercase hexadecimal SHA-256 of the published bytes.
    pub sha256: String,
    pub bytes: usize,
}

/// The digest the caller promises and the Worker verifies.
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Send `bytes` to `path` on the execution host.
///
/// `overwrite_sha256` is the content version being replaced; `None` means the
/// destination must not already exist, the same rule an editor save follows.
pub async fn upload(
    worker: &RemoteWorker,
    root_id: &str,
    root_path: &str,
    path: &str,
    bytes: &[u8],
    overwrite_sha256: Option<String>,
) -> AppResult<Uploaded> {
    let sha256 = digest(bytes);
    let upload_id = worker
        .upload_begin(
            root_id,
            root_path,
            path,
            bytes.len() as u64,
            sha256.clone(),
            overwrite_sha256,
        )
        .await?;
    match stream(worker, root_id, root_path, &upload_id, bytes).await {
        Ok(()) => {
            let committed = worker.upload_commit(root_id, root_path, &upload_id).await?;
            Ok(Uploaded {
                path: committed.path,
                sha256: committed.sha256,
                bytes: bytes.len(),
            })
        }
        Err(error) => {
            // Best effort: the Worker also expires abandoned uploads, so a
            // failed abort costs a temporary file and not correctness.
            let _ = worker.upload_abort(root_id, root_path, &upload_id).await;
            Err(error)
        }
    }
}

async fn stream(
    worker: &RemoteWorker,
    root_id: &str,
    root_path: &str,
    upload_id: &str,
    bytes: &[u8],
) -> AppResult<()> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let end = (offset + MAX_CHUNK).min(bytes.len());
        let accepted = worker
            .upload_chunk(
                root_id,
                root_path,
                upload_id,
                offset as u64,
                bytes[offset..end].to_vec(),
            )
            .await?;
        // The Worker reports what it has, not what it was sent. A receipt that
        // does not match means the two ends disagree about the stream, and
        // continuing would publish bytes at the wrong offsets.
        if accepted != end as u64 {
            return Err(AppError::Conflict(
                "The execution host and this controller disagree on the upload position".into(),
            ));
        }
        offset = end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The digest is the whole safety argument for streaming, so it has to be
    /// the plain lowercase hex of the bytes and nothing cleverer.
    #[test]
    fn the_digest_is_lowercase_hex_of_the_whole_body() {
        assert_eq!(
            digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(digest(b"abc").len(), 64);
        assert!(digest(b"abc").chars().all(|c| c.is_ascii_hexdigit()));
    }
}
