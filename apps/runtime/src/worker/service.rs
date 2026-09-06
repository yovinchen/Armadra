//! The three actions a controller uses to work on a whole root: proxied
//! service operations, filesystem subscriptions and chunked uploads.
//!
//! Split out of the dispatch table because each carries rules of its own worth
//! reading together — which grant an operation needs, why a subscription is
//! typed rather than proxied, and why every step of an upload is a write.

use armadra_protocol::v1::*;

use super::{MAX_FRAME, Worker, invalid};
use crate::error::AppError;

impl Worker {
    /// Version-locked operations proxied from a controller. The list is closed
    /// and the payload is this build's own JSON; see `remote::service` for why
    /// that is safe here and nowhere else.
    pub(super) async fn service(
        &mut self,
        input: WorkerServiceRequest,
    ) -> Result<worker_response::Result, AppError> {
        use worker_response::Result as Response;

        let Ok(operation) = WorkerServiceOperation::try_from(input.operation) else {
            return Ok(Response::Error(ErrorResponse {
                code: "UNSUPPORTED".into(),
                message: "Worker service operation is not recognized".into(),
            }));
        };
        let root = self.root(&input.root_id)?;
        let (http_status, response_json) = crate::remote::service::handle(
            root,
            operation,
            input.request_json,
            input.allow_write,
            input.allow_execute,
        )
        .await;
        // Refused rather than truncated: half an answer that still parses is
        // worse than an error naming the limit.
        if response_json.len() > MAX_FRAME - 1024 {
            return Ok(Response::Error(ErrorResponse {
                code: "RESOURCE_EXHAUSTED".into(),
                message: "The answer is larger than one Worker frame".into(),
            }));
        }
        Ok(Response::Service(WorkerServiceResponse {
            http_status,
            response_json,
        }))
    }

    /// Watching is not a service payload: the events it produces are
    /// unsolicited frames that belong to the connection, so the subscription
    /// is typed and the connection owns it.
    pub(super) fn watch(
        &mut self,
        input: WorkerWatchRequest,
    ) -> Result<worker_response::Result, AppError> {
        use worker_response::Result as Response;

        if self.watches.is_none() {
            return Ok(Response::Error(ErrorResponse {
                code: "UNSUPPORTED".into(),
                message: "This Worker transport cannot push watch events".into(),
            }));
        }
        let operation = WorkerServiceOperation::try_from(input.operation)
            .map_err(|_| invalid("Unknown watch operation"))?;
        if input.paths.len() > crate::remote::service::MAX_WATCH_PATHS {
            return Err(invalid("Too many watched paths"));
        }
        // The root is resolved before the subscription is borrowed, so an
        // unregistered root fails without disturbing the watches that already
        // exist.
        let root = match operation {
            WorkerServiceOperation::WatchSubscribe => Some(self.root(&input.root_id)?),
            WorkerServiceOperation::WatchUnsubscribe => None,
            _ => {
                return Ok(Response::Error(ErrorResponse {
                    code: "UNSUPPORTED".into(),
                    message: "That is not a watch operation".into(),
                }));
            }
        };
        let watches = self.watches.as_mut().expect("checked above");
        match root {
            Some(root) => watches.subscribe(&root, &input.root_id, &input.paths)?,
            None => watches.unsubscribe(&input.paths)?,
        }
        Ok(Response::Watch(WorkerWatchSubscription {
            root_id: input.root_id,
            watched_paths: watches.watched_paths(),
            sequence: watches.next_sequence(),
        }))
    }

    /// One step of a chunked upload.
    ///
    /// The write grant is checked at `begin` and nowhere else, because that is
    /// the only step that names a destination: a controller that may not write
    /// must not even be able to occupy the host's temporary space, and the
    /// upload id the other steps carry is one this Worker minted for a
    /// destination it has already proven.
    pub(super) fn upload(
        &mut self,
        input: WorkerUploadRequest,
    ) -> Result<worker_response::Result, AppError> {
        use worker_response::Result as Response;

        let step = input
            .step
            .ok_or_else(|| invalid("The upload step is missing"))?;
        let receipt = match step {
            worker_upload_request::Step::Begin(begin) => {
                if !begin.allow_write {
                    return Err(AppError::Forbidden(
                        "The execution host received an upload without the workspace grant".into(),
                    ));
                }
                let root = self.root(&begin.root_id)?;
                self.uploads.begin(
                    &root,
                    &begin.path,
                    begin.total_bytes,
                    &begin.sha256,
                    begin.overwrite_sha256,
                )?
            }
            worker_upload_request::Step::Chunk(chunk) => {
                self.uploads
                    .chunk(&chunk.upload_id, chunk.offset, &chunk.data)?
            }
            worker_upload_request::Step::Commit(commit) => {
                self.uploads.commit(&commit.upload_id)?
            }
            worker_upload_request::Step::Abort(abort) => self.uploads.abort(&abort.upload_id)?,
        };
        Ok(Response::Upload(WorkerUploadResponse {
            upload_id: receipt.upload_id,
            received_bytes: receipt.received_bytes,
            sha256: receipt.sha256,
            path: receipt.path,
        }))
    }
}
