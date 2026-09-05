//! The operations a controller proxies to an execution host, and the Worker
//! side that answers them (H02).
//!
//! The payloads are the Runtime's own camelCase JSON. That is a **version-lock**,
//! not a wire contract: the handshake refuses a Worker whose
//! `runtime_version` differs from this build, so both ends are literally the
//! same program and the same serde derives. Anything that has to survive
//! across versions — the envelope, the operation list, the handshake — is
//! typed Protobuf in `proto/armadra/v1/worker.proto`.
//!
//! Two rules hold on the Worker side:
//!
//! 1. **Grants travel with the request.** The controller resolves a
//!    workspace's read/write/execute permissions from its own database; the
//!    Worker refuses a mutating or Git operation whose request did not carry
//!    the grant, so a controller that skipped the check cannot mutate.
//! 2. **The root is the frozen canonical directory.** Every operation resolves
//!    inside `Worker::root`, which re-canonicalizes and rejects a root that
//!    moved since it was registered.

use std::path::{Path, PathBuf};

use armadra_protocol::v1::WorkerServiceOperation;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    file_search, file_watch, git,
};

/// One repository or directory under the workspace root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPayload {
    pub path: String,
}

/// A repository plus the paths an index or worktree operation applies to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsPayload {
    pub path: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPayload {
    pub path: String,
    pub paths: Vec<String>,
    pub source: git::RestoreSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendPayload {
    pub expected_head: String,
    pub allow_published: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPayload {
    pub path: String,
    pub message: String,
    pub paths: Option<Vec<String>>,
    pub amend: Option<AmendPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub path: String,
    pub scope: git::DiffScope,
    pub paths: Vec<String>,
    pub ignore_whitespace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexPayload {
    pub query: String,
    pub limit: Option<usize>,
}

/// Remote watching is a poll, and says so. One request carries every path the
/// editor nodes of a workspace currently have open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPollPayload {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPollResult {
    pub versions: Vec<file_watch::FileVersion>,
}

/// How many paths one poll may carry. A workspace with more open editors than
/// this polls the rest on the next tick rather than growing an unbounded frame.
pub const MAX_WATCH_PATHS: usize = 256;

/// Whether an operation may be replayed on a fresh connection after a
/// transport failure. `Never` is the default for anything with an effect: a
/// request that was already written is reported as an unknown outcome, never
/// re-sent (design §3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replay {
    Safe,
    Never,
}

/// Read-only operations may be retried once; everything that writes may not.
pub fn replay(operation: WorkerServiceOperation) -> Replay {
    use WorkerServiceOperation as Operation;
    match operation {
        Operation::FileRead
        | Operation::FileVersion
        | Operation::SearchContent
        | Operation::SearchIndex
        | Operation::WatchPoll
        | Operation::GitStatus
        | Operation::GitHeadCommit
        | Operation::GitDiff => Replay::Safe,
        Operation::GitStage
        | Operation::GitUnstage
        | Operation::GitRevert
        | Operation::GitResolve
        | Operation::GitCommit
        | Operation::GitInit
        | Operation::Unspecified => Replay::Never,
    }
}

fn decode<T: for<'a> Deserialize<'a>>(bytes: &[u8]) -> AppResult<T> {
    serde_json::from_slice(bytes)
        .map_err(|_| AppError::BadRequest("Execution request payload is malformed".into()))
}

fn encode<T: Serialize>(value: &T) -> AppResult<Vec<u8>> {
    serde_json::to_vec(value)
        .map_err(|_| AppError::Internal("Execution answer could not be encoded".into()))
}

fn require(granted: bool, message: &str) -> AppResult<()> {
    if granted {
        Ok(())
    } else {
        Err(AppError::Forbidden(message.into()))
    }
}

/// Run one proxied operation against the frozen root. The answer is the
/// status and body the same operation would have produced over the Runtime's
/// own HTTP surface, so a remote failure keeps its code instead of collapsing
/// into a transport error.
pub async fn handle(
    root: PathBuf,
    operation: WorkerServiceOperation,
    request_json: Vec<u8>,
    allow_write: bool,
    allow_execute: bool,
) -> (u32, Vec<u8>) {
    match dispatch(root, operation, request_json, allow_write, allow_execute).await {
        Ok(body) => (StatusCode::OK.as_u16() as u32, body),
        Err(error) => {
            let (status, body) = error.parts();
            (u32::from(status), body)
        }
    }
}

async fn dispatch(
    root: PathBuf,
    operation: WorkerServiceOperation,
    request_json: Vec<u8>,
    allow_write: bool,
    allow_execute: bool,
) -> AppResult<Vec<u8>> {
    use WorkerServiceOperation as Operation;
    // Git touches repository filters and hooks, so every Git operation needs
    // the workspace's execution grant, exactly as it does locally.
    if matches!(
        operation,
        Operation::GitStatus
            | Operation::GitHeadCommit
            | Operation::GitDiff
            | Operation::GitStage
            | Operation::GitUnstage
            | Operation::GitRevert
            | Operation::GitResolve
            | Operation::GitCommit
            | Operation::GitInit
    ) {
        git::access::require_execution(allow_execute, "This Git operation")?;
    }
    if matches!(replay(operation), Replay::Never) && operation != Operation::Unspecified {
        require(
            allow_write,
            "The execution host received a write without the workspace grant",
        )?;
    }
    match operation {
        Operation::Unspecified => Err(AppError::Unsupported(
            "The execution host does not recognize this operation".into(),
        )),
        Operation::FileRead => {
            let payload: PathPayload = decode(&request_json)?;
            blocking(move || crate::files::read_text_file(&root, &payload.path)).await
        }
        Operation::FileVersion => {
            let payload: PathPayload = decode(&request_json)?;
            blocking(move || file_watch::file_version(&root, &payload.path)).await
        }
        Operation::SearchContent => {
            let payload: file_search::SearchRequest = decode(&request_json)?;
            blocking(move || file_search::search_content(&root, &payload)).await
        }
        Operation::SearchIndex => {
            let payload: IndexPayload = decode(&request_json)?;
            blocking(move || file_search::index_files(&root, &payload.query, payload.limit)).await
        }
        Operation::WatchPoll => {
            let payload: WatchPollPayload = decode(&request_json)?;
            if payload.paths.len() > MAX_WATCH_PATHS {
                return Err(AppError::BadRequest("Too many watched paths".into()));
            }
            blocking(move || {
                let mut versions = Vec::with_capacity(payload.paths.len());
                for path in &payload.paths {
                    // One unreadable path must not blind the whole workspace.
                    if let Ok(version) = file_watch::file_version(&root, path) {
                        versions.push(version);
                    }
                }
                Ok(WatchPollResult { versions })
            })
            .await
        }
        Operation::GitStatus => {
            let payload: PathPayload = decode(&request_json)?;
            blocking(move || git::read_status_at(&root, &payload.path)).await
        }
        Operation::GitHeadCommit => {
            let payload: PathPayload = decode(&request_json)?;
            blocking(move || git::head_commit(&root, &payload.path)).await
        }
        Operation::GitDiff => {
            let payload: DiffPayload = decode(&request_json)?;
            blocking(move || {
                git::read_diff_with_execution(
                    &root,
                    &payload.path,
                    &git::DiffRequest {
                        scope: payload.scope,
                        paths: payload.paths,
                        ignore_whitespace: payload.ignore_whitespace,
                    },
                    allow_execute,
                )
            })
            .await
        }
        Operation::GitStage => {
            let payload: PathsPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git::stage_paths(&root, &payload.path, &payload.paths)
            })
            .await
        }
        Operation::GitUnstage => {
            let payload: PathsPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git::unstage_paths(&root, &payload.path, &payload.paths)
            })
            .await
        }
        Operation::GitResolve => {
            let payload: PathsPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git::mark_resolved(&root, &payload.path, &payload.paths)
            })
            .await
        }
        Operation::GitRevert => {
            let payload: RevertPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git::revert_paths(&root, &payload.path, &payload.paths, payload.source)
            })
            .await
        }
        Operation::GitCommit => {
            let payload: CommitPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                let amend = payload.amend.map(|amend| git::AmendRequest {
                    expected_head: amend.expected_head,
                    allow_published: amend.allow_published,
                });
                git::commit(
                    &root,
                    &payload.path,
                    &payload.message,
                    payload.paths.as_deref(),
                    amend.as_ref(),
                )
            })
            .await
        }
        Operation::GitInit => blocking(move || git::init_repository(&root)).await,
    }
}

/// The per-repository mutation queue lives on the execution host, next to the
/// repository it serializes. A controller cannot hold it: the path is not on
/// the controller's filesystem.
async fn guard(root: &Path, requested: &str) -> AppResult<crate::git_repository::RepositoryGuard> {
    crate::git_api::REPOSITORIES
        .mutation_guard(root, requested)
        .await
}

async fn blocking<T, F>(work: F) -> AppResult<Vec<u8>>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    let value = tokio::task::spawn_blocking(work).await??;
    encode(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_that_writes_is_marked_unreplayable() {
        use WorkerServiceOperation as Operation;
        for operation in [
            Operation::GitStage,
            Operation::GitUnstage,
            Operation::GitRevert,
            Operation::GitResolve,
            Operation::GitCommit,
            Operation::GitInit,
        ] {
            assert_eq!(replay(operation), Replay::Never, "{operation:?}");
        }
        for operation in [
            Operation::FileVersion,
            Operation::SearchContent,
            Operation::SearchIndex,
            Operation::WatchPoll,
            Operation::GitStatus,
            Operation::GitHeadCommit,
            Operation::GitDiff,
        ] {
            assert_eq!(replay(operation), Replay::Safe, "{operation:?}");
        }
    }

    #[tokio::test]
    async fn a_git_operation_without_the_execution_grant_fails_on_the_execution_host() {
        let root = tempfile::tempdir().unwrap();
        let (status, body) = handle(
            root.path().to_owned(),
            WorkerServiceOperation::GitStatus,
            serde_json::to_vec(&PathPayload { path: ".".into() }).unwrap(),
            true,
            false,
        )
        .await;
        assert_eq!(status, 403);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], "git_execution_required");
    }

    #[tokio::test]
    async fn a_write_that_did_not_carry_the_grant_is_refused_remotely() {
        let root = tempfile::tempdir().unwrap();
        let (status, body) = handle(
            root.path().to_owned(),
            WorkerServiceOperation::GitInit,
            b"{}".to_vec(),
            false,
            true,
        )
        .await;
        assert_eq!(status, 403);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], "forbidden");
    }

    #[tokio::test]
    async fn an_unknown_operation_is_unsupported_rather_than_a_passthrough() {
        let root = tempfile::tempdir().unwrap();
        let (status, _) = handle(
            root.path().to_owned(),
            WorkerServiceOperation::Unspecified,
            b"{}".to_vec(),
            true,
            true,
        )
        .await;
        assert_eq!(status, 501);
    }
}
