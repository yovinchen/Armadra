//! Receiving a chunked upload on the execution host (design §3.1).
//!
//! Every upload writes one temporary file **beside its destination**, so the
//! publish is a rename within one filesystem and therefore atomic. Nothing
//! reaches the destination until the received bytes hash to the digest the
//! controller promised at `begin`: a dropped connection, a truncated stream or
//! a reordered chunk all end as a refusal with the destination untouched.
//!
//! Three ceilings keep a hostile or broken controller from costing the host
//! more than one request's worth of disk: a per-upload byte limit, a limit on
//! how many uploads may be open at once, and an idle expiry that reclaims what
//! a vanished controller left behind.

use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    security,
};

/// The largest file one upload may carry, matching the local import ceiling.
pub const MAX_UPLOAD_BYTES: u64 = crate::imports::MAX_FILE_BYTES as u64;
/// How many uploads one Worker keeps open at once.
const MAX_OPEN: usize = 8;
/// How long an upload may sit without a chunk before it is reclaimed.
const IDLE: Duration = Duration::from_secs(300);

/// Nothing here may be written into: the trash is where deleted bytes wait to
/// be restored, and an upload landing in it would silently replace one.
const FORBIDDEN_PREFIX: &str = ".armadra/trash";

struct Pending {
    destination: PathBuf,
    temporary: PathBuf,
    file: std::fs::File,
    received: u64,
    total: u64,
    hasher: Sha256,
    expected: String,
    /// The content version being replaced. `None` means create-only.
    overwrite: Option<String>,
    touched: Instant,
    /// The path the receipt reports, workspace-relative.
    relative: String,
}

#[derive(Default)]
pub struct Uploads {
    open: HashMap<String, Pending>,
}

/// What one step of the stream answers with.
pub struct Receipt {
    pub upload_id: String,
    pub received_bytes: u64,
    pub sha256: String,
    pub path: String,
}

impl Uploads {
    /// Open an upload against `root`. The destination's parent is created here
    /// so that the temporary file can live beside it.
    pub fn begin(
        &mut self,
        root: &Path,
        requested: &str,
        total_bytes: u64,
        sha256: &str,
        overwrite: Option<String>,
    ) -> AppResult<Receipt> {
        self.expire();
        if total_bytes > MAX_UPLOAD_BYTES {
            return Err(AppError::BadRequest(
                "The upload is larger than this workspace accepts".into(),
            ));
        }
        if !is_digest(sha256) {
            return Err(AppError::BadRequest("The upload digest is invalid".into()));
        }
        if overwrite.as_deref().is_some_and(|value| !is_digest(value)) {
            return Err(AppError::BadRequest(
                "The content version being replaced is invalid".into(),
            ));
        }
        if self.open.len() >= MAX_OPEN {
            return Err(AppError::Conflict(
                "Too many uploads are already in flight on this execution host".into(),
            ));
        }
        let relative = security::workspace_relative_path(requested)?;
        if relative == FORBIDDEN_PREFIX || relative.starts_with(&format!("{FORBIDDEN_PREFIX}/")) {
            return Err(AppError::Forbidden(
                "The trash is not an upload destination".into(),
            ));
        }
        // The destination directory is created first, because an upload to
        // `.armadra/assets/` is normally the thing that creates it. The
        // *boundary* is then proven by resolving the parent, which
        // canonicalizes it: a symlinked directory inside the workspace must
        // not become a way out of it.
        std::fs::create_dir_all(root.join(parent_relative(&relative)))?;
        let destination = security::resolve_writable_in_root(root, &relative)?;
        let parent = destination
            .parent()
            .ok_or_else(|| AppError::BadRequest("The upload has no destination".into()))?
            .to_owned();
        verify_version(&destination, overwrite.as_deref())?;

        let upload_id = format!("u-{}", uuid::Uuid::now_v7().simple());
        let temporary = parent.join(format!(".armadra-upload-{upload_id}"));
        let file = std::fs::File::create(&temporary)?;
        self.open.insert(
            upload_id.clone(),
            Pending {
                destination,
                temporary,
                file,
                received: 0,
                total: total_bytes,
                hasher: Sha256::new(),
                expected: sha256.to_ascii_lowercase(),
                overwrite,
                touched: Instant::now(),
                relative: relative.clone(),
            },
        );
        Ok(Receipt {
            upload_id,
            received_bytes: 0,
            sha256: String::new(),
            path: relative,
        })
    }

    /// Append one chunk. `offset` must be exactly what the Worker already has:
    /// a stream that skipped ahead would leave a hole the digest could not
    /// detect until the very end, and the caller deserves to know sooner.
    pub fn chunk(&mut self, upload_id: &str, offset: u64, data: &[u8]) -> AppResult<Receipt> {
        let pending = self.pending(upload_id)?;
        if offset != pending.received {
            return Err(AppError::Conflict(
                "The upload chunk is not at the position the execution host expects".into(),
            ));
        }
        if pending.received + data.len() as u64 > pending.total {
            return Err(AppError::BadRequest(
                "The upload is longer than it declared".into(),
            ));
        }
        // Chunks are capped at 256 KiB by the frame limit, so this write is
        // short enough not to be worth moving off the reactor.
        pending.file.write_all(data)?;
        pending.hasher.update(data);
        pending.received += data.len() as u64;
        pending.touched = Instant::now();
        Ok(Receipt {
            upload_id: upload_id.to_owned(),
            received_bytes: pending.received,
            sha256: String::new(),
            path: pending.relative.clone(),
        })
    }

    /// Verify and publish. The destination's content version is checked again
    /// here, because the file may have changed while the bytes were arriving.
    pub fn commit(&mut self, upload_id: &str) -> AppResult<Receipt> {
        {
            let pending = self.pending(upload_id)?;
            if pending.received != pending.total {
                return Err(AppError::Conflict(
                    "The upload ended before all of its bytes arrived".into(),
                ));
            }
        }
        // Taken out of the map first: whatever happens next, this upload is
        // over and its temporary file must not be left registered.
        let mut pending = self.open.remove(upload_id).expect("checked above");
        let result = (|| -> AppResult<Receipt> {
            let digest = format!("{:x}", std::mem::take(&mut pending.hasher).finalize());
            if digest != pending.expected {
                return Err(AppError::Conflict(
                    "The uploaded bytes do not match the digest the caller promised".into(),
                ));
            }
            pending.file.flush()?;
            pending.file.sync_all()?;
            verify_version(&pending.destination, pending.overwrite.as_deref())?;
            std::fs::rename(&pending.temporary, &pending.destination)?;
            Ok(Receipt {
                upload_id: upload_id.to_owned(),
                received_bytes: pending.received,
                sha256: digest,
                path: pending.relative.clone(),
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&pending.temporary);
        }
        result
    }

    /// Give up on an upload and remove what it had written.
    pub fn abort(&mut self, upload_id: &str) -> AppResult<Receipt> {
        self.pending(upload_id)?;
        let pending = self.open.remove(upload_id).expect("checked above");
        let _ = std::fs::remove_file(&pending.temporary);
        Ok(Receipt {
            upload_id: upload_id.to_owned(),
            received_bytes: pending.received,
            sha256: String::new(),
            path: pending.relative,
        })
    }

    fn pending(&mut self, upload_id: &str) -> AppResult<&mut Pending> {
        self.expire();
        self.open
            .get_mut(upload_id)
            .ok_or_else(|| AppError::NotFound("The upload is not open".into()))
    }

    fn expire(&mut self) {
        let now = Instant::now();
        let stale: Vec<String> = self
            .open
            .iter()
            .filter(|(_, pending)| now.duration_since(pending.touched) > IDLE)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(pending) = self.open.remove(&id) {
                let _ = std::fs::remove_file(&pending.temporary);
            }
        }
    }
}

impl Drop for Uploads {
    fn drop(&mut self) {
        // A Worker that goes away leaves no half-written files behind.
        for pending in self.open.values() {
            let _ = std::fs::remove_file(&pending.temporary);
        }
    }
}

fn parent_relative(relative: &str) -> String {
    match relative.rsplit_once('/') {
        Some((parent, _)) => parent.to_owned(),
        None => ".".to_owned(),
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `None` means create-only; `Some` means the file must currently hold exactly
/// that content version.
fn verify_version(destination: &Path, overwrite: Option<&str>) -> AppResult<()> {
    let current = match std::fs::read(destination) {
        Ok(bytes) => Some(format!("{:x}", Sha256::digest(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    match (overwrite, current) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(AppError::Conflict(
            "A file already exists at the upload destination".into(),
        )),
        (Some(_), None) => Err(AppError::Conflict(
            "The file the upload would replace no longer exists".into(),
        )),
        (Some(expected), Some(actual)) if expected.eq_ignore_ascii_case(&actual) => Ok(()),
        (Some(_), Some(_)) => Err(AppError::Conflict(
            "The file changed on the execution host while the upload was in flight".into(),
        )),
    }
}

#[cfg(test)]
mod tests;
