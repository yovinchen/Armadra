use super::*;

const MAX_UNTRACKED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_STASHES: usize = 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashRecord {
    pub oid: String,
    pub selector: String,
    pub subject: String,
    pub author_name: String,
    pub author_time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashSnapshot {
    pub repository_id: String,
    pub repository_path: String,
    pub head: ExpectedState,
    pub state_token: String,
    pub dirty: bool,
    pub has_conflicts: bool,
    pub stashes: Vec<StashRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDetail {
    pub oid: String,
    pub parents: Vec<String>,
    pub patch: String,
    pub staged_patch: String,
    pub untracked_patch: String,
}

pub(super) fn validate_message(message: &str) -> AppResult<()> {
    if message.len() > 4096 || message.chars().any(|c| c == '\0' || c == '\r') {
        return Err(AppError::BadRequest(
            "Stash message is invalid or too long".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_state_token(token: &str) -> AppResult<()> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest(
            "Stash requires an observed repository state token".into(),
        ));
    }
    Ok(())
}

impl RepositoryService {
    pub async fn stashes(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<StashSnapshot> {
        crate::git::access::require_execution(self.allow_helpers, "Git stash worktree state")?;
        let context = self.context(workspace_root, requested).await?;
        let (snapshot, _) = self
            .stash_snapshot(&context, &Cancellation::default())
            .await?;
        Ok(snapshot)
    }

    /// Detail reads are anchored to an immutable OID still present in the stash
    /// list. Index/worktree and optional untracked snapshots are displayed apart.
    pub async fn stash_detail(
        &self,
        workspace_root: &Path,
        requested: &str,
        oid: &str,
    ) -> AppResult<StashDetail> {
        require_oid(oid)?;
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let (_, records) = self.stash_records(&context, &token).await?;
        selected_stash(&records, oid)?;
        let parents = self
            .read(
                &context.repository,
                args(&["rev-list", "--parents", "-n", "1", oid, "--"]),
                &token,
            )
            .await?;
        let parents = one_line(&parents)?
            .split_whitespace()
            .skip(1)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !(2..=3).contains(&parents.len()) || !parents.iter().all(|oid| valid_oid(oid)) {
            return Err(malformed());
        }
        let patch = self
            .read(
                &context.repository,
                args(&[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--binary",
                    &parents[0],
                    oid,
                    "--",
                ]),
                &token,
            )
            .await?;
        let staged = self
            .read(
                &context.repository,
                args(&[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--binary",
                    &parents[0],
                    &parents[1],
                    "--",
                ]),
                &token,
            )
            .await?;
        let untracked = if let Some(untracked) = parents.get(2) {
            self.read(
                &context.repository,
                args(&[
                    "show",
                    "--format=",
                    "--root",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--binary",
                    untracked,
                    "--",
                ]),
                &token,
            )
            .await?
        } else {
            Vec::new()
        };
        Ok(StashDetail {
            oid: oid.into(),
            parents,
            patch: String::from_utf8_lossy(&patch).into_owned(),
            staged_patch: String::from_utf8_lossy(&staged).into_owned(),
            untracked_patch: String::from_utf8_lossy(&untracked).into_owned(),
        })
    }

    async fn stash_records(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<(Vec<u8>, Vec<StashRecord>)> {
        let raw = self
            .read(
                &context.repository,
                args(&[
                    "stash",
                    "list",
                    "-z",
                    "--format=%H%x00%gd%x00%gs%x00%an%x00%aI",
                ]),
                token,
            )
            .await?;
        let fields: Vec<_> = raw.split(|byte| *byte == 0).collect();
        let fields = if fields.last() == Some(&&b""[..]) {
            &fields[..fields.len() - 1]
        } else {
            &fields[..]
        };
        if fields.len() % 5 != 0 || fields.len() / 5 > MAX_STASHES {
            return Err(AppError::BadRequest(
                "Stash list exceeds the supported limit or is malformed".into(),
            ));
        }
        let mut records = Vec::new();
        for (index, fields) in fields.chunks_exact(5).enumerate() {
            let text = |i: usize| String::from_utf8(fields[i].to_vec()).map_err(|_| malformed());
            let oid = text(0)?;
            let selector = text(1)?;
            require_oid(&oid)?;
            if selector != format!("stash@{{{index}}}") {
                return Err(malformed());
            }
            records.push(StashRecord {
                oid,
                selector,
                subject: text(2)?,
                author_name: text(3)?,
                author_time: text(4)?,
            });
        }
        Ok((raw, records))
    }

    pub(super) async fn stash_snapshot(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<(StashSnapshot, Vec<u8>)> {
        let head = self.head(&context.repository, token).await?;
        let (stash_raw, stashes) = self.stash_records(context, token).await?;
        let status = self
            .read(
                &context.repository,
                args(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
                token,
            )
            .await?;
        let conflicts = self
            .read(
                &context.repository,
                args(&["diff", "--name-only", "--diff-filter=U", "-z", "--"]),
                token,
            )
            .await?;
        let mut digest = Sha256::new();
        hash_field(
            &mut digest,
            context.repository.as_os_str().as_encoded_bytes(),
        );
        hash_field(
            &mut digest,
            &serde_json::to_vec(&head).map_err(|_| malformed())?,
        );
        hash_field(&mut digest, &stash_raw);
        hash_field(&mut digest, &status);
        // Status alone cannot notice a second edit to an already dirty file.
        // Binary diffs include full staged/unstaged content and mode changes.
        for staged in [false, true] {
            let mut command = args(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                "--no-renames",
            ]);
            if staged {
                command.push("--cached".into());
            }
            command.push("--".into());
            hash_field(
                &mut digest,
                &self.read(&context.repository, command, token).await?,
            );
        }
        let untracked = self
            .read(
                &context.repository,
                args(&["ls-files", "--others", "--exclude-standard", "-z", "--"]),
                token,
            )
            .await?;
        hash_field(&mut digest, &untracked);
        if untracked.iter().filter(|byte| **byte == 0).count() > 4096 {
            return Err(AppError::BadRequest(
                "Too many untracked files for stash confirmation".into(),
            ));
        }
        let mut budget = MAX_UNTRACKED_BYTES;
        for bytes in untracked
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            if token.requested.load(Ordering::SeqCst) || self.is_shutting_down() {
                return Err(shutting_down());
            }
            let name = std::str::from_utf8(bytes).map_err(|_| malformed())?;
            hash_untracked(&context.repository, name, &mut digest, &mut budget)?;
        }
        if self.head(&context.repository, token).await? != head {
            return Err(AppError::Conflict(
                "HEAD changed while observing stash state; refresh first".into(),
            ));
        }
        Ok((
            StashSnapshot {
                repository_id: context.repository_id(),
                repository_path: path_string(&context.repository)?,
                head,
                state_token: format!("{:x}", digest.finalize()),
                dirty: !status.is_empty(),
                has_conflicts: !conflicts.is_empty(),
                stashes,
            },
            stash_raw,
        ))
    }

    /// Move the current ref to a reviewed commit.
    ///
    /// `Hard` is the only mode that can lose uncommitted work, so it needs an
    /// explicit acknowledgement whenever anything is uncommitted, and it always
    /// records a stash snapshot first — the same stash backend the Stashes tab
    /// lists, so the discarded state has a named way back. A snapshot that Git
    /// does not actually create stops the reset instead of proceeding without
    /// the recovery point it promised.
    pub(super) async fn reset(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let RepositoryAction::Reset {
            mode,
            target_oid,
            expected_state_token: expected_token,
            discard_changes,
        } = action
        else {
            return Err(malformed());
        };
        let (mode, discard_changes) = (*mode, *discard_changes);
        let token = &operation.cancellation;
        let (snapshot, before_stashes) = self.stash_snapshot(context, token).await?;
        if snapshot.head != *expected || snapshot.state_token != *expected_token {
            return Err(AppError::Conflict(
                "Repository state changed; refresh and confirm the reset again".into(),
            ));
        }
        if snapshot.has_conflicts {
            return Err(AppError::Conflict(
                "Resolve the conflicted index before resetting".into(),
            ));
        }
        if self.resolve(&context.repository, target_oid, token).await? != *target_oid {
            return Err(AppError::BadRequest(
                "Reset target must be a commit object ID".into(),
            ));
        }
        if mode == ResetMode::Hard && snapshot.dirty && !discard_changes {
            return Err(AppError::Conflict(
                "A hard reset replaces uncommitted work; confirm discarding it explicitly".into(),
            ));
        }
        if mode == ResetMode::Hard && snapshot.dirty {
            let message = format!("armadra: before hard reset to {target_oid}");
            self.mutate(
                context,
                vec![
                    "stash".into(),
                    "push".into(),
                    "--include-untracked".into(),
                    "--message".into(),
                    message,
                    "--".into(),
                ],
                operation,
            )
            .await?;
            if self.stash_records(context, token).await?.0 == before_stashes {
                return Err(AppError::Conflict(
                    "No recovery stash was created; the hard reset was not started".into(),
                ));
            }
            // The stash already restored the worktree to HEAD, so the reset
            // that follows only has to move the ref.
        }
        self.mutate(
            context,
            args(&["reset", mode.flag(), target_oid]),
            operation,
        )
        .await?;
        let head = self.head(&context.repository, token).await?;
        if head.head_oid.as_deref() != Some(target_oid) || head.branch != expected.branch {
            return Err(AppError::Conflict(
                "HEAD does not point at the confirmed commit after the reset; inspect the repository".into(),
            ));
        }
        Ok(())
    }

    pub(super) async fn execute_stash(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        let expected_token = match action {
            RepositoryAction::CreateStash {
                expected_state_token,
                ..
            }
            | RepositoryAction::ApplyStash {
                expected_state_token,
                ..
            }
            | RepositoryAction::PopStash {
                expected_state_token,
                ..
            }
            | RepositoryAction::DropStash {
                expected_state_token,
                ..
            } => expected_state_token,
            _ => return Err(malformed()),
        };
        let (snapshot, before_stashes) = self.stash_snapshot(context, token).await?;
        if snapshot.head != *expected || snapshot.state_token != *expected_token {
            return Err(AppError::Conflict(
                "Repository or stash list changed; refresh and confirm again".into(),
            ));
        }
        if snapshot.has_conflicts && !matches!(action, RepositoryAction::DropStash { .. }) {
            return Err(AppError::Conflict(
                "Resolve existing index conflicts before changing stashes".into(),
            ));
        }
        match action {
            RepositoryAction::CreateStash {
                message,
                include_untracked,
                ..
            } => {
                if !snapshot.dirty || snapshot.head.head_oid.is_none() {
                    return Err(AppError::Conflict(
                        "Stash requires an initial commit and local changes".into(),
                    ));
                }
                let mut command = args(&["stash", "push", "--message", message]);
                if *include_untracked {
                    command.push("--include-untracked".into());
                }
                command.push("--".into());
                self.mutate(context, command, operation).await?;
                if self.stash_records(context, token).await?.0 == before_stashes {
                    return Err(AppError::Conflict(
                        "No stash was created; untracked files require the explicit include option"
                            .into(),
                    ));
                }
                Ok(())
            }
            RepositoryAction::ApplyStash {
                oid,
                reinstate_index,
                ..
            }
            | RepositoryAction::PopStash {
                oid,
                reinstate_index,
                ..
            } => {
                selected_stash(&snapshot.stashes, oid)?;
                self.protect_stash_paths(context, oid, token).await?;
                let mut command = args(&["stash", "apply"]);
                if *reinstate_index {
                    command.push("--index".into());
                }
                command.extend(["--".into(), oid.clone()]);
                // Apply the selected immutable object, never an index that can
                // shift. Any conflict/cancellation retains the stash.
                self.mutate(context, command, operation).await?;
                if matches!(action, RepositoryAction::PopStash { .. }) {
                    self.drop_stash(context, oid, &before_stashes, operation)
                        .await?;
                }
                Ok(())
            }
            RepositoryAction::DropStash { oid, .. } => {
                self.drop_stash(context, oid, &before_stashes, operation)
                    .await
            }
            _ => Err(malformed()),
        }
    }

    /// Git stash apply can overwrite ignored files. Inspect only paths touched
    /// by this immutable stash, including staged and untracked snapshots, before
    /// allowing Git to perform the merge. Never follow an untracked symlink.
    async fn protect_stash_paths(
        &self,
        context: &RepositoryContext,
        oid: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        let parents = self
            .read(
                &context.repository,
                args(&["rev-list", "--parents", "-n", "1", oid, "--"]),
                token,
            )
            .await?;
        let parent_line = one_line(&parents)?;
        let parents = parent_line.split_whitespace().skip(1).collect::<Vec<_>>();
        if !(2..=3).contains(&parents.len()) {
            return Err(malformed());
        }
        let mut touched = std::collections::BTreeSet::new();
        for tree in [oid, parents[1]] {
            let names = self
                .read(
                    &context.repository,
                    args(&[
                        "diff",
                        "--name-only",
                        "--no-renames",
                        "-z",
                        parents[0],
                        tree,
                        "--",
                    ]),
                    token,
                )
                .await?;
            for path in names
                .split(|byte| *byte == 0)
                .filter(|part| !part.is_empty())
            {
                touched.insert(
                    std::str::from_utf8(path)
                        .map_err(|_| malformed())?
                        .to_owned(),
                );
            }
        }
        if let Some(tree) = parents.get(2) {
            let names = self
                .read(
                    &context.repository,
                    args(&["ls-tree", "-r", "-z", "--name-only", tree, "--"]),
                    token,
                )
                .await?;
            for path in names
                .split(|byte| *byte == 0)
                .filter(|part| !part.is_empty())
            {
                touched.insert(
                    std::str::from_utf8(path)
                        .map_err(|_| malformed())?
                        .to_owned(),
                );
            }
        }
        self.protect_local_paths(context, &touched, token).await
    }

    pub(super) async fn protect_local_paths(
        &self,
        context: &RepositoryContext,
        touched: &std::collections::BTreeSet<String>,
        token: &Cancellation,
    ) -> AppResult<()> {
        if touched.len() > 4096 {
            return Err(AppError::BadRequest(
                "Operation touches too many paths for safe confirmation".into(),
            ));
        }
        let mut inspect = std::collections::BTreeSet::new();
        for name in touched {
            let relative = Path::new(name);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err(malformed());
            }
            let mut prefix = PathBuf::new();
            for part in relative.components() {
                prefix.push(part);
                match context.repository.join(&prefix).symlink_metadata() {
                    Ok(metadata) if !metadata.is_dir() => {
                        if prefix != relative {
                            return Err(AppError::Conflict("An incoming parent path is a local file or symlink; resolve the collision before applying".into()));
                        }
                        inspect.insert(path_string(&prefix)?);
                        // A symlink/regular parent cannot be traversed safely.
                        break;
                    }
                    Ok(_) if prefix == relative => {
                        return Err(AppError::Conflict(
                            "An incoming file collides with a local directory; move it before applying"
                                .into(),
                        ));
                    }
                    Ok(_) => (),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                }
            }
        }
        if !inspect.is_empty() {
            // Chunk argv so a large but valid set cannot exceed platform limits.
            let names = inspect.into_iter().collect::<Vec<_>>();
            for chunk in names.chunks(64) {
                let mut command = args(&["ls-files", "-z", "--"]);
                command.extend(chunk.iter().map(|name| format!(":(literal){name}")));
                let tracked = self.read(&context.repository, command, token).await?;
                let tracked = tracked
                    .split(|byte| *byte == 0)
                    .filter(|part| !part.is_empty())
                    .collect::<std::collections::HashSet<_>>();
                if chunk.iter().any(|name| !tracked.contains(name.as_bytes())) {
                    return Err(AppError::Conflict("Operation would overwrite a local untracked or ignored path; preserve that file before applying".into()));
                }
            }
        }
        Ok(())
    }

    async fn drop_stash(
        &self,
        context: &RepositoryContext,
        oid: &str,
        expected_list: &[u8],
        operation: &Operation,
    ) -> AppResult<()> {
        let (raw, records) = self.stash_records(context, &operation.cancellation).await?;
        if raw != expected_list {
            return Err(AppError::Conflict(
                "Stash list changed; selected stash was retained. Refresh before another action"
                    .into(),
            ));
        }
        let selected = selected_stash(&records, oid)?;
        // Git has no OID-CAS reflog deletion API. Recheck the complete reflog
        // immediately under our common-directory queue. External Git processes
        // remain outside that queue; never edit Git's reflog files ourselves.
        self.mutate(
            context,
            args(&["stash", "drop", "--", &selected.selector]),
            operation,
        )
        .await
    }
}

fn selected_stash<'a>(records: &'a [StashRecord], oid: &str) -> AppResult<&'a StashRecord> {
    let mut matches = records.iter().filter(|record| record.oid == oid);
    let found = matches.next().ok_or_else(|| {
        AppError::Conflict("Selected stash no longer exists; refresh first".into())
    })?;
    if matches.next().is_some() {
        return Err(AppError::Conflict("This object appears more than once in the stash list; select it with Git before continuing".into()));
    }
    Ok(found)
}

fn hash_field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
}

fn hash_untracked(root: &Path, name: &str, digest: &mut Sha256, budget: &mut u64) -> AppResult<()> {
    let relative = Path::new(name);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(malformed());
    }
    let path = root.join(relative);
    let parent = path.parent().ok_or_else(malformed)?.canonicalize()?;
    if !parent.starts_with(root) {
        return Err(AppError::BadRequest(
            "Untracked path escapes the repository".into(),
        ));
    }
    let path = parent.join(relative.file_name().ok_or_else(malformed)?);
    let metadata = path.symlink_metadata()?;
    if metadata.file_type().is_symlink() {
        hash_field(digest, b"symlink");
        hash_field(
            digest,
            std::fs::read_link(&path)?.as_os_str().as_encoded_bytes(),
        );
    } else if metadata.is_file() {
        if metadata.len() > *budget {
            return Err(AppError::BadRequest(
                "Untracked content exceeds the 32 MiB stash confirmation limit".into(),
            ));
        }
        *budget -= metadata.len();
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let file = options.open(&path)?;
        let opened = file.metadata()?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if opened.file_attributes() & 0x400 != 0 {
                return Err(AppError::Conflict(
                    "Untracked file became a reparse point".into(),
                ));
            }
        }
        if !opened.is_file() || opened.len() != metadata.len() {
            return Err(AppError::Conflict(
                "Untracked file changed during confirmation".into(),
            ));
        }
        let mut contents = Vec::new();
        file.take(metadata.len() + 1).read_to_end(&mut contents)?;
        if contents.len() as u64 != metadata.len() {
            return Err(AppError::Conflict(
                "Untracked file changed during confirmation".into(),
            ));
        }
        hash_field(digest, b"file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            hash_field(digest, &(opened.permissions().mode() & 0o111).to_be_bytes());
        }
        hash_field(digest, &contents);
    } else {
        return Err(AppError::BadRequest(
            "Untracked directories or special files cannot be safely confirmed for stash".into(),
        ));
    }
    Ok(())
}
