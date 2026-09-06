//! The operations a controller proxies to an execution host, and the Worker
//! side that answers them (H02).
//!
//! The payloads are the Runtime's own camelCase JSON. That is a **version-lock**,
//! not a wire contract: the handshake refuses a Worker whose
//! [`replay::CONTRACT_VERSION`] differs from this build, so both ends are the
//! same serde derives even when their patch versions differ. Anything that has
//! to survive across versions — the envelope, the operation list, the
//! handshake — is typed Protobuf in `proto/armadra/v1/worker.proto`.
//!
//! Three rules hold on the Worker side:
//!
//! 1. **Grants travel with the request.** The controller resolves a
//!    workspace's read/write/execute permissions from its own database; the
//!    Worker refuses a mutating or Git operation whose request did not carry
//!    the grant, so a controller that skipped the check cannot mutate.
//! 2. **The root is the frozen canonical directory.** Every operation resolves
//!    inside `Worker::root`, which re-canonicalizes and rejects a root that
//!    moved since it was registered.
//! 3. **The list is closed.** An operation number this build does not know is
//!    `UNSUPPORTED`, never a passthrough.

pub mod assets;
pub mod files;
pub mod git;
pub mod replay;

use std::path::{Path, PathBuf};

use armadra_protocol::v1::WorkerServiceOperation;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

pub use replay::{Replay, capability, replay};

use crate::{
    error::{AppError, AppResult},
    file_search, file_watch, git as git_core,
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
    pub source: git_core::RestoreSource,
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
    pub scope: git_core::DiffScope,
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
    if git::requires_execution(operation) {
        git::execution_required(allow_execute)?;
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
            blocking(move || git_core::read_status_at(&root, &payload.path)).await
        }
        Operation::GitHeadCommit => {
            let payload: PathPayload = decode(&request_json)?;
            blocking(move || git_core::head_commit(&root, &payload.path)).await
        }
        Operation::GitDiff => {
            let payload: DiffPayload = decode(&request_json)?;
            blocking(move || {
                git_core::read_diff_with_execution(
                    &root,
                    &payload.path,
                    &git_core::DiffRequest {
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
                git_core::stage_paths(&root, &payload.path, &payload.paths)
            })
            .await
        }
        Operation::GitUnstage => {
            let payload: PathsPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git_core::unstage_paths(&root, &payload.path, &payload.paths)
            })
            .await
        }
        Operation::GitResolve => {
            let payload: PathsPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git_core::mark_resolved(&root, &payload.path, &payload.paths)
            })
            .await
        }
        Operation::GitRevert => {
            let payload: RevertPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                git_core::revert_paths(&root, &payload.path, &payload.paths, payload.source)
            })
            .await
        }
        Operation::GitCommit => {
            let payload: CommitPayload = decode(&request_json)?;
            let guard = guard(&root, &payload.path).await?;
            blocking(move || {
                let _guard = guard;
                let amend = payload.amend.map(|amend| git_core::AmendRequest {
                    expected_head: amend.expected_head,
                    allow_published: amend.allow_published,
                });
                git_core::commit(
                    &root,
                    &payload.path,
                    &payload.message,
                    payload.paths.as_deref(),
                    amend.as_ref(),
                )
            })
            .await
        }
        Operation::GitInit => blocking(move || git_core::init_repository(&root)).await,

        /* ------------------------- repository panel ------------------------ */
        Operation::GitRepositories => {
            git::repositories(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitBranches => git::branches(root, decode(&request_json)?, allow_execute).await,
        Operation::GitHistory => git::history(root, decode(&request_json)?, allow_execute).await,
        Operation::GitCommitDetail => {
            git::commit_detail(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitCommitFileDiff => {
            git::commit_file_diff(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitWorktrees => {
            git::worktrees(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitRebaseTodo => {
            git::rebase_todo(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitTags => git::tags(root, decode(&request_json)?, allow_execute).await,
        Operation::GitRemotes => git::remotes(root, decode(&request_json)?, allow_execute).await,
        Operation::GitStashes => git::stashes(root, decode(&request_json)?, allow_execute).await,
        Operation::GitStashDetail => {
            git::stash_detail(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitIntegration => {
            git::integration(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitCherryPickPreview => {
            git::cherry_pick_preview(root, decode(&request_json)?, allow_execute).await
        }
        Operation::GitHunks => git::hunks(root, decode(&request_json)?).await,
        Operation::GitApplyHunk => git::apply_hunk(root, decode(&request_json)?).await,
        Operation::GitMessageSource => {
            let _: git::RootPayload = decode(&request_json)?;
            git::message_source(root).await
        }
        Operation::GitOperations => {
            git::operations(root, decode(&request_json)?, allow_execute).await
        }
        // The queue records live in this process. After a Worker restart they
        // are gone and the lookup is a 404 — the repository is still readable,
        // only the record of who drove it is lost, which is the same thing an
        // external `git` run leaves behind.
        Operation::GitOperationGet => git::operation(decode(&request_json)?).await,
        Operation::GitOperationStart => git::start(root, decode(&request_json)?).await,
        Operation::GitOperationCancel => git::cancel(decode(&request_json)?).await,

        /* -------------------------- file management ------------------------ */
        Operation::FileInfo => {
            let payload: PathPayload = decode(&request_json)?;
            files::info(root, payload.path).await
        }
        Operation::FileEntryCreate => files::create(root, decode(&request_json)?).await,
        // One filesystem call answers both numbers: what differs is whether the
        // parent directory changed, which the caller already decided.
        Operation::FileEntryRename | Operation::FileEntryMove => {
            files::rename(root, decode(&request_json)?).await
        }
        Operation::FileEntryDelete => {
            let payload: PathPayload = decode(&request_json)?;
            files::trash(root, payload.path).await
        }
        Operation::FileEntryTrashList => {
            let _: files::TrashListPayload = decode(&request_json)?;
            files::list_trash(root).await
        }
        Operation::FileEntryRestore => files::restore(root, decode(&request_json)?).await,
        Operation::AssetImport => assets::import(root, decode(&request_json)?).await,

        /* ------------------------------ watching --------------------------- */
        // Subscriptions travel as the typed `WorkerWatchRequest`, because the
        // events they produce are unsolicited frames and belong to the
        // connection rather than to one answer. These numbers exist so the
        // operation is nameable in the capability table and in the contract
        // snapshot; the JSON road to them is deliberately closed.
        Operation::WatchSubscribe | Operation::WatchUnsubscribe => Err(AppError::BadRequest(
            "Watch subscriptions travel as a typed Worker request, not as a service payload".into(),
        )),
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

    /// Renaming, deleting and restoring are writes wherever they run. A
    /// controller that resolved a read-only workspace and forwarded anyway
    /// must be refused by the machine holding the files.
    #[tokio::test]
    async fn file_management_without_the_write_grant_is_refused_on_the_execution_host() {
        let root = tempfile::tempdir().unwrap();
        for (operation, payload) in [
            (
                WorkerServiceOperation::FileEntryCreate,
                serde_json::json!({ "path": "new.txt", "kind": "file" }),
            ),
            (
                WorkerServiceOperation::FileEntryRename,
                serde_json::json!({ "from": "a.txt", "to": "b.txt" }),
            ),
            (
                WorkerServiceOperation::FileEntryDelete,
                serde_json::json!({ "path": "a.txt" }),
            ),
            (
                WorkerServiceOperation::FileEntryRestore,
                serde_json::json!({ "id": "0123456789abcdef" }),
            ),
        ] {
            let (status, body) = handle(
                root.path().to_owned(),
                operation,
                serde_json::to_vec(&payload).unwrap(),
                false,
                true,
            )
            .await;
            assert_eq!(status, 403, "{operation:?}");
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["code"], "forbidden", "{operation:?}");
        }
    }

    /// The trash listing is a read, so it is served without a write grant —
    /// and it has to actually answer, because restoring is impossible without
    /// knowing what is there.
    #[tokio::test]
    async fn the_trash_listing_is_a_read_and_answers_without_a_write_grant() {
        let root = tempfile::tempdir().unwrap();
        let (status, body) = handle(
            root.path().to_owned(),
            WorkerServiceOperation::FileEntryTrashList,
            b"{}".to_vec(),
            false,
            false,
        )
        .await;
        assert_eq!(status, 200);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value, serde_json::json!([]));
    }

    /// A subscription is not a service payload. Letting it in through this
    /// door would create a watcher whose events nothing is demultiplexing.
    #[tokio::test]
    async fn a_watch_subscription_is_refused_on_the_service_road() {
        let root = tempfile::tempdir().unwrap();
        let (status, _) = handle(
            root.path().to_owned(),
            WorkerServiceOperation::WatchSubscribe,
            serde_json::to_vec(&serde_json::json!({ "paths": ["a.txt"] })).unwrap(),
            true,
            true,
        )
        .await;
        assert_eq!(status, 400);
    }
}
