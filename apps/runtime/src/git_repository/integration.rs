//! Explicit integration state. Ownership is deliberately local to this service
//! lifetime; a restarted Runtime never claims an external Git sequence.
use super::*;
mod cherry_pick;
pub use cherry_pick::CherryPickPreview;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Recovery {
    Continue,
    Abort,
    Skip,
}

const MAX_PREVIEW: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub oid: String,
    pub mode: String,
    pub size: u64,
    pub preview: String,
    pub binary: Option<bool>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub base: Option<ConflictSide>,
    pub ours: Option<ConflictSide>,
    pub theirs: Option<ConflictSide>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSnapshot {
    pub repository_id: String,
    pub repository_path: String,
    pub head: ExpectedState,
    pub state_token: String,
    pub kind: String,
    pub owned: bool,
    pub session_id: Option<String>,
    pub original_head: Option<String>,
    pub target_oid: Option<String>,
    pub message: Option<String>,
    pub dirty: bool,
    pub can_continue: bool,
    pub mainline: Option<u32>,
    pub empty: bool,
    pub can_skip: bool,
    pub conflicts: Vec<ConflictFile>,
}

#[derive(Debug, Clone)]
pub(super) struct IntegrationOwner {
    session_id: String,
    kind: &'static str,
    mainline: Option<u32>,
    original: ExpectedState,
    target_oid: String,
    marker: Option<MarkerIdentity>,
}
impl IntegrationOwner {
    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkerIdentity {
    digest: Vec<u8>,
    created: Option<std::time::SystemTime>,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device_inode: (u64, u64),
}
struct GitIntegration {
    kind: String,
    message: Option<String>,
    metadata_digest: Vec<u8>,
    target_oid: Option<String>,
    original_head: Option<String>,
    marker: Option<MarkerIdentity>,
}

impl RepositoryService {
    pub async fn integration_status(
        &self,
        root: &Path,
        requested: &str,
    ) -> AppResult<IntegrationSnapshot> {
        // Read and reconcile only after queued mutations have fully finished;
        // a commit briefly removes MERGE_HEAD before its post-commit work ends.
        let guard = self.mutation_guard(root, requested).await?;
        self.integration_snapshot(&guard.context, &Cancellation::default())
            .await
    }

    pub(super) async fn ensure_integration_idle(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<()> {
        if self.git_integration(context, token).await?.kind != "none" {
            return Err(AppError::Conflict("A Git integration is already in progress; resolve it before another repository operation".into()));
        }
        Ok(())
    }

    pub(super) async fn start_merge(
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

    pub(super) async fn resume_integration(
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
            _ => {
                return Err(AppError::Conflict(
                    "This Git operation is not managed by the current service".into(),
                ));
            }
        };
        self.mutate(context, command, operation).await?;
        let after = self.git_integration(context, token).await?;
        let head = self.head(&context.repository, token).await?;
        if after.kind != "none" || (recovery != Recovery::Continue && head != *expected) {
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

    fn release_integration_owner(
        &self,
        context: &RepositoryContext,
        session_id: &str,
        state: OperationState,
        message: &str,
    ) {
        let removed = {
            let mut owners = self.inner.integrations.lock().expect("Git integrations");
            if owners
                .get(&context.repository)
                .is_some_and(|owner| owner.session_id == session_id)
            {
                owners.remove(&context.repository);
                true
            } else {
                false
            }
        };
        if removed {
            // Drop the owner mutex before taking the operation registry mutex.
            let operation = self
                .inner
                .operations
                .lock()
                .expect("Git operations")
                .get(session_id)
                .cloned();
            if let Some(operation) = operation {
                let mut snapshot = operation.snapshot.lock().expect("Git operation");
                if matches!(
                    snapshot.state,
                    OperationState::AwaitingResolution | OperationState::UnknownOutcome
                ) {
                    snapshot.state = state;
                    snapshot.finished_at = Some(now());
                    snapshot.message = Some(message.into());
                }
            }
        }
    }

    async fn protect_abort_paths(
        &self,
        context: &RepositoryContext,
        original: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        // A file deleted by the merge may have been recreated as ignored local
        // content. Abort must not overwrite it while restoring the old tree.
        let changed = self
            .read(
                &context.repository,
                args(&[
                    "diff",
                    "--cached",
                    "--name-only",
                    "--no-renames",
                    "-z",
                    original,
                    "--",
                ]),
                token,
            )
            .await?;
        for name in changed
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
        {
            let name = std::str::from_utf8(name).map_err(|_| malformed())?;
            let path = Path::new(name);
            if path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err(malformed());
            }
            let mut prefix = PathBuf::new();
            for part in path.components() {
                prefix.push(part);
                match context.repository.join(&prefix).symlink_metadata() {
                    Ok(metadata) if metadata.is_dir() && prefix != path => continue,
                    Ok(metadata) if !metadata.is_dir() && prefix == path => {
                        let prefix = path_string(&prefix)?;
                        let tracked = self
                            .read(
                                &context.repository,
                                args(&["ls-files", "-z", "--", &format!(":(literal){prefix}")]),
                                token,
                            )
                            .await?;
                        if !tracked
                            .split(|byte| *byte == 0)
                            .any(|entry| entry == prefix.as_bytes())
                        {
                            return Err(AppError::Conflict("Abort would overwrite a local untracked or ignored file; preserve it first".into()));
                        }
                        break;
                    }
                    Ok(_) => {
                        return Err(AppError::Conflict(
                            "A local directory or parent path blocks safe merge recovery".into(),
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }

    async fn integration_snapshot(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<IntegrationSnapshot> {
        let (state, _) = self.stash_snapshot(context, token).await?;
        let actual = self.git_integration(context, token).await?;
        let conflicts = self.conflict_files(context, token).await?;
        let owner = self
            .inner
            .integrations
            .lock()
            .expect("Git integrations")
            .get(&context.repository)
            .cloned();
        let owned = owner
            .as_ref()
            .is_some_and(|owner| owns_integration(owner, &actual, &state.head));
        if let Some(owner) = &owner
            && owner.marker.is_some()
            && !owned
        {
            self.release_integration_owner(context, &owner.session_id, OperationState::UnknownOutcome,
                "Recorded Git integration state was completed or replaced outside this operation; ownership was released. Inspect current HEAD before another action");
        }
        let mut digest = Sha256::new();
        digest.update(state.state_token.as_bytes());
        digest.update(actual.kind.as_bytes());
        digest.update(&actual.metadata_digest);
        if let Some(marker) = &actual.marker {
            digest.update(&marker.digest);
        }
        if let Some(original) = &actual.original_head {
            digest.update(original.as_bytes());
        }
        let unstaged = self
            .output(
                &context.repository,
                args(&["diff", "--no-ext-diff", "--quiet", "--"]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if !matches!(unstaged.status, Some(0 | 1)) {
            return Err(command_error(&unstaged));
        }
        let staged = self
            .output(
                &context.repository,
                args(&["diff", "--cached", "--no-ext-diff", "--quiet", "--"]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if !matches!(staged.status, Some(0 | 1)) {
            return Err(command_error(&staged));
        }
        let empty = actual.kind == "cherryPick"
            && conflicts.is_empty()
            && staged.status == Some(0)
            && unstaged.status == Some(0);
        let can_skip = owned && empty;
        Ok(IntegrationSnapshot {
            repository_id: state.repository_id,
            repository_path: state.repository_path,
            head: state.head,
            state_token: format!("{:x}", digest.finalize()),
            kind: actual.kind,
            owned,
            session_id: owned.then(|| owner.as_ref().unwrap().session_id.clone()),
            original_head: if owned {
                owner
                    .as_ref()
                    .and_then(|owner| owner.original.head_oid.clone())
            } else {
                actual.original_head
            },
            target_oid: actual.target_oid,
            can_continue: owned
                && conflicts.is_empty()
                && unstaged.status == Some(0)
                && actual.message.is_some()
                && !empty,
            mainline: owned.then(|| owner.as_ref().unwrap().mainline).flatten(),
            empty,
            can_skip,
            message: actual.message,
            dirty: state.dirty,
            conflicts,
        })
    }

    async fn git_integration(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<GitIntegration> {
        let git_dir = self
            .read(
                &context.repository,
                args(&["rev-parse", "--absolute-git-dir"]),
                token,
            )
            .await?;
        let git_dir = PathBuf::from(one_line(&git_dir)?);
        let mut active = Vec::new();
        for (name, kind) in [
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("MERGE_HEAD", "merge"),
            ("MERGE_AUTOSTASH", "unknown"),
            ("CHERRY_PICK_HEAD", "cherryPick"),
            ("REVERT_HEAD", "revert"),
            ("BISECT_START", "bisect"),
        ] {
            match git_dir.join(name).symlink_metadata() {
                Ok(metadata) if metadata.file_type().is_symlink() => return Err(AppError::Conflict("Git integration metadata is a symlink; inspect it with Git before continuing".into())),
                Ok(_) => active.push(kind),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        match git_dir.join("sequencer").symlink_metadata() {
            Ok(_) => active.push("unknown"), // only single-commit picks are owned; never run an external sequence
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let kind = match active.as_slice() {
            [] => "none",
            [kind] => kind,
            _ => "unknown",
        }
        .to_string();
        let (target_oid, marker) = if kind == "merge" || kind == "cherryPick" {
            let (bytes, marker) = read_marker(&git_dir.join(if kind == "merge" {
                "MERGE_HEAD"
            } else {
                "CHERRY_PICK_HEAD"
            }))?;
            let ids = std::str::from_utf8(&bytes)
                .map_err(|_| malformed())?
                .split_whitespace()
                .collect::<Vec<_>>();
            let oid = match ids.as_slice() {
                [oid] if valid_oid(oid) => Some((*oid).to_owned()),
                _ => None,
            };
            (oid, Some(marker))
        } else {
            (None, None)
        };
        let original_head = if kind != "none" && kind != "cherryPick" {
            match read_marker(&git_dir.join("ORIG_HEAD")) {
                Ok((bytes, _)) => {
                    let oid = one_line(&bytes)?;
                    valid_oid(oid).then(|| oid.to_owned())
                }
                Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let mut message = None;
        let mut metadata_digest = Sha256::new();
        if kind == "merge" || kind == "cherryPick" {
            for name in if kind == "merge" {
                &["MERGE_MSG", "MERGE_MODE"][..]
            } else {
                &["MERGE_MSG"][..]
            } {
                metadata_digest.update(name.as_bytes());
                match read_marker(&git_dir.join(name)) {
                    Ok((bytes, _)) => {
                        metadata_digest.update((bytes.len() as u64).to_be_bytes());
                        metadata_digest.update(&bytes);
                        if *name == "MERGE_MSG" {
                            message = Some(String::from_utf8_lossy(&bytes).into_owned());
                        }
                    }
                    Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                        metadata_digest.update(b"absent")
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(GitIntegration {
            kind,
            message,
            metadata_digest: metadata_digest.finalize().to_vec(),
            target_oid,
            original_head,
            marker,
        })
    }

    async fn conflict_files(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<Vec<ConflictFile>> {
        let raw = self
            .read(
                &context.repository,
                args(&["ls-files", "--unmerged", "-z", "--"]),
                token,
            )
            .await?;
        let mut files = std::collections::BTreeMap::<String, ConflictFile>::new();
        let mut preview_budget = 1024 * 1024;
        for record in raw
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let split = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(malformed)?;
            let header = std::str::from_utf8(&record[..split])
                .map_err(|_| malformed())?
                .split_whitespace()
                .collect::<Vec<_>>();
            if header.len() != 3 || !valid_oid(header[1]) {
                return Err(malformed());
            }
            let name = std::str::from_utf8(&record[split + 1..]).map_err(|_| malformed())?;
            let path = Path::new(name);
            if path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err(malformed());
            }
            if files.len() >= 200 && !files.contains_key(name) {
                return Err(AppError::BadRequest(
                    "Too many conflict files for this view; inspect remaining conflicts with Git"
                        .into(),
                ));
            }
            let side = self
                .conflict_side(context, header[0], header[1], token, &mut preview_budget)
                .await?;
            let file = files.entry(name.into()).or_insert_with(|| ConflictFile {
                path: name.into(),
                base: None,
                ours: None,
                theirs: None,
            });
            let destination = match header[2] {
                "1" => &mut file.base,
                "2" => &mut file.ours,
                "3" => &mut file.theirs,
                _ => return Err(malformed()),
            };
            if destination.replace(side).is_some() {
                return Err(malformed());
            }
        }
        Ok(files.into_values().collect())
    }

    async fn conflict_side(
        &self,
        context: &RepositoryContext,
        mode: &str,
        oid: &str,
        token: &Cancellation,
        preview_budget: &mut u64,
    ) -> AppResult<ConflictSide> {
        if !matches!(mode, "100644" | "100755" | "120000" | "160000") {
            return Err(malformed());
        }
        let size = self
            .read(&context.repository, args(&["cat-file", "-s", oid]), token)
            .await?;
        let size = one_line(&size)?.parse::<u64>().map_err(|_| malformed())?;
        let mut side = ConflictSide {
            oid: oid.into(),
            mode: mode.into(),
            size,
            preview: String::new(),
            binary: None,
            truncated: size > MAX_PREVIEW || size > *preview_budget,
        };
        if !side.truncated && mode != "160000" {
            *preview_budget -= size;
            let bytes = self
                .read(&context.repository, args(&["cat-file", "blob", oid]), token)
                .await?;
            let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
            side.binary = Some(binary);
            if !binary {
                side.preview = String::from_utf8(bytes).map_err(|_| malformed())?;
            }
        }
        Ok(side)
    }
}

fn owns_integration(
    owner: &IntegrationOwner,
    actual: &GitIntegration,
    head: &ExpectedState,
) -> bool {
    actual.kind == owner.kind
        && owner.original == *head
        && actual.target_oid.as_ref() == Some(&owner.target_oid)
        && (owner.kind != "merge" || actual.original_head == owner.original.head_oid)
        && owner.marker.is_some()
        && owner.marker == actual.marker
}

fn read_marker(path: &Path) -> AppResult<(Vec<u8>, MarkerIdentity)> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(AppError::Conflict(
            "Git integration marker is not a bounded regular file".into(),
        ));
    }
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
    let mut file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() != metadata.len() {
        return Err(AppError::Conflict(
            "Git integration marker changed while reading".into(),
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err(AppError::Conflict(
                "Git integration marker became a reparse point".into(),
            ));
        }
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != opened.len() {
        return Err(AppError::Conflict(
            "Git integration marker changed while reading".into(),
        ));
    }
    let marker = MarkerIdentity {
        digest: Sha256::digest(&bytes).to_vec(),
        created: opened.created().ok(),
        modified: opened.modified().ok(),
        #[cfg(unix)]
        device_inode: {
            use std::os::unix::fs::MetadataExt;
            (opened.dev(), opened.ino())
        },
    };
    Ok((bytes, marker))
}

#[cfg(test)]
mod retention_tests {
    use super::*;

    fn record(id: &str, state: OperationState) -> Arc<Operation> {
        Arc::new(Operation {
            snapshot: Mutex::new(OperationSnapshot {
                id: id.into(),
                repository_id: "repository".into(),
                workspace_root: "/workspace".into(),
                repository_path: "/workspace/repo".into(),
                action: RepositoryAction::CreateBranch {
                    name: "example".into(),
                    start_point: None,
                    switch: false,
                },
                state,
                cancellation_requested: false,
                created_at: "observed".into(),
                finished_at: Some("observed".into()),
                message: None,
            }),
            cancellation: Cancellation::default(),
            mutation_started: Arc::new(AtomicBool::new(false)),
            awaiting_resolution: AtomicBool::new(false),
        })
    }

    #[test]
    fn live_owner_reference_survives_history_eviction_without_reordering_records() {
        let mut registry = HashMap::new();
        let mut order = VecDeque::new();
        for number in 0..MAX_OPERATIONS {
            let id = number.to_string();
            registry.insert(
                id.clone(),
                record(
                    &id,
                    if number == 0 {
                        OperationState::AwaitingResolution
                    } else {
                        OperationState::Succeeded
                    },
                ),
            );
            order.push_back(id);
        }
        let protected = std::collections::HashSet::from(["0".to_owned()]);
        reserve_operation_slot(&mut registry, &mut order, &protected, false).unwrap();
        assert!(registry.contains_key("0"));
        assert!(!registry.contains_key("1"));
        assert_eq!(order.front().map(String::as_str), Some("0"));
        assert_eq!(order.get(1).map(String::as_str), Some("2"));
        assert_eq!(registry.len(), MAX_OPERATIONS - 1);
        // Once reconciliation releases that owner, it is an ordinary terminal
        // history item and no longer permanently consumes a registry slot.
        registry.insert("new".into(), record("new", OperationState::Succeeded));
        order.push_back("new".into());
        reserve_operation_slot(&mut registry, &mut order, &Default::default(), false).unwrap();
        assert!(!registry.contains_key("0"));
    }

    #[test]
    fn a_full_registry_of_live_owners_keeps_bounded_recovery_capacity() {
        let mut registry = HashMap::new();
        let mut order = VecDeque::new();
        let mut protected = std::collections::HashSet::new();
        for number in 0..MAX_OPERATIONS {
            let id = number.to_string();
            registry.insert(id.clone(), record(&id, OperationState::AwaitingResolution));
            order.push_back(id.clone());
            protected.insert(id);
        }
        assert!(reserve_operation_slot(&mut registry, &mut order, &protected, false).is_err());
        for number in 0..16 {
            reserve_operation_slot(&mut registry, &mut order, &protected, true).unwrap();
            let id = format!("recovery-{number}");
            registry.insert(id.clone(), record(&id, OperationState::Queued));
            order.push_back(id);
        }
        assert!(reserve_operation_slot(&mut registry, &mut order, &protected, true).is_err());
        assert!(protected.iter().all(|id| registry.contains_key(id)));
    }
}
