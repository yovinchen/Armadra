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

mod actions;
mod branches;
mod command;
mod commits;
mod execute;
mod history;
mod integration;
mod parse;
mod queue;
mod reflog;
mod refs;
mod remotes;
mod stash;
mod worktrees;

pub use actions::{
    ForceWithLease, RebaseTodoCommand, RebaseTodoEntry, RebaseTodoPreview, RepositoryAction,
    ResetMode,
};
pub use branches::{BranchRecord, BranchSnapshot};
pub use commits::{CommitDetail, CommitFile, CommitFileDiff};
pub use history::{CommitRecord, HistoryPage, HistoryRequest};
pub use integration::{CherryPickPreview, ConflictFile, ConflictSide, IntegrationSnapshot};
pub use queue::{OperationSnapshot, OperationState};
pub use reflog::{ReflogEntry, ReflogPage, ReflogRequest};
pub use refs::{RemoteRecord, TagRecord, TagSnapshot};
pub use stash::{StashDetail, StashRecord, StashSnapshot};
pub use worktrees::{WorktreeBindingRequest, WorktreeBindingVerdict, WorktreeRecord};

use self::{command::*, execute::*, parse::*, worktrees::*};

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
        self.output_with(directory, arguments, timeout, token, mutation_started, &[])
            .await
    }

    /// `environment` exists only for the sequence editor an interactive rebase
    /// needs; every other command runs with the fixed environment below.
    async fn output_with(
        &self,
        directory: &Path,
        arguments: Vec<String>,
        timeout: Duration,
        token: &Cancellation,
        mutation_started: Option<Arc<AtomicBool>>,
        environment: &[(String, String)],
    ) -> AppResult<CommandOutput> {
        let arguments = crate::git::access::arguments(arguments, self.allow_helpers)?;
        let policy = GitRunPolicy {
            timeout,
            allow_helpers: self.allow_helpers,
            environment: environment.to_vec(),
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
}

fn finish(operation: &Operation, state: OperationState, message: Option<String>) {
    let mut snapshot = operation.snapshot.lock().expect("Git operation");
    snapshot.state = state;
    snapshot.message = message;
    snapshot.finished_at = Some(now());
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
