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

impl RepositoryService {
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
