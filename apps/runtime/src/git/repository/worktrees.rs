//! Linked worktrees: listing them and preparing the directories a new one
//! may be created in.

use super::*;

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

/// What a Frame says its worktree is (Git 设计 §5.1 `FrameBinding`).
///
/// The binding is *a record about a checkout that already exists*, never the
/// checkout itself, so everything in it can drift: the directory can be removed
/// by an external `git worktree remove`, the branch can be switched, the
/// repository can be re-cloned somewhere else. This is the request that asks
/// whether it still describes anything.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBindingRequest {
    /// The checkout the Frame is bound to, workspace-relative or absolute on
    /// this execution host.
    pub worktree_path: String,
    /// The branch the binding recorded. Absent means the binding never claimed
    /// one, which is a valid binding to a detached checkout.
    #[serde(default)]
    pub branch: Option<String>,
    /// The repository id the binding recorded — SHA-256 of the canonical common
    /// git dir. Absent means the binding predates the field.
    #[serde(default)]
    pub repository_id: Option<String>,
}

/// The verdict, with a reason rather than a boolean.
///
/// "The path left the workspace", "the checkout is gone" and "somebody switched
/// the branch" are three different things for a person to fix, and a badge that
/// only knew "invalid" would offer the same repair for all three. `valid` is
/// still there because the common case is a caller that only wants to know
/// whether to show the badge at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBindingVerdict {
    pub valid: bool,
    /// `ok`, `pathMissing`, `notAWorktree`, `repositoryMismatch` or
    /// `branchChanged`. A path outside the workspace root is not one of these:
    /// it is refused before the repository is read at all, because that is a
    /// statement about what this workspace may address rather than an
    /// observation about a checkout.
    pub code: String,
    /// The path as this host resolved it, workspace-relative.
    pub worktree_path: String,
    /// The same path, absolute — what a terminal's `cwd` needs.
    pub absolute_path: String,
    pub repository_id: String,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
}

impl RepositoryService {
    /// Whether a Frame's worktree binding still names a checkout of the
    /// repository it claims (Git 设计 §5.1, §5.3).
    ///
    /// The path is resolved against the workspace root first and a path that
    /// escapes it is refused, not reported — the same refusal every other Git
    /// read makes, for the same reason: a directory outside the registered root
    /// is one this workspace's grants never covered, and answering questions
    /// about it would be this service choosing what it may look at.
    pub async fn verify_worktree_binding(
        &self,
        workspace_root: &Path,
        request: &WorktreeBindingRequest,
    ) -> AppResult<WorktreeBindingVerdict> {
        crate::git::access::require_execution(self.allow_helpers, "Git worktree binding check")?;
        let workspace_root = canonical_directory(workspace_root)?;
        let requested = request.worktree_path.trim();
        if requested.is_empty() {
            return Err(AppError::BadRequest(
                "A worktree binding names no path".into(),
            ));
        }
        // Absolute and relative spellings both occur: a terminal's `cwd` is
        // absolute and the discovery record's `repositoryPath` is relative, and
        // both end up on a binding.
        let relative = if Path::new(requested).is_absolute() {
            let candidate = canonical_directory(requested).map_err(|_| {
                AppError::NotFound("The bound worktree directory does not exist".into())
            })?;
            candidate
                .strip_prefix(&workspace_root)
                .map_err(|_| {
                    AppError::Forbidden("The bound worktree is outside the workspace".into())
                })?
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            requested.to_owned()
        };
        let relative = if relative.is_empty() {
            ".".to_owned()
        } else {
            relative
        };
        // `resolve_in_root` is the refusal for a relative path that climbs out.
        let absolute = match resolve_in_root(&workspace_root, &relative) {
            Ok(path) => path,
            Err(AppError::Forbidden(message)) => return Err(AppError::Forbidden(message)),
            Err(error) => return Err(error),
        };
        let context = match self.context(&workspace_root, &relative).await {
            Ok(context) => context,
            // Not a repository any more, or the directory is gone. Both are the
            // same repair for the person looking at the badge: the checkout the
            // Frame was bound to is not there.
            Err(AppError::BadRequest(_)) | Err(AppError::NotFound(_)) => {
                return Ok(WorktreeBindingVerdict {
                    valid: false,
                    code: "pathMissing".into(),
                    worktree_path: relative,
                    absolute_path: absolute.to_string_lossy().into_owned(),
                    repository_id: String::new(),
                    branch: None,
                    head_oid: None,
                    is_main: false,
                    locked: false,
                    prunable: false,
                });
            }
            Err(error) => return Err(error),
        };
        let repository_id = context.repository_id();
        let records = self
            .worktree_records(&context, &Cancellation::default())
            .await?;
        // Git prints absolute paths; the binding may hold either spelling and
        // may have been written before a symlinked root was resolved. Both
        // sides are canonicalized before they are compared, which is the same
        // rule the Worker frame uses for a repository path.
        let target = absolute.canonicalize().unwrap_or_else(|_| absolute.clone());
        let found = records.into_iter().find(|record| {
            let path = Path::new(&record.path);
            path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) == target
        });
        let Some(record) = found else {
            return Ok(WorktreeBindingVerdict {
                valid: false,
                code: "notAWorktree".into(),
                worktree_path: relative,
                absolute_path: target.to_string_lossy().into_owned(),
                repository_id,
                branch: None,
                head_oid: None,
                is_main: false,
                locked: false,
                prunable: false,
            });
        };
        let code = if request
            .repository_id
            .as_deref()
            .is_some_and(|claimed| claimed != repository_id)
        {
            "repositoryMismatch"
        } else if request
            .branch
            .as_deref()
            .is_some_and(|claimed| record.branch.as_deref() != Some(claimed))
        {
            "branchChanged"
        } else {
            "ok"
        };
        Ok(WorktreeBindingVerdict {
            valid: code == "ok",
            code: code.into(),
            worktree_path: relative,
            absolute_path: target.to_string_lossy().into_owned(),
            repository_id,
            branch: record.branch,
            head_oid: record.head_oid,
            is_main: record.is_main,
            locked: record.locked,
            prunable: record.prunable,
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

    pub(super) async fn worktree_records(
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
}

pub(super) fn new_worktree_path(
    context: &RepositoryContext,
    requested: &str,
) -> AppResult<PathBuf> {
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

pub(super) struct CreatedParents(Vec<PathBuf>);
impl Drop for CreatedParents {
    fn drop(&mut self) {
        // Only empty directories this invocation created; never recurse/delete
        // a partial checkout or anything another process has added.
        for directory in self.0.iter().rev() {
            let _ = std::fs::remove_dir(directory);
        }
    }
}

pub(super) fn create_worktree_parents(
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
                // The only mutation is the Unix-only `mode` below.
                #[cfg_attr(not(unix), allow(unused_mut))]
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

pub(super) fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

pub(super) fn protect_nested_worktree(
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
