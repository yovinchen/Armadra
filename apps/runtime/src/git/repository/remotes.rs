//! Remote validation and the fetch/push/pull traffic that uses it.

use super::*;

impl RepositoryService {
    pub(super) async fn remotes(
        &self,
        directory: &Path,
        token: &Cancellation,
    ) -> AppResult<Vec<String>> {
        let output = self.read(directory, args(&["remote"]), token).await?;
        let text = text(&output)?;
        Ok(text.lines().map(str::to_owned).collect())
    }

    pub(super) async fn validate_remote(
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

    pub(super) async fn remote_tracking_oid(
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
    pub(super) async fn sync(
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
    pub(super) async fn sync_stop(
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

    pub(super) async fn fast_forward_pull(
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
