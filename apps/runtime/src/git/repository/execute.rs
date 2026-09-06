//! Running one validated action to completion.

use super::*;

impl RepositoryService {
    pub(super) async fn execute(
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
                | RepositoryAction::Revert { .. }
                | RepositoryAction::StartRebase { .. }
                | RepositoryAction::StartInteractiveRebase { .. }
                | RepositoryAction::SkipIntegration { .. }
                | RepositoryAction::ContinueIntegration { .. }
                | RepositoryAction::AbortIntegration { .. }
        ) {
            self.ensure_integration_idle(context, token).await?;
        }
        match action {
            RepositoryAction::StartCherryPick { .. } | RepositoryAction::Revert { .. } => {
                self.start_cherry_pick(context, action, expected, operation)
                    .await
            }
            RepositoryAction::CheckoutCommit { target_oid } => {
                // The OID is immutable, so confirming it resolves to a commit
                // here is the whole precondition; HEAD itself was already
                // compared against the reviewed state above.
                if self.resolve(&context.repository, target_oid, token).await? != *target_oid {
                    return Err(AppError::BadRequest(
                        "Checkout target must be a commit object ID".into(),
                    ));
                }
                self.mutate(
                    context,
                    args(&["switch", "--detach", "--no-overwrite-ignore", target_oid]),
                    operation,
                )
                .await
            }
            RepositoryAction::StartRebase {
                onto,
                expected_state_token,
            } => {
                self.start_rebase(context, onto, expected_state_token, expected, operation)
                    .await
            }
            RepositoryAction::StartInteractiveRebase { .. } => {
                self.start_interactive_rebase(context, action, expected, operation)
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
            RepositoryAction::CreateTag { .. }
            | RepositoryAction::DeleteTag { .. }
            | RepositoryAction::PushTag { .. } => {
                self.execute_tag(context, action, operation).await
            }
            RepositoryAction::AddRemote { .. }
            | RepositoryAction::RenameRemote { .. }
            | RepositoryAction::SetRemoteUrl { .. }
            | RepositoryAction::RemoveRemote { .. } => {
                self.execute_remote(context, action, operation).await
            }
            RepositoryAction::Reset { .. } => {
                self.reset(context, action, expected, operation).await
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
}

/// `--no-force` stays on every push; it disables the blanket force flag without
/// cancelling an explicit lease, so a rewrite can only happen against the exact
/// remote OID the caller reviewed. There is no code path that omits both.
pub(super) fn push_arguments(
    remote: &str,
    branch: &str,
    oid: &str,
    lease: Option<&ForceWithLease>,
) -> Vec<String> {
    // `--progress` because stderr is a pipe here, not a terminal, and Git only
    // reports counters when it believes somebody is watching. The percentages
    // it writes are what the panel's bar moves on (Git 设计 §10).
    let mut arguments = args(&[
        "push",
        "--porcelain",
        "--progress",
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
