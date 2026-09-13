use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

pub(crate) mod access;
pub mod api;
mod clone;
mod command;
mod commit;
mod diff;
pub mod discovery;
pub mod hunks;
pub mod message;
pub mod repository;
mod stage;
mod status;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    security::{
        canonical_directory, prepare_new_directory, resolve_in_root, valid_directory_name,
        workspace_relative_path,
    },
};

pub use self::clone::{
    CloneStarted, CloneState, CloneStatus, active_clone_count, cancel_clone, clone_directory_name,
    clone_status, start_clone, start_clone_from, validate_clone_url,
};
pub use self::commit::{
    AmendRequest, CommitResult, HeadCommit, InitResult, commit, head_commit, init_repository,
};
pub use self::diff::{
    DiffRequest, DiffScope, GitDiff, GitFileDiff, read_diff, read_diff_with_execution,
};
pub use self::stage::{
    ResolveResult, RestoreSource, RevertResult, StageResult, UnstageResult, conflict_marker_lines,
    mark_resolved, revert_paths, stage_paths, unstage_paths,
};
pub use self::status::{
    GitFileStatus, GitStatus, StatusBatchEntry, StatusBatchFailure, StatusBatchRequest,
    StatusBatchResponse, dirty_entry_count, normalize_file_status, parse_porcelain_z, read_status,
    read_status_at, read_status_batch, read_status_filtered,
};

const MAX_PATHS_PER_REQUEST: usize = 200;
/// Display-only diff option; never used on a path that gets staged or applied.
const IGNORE_WHITESPACE: &str = "--ignore-all-space";

/// Repository context for one request: the authorized workspace root, the Git
/// repository root (guaranteed to live inside the workspace root) and the
/// pathspec of the requested directory relative to the repository.
pub struct RepoContext {
    pub workspace_root: PathBuf,
    pub repository: PathBuf,
    pub pathspec: String,
}

fn repo_context(workspace_root: &Path, requested: &str) -> AppResult<Option<RepoContext>> {
    repo_context_with_execution(workspace_root, requested, true)
}
fn repo_context_with_execution(
    workspace_root: &Path,
    requested: &str,
    execute: bool,
) -> AppResult<Option<RepoContext>> {
    let workspace_root = canonical_directory(workspace_root)?;
    let requested_directory = resolve_in_root(&workspace_root, requested)?;
    if !requested_directory.is_dir() {
        return Err(AppError::BadRequest("Git path must be a directory".into()));
    }
    let mut process = command::git_command();
    process
        .args(access::arguments(
            vec!["rev-parse".into(), "--is-inside-work-tree".into()],
            execute,
        )?)
        .current_dir(&requested_directory);
    if !execute {
        access::restrict_sync(&mut process);
    }
    let inside = command::run(process, Duration::from_secs(30))?;
    if !inside.status.success() {
        let error = String::from_utf8_lossy(&inside.stderr);
        if error.contains("not a git repository") {
            return Ok(None);
        }
        return Err(AppError::Internal(command::sanitize(&error)));
    }
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return Ok(None);
    }
    let repository = git_with_execution(
        &requested_directory,
        &["rev-parse", "--show-toplevel"],
        execute,
    )?;
    let repository = crate::paths::canonicalize(Path::new(
        repository.strip_suffix('\n').unwrap_or(&repository),
    ))
    .map_err(|_| AppError::Internal("Git repository root cannot be resolved".into()))?;
    if repository != workspace_root && !repository.starts_with(&workspace_root) {
        return Err(AppError::Forbidden(
            "Git repository root is outside the authorized workspace".into(),
        ));
    }
    let pathspec = requested_directory
        .strip_prefix(&repository)
        .map_err(|_| AppError::Forbidden("Git path is outside the repository".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Some(RepoContext {
        workspace_root,
        repository,
        pathspec,
    }))
}

fn status_entries(repository: &Path, pathspecs: &[String]) -> AppResult<Vec<GitFileStatus>> {
    let mut args = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    if !pathspecs.is_empty() {
        args.push("--");
        args.extend(pathspecs.iter().map(String::as_str));
    }
    Ok(parse_porcelain_z(&git(repository, &args)?))
}

fn workspace_relative_root(repository: &Path) -> AppResult<String> {
    repository
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::BadRequest("Git path is not valid UTF-8".into()))
}

/// The repository that owns `requested` — a workspace-relative directory, `.`
/// for the workspace root. A multi-repository workspace addresses one checkout
/// this way (roadmap §4.1); every path in the request is then relative to
/// *that* repository, which is what `read_status` already reports.
fn require_repository(workspace_root: &Path, requested: &str) -> AppResult<RepoContext> {
    repo_context(workspace_root, requested)?
        .ok_or_else(|| AppError::BadRequest("The workspace is not a Git repository".into()))
}

fn is_tracked(context: &RepoContext, relative: &str) -> AppResult<bool> {
    let output = git(&context.repository, &["ls-files", "--", relative])?;
    Ok(!output.trim().is_empty())
}

/// The pathspec list a read may narrow itself with, checked before it becomes
/// Git arguments.
///
/// It is a *filter*, so unlike [`prepare_paths`] nothing here has to exist: a
/// panel narrowing its Changes list to a directory that was just deleted is
/// asking a legitimate question with an empty answer. What is refused is a
/// spelling that would stop being a path — an absolute one, one that climbs out
/// of the repository, or one Git would read as an option because it starts with
/// a dash. Every entry is passed after `--`, so it can only ever be a pathspec.
pub fn valid_pathspecs(paths: &[String]) -> AppResult<Vec<String>> {
    if paths.len() > MAX_PATHS_PER_REQUEST {
        return Err(AppError::BadRequest(
            "At most 200 pathspecs may be supplied".into(),
        ));
    }
    let mut prepared = Vec::with_capacity(paths.len());
    for requested in paths {
        let value = requested.trim();
        if value.is_empty() {
            continue;
        }
        if value.starts_with('-') {
            return Err(AppError::BadRequest(
                "A pathspec must not start with a dash".into(),
            ));
        }
        prepared.push(workspace_relative_path(value)?);
    }
    Ok(prepared)
}

/// Reject absolute paths, `..` traversal, and paths whose closest existing
/// ancestor resolves outside the authorized workspace (symlinked directories).
fn prepare_paths(context: &RepoContext, paths: &[String]) -> AppResult<Vec<(String, PathBuf)>> {
    if paths.is_empty() || paths.len() > MAX_PATHS_PER_REQUEST {
        return Err(AppError::BadRequest(
            "Between one and 200 paths must be supplied".into(),
        ));
    }
    let mut prepared = Vec::with_capacity(paths.len());
    for requested in paths {
        let relative = workspace_relative_path(requested)?;
        let absolute = context.repository.join(&relative);
        let mut ancestor = absolute.as_path();
        let existing = loop {
            match ancestor.parent() {
                Some(parent) if !ancestor.exists() => ancestor = parent,
                _ => break ancestor,
            }
        };
        let canonical = crate::paths::canonicalize(existing)
            .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?;
        if !canonical.starts_with(&context.workspace_root)
            || !canonical.starts_with(&context.repository)
        {
            return Err(AppError::Forbidden(
                "Requested path is outside the authorized workspace".into(),
            ));
        }
        prepared.push((relative, absolute));
    }
    Ok(prepared)
}

/// Explicit Runtime shutdown: reject new legacy Git/clone commands and await
/// owned child cleanup. Normal caller cancellation never releases process ownership.
pub async fn shutdown_legacy_operations(timeout: Duration) -> AppResult<()> {
    command::shutdown(timeout).await
}

fn git(directory: &Path, args: &[&str]) -> AppResult<String> {
    git_with_execution(directory, args, true)
}
fn git_with_execution(directory: &Path, args: &[&str], execute: bool) -> AppResult<String> {
    let mut process = command::git_command();
    process
        .args(access::arguments(
            args.iter().map(|arg| (*arg).to_owned()).collect(),
            execute,
        )?)
        .current_dir(directory);
    if !execute {
        access::restrict_sync(&mut process);
    }
    let output = command::run(process, Duration::from_secs(30))?;
    if !output.status.success() {
        return Err(AppError::Internal(command::sanitize(
            &String::from_utf8_lossy(&output.stderr),
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
