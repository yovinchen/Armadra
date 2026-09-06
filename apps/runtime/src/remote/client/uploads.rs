//! The chunked upload steps: begin, chunk, commit and abort.

use armadra_protocol::v1;

use super::RemoteWorker;
use crate::{error::AppResult, remote::service::Replay};

impl RemoteWorker {
    /// Open a chunked upload. Answers the id the remaining steps use.
    pub async fn upload_begin(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        total_bytes: u64,
        sha256: String,
        overwrite_sha256: Option<String>,
    ) -> AppResult<String> {
        self.require_capability(crate::remote::service::replay::UPLOAD_CAPABILITY)
            .await?;
        Ok(self
            .upload_step(
                root_id,
                root_path,
                v1::worker_upload_request::Step::Begin(v1::WorkerUploadBegin {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                    total_bytes,
                    sha256,
                    overwrite_sha256,
                    allow_write: true,
                }),
            )
            .await?
            .upload_id)
    }

    /// Append one chunk; answers how many bytes the host now holds.
    pub async fn upload_chunk(
        &self,
        root_id: &str,
        root_path: &str,
        upload_id: &str,
        offset: u64,
        data: Vec<u8>,
    ) -> AppResult<u64> {
        Ok(self
            .upload_step(
                root_id,
                root_path,
                v1::worker_upload_request::Step::Chunk(v1::WorkerUploadChunk {
                    upload_id: upload_id.to_owned(),
                    offset,
                    data,
                }),
            )
            .await?
            .received_bytes)
    }

    pub async fn upload_commit(
        &self,
        root_id: &str,
        root_path: &str,
        upload_id: &str,
    ) -> AppResult<v1::WorkerUploadResponse> {
        self.upload_step(
            root_id,
            root_path,
            v1::worker_upload_request::Step::Commit(v1::WorkerUploadCommit {
                upload_id: upload_id.to_owned(),
            }),
        )
        .await
    }

    pub async fn upload_abort(
        &self,
        root_id: &str,
        root_path: &str,
        upload_id: &str,
    ) -> AppResult<v1::WorkerUploadResponse> {
        self.upload_step(
            root_id,
            root_path,
            v1::worker_upload_request::Step::Abort(v1::WorkerUploadAbort {
                upload_id: upload_id.to_owned(),
            }),
        )
        .await
    }

    async fn upload_step(
        &self,
        root_id: &str,
        root_path: &str,
        step: v1::worker_upload_request::Step,
    ) -> AppResult<v1::WorkerUploadResponse> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::Upload(v1::WorkerUploadRequest { step: Some(step) }),
                // Every step writes. A step that was sent and then lost its
                // answer may have landed, and re-sending it would either
                // duplicate bytes or publish a file twice.
                Replay::Never,
            )
            .await?
        {
            v1::worker_response::Result::Upload(response) => Ok(response),
            _ => Err(self.wrong_answer()),
        }
    }
}
