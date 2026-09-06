//! Rebase replays the current branch onto a reviewed commit. Unlike merge and
//! cherry-pick it detaches HEAD for the whole sequence, so ownership is bound to
//! Git's own `rebase-merge` records instead of a motionless HEAD.
use super::*;

impl RepositoryService {
    /// The commits a rebase onto `onto` would replay, oldest first.
    ///
    /// This is a read: it is what the todo editor shows, and the same range the
    /// service later requires the submitted todo to cover exactly.
    pub async fn rebase_todo_preview(
        &self,
        workspace_root: &Path,
        requested: &str,
        onto: &str,
    ) -> AppResult<RebaseTodoPreview> {
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let head = self.head(&context.repository, &token).await?;
        let onto_oid = self.resolve(&context.repository, onto, &token).await?;
        let head_oid = head
            .head_oid
            .clone()
            .ok_or_else(|| AppError::Conflict("There are no commits to replay".into()))?;
        let (base, commits) = self
            .replay_range(&context, &onto_oid, &head_oid, &token)
            .await?;
        Ok(RebaseTodoPreview {
            onto: onto_oid,
            base,
            has_merges: commits.iter().any(|commit| commit.parents.len() > 1),
            commits,
            head,
        })
    }

    /// `(merge base, commits to replay oldest first)`.
    async fn replay_range(
        &self,
        context: &RepositoryContext,
        onto_oid: &str,
        head_oid: &str,
        token: &Cancellation,
    ) -> AppResult<(String, Vec<CommitRecord>)> {
        let base = self
            .output(
                &context.repository,
                args(&["merge-base", onto_oid, head_oid]),
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
        let output = self
            .read(
                &context.repository,
                vec![
                    "log".into(),
                    "--reverse".into(),
                    "--topo-order".into(),
                    "--no-show-signature".into(),
                    "--no-decorate".into(),
                    "-z".into(),
                    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s".into(),
                    "--max-count=1001".into(),
                    format!("{base}..{head_oid}"),
                    "--".into(),
                ],
                token,
            )
            .await?;
        let commits = parse_history(&output, &HashMap::new())?;
        if commits.len() > 1_000 {
            return Err(AppError::BadRequest(
                "This range has more commits than the todo editor supports".into(),
            ));
        }
        Ok((base, commits))
    }

    /// Run a reviewed todo list through `GIT_SEQUENCE_EDITOR`.
    ///
    /// The editor is `cp <file>`: Git appends the todo path, so the reviewed
    /// list replaces Git's generated one byte for byte and no interactive
    /// editor ever starts. `core.editor=:` covers the message step a squash
    /// would otherwise open, which is why squash keeps Git's own prefilled
    /// combined message rather than one this service invents.
    pub(in super::super) async fn start_interactive_rebase(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let RepositoryAction::StartInteractiveRebase {
            onto,
            todo,
            expected_state_token,
        } = action
        else {
            return Err(malformed());
        };
        let token = &operation.cancellation;
        let state = self.integration_snapshot(context, token).await?;
        if state.kind != "none" {
            return Err(AppError::Conflict(
                "An existing Git operation must be completed first".into(),
            ));
        }
        if state.head != *expected || state.state_token != *expected_state_token {
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
        let (base, commits) = self
            .replay_range(context, &onto_oid, &head_oid, token)
            .await?;
        if commits.iter().any(|commit| commit.parents.len() > 1) {
            return Err(AppError::Conflict(
                "This range contains a merge commit, which the todo editor does not replay".into(),
            ));
        }
        // The todo must be a permutation of the actual range: a commit can only
        // be dropped by saying so, never by being left out of the list.
        let expected_set: std::collections::BTreeSet<&str> =
            commits.iter().map(|commit| commit.oid.as_str()).collect();
        let submitted: std::collections::BTreeSet<&str> =
            todo.iter().map(|entry| entry.oid.as_str()).collect();
        if submitted.len() != todo.len() || submitted != expected_set {
            return Err(AppError::Conflict(
                "The reviewed todo does not list exactly the commits this rebase would replay; refresh it".into(),
            ));
        }
        if todo
            .iter()
            .all(|entry| entry.command == RebaseTodoCommand::Drop)
        {
            return Err(AppError::BadRequest(
                "A todo that drops every commit would leave nothing to replay".into(),
            ));
        }
        // A squash or a fixup needs a kept entry before it, after any
        // reordering. `keeps_commit` is what decides that, in one place, so a
        // verb added later cannot be forgotten here.
        let mut previous_kept = false;
        for entry in todo {
            if matches!(
                entry.command,
                RebaseTodoCommand::Squash | RebaseTodoCommand::Fixup
            ) && !previous_kept
            {
                return Err(AppError::BadRequest(
                    "A squash or fixup needs a kept commit before it in the reviewed order".into(),
                ));
            }
            if entry.command.keeps_commit() {
                previous_kept = true;
            }
        }

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
        let script = TodoScript::write(&context.common_dir, &session_id, todo)?;
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
            .output_with(
                &context.repository,
                args(&[
                    "-c",
                    "core.editor=:",
                    "-c",
                    "rerere.enabled=false",
                    "rebase",
                    "--interactive",
                    "--no-autosquash",
                    "--no-autostash",
                    "--no-rerere-autoupdate",
                    "--no-update-refs",
                    "--no-fork-point",
                    &onto_oid,
                ]),
                self.command_timeout,
                token,
                Some(operation.mutation_started.clone()),
                &[("GIT_SEQUENCE_EDITOR".into(), script.editor.clone())],
            )
            .await;
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

/// The reviewed todo list on disk plus the `GIT_SEQUENCE_EDITOR` command that
/// copies it over Git's generated one.
///
/// The command is `cp -- '<path>'`; Git runs it as `sh -c "$editor \"$@\"" --
/// <todo>`, so the reviewed file lands verbatim and no interactive editor ever
/// starts. The file lives in the repository's own Git directory under a name
/// derived from this operation, is created exclusively, and is removed when the
/// operation ends. A repository path that could break out of the single quotes
/// is refused rather than escaped.
struct TodoScript {
    editor: String,
    path: PathBuf,
    /// The message files a `reword` entry amends from. They live beside the
    /// todo, are removed with it, and are what makes a reword possible without
    /// an editor: the message was decided and reviewed before Git started.
    messages: Vec<PathBuf>,
}

impl Drop for TodoScript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        for message in &self.messages {
            let _ = std::fs::remove_file(message);
        }
    }
}

/// A path this service may pass to Git inside single quotes.
///
/// Git runs `GIT_SEQUENCE_EDITOR` and a todo's `exec` line through
/// `sh -c`, so a path containing a quote or a control character would stop
/// being one argument. Such a path is refused rather than escaped: escaping is
/// where this kind of check goes wrong, and a repository whose Git directory
/// contains a quote is rare enough to be told about.
fn shell_safe(path: &Path, what: &str) -> AppResult<String> {
    let value = path
        .to_str()
        .ok_or_else(|| AppError::Internal(format!("Rebase {what} path is not valid UTF-8")))?;
    if value.contains('\'') || value.chars().any(char::is_control) {
        return Err(AppError::Internal(format!(
            "Rebase {what} path cannot be passed to Git safely"
        )));
    }
    Ok(value.to_owned())
}

/// Creates one 0600 file with exactly these bytes, refusing to reuse an
/// existing one.
fn write_new(path: &Path, contents: &str, what: &str) -> AppResult<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| AppError::Internal(format!("Could not stage the rebase {what}")))?;
    file.write_all(contents.as_bytes())
        .map_err(|_| AppError::Internal(format!("Could not stage the rebase {what}")))?;
    Ok(())
}

impl TodoScript {
    fn write(common_dir: &Path, session_id: &str, todo: &[RebaseTodoEntry]) -> AppResult<Self> {
        let path = common_dir.join(format!("armadra-rebase-todo-{session_id}"));
        let quoted = shell_safe(&path, "todo")?;
        let editor = format!("cp -- '{quoted}'");
        // The file is registered before it is written, so a failure halfway
        // through still removes everything this call created.
        let mut script = Self {
            editor,
            path,
            messages: Vec::new(),
        };
        // Every OID was validated as hex and every keyword comes from a closed
        // enum, so no line can carry a Git directive of its own. A `reword` is
        // written as its `pick` plus one generated `exec`, because Git's own
        // `reword` opens an editor and there is no editor here to open.
        //
        // The `exec` is not the arbitrary-command verb the todo editor still
        // refuses to offer: its whole text is produced here from a path this
        // service created and a fixed argument list, and the message it reads
        // is a file rather than an argument, so nothing a caller typed ever
        // becomes part of a command line.
        let mut contents = String::new();
        for (index, entry) in todo.iter().enumerate() {
            contents.push_str(entry.command.keyword());
            contents.push(' ');
            contents.push_str(&entry.oid);
            contents.push('\n');
            if entry.command != RebaseTodoCommand::Reword {
                continue;
            }
            let message = entry.message.as_deref().ok_or_else(|| {
                AppError::Internal("A reword reached execution without its message".into())
            })?;
            let message_path =
                common_dir.join(format!("armadra-rebase-message-{session_id}-{index}"));
            let quoted_message = shell_safe(&message_path, "message")?;
            write_new(&message_path, message, "message")?;
            script.messages.push(message_path);
            contents.push_str(&format!(
                "exec git commit --amend --allow-empty --file '{quoted_message}'\n"
            ));
        }
        write_new(&script.path, &contents, "todo")?;
        Ok(script)
    }
}
