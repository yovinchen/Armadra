//! Explicit integration state. Ownership is deliberately local to this service
//! lifetime; a restarted Runtime never claims an external Git sequence.
use super::*;

mod cherry_pick;
mod merge;
mod rebase;
mod snapshot;
#[cfg(test)]
mod tests;

pub use cherry_pick::CherryPickPreview;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Recovery {
    Continue,
    Abort,
    Skip,
}

const MAX_PREVIEW: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub oid: String,
    pub mode: String,
    pub size: u64,
    pub preview: String,
    pub binary: Option<bool>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub base: Option<ConflictSide>,
    pub ours: Option<ConflictSide>,
    pub theirs: Option<ConflictSide>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// The branch a paused sequence returns to. A rebase detaches HEAD, so the
    /// current head alone cannot show where the work belongs.
    pub original_branch: Option<String>,
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
    /// `refs/heads/<branch>` recorded by an in-progress rebase; None otherwise.
    head_name: Option<String>,
    marker: Option<MarkerIdentity>,
}

impl RepositoryService {
    pub async fn integration_status(
        &self,
        root: &Path,
        requested: &str,
    ) -> AppResult<IntegrationSnapshot> {
        crate::git::access::require_execution(
            self.allow_helpers,
            "Git integration worktree state",
        )?;
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
}

/// A rebase deliberately moves HEAD between steps, so ownership is bound to the
/// recorded start point and branch instead of the live head. Every other kind
/// keeps the stricter "HEAD has not moved at all" rule.
fn owns_integration(
    owner: &IntegrationOwner,
    actual: &GitIntegration,
    head: &ExpectedState,
) -> bool {
    let rebase = owner.kind == "rebase";
    actual.kind == owner.kind
        && (rebase || owner.original == *head)
        && actual.target_oid.as_ref() == Some(&owner.target_oid)
        && (!matches!(owner.kind, "merge" | "rebase")
            || actual.original_head == owner.original.head_oid)
        && (!rebase
            || actual.head_name
                == owner
                    .original
                    .branch
                    .as_ref()
                    .map(|branch| format!("refs/heads/{branch}")))
        && owner.marker.is_some()
        && owner.marker == actual.marker
}

fn optional_marker(path: &Path) -> AppResult<Option<(Vec<u8>, MarkerIdentity)>> {
    match read_marker(path) {
        Ok(value) => Ok(Some(value)),
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn marker_oid(bytes: &[u8]) -> Option<String> {
    let ids = std::str::from_utf8(bytes).ok()?;
    match ids.split_whitespace().collect::<Vec<_>>().as_slice() {
        [oid] if valid_oid(oid) => Some((*oid).to_owned()),
        _ => None,
    }
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
