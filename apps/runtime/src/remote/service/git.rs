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
    /// The server-side pathspec filter. `default` rather than required so a
    /// controller of an older build keeps deserializing against this one.
    #[serde(default)]
    pub paths: Vec<String>,
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
    /// The checkout, workspace-relative. `default` so a controller of an older
    /// build, which named none, still reads the workspace root.
    #[serde(default = "git_hunks::root_checkout")]
    pub path: String,
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
                    paths: payload.paths,
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

/// One page of a ref's reference log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogPayload {
    pub path: String,
    pub reference: String,
    pub limit: usize,
    pub cursor: Option<String>,
}

/// Several checkouts' status in one request. The list of checkouts travels
/// whole because the saving is the round trip: forwarding twelve of these would
/// be the twelve requests this operation exists to replace.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBatchPayload {
    pub paths: Vec<String>,
    #[serde(default)]
    pub pathspecs: Vec<String>,
}

/// One page of the workspace's merged commit log (Git 工具窗口设计 §3.1).
///
/// The whole request travels as one field rather than being spread out, because
/// its identity is what the page cursor is bound to: a controller that
/// re-assembled the filters field by field could reorder or drop one, and the
/// execution host would then answer a window the cursor was not taken over.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPayload {
    pub request: git_repository::LogRequest,
}

/// Whether a Frame's worktree binding still describes a checkout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBindingPayload {
    pub worktree_path: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub repository_id: Option<String>,
}

pub async fn reflog(root: PathBuf, payload: ReflogPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .reflog(
                &root,
                &payload.path,
                git_repository::ReflogRequest {
                    reference: payload.reference,
                    limit: payload.limit,
                    cursor: payload.cursor,
                },
            )
            .await?,
    )
}

/// The merged commit log. The discovery cache on the execution host is keyed by
/// the canonical root, which is what a Worker has instead of a workspace table.
pub async fn log(root: PathBuf, payload: LogPayload, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    let key = discovery_key(&root);
    super::encode(&service.log(&root, &key, payload.request).await?)
}

/// Every discovered repository's branch tree.
pub async fn refs(root: PathBuf, execute: bool) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    let key = discovery_key(&root);
    super::encode(&service.refs_snapshot(&root, &key).await?)
}

pub async fn status_batch(
    root: PathBuf,
    payload: StatusBatchPayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    // Running `git status` may invoke this repository's own filters, so it is
    // execution — the same gate the single-checkout status passes through, and
    // the reason a batch cannot be the cheaper way around it.
    super::git::execution_required(execute)?;
    blocking(move || {
        git::read_status_batch(
            &root,
            &git::StatusBatchRequest {
                paths: payload.paths,
                pathspecs: payload.pathspecs,
            },
        )
    })
    .await
}

pub async fn worktree_binding(
    root: PathBuf,
    payload: WorktreeBindingPayload,
    execute: bool,
) -> AppResult<Vec<u8>> {
    let service = git_api::REPOSITORIES.with_execution(execute);
    super::encode(
        &service
            .verify_worktree_binding(
                &root,
                &git_repository::WorktreeBindingRequest {
                    worktree_path: payload.worktree_path,
                    branch: payload.branch,
                    repository_id: payload.repository_id,
                },
            )
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
    super::encode(
        &git_hunks::read_hunks(&root, &payload.path, &payload.file, payload.scope).await?,
    )
}

pub async fn apply_hunk(root: PathBuf, payload: git_hunks::GitHunkMutation) -> AppResult<Vec<u8>> {
    super::encode(&git_hunks::apply_hunk(&root, payload).await?)
}

/// What the AI drafter would read, as a client sees it.
pub async fn message_source(root: PathBuf) -> AppResult<Vec<u8>> {
    super::encode(&git_message::source(&root).await?)
}

/// The same capture with the prompt included.
///
/// The model is not run here: the provider CLI and its credentials belong to
/// the controller. What crosses the channel is the redacted staged diff this
/// host produced, and what comes back is a message — never a write.
pub async fn message_capture(root: PathBuf) -> AppResult<Vec<u8>> {
    super::encode(&git_message::capture_staged(&root).await?)
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
            | Operation::GitMessageCapture
            | Operation::GitOperations
            | Operation::GitOperationGet
            | Operation::GitOperationStart
            | Operation::GitOperationCancel
            | Operation::GitApplyHunk
            | Operation::GitReflog
            | Operation::GitStatusBatch
            | Operation::GitWorktreeBinding
    )
}

/// The message a refused Git operation carries, matching the local wording so
/// a remote workspace's error reads the same as a local one's.
pub fn execution_required(allow_execute: bool) -> AppResult<()> {
    git::access::require_execution(allow_execute, "This Git operation")
}
