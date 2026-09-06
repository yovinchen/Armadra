//! The repository panel on the execution host (design §3.1).
//!
//! Branches, history, worktrees, stashes and the mutation queue all reach into
//! a repository through a path. On a remote workspace that path exists on the
//! other machine, so the whole panel runs there and the controller forwards.
//!
//! The queue matters most. `git_api::REPOSITORIES` serializes mutations per
//! worktree and holds the repository lock ordering; a controller cannot hold
//! either, because the worktree is not on its filesystem. So the queue lives in
//! the Worker process, next to the repository it serializes, and the
//! controller keeps only the ownership bookkeeping that says which workspace
//! started which operation.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{
    error::AppResult,
    git, git_api, git_discovery, git_hunks, git_message, git_repository,
    remote::service::{PathPayload, blocking, guard},
};

/// A repository scan of everything under the root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesPayload {
    pub max_depth: Option<usize>,
    #[serde(default)]
    pub refresh: bool,
}

/// One page of the commit graph. Declared here rather than reusing
/// `git_repository::HistoryRequest`: that type is deserialize-only, and the
/// controller has to serialize this one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPayload {
    pub path: String,
    pub reference: String,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPayload {
    pub path: String,
    pub oid: String,
    /// Absent compares against the commit's first parent.
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFilePayload {
    pub path: String,
    pub oid: String,
    pub base: Option<String>,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoPayload {
    pub path: String,
    pub onto: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDetailPayload {
    pub path: String,
    pub oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickPayload {
    pub path: String,
    pub oid: String,
    pub mainline: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunksPayload {
    pub file: String,
    pub scope: git_hunks::GitHunkScope,
}

/// Starting a queued operation. `expected` is the state the caller believes
/// the repository is in, and the Worker re-validates it: a queue entry that
/// raced another writer must fail on the machine holding the lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOperationPayload {
    pub path: String,
    pub action: git_repository::RepositoryAction,
    pub expected: git_repository::ExpectedState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPayload {
    pub id: String,
}

/// Nothing but the root. Kept as a named type so the contract snapshot records
/// that this operation deliberately carries no arguments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RootPayload {}

/// The cache key the discovery scan uses on the execution host. Locally it is
/// the workspace id; the Worker has no workspace table, and the canonical root
/// is exactly as unique for the one thing the cache stores.
fn discovery_key(root: &std::path::Path) -> String {
    root.to_string_lossy().into_owned()
}

pub async fn repositories(
    root: PathBuf,
    payload: RepositoriesPayload,
    allow_execute: bool,
) -> AppResult<Vec<u8>> {
    let key = discovery_key(&root);
    if payload.refresh {
        git_discovery::invalidate(&key);
    }
    blocking(move || git_discovery::repositories(&key, &root, payload.max_depth, allow_execute))
        .await
}

pub async fn branches(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.branches(&root, &payload.path).await?)
}

pub async fn history(root: PathBuf, payload: HistoryPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .history(
                &root,
                &payload.path,
                git_repository::HistoryRequest {
                    reference: payload.reference,
                    limit: payload.limit,
                    cursor: payload.cursor,
                },
            )
            .await?,
    )
}

pub async fn commit_detail(
    root: PathBuf,
    payload: CommitPayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .commit_detail(&root, &payload.path, &payload.oid, payload.base.as_deref())
            .await?,
    )
}

pub async fn commit_file_diff(
    root: PathBuf,
    payload: CommitFilePayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .commit_file_diff(
                &root,
                &payload.path,
                &payload.oid,
                payload.base.as_deref(),
                &payload.file,
            )
            .await?,
    )
}

pub async fn worktrees(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.worktrees(&root, &payload.path).await?)
}

pub async fn rebase_todo(
    root: PathBuf,
    payload: RebaseTodoPayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .rebase_todo_preview(&root, &payload.path, &payload.onto)
            .await?,
    )
}

pub async fn tags(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.tags(&root, &payload.path).await?)
}

pub async fn remotes(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.remote_records(&root, &payload.path).await?)
}

pub async fn stashes(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.stashes(&root, &payload.path).await?)
}

pub async fn stash_detail(
    root: PathBuf,
    payload: StashDetailPayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .stash_detail(&root, &payload.path, &payload.oid)
            .await?,
    )
}

/// The integration snapshot as the execution host sees it. Session ownership
/// is *not* decided here: the controller keeps the map of which workspace
/// started which session and redacts what it does not own, exactly as it does
/// for a local repository.
pub async fn integration(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.integration_status(&root, &payload.path).await?)
}

pub async fn cherry_pick_preview(
    root: PathBuf,
    payload: CherryPickPayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .cherry_pick_preview(&root, &payload.path, &payload.oid, payload.mainline)
            .await?,
    )
}

pub async fn hunks(root: PathBuf, payload: HunksPayload) -> AppResult<Vec<u8>> {
    super::encode(&git_hunks::read_hunks(&root, &payload.file, payload.scope).await?)
}

pub async fn apply_hunk(root: PathBuf, payload: git_hunks::GitHunkMutation) -> AppResult<Vec<u8>> {
    super::encode(&git_hunks::apply_hunk(&root, payload).await?)
}

/// What the AI drafter would read. The draft itself is not proxied: it runs a
/// provider CLI configured on the controller, so it stays where that CLI and
/// its credentials are.
pub async fn message_source(root: PathBuf) -> AppResult<Vec<u8>> {
    super::encode(&git_message::source(&root).await?)
}

pub async fn operations(root: PathBuf, payload: PathPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(&service.list_operations(&root, &payload.path).await?)
}

pub async fn operation(payload: OperationPayload) -> AppResult<Vec<u8>> {
    super::encode(&git_api::REPOSITORIES.operation(&payload.id)?)
}

pub async fn start(root: PathBuf, payload: StartOperationPayload) -> AppResult<Vec<u8>> {
    let rescans = matches!(
        payload.action,
        git_repository::RepositoryAction::CreateWorktree { .. }
            | git_repository::RepositoryAction::RemoveWorktree { .. }
    );
    let key = discovery_key(&root);
    let snapshot = git_api::REPOSITORIES
        .start(root, payload.path, payload.action, payload.expected)
        .await?;
    if rescans {
        git_discovery::invalidate(&key);
    }
    super::encode(&snapshot)
}

pub async fn cancel(payload: OperationPayload) -> AppResult<Vec<u8>> {
    super::encode(&git_api::REPOSITORIES.cancel(&payload.id)?)
}

/// The mutation guard for the operations that take one. Held across the
/// blocking work so two controllers cannot interleave index writes on the same
/// worktree.
pub async fn guarded<T, F>(root: PathBuf, requested: String, work: F) -> AppResult<Vec<u8>>
where
    T: Serialize + Send + 'static,
    F: FnOnce(&std::path::Path) -> AppResult<T> + Send + 'static,
{
    let held = guard(&root, &requested).await?;
    blocking(move || {
        let _held = held;
        work(&root)
    })
    .await
}

/// Whether an operation needs the workspace's execution grant. Every Git
/// operation does: reading a repository runs `git`, which runs filters and
/// hooks the project chose.
pub fn requires_execution(operation: armadra_protocol::v1::WorkerServiceOperation) -> bool {
    use armadra_protocol::v1::WorkerServiceOperation as Operation;
    matches!(
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
            | Operation::GitRepositories
            | Operation::GitBranches
            | Operation::GitHistory
            | Operation::GitCommitDetail
            | Operation::GitCommitFileDiff
            | Operation::GitWorktrees
            | Operation::GitRebaseTodo
            | Operation::GitTags
            | Operation::GitRemotes
            | Operation::GitStashes
            | Operation::GitStashDetail
            | Operation::GitIntegration
            | Operation::GitCherryPickPreview
            | Operation::GitHunks
            | Operation::GitMessageSource
            | Operation::GitOperations
            | Operation::GitOperationGet
            | Operation::GitOperationStart
            | Operation::GitOperationCancel
            | Operation::GitApplyHunk
    )
}

/// The message a refused Git operation carries, matching the local wording so
/// a remote workspace's error reads the same as a local one's.
pub fn execution_required(allow_execute: bool) -> AppResult<()> {
    git::access::require_execution(allow_execute, "This Git operation")
}
