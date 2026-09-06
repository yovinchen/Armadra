//! The filesystem domain on the private Worker channel
//! (Go Host 业务所有权迁移 §2.9, `WorkerRequest.action` 26).
//!
//! One question travels here, and it is a read: *what does this Runtime believe
//! about its workspace roots?* The Host asks it while handing the domain back,
//! and compares the answer with the package it just wrote. That comparison is
//! only worth making because this answer comes from the rows rather than from
//! the request that stored them — a Worker that echoed the request would make
//! every handback pass.
//!
//! Nothing here writes. Registering a root, changing a permission and applying
//! a reverse export all have their own paths; this module is the translation
//! between a frame and one query, and it stays that way so the frame handler
//! never becomes a second place where roots are decided.

use armadra_protocol::v1::{
    FilesystemWorkerRequest, FilesystemWorkerResponse, WorkerWorkspaceRoots,
    filesystem_worker_request, filesystem_worker_response,
};
use sqlx::SqlitePool;

use crate::{
    error::{AppError, AppResult},
    ownership,
};

/// Advertised when this Worker actually opened the Runtime's database, so a
/// controller never plans a handback verification this process would have to
/// refuse.
pub const CAPABILITY: &str = "filesystem.worker.v1";

pub async fn handle(
    pool: &SqlitePool,
    request: FilesystemWorkerRequest,
) -> AppResult<FilesystemWorkerResponse> {
    match request.action {
        Some(filesystem_worker_request::Action::ListRoots(_)) => {
            let roots = ownership::filesystem::worker_roots(pool).await?;
            Ok(FilesystemWorkerResponse {
                result: Some(filesystem_worker_response::Result::Roots(
                    WorkerWorkspaceRoots { roots },
                )),
            })
        }
        // An action a newer Host introduced is refused rather than answered
        // with an empty list, which the Host would compare against its package
        // and read as agreement.
        None => Err(AppError::BadRequest(
            "Filesystem worker action is missing".into(),
        )),
    }
}
