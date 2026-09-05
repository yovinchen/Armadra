//! Staging, unstaging, conflict resolution and restoring paths.

use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    pub staged: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub reverted: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnstageResult {
    pub unstaged: Vec<String>,
}

/// `git restore --staged -- <paths>`: drops the index entry back to HEAD and
/// leaves the working tree alone, so nothing the user typed is ever lost.
///
/// Before the first commit there is no HEAD to restore from, so a freshly added
/// file is removed from the index instead (`--ignore-unmatch` keeps a path that
/// was never staged from turning into an error).
pub fn unstage_paths(
    workspace_root: &Path,
    requested: &str,
    paths: &[String],
) -> AppResult<UnstageResult> {
    let context = require_repository(workspace_root, requested)?;
    let requested = prepare_paths(&context, paths)?;
    let unstaged: Vec<String> = requested
        .into_iter()
        .map(|(relative, _)| relative)
        .collect();
    let has_head = git(
        &context.repository,
        &["rev-parse", "--verify", "-q", "HEAD"],
    )
    .is_ok();
    let mut args = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-q", "--ignore-unmatch", "--"]
    };
    args.extend(unstaged.iter().map(String::as_str));
    git(&context.repository, &args)?;
    Ok(UnstageResult { unstaged })
}

/// `git add -- <paths>`. Every path must be a workspace-relative regular file
/// inside the authorized root (or a tracked path that was deleted on disk).
pub fn stage_paths(
    workspace_root: &Path,
    requested: &str,
    paths: &[String],
) -> AppResult<StageResult> {
    let context = require_repository(workspace_root, requested)?;
    let requested = prepare_paths(&context, paths)?;
    let mut staged = Vec::with_capacity(requested.len());
    for (relative, absolute) in &requested {
        match std::fs::symlink_metadata(absolute) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(AppError::Forbidden(
                        "Only regular files inside the workspace can be staged".into(),
                    ));
                }
            }
            Err(_) => {
                if !is_tracked(&context, relative)? {
                    return Err(AppError::NotFound(
                        "Requested path does not exist in the workspace".into(),
                    ));
                }
            }
        }
        staged.push(relative.clone());
    }
    if !staged.is_empty() {
        let mut args = vec!["add", "--"];
        args.extend(staged.iter().map(String::as_str));
        git(&context.repository, &args)?;
    }
    Ok(StageResult { staged })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub resolved: Vec<String>,
}

/// The largest file this scan will read before refusing to judge it resolved.
const MAX_RESOLVE_SCAN: u64 = 16 * 1024 * 1024;

/// Explicitly mark conflicted paths resolved: `git add -- <paths>`, but only
/// after each file has been read back and no longer contains a conflict marker
/// (plan §4.3 — saving a file never marks it resolved on its own).
///
/// A file that still has markers is refused with the exact lines, so the caller
/// can go back to them instead of staging a half-merged result.
pub fn mark_resolved(
    workspace_root: &Path,
    requested: &str,
    paths: &[String],
) -> AppResult<ResolveResult> {
    let context = require_repository(workspace_root, requested)?;
    let requested = prepare_paths(&context, paths)?;
    let mut resolved = Vec::with_capacity(requested.len());
    for (relative, absolute) in &requested {
        let unmerged = git(
            &context.repository,
            &["ls-files", "--unmerged", "-z", "--", relative],
        )?;
        if unmerged.is_empty() {
            return Err(AppError::BadRequest(format!(
                "{relative} is not a conflicted path in this index"
            )));
        }
        let metadata = std::fs::symlink_metadata(absolute).map_err(|_| {
            AppError::NotFound(format!(
                "{relative} has no resolved content on disk; delete or restore it with Git first"
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AppError::Forbidden(
                "Only regular files can be marked resolved".into(),
            ));
        }
        if metadata.len() > MAX_RESOLVE_SCAN {
            return Err(AppError::BadRequest(format!(
                "{relative} is too large to check for conflict markers"
            )));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(absolute)?
            .take(MAX_RESOLVE_SCAN)
            .read_to_end(&mut bytes)?;
        let markers = conflict_marker_lines(&bytes);
        if !markers.is_empty() {
            let shown = markers
                .iter()
                .take(20)
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            let more = if markers.len() > 20 {
                format!(" (and {} more)", markers.len() - 20)
            } else {
                String::new()
            };
            return Err(AppError::Conflict(format!(
                "{relative} still contains conflict markers on line(s) {shown}{more}; resolve them before marking it resolved"
            )));
        }
        resolved.push(relative.clone());
    }
    let mut args = vec!["add", "--"];
    args.extend(resolved.iter().map(String::as_str));
    git(&context.repository, &args)?;
    Ok(ResolveResult { resolved })
}

/// 1-based line numbers holding a Git conflict marker. Bytes are scanned
/// directly so a binary or non-UTF-8 file is still checked rather than refused.
pub fn conflict_marker_lines(bytes: &[u8]) -> Vec<u64> {
    let mut lines = Vec::new();
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.len() < 7 {
            continue;
        }
        let marker = line[0];
        // Git writes exactly seven of `<`, `|`, `=` or `>`, followed by end of
        // line or a space and the side's label.
        if matches!(marker, b'<' | b'|' | b'=' | b'>')
            && line[..7].iter().all(|byte| *byte == marker)
            && (line.len() == 7 || line[7] == b' ')
        {
            lines.push(index as u64 + 1);
        }
    }
    lines
}

/// Which version a restore takes the file back to. The two are deliberately
/// separate actions, because they lose different work (plan §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreSource {
    /// `git checkout -- <path>`: the working tree returns to what is staged.
    /// A staged change survives; only the unstaged edit on top of it is lost.
    #[default]
    Index,
    /// `git restore --source=HEAD --staged --worktree -- <path>`: the file
    /// returns to the committed version and its staged change is dropped too.
    Head,
}

/// Tracked paths are restored from the requested source; untracked regular
/// files are deleted either way. Directories and symlinks are refused.
///
/// Restoring from HEAD also unstages, which is the whole difference from the
/// index restore: the caller has to pick which of the two losses it wants.
pub fn revert_paths(
    workspace_root: &Path,
    requested: &str,
    paths: &[String],
    source: RestoreSource,
) -> AppResult<RevertResult> {
    let context = require_repository(workspace_root, requested)?;
    let requested = prepare_paths(&context, paths)?;
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for (relative, absolute) in &requested {
        if let Ok(metadata) = std::fs::symlink_metadata(absolute)
            && (metadata.file_type().is_symlink() || metadata.is_dir())
        {
            return Err(AppError::Forbidden(
                "Only regular files can be reverted".into(),
            ));
        }
        if is_tracked(&context, relative)? {
            tracked.push(relative.clone());
        } else if absolute.exists() {
            untracked.push((relative.clone(), absolute.clone()));
        }
    }
    let mut reverted = Vec::new();
    if !tracked.is_empty() {
        let mut args = match source {
            RestoreSource::Index => vec!["checkout", "--"],
            RestoreSource::Head => {
                // Before the first commit there is no HEAD to restore from,
                // and refusing is better than pretending the index is HEAD.
                if git(
                    &context.repository,
                    &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
                )
                .is_err()
                {
                    return Err(AppError::Conflict(
                        "This branch has no commit to restore these files from".into(),
                    ));
                }
                vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"]
            }
        };
        args.extend(tracked.iter().map(String::as_str));
        git(&context.repository, &args)?;
        reverted.extend(tracked);
    }
    for (relative, absolute) in untracked {
        std::fs::remove_file(&absolute)?;
        reverted.push(relative);
    }
    reverted.sort();
    Ok(RevertResult { reverted })
}
