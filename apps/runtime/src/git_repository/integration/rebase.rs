//! Rebase replays the current branch onto a reviewed commit. Unlike merge and
//! cherry-pick it detaches HEAD for the whole sequence, so ownership is bound to
//! Git's own `rebase-merge` records instead of a motionless HEAD.
use super::*;

impl RepositoryService {
    pub(in super::super) async fn start_rebase(
        &self,
        context: &RepositoryContext,
        onto: &str,
        expected_token: &str,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        let state = self.integration_snapshot(context, token).await?;
        if state.kind != "none" {
            return Err(AppError::Conflict(
                "An existing Git operation must be completed first".into(),
            ));
        }
        if state.head != *expected || state.state_token != expected_token {
            return Err(AppError::Conflict(
                "Repository state changed; refresh and confirm the rebase again".into(),
            ));
        }
        if state.dirty || !state.conflicts.is_empty() {
            return Err(AppError::Conflict(
                "Rebase requires a clean worktree and index on a committed local branch".into(),
            ));
        }
        let (head_oid, branch) = match (&expected.head_oid, &expected.branch) {
            (Some(oid), Some(branch)) => (oid.clone(), branch.clone()),
            _ => {
                return Err(AppError::Conflict(
                    "Rebase requires a clean worktree and index on a committed local branch".into(),
                ));
            }
        };
        let onto_oid = self.resolve(&context.repository, onto, token).await?;
        let base = self
            .output(
                &context.repository,
                args(&["merge-base", &onto_oid, &head_oid]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if base.status != Some(0) {
            return Err(AppError::Conflict(
                "The rebase target and the current branch share no history".into(),
            ));
        }
        let base = one_line(&base.stdout)?.to_owned();
        if !valid_oid(&base) {
            return Err(malformed());
        }
        // The replay first checks out the target and then reapplies the local
        // commits, so both halves of the range can touch the worktree.
        let mut touched = std::collections::BTreeSet::new();
        for other in [&head_oid, &onto_oid] {
            let names = self
                .read(
                    &context.repository,
                    args(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--name-only",
                        "--no-renames",
                        "-z",
                        &base,
                        other,
                        "--",
                    ]),
                    token,
                )
                .await?;
            for path in names
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                touched.insert(
                    std::str::from_utf8(path)
                        .map_err(|_| malformed())?
                        .to_owned(),
                );
            }
        }
        self.protect_local_paths(context, &touched, token).await?;
        let session_id = operation.snapshot.lock().expect("Git operation").id.clone();
        self.inner
            .integrations
            .lock()
            .expect("Git integrations")
            .insert(
                context.repository.clone(),
                IntegrationOwner {
                    session_id,
                    kind: "rebase",
                    mainline: None,
                    original: expected.clone(),
                    target_oid: onto_oid.clone(),
                    marker: None,
                },
            );
        let result = self
            .output(
                &context.repository,
                args(&[
                    "-c",
                    "core.editor=:",
                    "-c",
                    "rerere.enabled=false",
                    "rebase",
                    "--no-autostash",
                    "--no-rerere-autoupdate",
                    "--no-update-refs",
                    "--no-fork-point",
                    &onto_oid,
                ]),
                self.command_timeout,
                token,
                Some(operation.mutation_started.clone()),
            )
            .await;
        // Read with a fresh token after a cancelled child has been reaped, so a
        // stopped sequence can still be bound for explicit recovery.
        let actual = self
            .git_integration(context, &Cancellation::default())
            .await;
        let actual_head = self
            .head(&context.repository, &Cancellation::default())
            .await;
        let mut owns = false;
        if let (Ok(actual), Ok(head)) = (&actual, &actual_head) {
            let mut owners = self.inner.integrations.lock().expect("Git integrations");
            if let Some(owner) = owners.get_mut(&context.repository) {
                if actual.kind == "rebase"
                    && actual.target_oid.as_deref() == Some(onto_oid.as_str())
                    && actual.original_head.as_deref() == Some(head_oid.as_str())
                {
                    owner.marker = actual.marker.clone();
                    owns = owns_integration(owner, actual, head);
                } else if actual.kind == "none" {
                    owners.remove(&context.repository);
                }
            }
        }
        let output = result?;
        let actual = actual?;
        let actual_head = actual_head?;
        if owns && matches!(output.status, Some(0 | 1)) {
            operation.awaiting_resolution.store(true, Ordering::SeqCst);
            return Ok(());
        }
        if output.status != Some(0) {
            return Err(command_error(&output));
        }
        if actual.kind != "none" {
            return Err(AppError::Conflict(
                "Rebase left an unverified Git sequence; inspect it before another action".into(),
            ));
        }
        self.verify_rebase_result(context, &branch, &onto_oid, &actual_head, token)
            .await
    }

    pub(super) async fn verify_rebase(
        &self,
        context: &RepositoryContext,
        state: &IntegrationSnapshot,
        head: &ExpectedState,
        token: &Cancellation,
    ) -> AppResult<()> {
        self.verify_rebase_result(
            context,
            state.original_branch.as_deref().ok_or_else(malformed)?,
            state.target_oid.as_deref().ok_or_else(malformed)?,
            head,
            token,
        )
        .await
    }

    /// A finished rebase must be back on its own branch with the confirmed
    /// target reachable. Nothing about the replayed commits is assumed.
    async fn verify_rebase_result(
        &self,
        context: &RepositoryContext,
        branch: &str,
        onto: &str,
        head: &ExpectedState,
        token: &Cancellation,
    ) -> AppResult<()> {
        let current = head.head_oid.as_deref().ok_or_else(malformed)?;
        if head.branch.as_deref() != Some(branch) {
            return Err(AppError::Conflict(
                "The rebase did not return to its original branch; inspect HEAD before another action"
                    .into(),
            ));
        }
        let reachable = self
            .output(
                &context.repository,
                args(&["merge-base", "--is-ancestor", onto, current]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if reachable.status != Some(0) {
            return Err(AppError::Conflict(
                "The rebased branch does not contain the confirmed target commit; inspect HEAD"
                    .into(),
            ));
        }
        Ok(())
    }
}
