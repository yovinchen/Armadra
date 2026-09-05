//! Starting a merge and resuming an owned integration sequence.

use super::*;

impl RepositoryService {
    pub(in crate::git::repository) async fn start_merge(
        &self,
        context: &RepositoryContext,
        target_oid: &str,
        message: &str,
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
                "Repository state changed; refresh and confirm the merge again".into(),
            ));
        }
        if state.dirty
            || !state.conflicts.is_empty()
            || state.head.head_oid.is_none()
            || state.head.branch.is_none()
        {
            return Err(AppError::Conflict(
                "Merge requires a clean worktree and index on a committed local branch".into(),
            ));
        }
        if self.resolve(&context.repository, target_oid, token).await? != target_oid {
            return Err(AppError::BadRequest(
                "Merge target must be a commit object ID".into(),
            ));
        }
        let touched = self
            .read(
                &context.repository,
                args(&[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-only",
                    "--no-renames",
                    "-z",
                    expected.head_oid.as_deref().ok_or_else(malformed)?,
                    target_oid,
                    "--",
                ]),
                token,
            )
            .await?;
        let touched = touched
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| {
                std::str::from_utf8(path)
                    .map(str::to_owned)
                    .map_err(|_| malformed())
            })
            .collect::<AppResult<std::collections::BTreeSet<_>>>()?;
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
                    kind: "merge",
                    mainline: None,
                    original: expected.clone(),
                    target_oid: target_oid.into(),
                    marker: None,
                },
            );
        let mut command = args(&[
            "-c",
            "rerere.enabled=false",
            "merge",
            "--no-ff",
            "--no-commit",
            "--no-autostash",
            "--no-overwrite-ignore",
            "--no-rerere-autoupdate",
        ]);
        if !message.is_empty() {
            command.extend(["-m".into(), message.into()]);
        }
        command.extend(["--".into(), target_oid.into()]);
        let result = self
            .output(
                &context.repository,
                command,
                self.command_timeout,
                token,
                Some(operation.mutation_started.clone()),
            )
            .await;
        // Use a new read token after a cancelled child has been reaped. This can
        // bind its actual remaining marker without ever retrying the mutation.
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
                if actual.kind == "merge"
                    && actual.target_oid.as_deref() == Some(target_oid)
                    && actual.original_head == expected.head_oid
                    && head == expected
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
        if actual.kind != "none" || actual_head != *expected {
            return Err(AppError::Conflict("Merge ownership or HEAD could not be verified after Git exited; inspect current state".into()));
        }
        let ancestor = self
            .output(
                &context.repository,
                args(&[
                    "merge-base",
                    "--is-ancestor",
                    target_oid,
                    expected.head_oid.as_deref().ok_or_else(malformed)?,
                ]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if ancestor.status != Some(0) {
            return Err(AppError::Conflict(
                "Git returned without a merge state or reachable target; inspect the repository"
                    .into(),
            ));
        }
        Ok(())
    }

    pub(in crate::git::repository) async fn resume_integration(
        &self,
        context: &RepositoryContext,
        session_id: &str,
        expected_token: &str,
        expected: &ExpectedState,
        recovery: Recovery,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        let state = self.integration_snapshot(context, token).await?;
        if !state.owned
            || state.session_id.as_deref() != Some(session_id)
            || state.head != *expected
            || state.state_token != expected_token
        {
            return Err(AppError::Conflict(
                "Integration ownership or repository state changed; refresh before continuing"
                    .into(),
            ));
        }
        if recovery == Recovery::Continue && !state.can_continue {
            return Err(AppError::Conflict(
                "Resolve all conflicts and stage the saved results before continuing".into(),
            ));
        }
        if recovery == Recovery::Skip && !state.can_skip {
            return Err(AppError::Conflict("Only an owned empty cherry-pick can be skipped; nonempty work must be resolved or explicitly aborted".into()));
        }
        if recovery != Recovery::Continue {
            self.protect_abort_paths(
                context,
                state.original_head.as_deref().ok_or_else(malformed)?,
                token,
            )
            .await?;
        }
        let command = match (state.kind.as_str(), recovery) {
            ("merge", Recovery::Abort) => args(&["merge", "--abort"]),
            ("merge", Recovery::Continue) => args(&["-c", "core.editor=:", "commit", "--no-edit"]),
            ("cherryPick", mode) => args(&[
                "-c",
                "core.editor=:",
                "cherry-pick",
                match mode {
                    Recovery::Continue => "--continue",
                    Recovery::Abort => "--abort",
                    Recovery::Skip => "--skip",
                },
            ]),
            // Skip belongs to an empty cherry-pick only; dropping a revert
            // silently would leave the change it was meant to undo in place.
            ("revert", mode @ (Recovery::Continue | Recovery::Abort)) => args(&[
                "-c",
                "core.editor=:",
                "revert",
                if mode == Recovery::Continue {
                    "--continue"
                } else {
                    "--abort"
                },
            ]),
            // Skip would silently drop a whole replayed commit, so a rebase
            // only offers the two decisions the caller can actually review.
            ("rebase", mode @ (Recovery::Continue | Recovery::Abort)) => args(&[
                "-c",
                "core.editor=:",
                "-c",
                "rerere.enabled=false",
                "rebase",
                if mode == Recovery::Continue {
                    "--continue"
                } else {
                    "--abort"
                },
            ]),
            _ => {
                return Err(AppError::Conflict(
                    "This Git operation is not managed by the current service".into(),
                ));
            }
        };
        self.mutate(context, command, operation).await?;
        let after = self.git_integration(context, token).await?;
        let head = self.head(&context.repository, token).await?;
        // Abort returns a rebase to its recorded branch, not to the detached
        // head the caller confirmed; every other kind leaves HEAD where it was.
        let restored = if state.kind == "rebase" {
            ExpectedState {
                head_oid: state.original_head.clone(),
                branch: state.original_branch.clone(),
            }
        } else {
            expected.clone()
        };
        if state.kind == "rebase" && recovery == Recovery::Continue && after.kind == "rebase" {
            // A replay can stop again on the next commit. That is still the
            // same owned sequence, not a failed recovery.
            let still_owned = self
                .inner
                .integrations
                .lock()
                .expect("Git integrations")
                .get(&context.repository)
                .is_some_and(|owner| owns_integration(owner, &after, &head));
            if still_owned {
                operation.awaiting_resolution.store(true, Ordering::SeqCst);
                return Ok(());
            }
        }
        if after.kind != "none" || (recovery != Recovery::Continue && head != restored) {
            return Err(AppError::Conflict("Git did not finish the requested recovery; inspect the current state before another action".into()));
        }
        if recovery == Recovery::Continue && state.kind == "cherryPick" {
            self.verify_cherry_pick(
                context,
                state.target_oid.as_deref().ok_or_else(malformed)?,
                expected,
                &head,
                token,
            )
            .await?;
        }
        if recovery == Recovery::Continue && state.kind == "revert" {
            self.verify_revert(
                context,
                state.target_oid.as_deref().ok_or_else(malformed)?,
                expected,
                &head,
                token,
            )
            .await?;
        }
        if recovery == Recovery::Continue && state.kind == "rebase" {
            self.verify_rebase(context, &state, &head, token).await?;
        }
        if recovery == Recovery::Continue && state.kind == "merge" {
            let commit = head.head_oid.as_deref().ok_or_else(malformed)?;
            let parents = self
                .read(
                    &context.repository,
                    args(&["rev-list", "--parents", "-n", "1", commit, "--"]),
                    token,
                )
                .await?;
            let parents = one_line(&parents)?
                .split_whitespace()
                .skip(1)
                .collect::<Vec<_>>();
            if head.branch != expected.branch
                || parents
                    != vec![
                        expected.head_oid.as_deref().ok_or_else(malformed)?,
                        state.target_oid.as_deref().ok_or_else(malformed)?,
                    ]
            {
                return Err(AppError::Conflict(
                    "The resulting commit does not match the confirmed merge parents; inspect HEAD"
                        .into(),
                ));
            }
        }
        self.release_integration_owner(
            context,
            session_id,
            if recovery == Recovery::Abort {
                OperationState::Cancelled
            } else {
                OperationState::Succeeded
            },
            match recovery {
                Recovery::Abort => {
                    "Git integration was explicitly aborted; its starting state was restored"
                }
                Recovery::Continue => "Git integration was completed by a confirmed continuation",
                Recovery::Skip => {
                    "The empty cherry-pick was explicitly skipped; HEAD was preserved"
                }
            },
        );
        Ok(())
    }
}
