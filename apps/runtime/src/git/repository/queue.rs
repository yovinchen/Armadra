//! The operation queue: starting, observing and cancelling the long-running
//! repository mutations.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

/// Deserializable too: a remote workspace queues on the execution host, so
/// the controller has to read back the snapshot that host produced (remote
/// completion design 3.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl RepositoryService {
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

    /// What this process still has in flight, across every workspace.
    ///
    /// A write-ownership switch reads it and refuses to move the git domain
    /// while it is not zero (business migration §3.3, `git.queue_empty`): a
    /// domain moved while a push was running would leave the only record of
    /// that push in a process that is about to stop being the writer, and
    /// "did it reach the remote?" would then have no answer at all.
    ///
    /// It counts this process's own registry, which is the only queue there
    /// is — the records are in memory and die with the Runtime, so a stopped
    /// Runtime has an empty queue by construction rather than by report.
    pub fn active_operations(&self) -> (u32, u32, Vec<String>) {
        let registry = self.inner.operations.lock().expect("Git operations");
        let order = self.inner.order.lock().expect("Git operation order");
        let (mut queued, mut running, mut ids) = (0, 0, Vec::new());
        for id in order.iter() {
            let Some(operation) = registry.get(id) else {
                continue;
            };
            match operation.snapshot.lock().expect("Git operation").state {
                OperationState::Queued => queued += 1,
                OperationState::Running => running += 1,
                _ => continue,
            }
            if ids.len() < 32 {
                ids.push(id.clone());
            }
        }
        (queued, running, ids)
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
}

/// Awaiting integration records are capabilities referenced by live owners.
/// Keep them until reconciliation releases the owner. Recovery has a small
/// bounded reserve so a fully occupied history can still be continued/aborted.
pub(super) fn reserve_operation_slot(
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
