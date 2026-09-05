//! Repository operations for the existing Runtime and the future Worker.
//!
//! Git remains authoritative. The common-directory mutex coordinates this
//! service (and callers holding `mutation_guard`), not external Git processes.
//! An interrupted mutation is an unknown outcome, never an automatic retry.
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    task::Poll,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Notify, OwnedMutexGuard},
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, redact_secrets, resolve_in_root, valid_directory_name},
};

mod integration;
mod stash;
pub use integration::{CherryPickPreview, ConflictFile, ConflictSide, IntegrationSnapshot};
pub use stash::{StashDetail, StashRecord, StashSnapshot};

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
const MAX_OPERATIONS: usize = 256;
const MAX_HISTORY_PAGE: usize = 200;

#[derive(Debug, Clone)]
pub struct RepositoryContext {
    pub workspace_root: PathBuf,
    pub repository: PathBuf,
    pub common_dir: PathBuf,
}

impl RepositoryContext {
    pub fn repository_id(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(self.common_dir.to_string_lossy().as_bytes())
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedState {
    /// None means an unborn HEAD, not "skip validation".
    pub head_oid: Option<String>,
    /// None means detached HEAD.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRecord {
    pub name: String,
    pub full_ref: String,
    pub oid: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub upstream_missing: bool,
    pub symbolic_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSnapshot {
    pub repository_id: String,
    pub repository_path: String,
    pub head: ExpectedState,
    pub branches: Vec<BranchRecord>,
    pub remotes: Vec<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    #[serde(default = "head_ref")]
    pub reference: String,
    #[serde(default = "history_limit")]
    pub limit: usize,
    pub cursor: Option<String>,
}
fn head_ref() -> String {
    "HEAD".into()
}
fn history_limit() -> usize {
    50
}
impl Default for HistoryRequest {
    fn default() -> Self {
        Self {
            reference: head_ref(),
            limit: history_limit(),
            cursor: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: String,
    pub committer_time: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub reference: String,
    pub anchor_oid: Option<String>,
    pub commits: Vec<CommitRecord>,
    pub next_cursor: Option<String>,
    pub shallow: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryCursor {
    version: u8,
    repository_id: String,
    reference: String,
    anchor_oid: String,
    offset: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub path: String,
    pub head_oid: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub is_main: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub prune_reason: Option<String>,
    /// False for another checkout outside this request's workspace authority.
    pub accessible: bool,
    /// Missing/prunable/unauthorized worktrees have no trustworthy dirty state.
    pub dirty: Option<bool>,
}

/// The only way to overwrite remote history: `git push
/// --force-with-lease=<ref>:<oid>`. There is deliberately no lease-free force,
/// and no "lease against whatever the last background fetch happened to see".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForceWithLease {
    pub expected_remote_oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepositoryAction {
    StartCherryPick {
        target_oid: String,
        mainline: Option<u32>,
        record_origin: bool,
        expected_state_token: String,
    },
    SkipIntegration {
        session_id: String,
        expected_state_token: String,
    },
    StartMerge {
        target_oid: String,
        message: String,
        expected_state_token: String,
    },
    /// Replay the current branch onto `onto`. A conflicted rebase becomes an
    /// owned integration recovered through Continue/Abort, never an autostash.
    StartRebase {
        onto: String,
        expected_state_token: String,
    },
    ContinueIntegration {
        session_id: String,
        expected_state_token: String,
    },
    AbortIntegration {
        session_id: String,
        expected_state_token: String,
    },
    CreateStash {
        message: String,
        include_untracked: bool,
        expected_state_token: String,
    },
    ApplyStash {
        oid: String,
        reinstate_index: bool,
        expected_state_token: String,
    },
    PopStash {
        oid: String,
        reinstate_index: bool,
        expected_state_token: String,
    },
    DropStash {
        oid: String,
        expected_state_token: String,
    },
    CreateBranch {
        name: String,
        start_point: Option<String>,
        #[serde(default)]
        switch: bool,
    },
    SwitchBranch {
        name: String,
        expected_oid: String,
    },
    DeleteBranch {
        name: String,
        expected_oid: String,
    },
    Fetch {
        remote: String,
        #[serde(default)]
        prune: bool,
    },
    /// Deliberately only fast-forward; merge/rebase require separate workflows.
    Pull {
        remote: String,
        branch: String,
    },
    /// Push only the observed current branch/OID, never a mirror push and never
    /// an unconditional force. Overwriting remote history requires an explicit
    /// lease naming the remote OID the caller reviewed.
    Push {
        remote: String,
        branch: String,
        #[serde(default)]
        set_upstream: bool,
        #[serde(default)]
        force_with_lease: Option<ForceWithLease>,
    },
    /// Fetch, fast-forward pull, then push as one owned sequence. A failing step
    /// stops the operation; nothing is merged or rebased on the caller's behalf.
    Sync {
        remote: String,
        branch: String,
        /// The reviewed remote-tracking OID; None means no tracking ref yet.
        expected_remote_oid: Option<String>,
    },
    CreateWorktree {
        path: String,
        branch: String,
        #[serde(default)]
        create_branch: bool,
        start_point: Option<String>,
        /// Required when checking out an existing branch; None for a new one.
        expected_oid: Option<String>,
    },
    RemoveWorktree {
        path: String,
        expected_oid: String,
        #[serde(default)]
        allow_unpublished: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    UnknownOutcome,
    AwaitingResolution,
}
impl OperationState {
    pub fn terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSnapshot {
    pub id: String,
    pub repository_id: String,
    pub workspace_root: String,
    pub repository_path: String,
    pub action: RepositoryAction,
    pub state: OperationState,
    pub cancellation_requested: bool,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Default)]
struct CancellationState {
    requested: AtomicBool,
    notify: Notify,
}
#[derive(Clone, Default)]
struct Cancellation(Arc<CancellationState>);
impl std::ops::Deref for Cancellation {
    type Target = CancellationState;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
struct CancelOnDrop(Cancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl Cancellation {
    fn cancel(&self) {
        self.requested.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    async fn cancelled(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.requested.load(Ordering::SeqCst) {
            notified.await;
        }
    }
}

struct Operation {
    snapshot: Mutex<OperationSnapshot>,
    cancellation: Cancellation,
    mutation_started: Arc<AtomicBool>,
    awaiting_resolution: AtomicBool,
}

#[derive(Default)]
struct Inner {
    locks: Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>,
    operations: Mutex<HashMap<String, Arc<Operation>>>,
    order: Mutex<VecDeque<String>>,
    integrations: Mutex<HashMap<PathBuf, integration::IntegrationOwner>>,
    lifecycle: Mutex<ServiceLifecycle>,
    stopping: Cancellation,
}

#[derive(Default)]
struct ServiceLifecycle {
    stopping: bool,
    active_commands: usize,
    active_guards: usize,
    cleanup_failed: bool,
}

/// Lifecycle registration only: the caller still authorizes its Git/AI action.
/// Keep this in the owned task until the actual child has been reaped.
pub struct RepositoryCommandLease {
    inner: Arc<Inner>,
    started: AtomicBool,
    reaped: AtomicBool,
}
impl RepositoryCommandLease {
    pub fn mark_started(&self) {
        self.started.store(true, Ordering::SeqCst);
    }
    pub fn mark_reaped(&self) {
        self.reaped.store(true, Ordering::SeqCst);
    }
    pub fn cancellation_requested(&self) -> bool {
        self.inner.stopping.requested.load(Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        self.inner.stopping.cancelled().await;
    }
}
impl Drop for RepositoryCommandLease {
    fn drop(&mut self) {
        let mut lifecycle = self.inner.lifecycle.lock().expect("Git service lifecycle");
        lifecycle.active_commands -= 1;
        if self.started.load(Ordering::SeqCst) && !self.reaped.load(Ordering::SeqCst) {
            lifecycle.cleanup_failed = true;
        }
    }
}

#[derive(Clone)]
pub struct RepositoryService {
    inner: Arc<Inner>,
    command_timeout: Duration,
    allow_helpers: bool,
}
impl Default for RepositoryService {
    fn default() -> Self {
        Self::new()
    }
}

/// Hold this across legacy index/worktree writes to share the same queue.
pub struct RepositoryGuard {
    pub context: RepositoryContext,
    _guard: OwnedMutexGuard<()>,
    inner: Arc<Inner>,
}

impl RepositoryGuard {
    pub fn cancellation_requested(&self) -> bool {
        self.inner.stopping.requested.load(Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        self.inner.stopping.cancelled().await;
    }
}
impl Drop for RepositoryGuard {
    fn drop(&mut self) {
        self.inner
            .lifecycle
            .lock()
            .expect("Git service lifecycle")
            .active_guards -= 1;
    }
}

impl RepositoryService {
    pub fn new() -> Self {
        Self {
            inner: Arc::default(),
            command_timeout: Duration::from_secs(120),
            allow_helpers: true,
        }
    }

    /// This affects only this clone's typed Git commands, not other OS
    /// processes or lifecycle leases. The API supplies the workspace grant.
    pub fn with_execution(&self, execute: bool) -> Self {
        Self {
            allow_helpers: execute,
            ..self.clone()
        }
    }

    pub fn with_timeout(timeout: Duration) -> AppResult<Self> {
        if timeout.is_zero() || timeout > Duration::from_secs(600) {
            return Err(AppError::BadRequest(
                "Git timeout must be between zero and ten minutes".into(),
            ));
        }
        Ok(Self {
            command_timeout: timeout,
            ..Self::new()
        })
    }

    fn lock_for(&self, directory: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.inner.locks.lock().expect("repository locks");
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(directory).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(directory.to_owned(), Arc::downgrade(&lock));
        lock
    }

    pub async fn mutation_guard(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<RepositoryGuard> {
        let context = self.context(workspace_root, requested).await?;
        let guard = tokio::select! {
            guard = self.lock_for(&context.common_dir).lock_owned() => guard,
            _ = self.inner.stopping.cancelled() => return Err(shutting_down()),
        };
        self.revalidate_context(&context, &Cancellation::default())
            .await?;
        {
            let mut lifecycle = self.inner.lifecycle.lock().expect("Git service lifecycle");
            if lifecycle.stopping {
                return Err(shutting_down());
            }
            lifecycle.active_guards += 1;
        }
        Ok(RepositoryGuard {
            context,
            _guard: guard,
            inner: self.inner.clone(),
        })
    }

    pub async fn context(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<RepositoryContext> {
        self.context_with_token(workspace_root, requested, &Cancellation::default())
            .await
    }

    async fn context_with_token(
        &self,
        workspace_root: &Path,
        requested: &str,
        token: &Cancellation,
    ) -> AppResult<RepositoryContext> {
        let root = canonical_directory(workspace_root)?;
        let directory = resolve_in_root(&root, requested)?;
        if !directory.is_dir() {
            return Err(AppError::BadRequest("Git path must be a directory".into()));
        }
        let inside = self
            .output(
                &directory,
                args(&["rev-parse", "--is-inside-work-tree"]),
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        if inside.status != Some(0) {
            if String::from_utf8_lossy(&inside.stderr).contains("not a git repository") {
                return Err(AppError::BadRequest(
                    "Path is not a Git working repository".into(),
                ));
            }
            return Err(command_error(&inside));
        }
        if one_line(&inside.stdout)? != "true" {
            return Err(AppError::BadRequest(
                "Path is not a working Git repository".into(),
            ));
        }
        let path = self
            .read(&directory, args(&["rev-parse", "--show-toplevel"]), token)
            .await?;
        let repository = canonical_directory(one_line(&path)?)?;
        if !repository.starts_with(&root) {
            return Err(AppError::Forbidden(
                "Git repository is outside the authorized workspace".into(),
            ));
        }
        let common = self
            .read(
                &repository,
                args(&["rev-parse", "--path-format=absolute", "--git-common-dir"]),
                token,
            )
            .await?;
        let common_dir = canonical_directory(one_line(&common)?)?;
        Ok(RepositoryContext {
            workspace_root: root,
            repository,
            common_dir,
        })
    }

    async fn revalidate_context(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<()> {
        let current = self
            .context_with_token(
                &context.workspace_root,
                &path_string(&context.repository)?,
                token,
            )
            .await?;
        if current.workspace_root != context.workspace_root
            || current.repository != context.repository
            || current.common_dir != context.common_dir
        {
            return Err(AppError::Conflict(
                "Repository location changed while the operation was queued".into(),
            ));
        }
        Ok(())
    }

    pub async fn branches(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<BranchSnapshot> {
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let head = self.head(&context.repository, &token).await?;
        let output = self.read(&context.repository, args(&["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)%00", "refs/heads/", "refs/remotes/"]), &token).await?;
        let mut branches = Vec::new();
        for record in fields_with_lf(&output, 5)? {
            let full_ref = record[0].clone();
            let remote = full_ref.starts_with("refs/remotes/");
            let name = full_ref
                .strip_prefix(if remote {
                    "refs/remotes/"
                } else {
                    "refs/heads/"
                })
                .ok_or_else(malformed)?
                .to_owned();
            if !valid_oid(&record[1]) {
                return Err(malformed());
            }
            let (ahead, behind, missing) = parse_tracking(&record[3])?;
            branches.push(BranchRecord {
                current: !remote && head.branch.as_ref() == Some(&name),
                name,
                full_ref,
                oid: record[1].clone(),
                remote,
                upstream: nonempty(&record[2]),
                ahead: if record[2].is_empty() { None } else { ahead },
                behind: if record[2].is_empty() { None } else { behind },
                upstream_missing: missing,
                symbolic_target: nonempty(&record[4]),
            });
        }
        Ok(BranchSnapshot {
            repository_id: context.repository_id(),
            repository_path: path_string(&context.repository)?,
            head,
            branches,
            remotes: self.remotes(&context.repository, &token).await?,
            observed_at: now(),
        })
    }

    pub async fn history(
        &self,
        workspace_root: &Path,
        requested: &str,
        request: HistoryRequest,
    ) -> AppResult<HistoryPage> {
        if request.limit == 0 || request.limit > MAX_HISTORY_PAGE {
            return Err(AppError::BadRequest(
                "History page size must be 1–200".into(),
            ));
        }
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        self.validate_reference(&context.repository, &request.reference, &token)
            .await?;
        let (anchor, offset) = if let Some(cursor) = request.cursor {
            if cursor.len() > 4096 {
                return Err(invalid_cursor());
            }
            let wire = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| invalid_cursor())?;
            let cursor: HistoryCursor =
                serde_json::from_slice(&wire).map_err(|_| invalid_cursor())?;
            if cursor.version != 1
                || cursor.repository_id != context.repository_id()
                || cursor.reference != request.reference
                || !valid_oid(&cursor.anchor_oid)
                || cursor.offset > 1_000_000
            {
                return Err(invalid_cursor());
            }
            // Resolve the immutable anchor, not the ref's new value.
            (
                Some(
                    self.resolve(&context.repository, &cursor.anchor_oid, &token)
                        .await?,
                ),
                cursor.offset,
            )
        } else if request.reference == "HEAD" {
            (self.head(&context.repository, &token).await?.head_oid, 0)
        } else {
            (
                Some(
                    self.resolve(&context.repository, &request.reference, &token)
                        .await?,
                ),
                0,
            )
        };
        let shallow = one_line(
            &self
                .read(
                    &context.repository,
                    args(&["rev-parse", "--is-shallow-repository"]),
                    &token,
                )
                .await?,
        )? == "true";
        let Some(anchor_oid) = anchor else {
            return Ok(HistoryPage {
                reference: request.reference,
                anchor_oid: None,
                commits: vec![],
                next_cursor: None,
                shallow,
            });
        };
        let output = self
            .read(
                &context.repository,
                vec![
                    "log".into(),
                    "--topo-order".into(),
                    "--no-show-signature".into(),
                    "--no-decorate".into(),
                    "-z".into(),
                    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s".into(),
                    format!("--skip={offset}"),
                    format!("--max-count={}", request.limit + 1),
                    anchor_oid.clone(),
                    "--".into(),
                ],
                &token,
            )
            .await?;
        let refs = self.commit_refs(&context.repository, &token).await?;
        let mut commits = parse_history(&output, &refs)?;
        let more = commits.len() > request.limit;
        commits.truncate(request.limit);
        let next_cursor = if more {
            Some(
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&HistoryCursor {
                        version: 1,
                        repository_id: context.repository_id(),
                        reference: request.reference.clone(),
                        anchor_oid: anchor_oid.clone(),
                        offset: offset + commits.len(),
                    })
                    .map_err(|_| malformed())?,
                ),
            )
        } else {
            None
        };
        Ok(HistoryPage {
            reference: request.reference,
            anchor_oid: Some(anchor_oid),
            commits,
            next_cursor,
            shallow,
        })
    }

    pub async fn worktrees(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<Vec<WorktreeRecord>> {
        crate::git::access::require_execution(self.allow_helpers, "Git worktree inspection")?;
        let context = self.context(workspace_root, requested).await?;
        self.worktree_records(&context, &Cancellation::default())
            .await
    }

    pub async fn start(
        &self,
        workspace_root: PathBuf,
        requested: String,
        action: RepositoryAction,
        expected: ExpectedState,
    ) -> AppResult<OperationSnapshot> {
        crate::git::access::require_execution(
            self.allow_helpers,
            "Git repository writes and synchronization",
        )?;
        let context = self.context(&workspace_root, &requested).await?;
        self.validate_action(&context, &action).await?;
        if expected
            .head_oid
            .as_deref()
            .is_some_and(|oid| !valid_oid(oid))
        {
            return Err(AppError::BadRequest(
                "Expected HEAD must be an object ID".into(),
            ));
        }
        if let Some(branch) = &expected.branch {
            self.validate_branch(&context.repository, branch, &Cancellation::default())
                .await?;
        }
        let snapshot = OperationSnapshot {
            id: Uuid::now_v7().to_string(),
            repository_id: context.repository_id(),
            workspace_root: path_string(&context.workspace_root)?,
            repository_path: path_string(&context.repository)?,
            action: action.clone(),
            state: OperationState::Queued,
            cancellation_requested: false,
            created_at: now(),
            finished_at: None,
            message: None,
        };
        let operation = Arc::new(Operation {
            snapshot: Mutex::new(snapshot.clone()),
            cancellation: Cancellation::default(),
            mutation_started: Arc::new(AtomicBool::new(false)),
            awaiting_resolution: AtomicBool::new(false),
        });
        {
            // This gate also protects the insertion itself: a request that
            // finished validation just before shutdown must not appear later.
            let lifecycle = self.inner.lifecycle.lock().expect("Git service lifecycle");
            if lifecycle.stopping {
                return Err(shutting_down());
            }
            let (protected, recovery) = {
                let owners = self.inner.integrations.lock().expect("Git integrations");
                let recovery = match &action {
                    RepositoryAction::ContinueIntegration { session_id, .. }
                    | RepositoryAction::AbortIntegration { session_id, .. }
                    | RepositoryAction::SkipIntegration { session_id, .. } => owners
                        .get(&context.repository)
                        .is_some_and(|owner| owner.session_id() == session_id),
                    _ => false,
                };
                (
                    owners
                        .values()
                        .map(|owner| owner.session_id().to_owned())
                        .collect::<std::collections::HashSet<_>>(),
                    recovery,
                )
            };
            let mut registry = self.inner.operations.lock().expect("Git operations");
            let mut order = self.inner.order.lock().expect("Git operation order");
            reserve_operation_slot(&mut registry, &mut order, &protected, recovery)?;
            order.push_back(snapshot.id.clone());
            registry.insert(snapshot.id.clone(), operation.clone());
        }
        // Poll once before returning to reserve the FIFO mutex position. Moving
        // this pinned future into the task preserves its semaphore waiter.
        let mut lock = Box::pin(self.lock_for(&context.common_dir).lock_owned());
        let initial = futures_util::poll!(lock.as_mut());
        let service = self.clone();
        tokio::spawn(async move {
            let guard = match initial {
                Poll::Ready(guard) => Some(guard),
                Poll::Pending => {
                    tokio::select! { guard = lock => Some(guard), _ = operation.cancellation.cancelled() => None }
                }
            };
            if guard.is_none() || operation.cancellation.requested.load(Ordering::SeqCst) {
                finish(
                    &operation,
                    OperationState::Cancelled,
                    Some("Cancelled before any repository mutation".into()),
                );
                return;
            }
            operation.snapshot.lock().expect("Git operation").state = OperationState::Running;
            let result = service
                .execute(&context, &action, &expected, &operation)
                .await;
            match result {
                Ok(()) => {
                    if operation.awaiting_resolution.load(Ordering::SeqCst) {
                        finish(&operation, OperationState::AwaitingResolution, Some("Git integration is paused; inspect its state, then explicitly continue, abort, or skip an empty pick".into()));
                    } else {
                        finish(&operation, OperationState::Succeeded, None);
                    }
                }
                Err(error) => {
                    let state = if operation.mutation_started.load(Ordering::SeqCst) {
                        OperationState::UnknownOutcome
                    } else if operation.cancellation.requested.load(Ordering::SeqCst) {
                        OperationState::Cancelled
                    } else {
                        OperationState::Failed
                    };
                    finish(&operation, state, Some(sanitize(&error.to_string())));
                }
            }
            drop(guard);
        });
        Ok(snapshot)
    }

    pub fn operation(&self, id: &str) -> AppResult<OperationSnapshot> {
        let registry = self.inner.operations.lock().expect("Git operations");
        let operation = registry
            .get(id)
            .ok_or_else(|| AppError::NotFound("Git operation is unavailable".into()))?;
        Ok(operation.snapshot.lock().expect("Git operation").clone())
    }

    pub fn cancel(&self, id: &str) -> AppResult<OperationSnapshot> {
        let operation = self
            .inner
            .operations
            .lock()
            .expect("Git operations")
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Git operation is unavailable".into()))?;
        let mut snapshot = operation.snapshot.lock().expect("Git operation");
        if !snapshot.state.terminal() {
            snapshot.cancellation_requested = true;
            operation.cancellation.cancel();
        }
        Ok(snapshot.clone())
    }

    /// Recover this Runtime's operation history after a frontend reload. The
    /// Host will persist these records after ownership migration; this service
    /// intentionally does not claim persistence across Runtime restarts.
    pub async fn list_operations(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<Vec<OperationSnapshot>> {
        let context = self.context(workspace_root, requested).await?;
        let repository_id = context.repository_id();
        let workspace = path_string(&context.workspace_root)?;
        let registry = self.inner.operations.lock().expect("Git operations");
        let order = self.inner.order.lock().expect("Git operation order");
        Ok(order
            .iter()
            .rev()
            .filter_map(|id| registry.get(id))
            .filter_map(|operation| {
                let snapshot = operation.snapshot.lock().expect("Git operation");
                (snapshot.repository_id == repository_id && snapshot.workspace_root == workspace)
                    .then(|| snapshot.clone())
            })
            .collect())
    }

    pub fn is_shutting_down(&self) -> bool {
        self.inner
            .lifecycle
            .lock()
            .expect("Git service lifecycle")
            .stopping
    }

    /// Reject new commands, cancel queued/running operations and even read-only
    /// Git children, then wait for observed reaping and terminal operation state.
    pub async fn shutdown(&self, timeout: Duration) -> AppResult<()> {
        {
            let mut lifecycle = self.inner.lifecycle.lock().expect("Git service lifecycle");
            lifecycle.stopping = true;
            self.inner.stopping.cancel();
        }
        let operations: Vec<_> = self
            .inner
            .operations
            .lock()
            .expect("Git operations")
            .values()
            .cloned()
            .collect();
        for operation in &operations {
            let mut snapshot = operation.snapshot.lock().expect("Git operation");
            if !snapshot.state.terminal() {
                snapshot.cancellation_requested = true;
                operation.cancellation.cancel();
            }
        }
        tokio::time::timeout(timeout, async {
            loop {
                let commands_done = {
                    let lifecycle = self.inner.lifecycle.lock().expect("Git service lifecycle");
                    lifecycle.active_commands == 0 && lifecycle.active_guards == 0
                };
                if commands_done
                    && operations.iter().all(|operation| {
                        operation
                            .snapshot
                            .lock()
                            .expect("Git operation")
                            .state
                            .terminal()
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| {
            AppError::Internal("Git shutdown did not finish before the deadline".into())
        })?;
        if self
            .inner
            .lifecycle
            .lock()
            .expect("Git service lifecycle")
            .cleanup_failed
        {
            return Err(AppError::Internal(
                "A Git child could not be confirmed stopped".into(),
            ));
        }
        Ok(())
    }

    pub fn command_lease(&self) -> AppResult<RepositoryCommandLease> {
        let mut lifecycle = self.inner.lifecycle.lock().expect("Git service lifecycle");
        if lifecycle.stopping {
            return Err(shutting_down());
        }
        lifecycle.active_commands += 1;
        Ok(RepositoryCommandLease {
            inner: self.inner.clone(),
            started: AtomicBool::new(false),
            reaped: AtomicBool::new(false),
        })
    }

    async fn output(
        &self,
        directory: &Path,
        arguments: Vec<String>,
        timeout: Duration,
        token: &Cancellation,
        mutation_started: Option<Arc<AtomicBool>>,
    ) -> AppResult<CommandOutput> {
        let arguments = crate::git::access::arguments(arguments, self.allow_helpers)?;
        let policy = GitRunPolicy {
            timeout,
            allow_helpers: self.allow_helpers,
        };
        let lease = self.command_lease()?;
        let directory = directory.to_owned();
        let token = token.clone();
        let caller = Cancellation::default();
        let _cancel_on_drop = CancelOnDrop(caller.clone());
        // The monitor keeps ownership after an HTTP read is dropped. Its own
        // cancellation path kills and reaps; shutdown can still wait for it.
        tokio::spawn(async move {
            run_git_status(
                &directory,
                arguments,
                policy,
                &token,
                mutation_started.as_deref(),
                &lease,
                &caller,
            )
            .await
        })
        .await
        .map_err(|_| {
            AppError::Internal("Git child monitor failed; outcome requires inspection".into())
        })?
    }

    async fn read(
        &self,
        directory: &Path,
        arguments: Vec<String>,
        token: &Cancellation,
    ) -> AppResult<Vec<u8>> {
        let output = self
            .output(
                directory,
                arguments,
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        if output.status != Some(0) {
            return Err(command_error(&output));
        }
        Ok(output.stdout)
    }

    async fn mutate(
        &self,
        context: &RepositoryContext,
        arguments: Vec<String>,
        operation: &Operation,
    ) -> AppResult<()> {
        let output = self
            .output(
                &context.repository,
                arguments,
                self.command_timeout,
                &operation.cancellation,
                Some(operation.mutation_started.clone()),
            )
            .await?;
        if output.status != Some(0) {
            return Err(command_error(&output));
        }
        Ok(())
    }

    async fn head(&self, directory: &Path, token: &Cancellation) -> AppResult<ExpectedState> {
        let branch_output = self
            .output(
                directory,
                args(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        let branch = match branch_output.status {
            Some(0) => Some(one_line(&branch_output.stdout)?.to_owned()),
            Some(1) => None,
            _ => return Err(command_error(&branch_output)),
        };
        let output = self
            .output(
                directory,
                args(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        let head_oid = if output.status == Some(0) {
            let oid = one_line(&output.stdout)?;
            if !valid_oid(oid) {
                return Err(malformed());
            }
            Some(oid.to_owned())
        } else if output.status == Some(1) && branch.is_some() {
            None
        } else {
            return Err(command_error(&output));
        };
        Ok(ExpectedState { head_oid, branch })
    }

    async fn resolve(
        &self,
        directory: &Path,
        reference: &str,
        token: &Cancellation,
    ) -> AppResult<String> {
        self.validate_reference(directory, reference, token).await?;
        let output = self
            .read(
                directory,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--end-of-options".into(),
                    format!("{reference}^{{commit}}"),
                ],
                token,
            )
            .await?;
        let oid = one_line(&output)?;
        if !valid_oid(oid) {
            return Err(malformed());
        }
        Ok(oid.to_owned())
    }

    async fn validate_branch(
        &self,
        directory: &Path,
        name: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        if name.is_empty()
            || name.len() > 255
            || name.starts_with('-')
            || name.starts_with("refs/")
            || name.contains("@{")
            || name.chars().any(char::is_control)
        {
            return Err(AppError::BadRequest("Branch name is invalid".into()));
        }
        self.read(
            directory,
            vec!["check-ref-format".into(), "--branch".into(), name.into()],
            token,
        )
        .await
        .map(|_| ())
        .map_err(|_| AppError::BadRequest("Branch name is invalid".into()))
    }

    async fn validate_reference(
        &self,
        directory: &Path,
        reference: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        if reference == "HEAD" || valid_oid(reference) {
            return Ok(());
        }
        if reference.starts_with("refs/") {
            if reference.len() > 1024 || reference.chars().any(char::is_control) {
                return Err(AppError::BadRequest("Git reference is invalid".into()));
            }
            self.read(
                directory,
                vec!["check-ref-format".into(), reference.into()],
                token,
            )
            .await
            .map(|_| ())
            .map_err(|_| AppError::BadRequest("Git reference is invalid".into()))
        } else {
            self.validate_branch(directory, reference, token).await
        }
    }

    async fn remotes(&self, directory: &Path, token: &Cancellation) -> AppResult<Vec<String>> {
        let output = self.read(directory, args(&["remote"]), token).await?;
        let text = text(&output)?;
        Ok(text.lines().map(str::to_owned).collect())
    }

    async fn validate_remote(
        &self,
        directory: &Path,
        remote: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        if remote.is_empty()
            || remote.len() > 255
            || remote.starts_with('-')
            || remote.contains(':')
            || remote.chars().any(char::is_control)
            || !self
                .remotes(directory, token)
                .await?
                .iter()
                .any(|name| name == remote)
        {
            return Err(AppError::BadRequest(
                "Select a configured Git remote".into(),
            ));
        }
        self.read(
            directory,
            vec![
                "check-ref-format".into(),
                format!("refs/remotes/{remote}/probe"),
            ],
            token,
        )
        .await
        .map_err(|_| AppError::BadRequest("Git remote name is invalid".into()))?;
        self.read(directory, args(&["remote", "get-url", "--", remote]), token)
            .await?;
        Ok(())
    }

    async fn commit_refs(
        &self,
        directory: &Path,
        token: &Cancellation,
    ) -> AppResult<HashMap<String, Vec<String>>> {
        let output = self
            .read(
                directory,
                args(&[
                    "for-each-ref",
                    "--format=%(objectname)%00%(*objectname)%00%(refname)%00",
                    "refs/heads/",
                    "refs/remotes/",
                    "refs/tags/",
                ]),
                token,
            )
            .await?;
        let mut refs: HashMap<String, Vec<String>> = HashMap::new();
        for record in fields_with_lf(&output, 3)? {
            let oid = if record[1].is_empty() {
                &record[0]
            } else {
                &record[1]
            };
            refs.entry(oid.clone()).or_default().push(record[2].clone());
        }
        Ok(refs)
    }

    async fn worktree_records(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<Vec<WorktreeRecord>> {
        let output = self
            .read(
                &context.repository,
                args(&["worktree", "list", "--porcelain", "-z"]),
                token,
            )
            .await?;
        let mut records = parse_worktrees(&output)?;
        for record in &mut records {
            let path = Path::new(&record.path);
            if let Ok(canonical) = path.canonicalize() {
                record.accessible = canonical.starts_with(&context.workspace_root);
                if record.accessible && !record.bare {
                    record.dirty = Some(
                        !self
                            .read(
                                &canonical,
                                args(&[
                                    "status",
                                    "--porcelain=v1",
                                    "-z",
                                    "--untracked-files=all",
                                    "--ignored=matching",
                                ]),
                                token,
                            )
                            .await?
                            .is_empty(),
                    );
                }
            }
        }
        Ok(records)
    }

    async fn validate_action(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
    ) -> AppResult<()> {
        let token = Cancellation::default();
        match action {
            RepositoryAction::StartCherryPick {
                target_oid,
                mainline,
                expected_state_token,
                ..
            } => {
                require_oid(target_oid)?;
                if *mainline == Some(0) {
                    return Err(AppError::BadRequest(
                        "Cherry-pick mainline starts at parent 1".into(),
                    ));
                }
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::SkipIntegration {
                session_id,
                expected_state_token,
            } => {
                Uuid::parse_str(session_id).map_err(|_| {
                    AppError::BadRequest("Integration session ID is invalid".into())
                })?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::StartMerge {
                target_oid,
                message,
                expected_state_token,
            } => {
                require_oid(target_oid)?;
                stash::validate_message(message)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::StartRebase {
                onto,
                expected_state_token,
            } => {
                self.validate_reference(&context.repository, onto, &token)
                    .await?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::ContinueIntegration {
                session_id,
                expected_state_token,
            }
            | RepositoryAction::AbortIntegration {
                session_id,
                expected_state_token,
            } => {
                Uuid::parse_str(session_id).map_err(|_| {
                    AppError::BadRequest("Integration session ID is invalid".into())
                })?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::CreateStash {
                message,
                expected_state_token,
                ..
            } => {
                stash::validate_message(message)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::ApplyStash {
                oid,
                expected_state_token,
                ..
            }
            | RepositoryAction::PopStash {
                oid,
                expected_state_token,
                ..
            }
            | RepositoryAction::DropStash {
                oid,
                expected_state_token,
            } => {
                require_oid(oid)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::CreateBranch {
                name, start_point, ..
            } => {
                self.validate_branch(&context.repository, name, &token)
                    .await?;
                if let Some(reference) = start_point {
                    self.validate_reference(&context.repository, reference, &token)
                        .await?;
                }
            }
            RepositoryAction::SwitchBranch { name, expected_oid }
            | RepositoryAction::DeleteBranch { name, expected_oid } => {
                self.validate_branch(&context.repository, name, &token)
                    .await?;
                require_oid(expected_oid)?;
            }
            RepositoryAction::Fetch { remote, .. } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?
            }
            RepositoryAction::Pull { remote, branch }
            | RepositoryAction::Sync { remote, branch, .. } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?;
                self.validate_branch(&context.repository, branch, &token)
                    .await?;
                if let RepositoryAction::Sync {
                    expected_remote_oid: Some(oid),
                    ..
                } = action
                {
                    require_oid(oid)?;
                }
            }
            RepositoryAction::Push {
                remote,
                branch,
                force_with_lease,
                ..
            } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?;
                self.validate_branch(&context.repository, branch, &token)
                    .await?;
                if let Some(lease) = force_with_lease {
                    require_oid(&lease.expected_remote_oid)?;
                }
            }
            RepositoryAction::CreateWorktree {
                path,
                branch,
                start_point,
                create_branch,
                expected_oid,
                ..
            } => {
                new_worktree_path(context, path)?;
                self.validate_branch(&context.repository, branch, &token)
                    .await?;
                if !create_branch {
                    require_oid(expected_oid.as_deref().ok_or_else(|| {
                        AppError::BadRequest(
                            "Existing worktree branch requires its observed object ID".into(),
                        )
                    })?)?;
                }
                if let Some(reference) = start_point {
                    self.validate_reference(&context.repository, reference, &token)
                        .await?;
                }
            }
            RepositoryAction::RemoveWorktree {
                path, expected_oid, ..
            } => {
                resolve_in_root(&context.workspace_root, path)?;
                require_oid(expected_oid)?;
            }
        }
        Ok(())
    }

    async fn execute(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        self.revalidate_context(context, token).await?;
        if self.head(&context.repository, token).await? != *expected {
            return Err(AppError::Conflict(
                "Repository HEAD changed; reload before retrying".into(),
            ));
        }
        if !matches!(
            action,
            RepositoryAction::StartMerge { .. }
                | RepositoryAction::StartCherryPick { .. }
                | RepositoryAction::StartRebase { .. }
                | RepositoryAction::SkipIntegration { .. }
                | RepositoryAction::ContinueIntegration { .. }
                | RepositoryAction::AbortIntegration { .. }
        ) {
            self.ensure_integration_idle(context, token).await?;
        }
        match action {
            RepositoryAction::StartCherryPick { .. } => {
                self.start_cherry_pick(context, action, expected, operation)
                    .await
            }
            RepositoryAction::StartRebase {
                onto,
                expected_state_token,
            } => {
                self.start_rebase(context, onto, expected_state_token, expected, operation)
                    .await
            }
            RepositoryAction::SkipIntegration {
                session_id,
                expected_state_token,
            } => {
                self.resume_integration(
                    context,
                    session_id,
                    expected_state_token,
                    expected,
                    integration::Recovery::Skip,
                    operation,
                )
                .await
            }
            RepositoryAction::StartMerge {
                target_oid,
                message,
                expected_state_token,
            } => {
                self.start_merge(
                    context,
                    target_oid,
                    message,
                    expected_state_token,
                    expected,
                    operation,
                )
                .await
            }
            RepositoryAction::ContinueIntegration {
                session_id,
                expected_state_token,
            } => {
                self.resume_integration(
                    context,
                    session_id,
                    expected_state_token,
                    expected,
                    integration::Recovery::Continue,
                    operation,
                )
                .await
            }
            RepositoryAction::AbortIntegration {
                session_id,
                expected_state_token,
            } => {
                self.resume_integration(
                    context,
                    session_id,
                    expected_state_token,
                    expected,
                    integration::Recovery::Abort,
                    operation,
                )
                .await
            }
            RepositoryAction::CreateStash { .. }
            | RepositoryAction::ApplyStash { .. }
            | RepositoryAction::PopStash { .. }
            | RepositoryAction::DropStash { .. } => {
                self.execute_stash(context, action, expected, operation)
                    .await
            }
            RepositoryAction::CreateBranch {
                name,
                start_point,
                switch,
            } => {
                let oid = self
                    .resolve(
                        &context.repository,
                        start_point.as_deref().unwrap_or("HEAD"),
                        token,
                    )
                    .await?;
                let arguments = if *switch {
                    vec![
                        "switch",
                        "--no-guess",
                        "--no-overwrite-ignore",
                        "--no-track",
                        "-c",
                        name,
                        &oid,
                    ]
                } else {
                    vec!["branch", "--no-track", "--", name, &oid]
                };
                self.mutate(context, args(&arguments), operation).await
            }
            RepositoryAction::SwitchBranch { name, expected_oid }
            | RepositoryAction::DeleteBranch { name, expected_oid } => {
                if self
                    .resolve(&context.repository, &format!("refs/heads/{name}"), token)
                    .await?
                    != *expected_oid
                {
                    return Err(AppError::Conflict(
                        "Selected branch changed; reload before retrying".into(),
                    ));
                }
                let arguments = if matches!(action, RepositoryAction::SwitchBranch { .. }) {
                    vec!["switch", "--no-guess", "--no-overwrite-ignore", "--", name]
                } else {
                    vec!["branch", "--delete", "--", name]
                };
                self.mutate(context, args(&arguments), operation).await
            }
            RepositoryAction::Fetch { remote, prune } => {
                self.validate_remote(&context.repository, remote, token)
                    .await?;
                let mut arguments =
                    args(&["fetch", "--atomic", "--progress", "--no-recurse-submodules"]);
                if *prune {
                    arguments.push("--prune".into());
                } else {
                    arguments.push("--no-prune".into());
                }
                arguments.push("--no-prune-tags".into());
                arguments.extend(["--".into(), remote.clone()]);
                self.mutate(context, arguments, operation).await
            }
            RepositoryAction::Pull { remote, branch } => {
                self.validate_remote(&context.repository, remote, token)
                    .await?;
                if expected.branch.is_none() {
                    return Err(AppError::Conflict(
                        "Pull requires an attached local branch".into(),
                    ));
                }
                self.fast_forward_pull(context, remote, branch, expected, operation)
                    .await
            }
            RepositoryAction::Sync {
                remote,
                branch,
                expected_remote_oid,
            } => {
                self.sync(
                    context,
                    remote,
                    branch,
                    expected_remote_oid.as_deref(),
                    expected,
                    operation,
                )
                .await
            }
            RepositoryAction::Push {
                remote,
                branch,
                set_upstream,
                force_with_lease,
            } => {
                self.validate_remote(&context.repository, remote, token)
                    .await?;
                if expected.branch.as_ref() != Some(branch) {
                    return Err(AppError::Conflict(
                        "Push must target the observed current local branch".into(),
                    ));
                }
                let oid = expected
                    .head_oid
                    .as_ref()
                    .ok_or_else(|| AppError::Conflict("There are no commits to push".into()))?;
                self.mutate(
                    context,
                    push_arguments(remote, branch, oid, force_with_lease.as_ref()),
                    operation,
                )
                .await?;
                if *set_upstream {
                    self.mutate(
                        context,
                        vec![
                            "branch".into(),
                            format!("--set-upstream-to={remote}/{branch}"),
                            "--".into(),
                            branch.clone(),
                        ],
                        operation,
                    )
                    .await?;
                }
                Ok(())
            }
            RepositoryAction::CreateWorktree {
                path,
                branch,
                create_branch,
                start_point,
                expected_oid,
            } => {
                let target = new_worktree_path(context, path)?;
                let mut arguments = args(&["worktree", "add"]);
                if *create_branch {
                    let oid = self
                        .resolve(
                            &context.repository,
                            start_point.as_deref().unwrap_or("HEAD"),
                            token,
                        )
                        .await?;
                    arguments.extend([
                        "--no-track".into(),
                        "-b".into(),
                        branch.clone(),
                        "--".into(),
                        path_string(&target)?,
                        oid,
                    ]);
                } else {
                    if start_point.is_some() {
                        return Err(AppError::BadRequest(
                            "An existing worktree branch cannot have a different start point"
                                .into(),
                        ));
                    }
                    let actual = self
                        .resolve(&context.repository, &format!("refs/heads/{branch}"), token)
                        .await?;
                    if expected_oid.as_ref() != Some(&actual) {
                        return Err(AppError::Conflict(
                            "Worktree branch changed; reload before creating the checkout".into(),
                        ));
                    }
                    arguments.extend(["--".into(), path_string(&target)?, branch.clone()]);
                }
                // Register the exact nested checkout in private Git excludes,
                // so a later Stage All cannot stage a repository inside itself.
                for worktree in self.worktree_records(context, token).await? {
                    if !worktree.bare
                        && let Ok(root) = Path::new(&worktree.path).canonicalize()
                    {
                        protect_nested_worktree(context, &root, &target, operation)?;
                    }
                }
                let _parents = create_worktree_parents(context, &target, operation)?;
                self.mutate(context, arguments, operation).await
            }
            RepositoryAction::RemoveWorktree {
                path,
                expected_oid,
                allow_unpublished,
            } => {
                let target = resolve_in_root(&context.workspace_root, path)?;
                if target.starts_with(&context.common_dir) {
                    return Err(AppError::Forbidden(
                        "Git administration directories cannot be removed as worktrees".into(),
                    ));
                }
                let records = self.worktree_records(context, token).await?;
                let record = records
                    .iter()
                    .find(|record| {
                        Path::new(&record.path).canonicalize().ok().as_ref() == Some(&target)
                    })
                    .ok_or_else(|| {
                        AppError::BadRequest("Path is not a registered worktree".into())
                    })?;
                if record.is_main
                    || record.bare
                    || record.locked
                    || record.prunable
                    || record.dirty != Some(false)
                {
                    return Err(AppError::Conflict(
                        "Main, locked, missing, or dirty worktrees cannot be removed".into(),
                    ));
                }
                if record.head_oid.as_ref() != Some(expected_oid) {
                    return Err(AppError::Conflict(
                        "Worktree HEAD changed; reload before removing".into(),
                    ));
                }
                if !allow_unpublished {
                    let output = self
                        .read(
                            &target,
                            args(&["rev-list", "--count", "HEAD", "--not", "--remotes"]),
                            token,
                        )
                        .await?;
                    if one_line(&output)?.parse::<u64>().map_err(|_| malformed())? > 0 {
                        return Err(AppError::Conflict("Worktree contains unpublished commits; review and explicitly acknowledge them first".into()));
                    }
                }
                self.mutate(
                    context,
                    vec![
                        "worktree".into(),
                        "remove".into(),
                        "--".into(),
                        path_string(&target)?,
                    ],
                    operation,
                )
                .await
            }
        }
    }

    async fn remote_tracking_oid(
        &self,
        directory: &Path,
        remote: &str,
        branch: &str,
        token: &Cancellation,
    ) -> AppResult<Option<String>> {
        let output = self
            .output(
                directory,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    "--end-of-options".into(),
                    format!("refs/remotes/{remote}/{branch}^{{commit}}"),
                ],
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        match output.status {
            Some(0) => {
                let oid = one_line(&output.stdout)?;
                if !valid_oid(oid) {
                    return Err(malformed());
                }
                Ok(Some(oid.to_owned()))
            }
            Some(1) => Ok(None),
            _ => Err(command_error(&output)),
        }
    }

    /// Fetch, fast-forward pull, push — in that order, in one owned operation.
    /// A diverged branch stops at the pull step and is reported; this never
    /// merges, rebases, or force-pushes to make the three steps "succeed".
    async fn sync(
        &self,
        context: &RepositoryContext,
        remote: &str,
        branch: &str,
        expected_remote_oid: Option<&str>,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        self.validate_remote(&context.repository, remote, token)
            .await?;
        if expected.branch.as_deref() != Some(branch) {
            return Err(AppError::Conflict(
                "Sync must target the observed current local branch".into(),
            ));
        }
        if expected.head_oid.is_none() {
            return Err(AppError::Conflict(
                "Sync requires at least one local commit".into(),
            ));
        }
        let observed = self
            .remote_tracking_oid(&context.repository, remote, branch, token)
            .await?;
        if observed.as_deref() != expected_remote_oid {
            return Err(AppError::Conflict(format!(
                "Remote tracking ref changed before Sync started: refs/remotes/{remote}/{branch} is {}, not the reviewed {}",
                observed.as_deref().unwrap_or("absent"),
                expected_remote_oid.unwrap_or("absent"),
            )));
        }
        let mut fetch = args(&[
            "fetch",
            "--atomic",
            "--progress",
            "--no-recurse-submodules",
            "--no-prune",
            "--no-prune-tags",
        ]);
        fetch.extend(["--".into(), remote.to_owned()]);
        if let Err(error) = self.mutate(context, fetch, operation).await {
            return Err(self
                .sync_stop(context, remote, branch, "fetch", &error)
                .await);
        }
        if let Err(error) = self
            .fast_forward_pull(context, remote, branch, expected, operation)
            .await
        {
            return Err(self
                .sync_stop(context, remote, branch, "pull", &error)
                .await);
        }
        let head = self.head(&context.repository, token).await?;
        if head.branch.as_deref() != Some(branch) {
            return Err(AppError::Conflict(
                "The local branch changed during Sync; nothing was pushed".into(),
            ));
        }
        let oid = head
            .head_oid
            .as_deref()
            .ok_or_else(|| AppError::Conflict("Sync found no commit to push".into()))?;
        if let Err(error) = self
            .mutate(
                context,
                push_arguments(remote, branch, oid, None),
                operation,
            )
            .await
        {
            return Err(self
                .sync_stop(context, remote, branch, "push", &error)
                .await);
        }
        Ok(())
    }

    /// Name the step that stopped and the state the user has to act on. A read
    /// that itself fails is reported as unknown rather than as a clean value.
    async fn sync_stop(
        &self,
        context: &RepositoryContext,
        remote: &str,
        branch: &str,
        step: &str,
        error: &AppError,
    ) -> AppError {
        let token = Cancellation::default();
        let head = self.head(&context.repository, &token).await;
        let tracking = self
            .remote_tracking_oid(&context.repository, remote, branch, &token)
            .await;
        let position = match &head {
            Ok(state) => format!(
                "{} on {}",
                state.head_oid.as_deref().unwrap_or("no commit"),
                state
                    .branch
                    .as_deref()
                    .map(|name| format!("branch {name}"))
                    .unwrap_or_else(|| "a detached HEAD".into())
            ),
            Err(_) => "unreadable".into(),
        };
        let remote_oid = match &tracking {
            Ok(Some(oid)) => oid.clone(),
            Ok(None) => "absent".into(),
            Err(_) => "unreadable".into(),
        };
        AppError::Conflict(format!(
            "Sync stopped at the {step} step and merged, rebased, or forced nothing: {error}. HEAD is {position}; refs/remotes/{remote}/{branch} is {remote_oid}"
        ))
    }

    async fn fast_forward_pull(
        &self,
        context: &RepositoryContext,
        remote: &str,
        branch: &str,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        let id = operation.snapshot.lock().expect("Git operation").id.clone();
        let fetched_ref = format!("refs/armadra/pull/{id}");
        let existing = self
            .output(
                &context.repository,
                args(&["show-ref", "--verify", "--quiet", &fetched_ref]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if existing.status != Some(1) {
            return Err(AppError::Conflict(
                "Temporary pull reference is already in use".into(),
            ));
        }
        self.mutate(
            context,
            vec![
                "fetch".into(),
                "--atomic".into(),
                "--no-prune".into(),
                "--no-prune-tags".into(),
                "--no-tags".into(),
                "--no-recurse-submodules".into(),
                "--".into(),
                remote.into(),
                format!("refs/heads/{branch}:{fetched_ref}"),
            ],
            operation,
        )
        .await?;
        let oid = self
            .resolve(&context.repository, &fetched_ref, token)
            .await?;
        let merged = if self.head(&context.repository, token).await? != *expected {
            Err(AppError::Conflict(
                "HEAD changed during fetch; no fast-forward was attempted".into(),
            ))
        } else {
            self.mutate(
                context,
                args(&[
                    "merge",
                    "--ff-only",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    "--",
                    &oid,
                ]),
                operation,
            )
            .await
        };
        // A cancelled/shutting-down operation may retain this uniquely named
        // ref for inspection. Never retry the pull or force-delete a changed ref.
        let cleanup = self
            .mutate(
                context,
                args(&["update-ref", "-d", &fetched_ref, &oid]),
                operation,
            )
            .await;
        merged.and(cleanup)
    }
}

/// Awaiting integration records are capabilities referenced by live owners.
/// Keep them until reconciliation releases the owner. Recovery has a small
/// bounded reserve so a fully occupied history can still be continued/aborted.
fn reserve_operation_slot(
    registry: &mut HashMap<String, Arc<Operation>>,
    order: &mut VecDeque<String>,
    protected: &std::collections::HashSet<String>,
    recovery: bool,
) -> AppResult<()> {
    let mut index = 0;
    while registry.len() >= MAX_OPERATIONS && index < order.len() {
        let id = &order[index];
        let removable = !protected.contains(id)
            && registry.get(id).is_some_and(|operation| {
                operation
                    .snapshot
                    .lock()
                    .expect("Git operation")
                    .state
                    .terminal()
            });
        if removable {
            let id = order.remove(index).expect("existing operation order index");
            registry.remove(&id);
        } else {
            index += 1;
        }
    }
    let limit = MAX_OPERATIONS + if recovery { 16 } else { 0 };
    if registry.len() >= limit {
        return Err(AppError::Conflict("Too many active Git operations".into()));
    }
    Ok(())
}

/// `--no-force` stays on every push; it disables the blanket force flag without
/// cancelling an explicit lease, so a rewrite can only happen against the exact
/// remote OID the caller reviewed. There is no code path that omits both.
fn push_arguments(
    remote: &str,
    branch: &str,
    oid: &str,
    lease: Option<&ForceWithLease>,
) -> Vec<String> {
    let mut arguments = args(&[
        "push",
        "--porcelain",
        "--no-force",
        "--no-mirror",
        "--no-follow-tags",
    ]);
    if let Some(lease) = lease {
        arguments.push(format!(
            "--force-with-lease=refs/heads/{branch}:{}",
            lease.expected_remote_oid
        ));
    }
    arguments.extend([
        "--".into(),
        remote.to_owned(),
        format!("{oid}:refs/heads/{branch}"),
    ]);
    arguments
}

fn finish(operation: &Operation, state: OperationState, message: Option<String>) {
    let mut snapshot = operation.snapshot.lock().expect("Git operation");
    snapshot.state = state;
    snapshot.message = message;
    snapshot.finished_at = Some(now());
}

fn new_worktree_path(context: &RepositoryContext, requested: &str) -> AppResult<PathBuf> {
    if requested.is_empty() || requested.len() > 4096 || requested.chars().any(|c| c == '\0') {
        return Err(AppError::BadRequest("Worktree path is invalid".into()));
    }
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        context.workspace_root.join(requested)
    };
    if candidate
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(AppError::BadRequest(
            "Worktree path must not contain parent traversal".into(),
        ));
    }
    match candidate.symlink_metadata() {
        Ok(_) => {
            return Err(AppError::Conflict(
                "Worktree destination already exists".into(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // Resolve the nearest existing ancestor, then validate every new segment.
    // No directories are created during request validation.
    let mut ancestor = candidate.as_path();
    let mut missing = Vec::new();
    loop {
        match ancestor.symlink_metadata() {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = ancestor
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| {
                        AppError::BadRequest("Worktree directory name must be UTF-8".into())
                    })?;
                if valid_directory_name(name)? != name {
                    return Err(AppError::BadRequest(
                        "Worktree path must not have padded directory names".into(),
                    ));
                }
                missing.push(name.to_owned());
                ancestor = ancestor.parent().ok_or_else(|| {
                    AppError::BadRequest("Worktree path has no existing ancestor".into())
                })?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut target = canonical_directory(ancestor)?;
    if !target.starts_with(&context.workspace_root) {
        return Err(AppError::Forbidden(
            "Worktree path is outside the workspace".into(),
        ));
    }
    for segment in missing.into_iter().rev() {
        target.push(segment);
    }
    if target.starts_with(&context.common_dir) {
        return Err(AppError::Forbidden(
            "Worktrees cannot be created inside Git administration directories".into(),
        ));
    }
    Ok(target)
}

struct CreatedParents(Vec<PathBuf>);
impl Drop for CreatedParents {
    fn drop(&mut self) {
        // Only empty directories this invocation created; never recurse/delete
        // a partial checkout or anything another process has added.
        for directory in self.0.iter().rev() {
            let _ = std::fs::remove_dir(directory);
        }
    }
}

fn create_worktree_parents(
    context: &RepositoryContext,
    target: &Path,
    operation: &Operation,
) -> AppResult<CreatedParents> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::BadRequest("Worktree needs a parent directory".into()))?;
    let relative = parent
        .strip_prefix(&context.workspace_root)
        .map_err(|_| AppError::Forbidden("Worktree is outside the workspace".into()))?;
    let mut cursor = context.workspace_root.clone();
    let mut created = CreatedParents(vec![]);
    for part in relative.components() {
        if operation.cancellation.requested.load(Ordering::SeqCst) {
            return Err(AppError::Conflict("Worktree creation cancelled".into()));
        }
        cursor.push(part);
        match cursor.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
            Ok(_) => {
                return Err(AppError::Forbidden(
                    "Worktree parent changed to a link or non-directory".into(),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                operation.mutation_started.store(true, Ordering::SeqCst);
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&cursor)?;
                created.0.push(cursor.clone());
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(created)
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn protect_nested_worktree(
    context: &RepositoryContext,
    repository_root: &Path,
    target: &Path,
    operation: &Operation,
) -> AppResult<()> {
    let Ok(relative) = target.strip_prefix(repository_root) else {
        return Ok(());
    };
    let mut pattern = String::from("/");
    for (index, part) in relative.components().enumerate() {
        if index > 0 {
            pattern.push('/');
        }
        let value = part
            .as_os_str()
            .to_str()
            .ok_or_else(|| AppError::BadRequest("Worktree path must be UTF-8".into()))?;
        if value.chars().any(char::is_control) {
            return Err(AppError::BadRequest(
                "Nested worktree paths cannot contain control characters".into(),
            ));
        }
        for character in value.chars() {
            if "\\*?[]!# ".contains(character) {
                pattern.push('\\');
            }
            pattern.push(character);
        }
    }
    pattern.push('/');
    if relative.starts_with(".armadra/worktrees") {
        pattern = "/.armadra/worktrees/".into();
    }
    if operation.cancellation.requested.load(Ordering::SeqCst) {
        return Err(AppError::Conflict("Worktree creation cancelled".into()));
    }
    let info = context.common_dir.join("info");
    match info.symlink_metadata() {
        Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
        Ok(_) => {
            return Err(AppError::Forbidden(
                "Git info directory must not be a link".into(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            operation.mutation_started.store(true, Ordering::SeqCst);
            std::fs::create_dir(&info)?;
        }
        Err(error) => return Err(error.into()),
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).append(true).create(true);
    let exclude = info.join("exclude");
    match exclude.symlink_metadata() {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => {}
        Ok(_) => {
            return Err(AppError::Forbidden(
                "Git exclude must be a regular file".into(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    operation.mutation_started.store(true, Ordering::SeqCst);
    let mut file = options.open(exclude)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(AppError::Forbidden(
            "Git exclude must be a regular file".into(),
        ));
    }
    let mut previous = Vec::new();
    (&mut file).take(1_048_577).read_to_end(&mut previous)?;
    if previous.len() > 1_048_576 {
        return Err(AppError::Conflict(
            "Git exclude exceeds the editable size budget".into(),
        ));
    }
    if previous
        .split(|byte| *byte == b'\n')
        .any(|line| line == pattern.as_bytes())
    {
        return Ok(());
    }
    // O_APPEND preserves other writers' existing content. The leading newline
    // also keeps an unterminated original final line intact.
    file.write_all(format!("\n{pattern}\n").as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}
fn malformed() -> AppError {
    AppError::Internal("Git returned unsupported or malformed machine-readable output".into())
}
fn invalid_cursor() -> AppError {
    AppError::BadRequest("History cursor does not match this repository/reference".into())
}
fn shutting_down() -> AppError {
    AppError::Conflict("Git repository service is shutting down".into())
}
fn path_string(path: &Path) -> AppResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::BadRequest("Git path is not valid UTF-8".into()))
}
fn text(bytes: &[u8]) -> AppResult<&str> {
    std::str::from_utf8(bytes).map_err(|_| malformed())
}
fn one_line(bytes: &[u8]) -> AppResult<&str> {
    let value = text(bytes)?;
    Ok(value.strip_suffix('\n').unwrap_or(value))
}
fn valid_oid(oid: &str) -> bool {
    (oid.len() == 40 || oid.len() == 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn require_oid(oid: &str) -> AppResult<()> {
    if valid_oid(oid) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Expected commit must be an object ID".into(),
        ))
    }
}

fn fields_with_lf(bytes: &[u8], width: usize) -> AppResult<Vec<Vec<String>>> {
    let mut records = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let mut fields = Vec::with_capacity(width);
        for _ in 0..width {
            let end = rest
                .iter()
                .position(|byte| *byte == 0)
                .ok_or_else(malformed)?;
            fields.push(text(&rest[..end])?.to_owned());
            rest = &rest[end + 1..];
        }
        rest = rest.strip_prefix(b"\n").ok_or_else(malformed)?;
        records.push(fields);
    }
    Ok(records)
}

fn parse_tracking(track: &str) -> AppResult<(Option<u64>, Option<u64>, bool)> {
    if track == "gone" {
        return Ok((None, None, true));
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(", ").filter(|part| !part.is_empty()) {
        let (direction, count) = part.split_once(' ').ok_or_else(malformed)?;
        let count = count.parse().map_err(|_| malformed())?;
        match direction {
            "ahead" => ahead = count,
            "behind" => behind = count,
            _ => return Err(malformed()),
        }
    }
    Ok((Some(ahead), Some(behind), false))
}

fn parse_history(
    bytes: &[u8],
    refs: &HashMap<String, Vec<String>>,
) -> AppResult<Vec<CommitRecord>> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    let mut fields: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    if fields.last() == Some(&b"".as_slice()) {
        fields.pop();
    }
    if fields.len() % 7 != 0 {
        return Err(malformed());
    }
    fields
        .chunks_exact(7)
        .map(|row| {
            let oid = text(row[0])?.to_owned();
            let parents: Vec<String> = text(row[1])?
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            if !valid_oid(&oid) || parents.iter().any(|oid| !valid_oid(oid)) {
                return Err(malformed());
            }
            Ok(CommitRecord {
                refs: refs.get(&oid).cloned().unwrap_or_default(),
                oid,
                parents,
                subject: text(row[6])?.into(),
                author_name: text(row[2])?.into(),
                author_email: text(row[3])?.into(),
                author_time: text(row[4])?.into(),
                committer_time: text(row[5])?.into(),
            })
        })
        .collect()
}

fn parse_worktrees(bytes: &[u8]) -> AppResult<Vec<WorktreeRecord>> {
    let mut records = Vec::new();
    let mut current: Option<WorktreeRecord> = None;
    for field in bytes.split(|byte| *byte == 0) {
        let line = text(field)?;
        if line.is_empty() {
            if let Some(record) = current.take() {
                records.push(record);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if current.is_some() {
                return Err(malformed());
            }
            current = Some(WorktreeRecord {
                path: path.into(),
                head_oid: None,
                branch: None,
                detached: false,
                bare: false,
                is_main: records.is_empty(),
                locked: false,
                lock_reason: None,
                prunable: false,
                prune_reason: None,
                accessible: false,
                dirty: None,
            });
        } else {
            let record = current.as_mut().ok_or_else(malformed)?;
            if let Some(oid) = line.strip_prefix("HEAD ") {
                if !valid_oid(oid) {
                    return Err(malformed());
                }
                record.head_oid = (!oid.bytes().all(|byte| byte == b'0')).then(|| oid.into());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                record.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).into());
            } else if line == "detached" {
                record.detached = true;
            } else if line == "bare" {
                record.bare = true;
            } else if line == "locked" || line.starts_with("locked ") {
                record.locked = true;
                record.lock_reason = line.strip_prefix("locked ").map(str::to_owned);
            } else if line == "prunable" || line.starts_with("prunable ") {
                record.prunable = true;
                record.prune_reason = line.strip_prefix("prunable ").map(str::to_owned);
            } else {
                return Err(malformed());
            }
        }
    }
    if let Some(record) = current {
        records.push(record);
    }
    Ok(records)
}

fn sanitize(message: &str) -> String {
    let redacted = redact_secrets(message);
    let url = Regex::new(r"(?i)(https?|ssh)://[^/\s@]+@").expect("credential URL regex");
    url.replace_all(&redacted, "$1://[redacted]@")
        .chars()
        .take(8192)
        .collect()
}

struct CommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<i32>,
}
fn command_error(output: &CommandOutput) -> AppError {
    let message = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    AppError::Internal(format!(
        "Git operation failed: {}",
        sanitize(&String::from_utf8_lossy(message))
    ))
}

async fn read_output(mut reader: impl AsyncRead + Unpin, limit: usize) -> AppResult<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(output);
        }
        if count > limit - output.len() {
            return Err(AppError::Internal(
                "Git output exceeded its bounded budget".into(),
            ));
        }
        output.extend_from_slice(&chunk[..count]);
    }
}

struct GitRunPolicy {
    timeout: Duration,
    allow_helpers: bool,
}
async fn run_git_status(
    directory: &Path,
    arguments: Vec<String>,
    policy: GitRunPolicy,
    token: &Cancellation,
    mutation_started: Option<&AtomicBool>,
    lease: &RepositoryCommandLease,
    caller: &Cancellation,
) -> AppResult<CommandOutput> {
    if token.requested.load(Ordering::SeqCst)
        || lease.inner.stopping.requested.load(Ordering::SeqCst)
        || caller.requested.load(Ordering::SeqCst)
    {
        return Err(AppError::Conflict("Git operation cancelled".into()));
    }
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "i18n.logOutputEncoding=UTF-8",
        ])
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0");
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy();
        if matches!(
            key.as_ref(),
            "GIT_DIR"
                | "GIT_WORK_TREE"
                | "GIT_COMMON_DIR"
                | "GIT_INDEX_FILE"
                | "GIT_OBJECT_DIRECTORY"
                | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
                | "GIT_NAMESPACE"
                | "GIT_CONFIG"
                | "GIT_CONFIG_COUNT"
                | "GIT_CONFIG_PARAMETERS"
                | "GIT_EXTERNAL_DIFF"
                | "GIT_DIFF_OPTS"
                | "GIT_CURL_VERBOSE"
        ) || key.starts_with("GIT_CONFIG_KEY_")
            || key.starts_with("GIT_CONFIG_VALUE_")
            || key.starts_with("GIT_TRACE")
        {
            command.env_remove(name);
        }
    }
    if !policy.allow_helpers {
        crate::git::access::restrict_async(&mut command);
    }
    let mut child = command
        .spawn()
        .map_err(|_| AppError::Internal("Could not start Git".into()))?;
    lease.started.store(true, Ordering::SeqCst);
    if let Some(started) = mutation_started {
        started.store(true, Ordering::SeqCst);
    }
    let stdout = child.stdout.take().ok_or_else(malformed)?;
    let stderr = child.stderr.take().ok_or_else(malformed)?;
    let execution = async {
        let (stdout, stderr, status) = tokio::try_join!(
            read_output(stdout, MAX_OUTPUT),
            read_output(stderr, MAX_STDERR),
            async { child.wait().await.map_err(AppError::from) }
        )?;
        Ok(CommandOutput {
            stdout,
            stderr,
            status: status.code(),
        })
    };
    let result = tokio::select! {
        result = execution => result,
        _ = token.cancelled() => Err(AppError::Conflict("Git process was cancelled; verify repository/remote state before retrying".into())),
        _ = caller.cancelled() => Err(AppError::Conflict("Git request cancelled".into())),
        _ = lease.inner.stopping.cancelled() => Err(shutting_down()),
        _ = tokio::time::sleep(policy.timeout) => Err(AppError::Internal("Git process timed out; verify repository/remote state before retrying".into())),
    };
    if result.is_err() {
        let _ = child.start_kill();
        match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(_)) => lease.reaped.store(true, Ordering::SeqCst),
            _ => {
                return Err(AppError::Internal(
                    "Git child cleanup was not confirmed; outcome requires verification".into(),
                ));
            }
        }
    } else {
        lease.reaped.store(true, Ordering::SeqCst);
    }
    result
}
