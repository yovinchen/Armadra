use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::File,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, Command, Stdio},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    security::{
        canonical_directory, prepare_new_directory, redact_secrets, resolve_in_root,
        valid_directory_name, workspace_relative_path,
    },
};

const MAX_PATHS_PER_REQUEST: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    /// Normalized to `M` / `A` / `D` / `R` / `?`.
    pub status: String,
    #[serde(skip)]
    pub untracked: bool,
    pub additions: u64,
    pub deletions: u64,
    pub patch: String,
    /// `false` when the file is listed but its content cannot be shown as a
    /// textual patch (binary or oversized untracked file). `patch` is then
    /// empty and must not be exported as part of a unified diff.
    pub previewable: bool,
    /// The patch comes from the index (`git diff --cached`) rather than the
    /// working tree. Mirrors the requested scope.
    pub staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub repository: bool,
    pub clean: bool,
    pub files: Vec<GitFileDiff>,
}

/// Which side of the index a diff is taken from (plan §3.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffScope {
    /// Unstaged edits plus untracked files — what `git diff` shows.
    #[default]
    Worktree,
    /// What `git diff --cached` shows. Untracked files never appear here.
    Staged,
}

/// Request shape for [`read_diff`].
#[derive(Debug, Clone, Default)]
pub struct DiffRequest {
    pub scope: DiffScope,
    /// Restricts the diff to these workspace-relative paths. Empty means "use
    /// the requested directory as the pathspec".
    pub paths: Vec<String>,
}

/// Repository context for one request: the authorized workspace root, the Git
/// repository root (guaranteed to live inside the workspace root) and the
/// pathspec of the requested directory relative to the repository.
pub struct RepoContext {
    pub workspace_root: PathBuf,
    pub repository: PathBuf,
    pub pathspec: String,
}

fn repo_context(workspace_root: &Path, requested: &str) -> AppResult<Option<RepoContext>> {
    let workspace_root = canonical_directory(workspace_root)?;
    let requested_directory = resolve_in_root(&workspace_root, requested)?;
    if !requested_directory.is_dir() {
        return Err(AppError::BadRequest("Git path must be a directory".into()));
    }
    let inside = git(
        &requested_directory,
        &["rev-parse", "--is-inside-work-tree"],
    );
    if !inside.is_ok_and(|output| output.trim() == "true") {
        return Ok(None);
    }
    let repository = git(&requested_directory, &["rev-parse", "--show-toplevel"])?;
    let repository = Path::new(repository.trim())
        .canonicalize()
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

/// Normalize a porcelain status code to the `M/A/D/R/?` set the UI renders.
pub fn normalize_file_status(raw: &str) -> String {
    let code = raw.trim();
    if code.starts_with('?') {
        return "?".to_owned();
    }
    for character in code.chars() {
        match character {
            'R' => return "R".to_owned(),
            'A' | 'C' => return "A".to_owned(),
            'D' => return "D".to_owned(),
            'M' | 'T' | 'U' => return "M".to_owned(),
            _ => {}
        }
    }
    "?".to_owned()
}

/// `GET /api/workspaces/{id}/git/diff?scope=&paths=`.
///
/// `scope` picks the side of the index: `worktree` is `git diff` plus untracked
/// files, `staged` is `git diff --cached` and never lists untracked files
/// (there is nothing staged about them).
pub fn read_diff(
    workspace_root: &Path,
    requested: &str,
    request: &DiffRequest,
) -> AppResult<GitDiff> {
    let Some(context) = repo_context(workspace_root, requested)? else {
        return Ok(GitDiff {
            repository: false,
            clean: true,
            files: vec![],
        });
    };
    let RepoContext {
        workspace_root,
        repository,
        pathspec,
    } = context;

    let pathspecs = if request.paths.is_empty() {
        if pathspec.is_empty() {
            vec![]
        } else {
            vec![pathspec]
        }
    } else {
        if request.paths.len() > MAX_PATHS_PER_REQUEST {
            return Err(AppError::BadRequest(
                "At most 200 paths can be diffed at once".into(),
            ));
        }
        request
            .paths
            .iter()
            .map(|path| workspace_relative_path(path))
            .collect::<AppResult<Vec<_>>>()?
    };

    let cached = request.scope == DiffScope::Staged;
    let mut files = BTreeMap::<String, GitFileDiff>::new();
    for (status, path) in diff_name_status(&repository, cached, &pathspecs)? {
        files.insert(
            path.clone(),
            GitFileDiff {
                path,
                status,
                untracked: false,
                additions: 0,
                deletions: 0,
                patch: String::new(),
                previewable: true,
                staged: cached,
            },
        );
    }
    if !cached {
        for entry in status_entries(&repository, &pathspecs)? {
            if entry.status == "?" && !files.contains_key(&entry.path) {
                files.insert(
                    entry.path.clone(),
                    GitFileDiff {
                        path: entry.path,
                        status: "?".to_owned(),
                        untracked: true,
                        additions: 0,
                        deletions: 0,
                        patch: String::new(),
                        previewable: true,
                        staged: false,
                    },
                );
            }
        }
    }

    for (additions, deletions, path) in diff_numstat(&repository, cached, &pathspecs)? {
        if let Some(file) = files.get_mut(&path) {
            file.additions += additions;
            file.deletions += deletions;
        }
    }

    for file in files.values_mut() {
        if !file.untracked {
            let path = file.path.clone();
            let mut args = vec!["diff"];
            if cached {
                args.push("--cached");
            }
            args.extend(["--", path.as_str()]);
            file.patch = git(&repository, &args)?.trim_end_matches('\n').to_owned();
        } else {
            // A single un-previewable untracked file (binary or oversized)
            // must not fail the whole scan; it is listed without a textual
            // patch instead.
            match read_untracked_file(&workspace_root, &repository, &file.path) {
                Ok(content) => {
                    file.additions = content.lines().count() as u64;
                    file.patch = content
                        .lines()
                        .take(400)
                        .map(|line| format!("+{line}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                // Symlinks / paths escaping the workspace stay hard errors.
                Err(AppError::BadRequest(reason)) => {
                    tracing::debug!(path = %file.path, %reason, "untracked file not previewable");
                    file.additions = 0;
                    file.patch.clear();
                    file.previewable = false;
                }
                Err(error) => return Err(error),
            }
        }
    }

    Ok(GitDiff {
        repository: true,
        clean: files.is_empty(),
        files: files.into_values().collect(),
    })
}

/// `git diff [--cached] --name-status -z` → `(status, path)`.
///
/// `-z` is what makes this safe: paths are emitted verbatim, so nothing has to
/// be un-quoted and a path containing a space, quote or newline still parses.
/// Renames and copies emit `R100\0<old>\0<new>\0`; the new path is the one the
/// UI addresses.
fn diff_name_status(
    repository: &Path,
    cached: bool,
    pathspecs: &[String],
) -> AppResult<Vec<(String, String)>> {
    let output = git(repository, &diff_args("--name-status", cached, pathspecs))?;
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    let mut entries = Vec::new();
    while let Some(code) = fields.next() {
        let renamed = code.starts_with('R') || code.starts_with('C');
        let Some(first) = fields.next() else { break };
        let path = if renamed {
            let Some(second) = fields.next() else { break };
            second
        } else {
            first
        };
        entries.push((normalize_file_status(code), path.to_owned()));
    }
    Ok(entries)
}

/// `git diff [--cached] --numstat -z` → `(additions, deletions, path)`.
///
/// Binary files are reported as `-\t-\t<path>`, which parses to `0 / 0`.
/// Renames put the paths in their own NUL fields and leave the inline path
/// empty (`1\t2\t\0<old>\0<new>\0`).
fn diff_numstat(
    repository: &Path,
    cached: bool,
    pathspecs: &[String],
) -> AppResult<Vec<(u64, u64, String)>> {
    let output = git(repository, &diff_args("--numstat", cached, pathspecs))?;
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    let mut entries = Vec::new();
    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, '\t');
        let additions = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let deletions = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let inline = parts.next().unwrap_or_default();
        let path = if inline.is_empty() {
            let _origin = fields.next();
            match fields.next() {
                Some(destination) => destination.to_owned(),
                None => break,
            }
        } else {
            inline.to_owned()
        };
        entries.push((additions, deletions, path));
    }
    Ok(entries)
}

fn diff_args<'a>(mode: &'a str, cached: bool, pathspecs: &'a [String]) -> Vec<&'a str> {
    let mut args = vec!["diff"];
    if cached {
        args.push("--cached");
    }
    args.extend([mode, "-z", "--"]);
    args.extend(pathspecs.iter().map(String::as_str));
    args
}

fn status_entries(repository: &Path, pathspecs: &[String]) -> AppResult<Vec<GitFileStatus>> {
    let mut args = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    if !pathspecs.is_empty() {
        args.push("--");
        args.extend(pathspecs.iter().map(String::as_str));
    }
    Ok(parse_porcelain_z(&git(repository, &args)?))
}

fn read_untracked_file(workspace_root: &Path, repository: &Path, path: &str) -> AppResult<String> {
    const MAX_UNTRACKED_PREVIEW: u64 = 1024 * 1024;
    let candidate = repository.join(path);
    let metadata = std::fs::symlink_metadata(&candidate)
        .map_err(|_| AppError::BadRequest("Untracked file cannot be inspected".into()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::Forbidden(
            "Untracked symlinks and special files are not previewed".into(),
        ));
    }
    if metadata.len() > MAX_UNTRACKED_PREVIEW {
        return Err(AppError::BadRequest(
            "Untracked file is too large to preview".into(),
        ));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| AppError::BadRequest("Untracked file cannot be resolved".into()))?;
    if !canonical.starts_with(workspace_root) || !canonical.starts_with(repository) {
        return Err(AppError::Forbidden(
            "Untracked file is outside the authorized workspace".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&canonical)?
        .take(MAX_UNTRACKED_PREVIEW)
        .read_to_end(&mut bytes)?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::BadRequest("Untracked binary files are not previewed".into()))
}

/// One row of `git status`, as the file tree and the source-control drawer
/// render it: a letter badge plus which side of the index changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    /// Normalized to `M` / `A` / `D` / `R` / `?`.
    pub status: String,
    /// `X` of the porcelain `XY` pair: the index differs from HEAD.
    pub staged: bool,
    /// `Y` of the porcelain `XY` pair: the working tree differs from the index.
    /// Untracked files count as unstaged.
    pub unstaged: bool,
}

/// Parse `git status --porcelain=v1 -z` output.
///
/// Each record is `XY <path>`, NUL-terminated. `X` is the index status and `Y`
/// the working-tree status; for renames and copies the origin path follows as
/// its own NUL-terminated field and is skipped — the UI addresses the
/// destination.
pub fn parse_porcelain_z(output: &str) -> Vec<GitFileStatus> {
    let mut fields = output.split('\0');
    let mut entries = Vec::new();
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let mut codes = record.chars();
        let index = codes.next().unwrap_or(' ');
        let worktree = codes.next().unwrap_or(' ');
        let path = record[3..].to_owned();
        if index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C' {
            let _origin = fields.next();
        }
        // `!!` only appears with --ignored, which we never pass; skip it anyway
        // so an ignored file can never be rendered as a change.
        if index == '!' || worktree == '!' {
            continue;
        }
        entries.push(GitFileStatus {
            status: normalize_file_status(&record[..2]),
            path,
            staged: index != ' ' && index != '?',
            unstaged: worktree != ' ',
        });
    }
    entries
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repository: bool,
    /// `null` on a detached HEAD or outside a repository.
    pub branch: Option<String>,
    pub changed_count: u64,
    // Only present when the branch tracks an upstream: plan §3 types these as
    // optional keys, so they are omitted rather than serialized as null.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<i64>,
    /// Per-file rows; empty outside a repository. This is the only source the
    /// file tree needs for its badges — it must not fetch a diff for them.
    pub files: Vec<GitFileStatus>,
}

/// `git status --porcelain=v2 --branch`, summarized for the top bar, plus the
/// per-file rows from a `--porcelain=v1 -z` pass.
pub fn read_status(workspace_root: &Path) -> AppResult<GitStatus> {
    let Some(context) = repo_context(workspace_root, ".")? else {
        return Ok(GitStatus {
            repository: false,
            branch: None,
            changed_count: 0,
            ahead: None,
            behind: None,
            files: vec![],
        });
    };
    let output = git(
        &context.repository,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let mut branch = None;
    let mut ahead = None;
    let mut behind = None;
    let mut changed_count = 0_u64;
    for line in output.lines() {
        if let Some(header) = line.strip_prefix("# ") {
            if let Some(head) = header.strip_prefix("branch.head ") {
                let head = head.trim();
                branch = (head != "(detached)").then(|| head.to_owned());
            } else if let Some(divergence) = header.strip_prefix("branch.ab ") {
                for token in divergence.split_whitespace() {
                    match token.chars().next() {
                        Some('+') => ahead = token[1..].parse::<i64>().ok(),
                        Some('-') => behind = token[1..].parse::<i64>().ok(),
                        _ => {}
                    }
                }
            }
            continue;
        }
        if line.starts_with(['1', '2', 'u', '?']) {
            changed_count += 1;
        }
    }
    Ok(GitStatus {
        repository: true,
        branch,
        changed_count,
        ahead,
        behind,
        files: status_entries(&context.repository, &[])?,
    })
}

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
pub fn unstage_paths(workspace_root: &Path, paths: &[String]) -> AppResult<UnstageResult> {
    let context = require_repository(workspace_root)?;
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
pub fn stage_paths(workspace_root: &Path, paths: &[String]) -> AppResult<StageResult> {
    let context = require_repository(workspace_root)?;
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

/// Tracked paths are restored with `git checkout -- <path>`; untracked regular
/// files are deleted. Directories and symlinks are refused.
pub fn revert_paths(workspace_root: &Path, paths: &[String]) -> AppResult<RevertResult> {
    let context = require_repository(workspace_root)?;
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
        let mut args = vec!["checkout", "--"];
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// Short hash of the commit that was just created.
    pub commit: String,
    pub committed: Vec<String>,
    pub summary: String,
}

/// `git commit -m <message> [-- <paths>]`.
///
/// With `paths` the listed files are staged first (through the same validation
/// as `stage_paths`, so nothing outside the authorized workspace can be
/// committed) and the commit is scoped to them. Without `paths` whatever is
/// already staged is committed.
pub fn commit(
    workspace_root: &Path,
    message: &str,
    paths: Option<&[String]>,
) -> AppResult<CommitResult> {
    let message = message.trim();
    if message.is_empty() || message.len() > 10_000 {
        return Err(AppError::BadRequest("Commit message is invalid".into()));
    }
    let context = require_repository(workspace_root)?;
    let committed = match paths {
        Some(paths) => stage_paths(workspace_root, paths)?.staged,
        None => vec![],
    };

    let mut args: Vec<&str> = vec!["commit", "-m", message];
    if !committed.is_empty() {
        args.push("--");
        args.extend(committed.iter().map(String::as_str));
    }
    let output = Command::new("git")
        .args(["-c", "core.quotepath=false"])
        .args(&args)
        .current_dir(&context.repository)
        .output()
        .map_err(|error| AppError::Internal(format!("Could not start Git: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        // "nothing to commit" is a user error, not a runtime failure.
        return Err(AppError::BadRequest(format!(
            "Git could not commit: {detail}"
        )));
    }
    let summary = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let commit = git(&context.repository, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_owned();
    Ok(CommitResult {
        commit,
        committed,
        summary,
    })
}

fn require_repository(workspace_root: &Path) -> AppResult<RepoContext> {
    repo_context(workspace_root, ".")?
        .ok_or_else(|| AppError::BadRequest("The workspace is not a Git repository".into()))
}

fn is_tracked(context: &RepoContext, relative: &str) -> AppResult<bool> {
    let output = git(&context.repository, &["ls-files", "--", relative])?;
    Ok(!output.trim().is_empty())
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
        let canonical = existing
            .canonicalize()
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

/* --------------------------------- clone ---------------------------------- */

/// A clone may not run forever: the job is killed and marked failed after this.
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Only the tail of `git clone --progress` is kept; the dialog shows one line.
const CLONE_MAX_LINES: usize = 20;
/// Finished jobs are dropped this long after they stop, so a dialog that is
/// still polling keeps getting an answer while the map does not grow forever.
const CLONE_RETENTION: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloneState {
    Running,
    Done,
    Error,
}

/// A snapshot of one clone job, handed to `GET /api/git/clone/{jobId}`.
#[derive(Debug, Clone)]
pub struct CloneStatus {
    pub state: CloneState,
    pub lines: Vec<String>,
    pub error: Option<String>,
    /// Where the repository landed; the workspace is created from it.
    pub target: PathBuf,
    /// The directory name, which becomes the workspace name.
    pub name: String,
}

struct CloneJob {
    state: CloneState,
    lines: VecDeque<String>,
    error: Option<String>,
    target: PathBuf,
    name: String,
    child: Arc<Mutex<Child>>,
    /// Set by `cancel_clone` so the reader thread reports a cancel, not a crash.
    cancelled: bool,
    finished_at: Option<Instant>,
}

/// Process-wide registry. Clone jobs exist before any workspace does, so they
/// cannot hang off the per-workspace event hub; the dialog polls instead.
static CLONE_JOBS: LazyLock<Mutex<HashMap<String, CloneJob>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn jobs() -> std::sync::MutexGuard<'static, HashMap<String, CloneJob>> {
    CLONE_JOBS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Characters a repository URL may contain. Git never sees a shell here, but
/// the allowlist also rules out the argument- and CRLF-injection shapes.
fn clone_url_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || "-._~:/@%+=,".contains(character)
}

/// Accept `https://host/path`, `ssh://[user@]host/path` and `user@host:path`
/// only. Anything else — `file://`, `http://`, `ext::`, a local path, a leading
/// dash — is refused (plan §20).
pub fn validate_clone_url(raw: &str) -> AppResult<String> {
    let url = raw.trim();
    let invalid = || AppError::BadRequest("Repository URL is invalid".into());
    if url.is_empty() || url.len() > 2_048 || !url.chars().all(clone_url_char) {
        return Err(invalid());
    }

    let rest = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        rest
    } else {
        // scp-like `user@host:path`; the `@` must come before the first `:`.
        let (user, remainder) = url.split_once('@').ok_or_else(invalid)?;
        let (host, path) = remainder.split_once(':').ok_or_else(invalid)?;
        if user.is_empty() || host.is_empty() || path.is_empty() || host.contains('/') {
            return Err(invalid());
        }
        return Ok(url.to_owned());
    };

    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => return Err(invalid()),
    };
    let host = authority.rsplit('@').next().unwrap_or_default();
    if host.is_empty() || path.is_empty() {
        return Err(invalid());
    }
    Ok(url.to_owned())
}

/// `https://host/o/repo.git` → `repo`. Used when the dialog leaves the folder
/// name empty.
pub fn clone_directory_name(url: &str) -> AppResult<String> {
    let tail = url.trim_end_matches('/');
    let tail = tail.rsplit(['/', ':']).next().unwrap_or_default();
    let name = tail.strip_suffix(".git").unwrap_or(tail);
    Ok(valid_directory_name(name)?.to_owned())
}

#[derive(Debug, Clone)]
pub struct CloneStarted {
    pub job_id: String,
    pub target: PathBuf,
}

/// Validate the request and spawn `git clone --progress` in the background.
///
/// Returns as soon as the child is running: the caller polls [`clone_status`]
/// and creates the workspace once the job reports `Done`.
pub fn start_clone(url: &str, parent: &str, name: Option<&str>) -> AppResult<CloneStarted> {
    let url = validate_clone_url(url)?;
    let name = match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => valid_directory_name(name)?.to_owned(),
        None => clone_directory_name(&url)?,
    };
    let target = prepare_new_directory(parent, &name)?;
    spawn_clone_job(&url, &name, target)
}

/// The half that actually runs Git, split out so tests can point it at a local
/// bare repository without loosening [`validate_clone_url`].
fn spawn_clone_job(url: &str, name: &str, target: PathBuf) -> AppResult<CloneStarted> {
    let mut child = Command::new("git")
        .args(["clone", "--progress", "--"])
        .arg(url)
        .arg(&target)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::Internal(format!("Could not start Git: {error}")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("Git produced no output stream".into()))?;

    let job_id = Uuid::now_v7().to_string();
    let child = Arc::new(Mutex::new(child));
    {
        let mut registry = jobs();
        registry.retain(|_, job| match job.finished_at {
            Some(at) => at.elapsed() < CLONE_RETENTION,
            None => true,
        });
        registry.insert(
            job_id.clone(),
            CloneJob {
                state: CloneState::Running,
                lines: VecDeque::new(),
                error: None,
                target: target.clone(),
                name: name.to_owned(),
                child: Arc::clone(&child),
                cancelled: false,
                finished_at: None,
            },
        );
    }

    spawn_clone_reader(job_id.clone(), stderr, Arc::clone(&child));
    spawn_clone_watchdog(job_id.clone(), child);

    Ok(CloneStarted { job_id, target })
}

/// `git clone --progress` separates progress updates with `\r` and finished
/// phases with `\n`, so both count as line breaks here.
fn spawn_clone_reader(job_id: String, stderr: ChildStderr, child: Arc<Mutex<Child>>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = Vec::new();
        let mut byte = [0_u8; 1];
        loop {
            match reader.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    if byte[0] == b'\r' || byte[0] == b'\n' {
                        push_clone_line(&job_id, &mut buffer);
                    } else if buffer.len() < 4_096 {
                        buffer.push(byte[0]);
                    }
                }
                Err(_) => break,
            }
        }
        push_clone_line(&job_id, &mut buffer);

        let status = child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .wait();
        let mut registry = jobs();
        let Some(job) = registry.get_mut(&job_id) else {
            return;
        };
        if job.state != CloneState::Running {
            return;
        }
        job.finished_at = Some(Instant::now());
        match status {
            Ok(status) if status.success() && !job.cancelled => job.state = CloneState::Done,
            Ok(_) => {
                job.state = CloneState::Error;
                if job.error.is_none() {
                    job.error = Some(
                        job.lines
                            .back()
                            .cloned()
                            .unwrap_or_else(|| "git clone failed".to_owned()),
                    );
                }
            }
            Err(error) => {
                job.state = CloneState::Error;
                job.error = Some(error.to_string());
            }
        }
    });
}

fn spawn_clone_watchdog(job_id: String, child: Arc<Mutex<Child>>) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + CLONE_TIMEOUT;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            {
                let registry = jobs();
                match registry.get(&job_id) {
                    Some(job) if job.state == CloneState::Running => {}
                    _ => return,
                }
            }
            if Instant::now() >= deadline {
                let _ = child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .kill();
                let mut registry = jobs();
                if let Some(job) = registry.get_mut(&job_id) {
                    job.cancelled = true;
                    job.error = Some("git clone timed out".to_owned());
                }
                return;
            }
        }
    });
}

fn push_clone_line(job_id: &str, buffer: &mut Vec<u8>) {
    if buffer.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(buffer).trim().to_owned();
    buffer.clear();
    if line.is_empty() {
        return;
    }
    let line = redact_secrets(&line);
    let mut registry = jobs();
    if let Some(job) = registry.get_mut(job_id) {
        if job.lines.len() == CLONE_MAX_LINES {
            job.lines.pop_front();
        }
        job.lines.push_back(line);
    }
}

pub fn clone_status(job_id: &str) -> AppResult<CloneStatus> {
    let registry = jobs();
    let job = registry
        .get(job_id)
        .ok_or_else(|| AppError::NotFound("That clone job is unknown".into()))?;
    Ok(CloneStatus {
        state: job.state,
        lines: job.lines.iter().cloned().collect(),
        error: job.error.clone(),
        target: job.target.clone(),
        name: job.name.clone(),
    })
}

/// Kill a running clone. The half-written directory is removed so the same
/// target can be retried straight away.
pub fn cancel_clone(job_id: &str) -> AppResult<()> {
    let (child, target) = {
        let mut registry = jobs();
        let job = registry
            .get_mut(job_id)
            .ok_or_else(|| AppError::NotFound("That clone job is unknown".into()))?;
        if job.state != CloneState::Running {
            return Ok(());
        }
        job.cancelled = true;
        job.error = Some("git clone cancelled".to_owned());
        (Arc::clone(&job.child), job.target.clone())
    };
    let _ = child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .kill();
    // The reader thread flips the state once the process is reaped; removing
    // the partial checkout here is best effort.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_dir_all(&target);
    });
    Ok(())
}

fn git(directory: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .current_dir(directory)
        .output()
        .map_err(|error| AppError::Internal(format!("Could not start Git: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn distinguishes_non_repository_and_changed_repository() {
        let root = tempdir().unwrap();
        assert!(
            !read_diff(root.path(), ".", &DiffRequest::default())
                .unwrap()
                .repository
        );

        Command::new("git")
            .args(["init", "-q"])
            .current_dir(root.path())
            .status()
            .unwrap();
        fs::write(root.path().join("new.txt"), "one\ntwo\n").unwrap();
        let diff = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
        assert!(diff.repository);
        assert!(!diff.clean);
        assert_eq!(diff.files[0].path, "new.txt");
        assert_eq!(diff.files[0].additions, 2);
    }

    #[test]
    fn rejects_repository_root_above_authorized_workspace() {
        let repository = tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(repository.path())
            .status()
            .unwrap();
        let workspace = repository.path().join("authorized");
        fs::create_dir(&workspace).unwrap();
        fs::write(repository.path().join("outside.txt"), "secret\n").unwrap();

        assert!(matches!(
            read_diff(&workspace, ".", &DiffRequest::default()),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn commits_only_the_requested_paths() {
        let root = tempdir().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "canvas@example.test"],
            vec!["config", "user.name", "Canvas"],
        ] {
            Command::new("git")
                .args(&args)
                .current_dir(root.path())
                .status()
                .unwrap();
        }
        fs::write(root.path().join("kept.txt"), "one\n").unwrap();
        fs::write(root.path().join("left.txt"), "two\n").unwrap();

        assert!(matches!(
            commit(root.path(), "   ", None),
            Err(AppError::BadRequest(_))
        ));
        // Nothing is staged yet, so an unscoped commit is refused.
        assert!(matches!(
            commit(root.path(), "empty", None),
            Err(AppError::BadRequest(_))
        ));

        let result = commit(root.path(), "add kept", Some(&["kept.txt".to_owned()])).unwrap();
        assert_eq!(result.committed, vec!["kept.txt".to_owned()]);
        assert!(!result.commit.is_empty());

        let status = read_status(root.path()).unwrap();
        assert_eq!(status.changed_count, 1, "left.txt must stay uncommitted");

        // Paths outside the workspace are refused before Git ever runs.
        assert!(commit(root.path(), "escape", Some(&["../outside.txt".to_owned()])).is_err());
    }

    #[test]
    fn supports_diff_scoped_to_nested_directory() {
        let root = tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(root.path())
            .status()
            .unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/new.txt"), "one\ntwo\n").unwrap();

        let diff = read_diff(root.path(), "src", &DiffRequest::default()).unwrap();
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "src/new.txt");
        assert_eq!(diff.files[0].additions, 2);
        assert!(diff.files[0].patch.contains("+one"));
    }

    #[test]
    fn accepts_only_the_three_supported_url_shapes() {
        for good in [
            "https://github.com/octocat/Hello-World.git",
            "https://user@example.test/team/repo",
            "ssh://git@example.test/team/repo.git",
            "git@example.test:team/repo.git",
        ] {
            assert!(validate_clone_url(good).is_ok(), "{good} must be accepted");
        }
        for bad in [
            "",
            "   ",
            "http://example.test/repo.git",
            "file:///tmp/repo.git",
            "ext::sh -c whoami",
            "/tmp/repo.git",
            "--upload-pack=touch /tmp/pwned",
            "https://example.test/repo.git; rm -rf /",
            "https://example.test/repo.git\nhost: evil",
            "https://example.test",
            "git@example.test",
            "https:///repo.git",
        ] {
            assert!(
                matches!(validate_clone_url(bad), Err(AppError::BadRequest(_))),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn derives_the_folder_name_from_the_url() {
        for (url, expected) in [
            ("https://github.com/octocat/Hello-World.git", "Hello-World"),
            ("https://example.test/team/repo/", "repo"),
            ("git@example.test:team/repo.git", "repo"),
            ("ssh://git@example.test/team/deep/repo", "repo"),
        ] {
            assert_eq!(clone_directory_name(url).unwrap(), expected);
        }
    }

    #[test]
    fn refuses_to_clone_over_an_existing_directory() {
        let parent = tempdir().unwrap();
        fs::create_dir(parent.path().join("Hello-World")).unwrap();
        assert!(matches!(
            start_clone(
                "https://github.com/octocat/Hello-World.git",
                parent.path().to_str().unwrap(),
                None,
            ),
            Err(AppError::Conflict(_))
        ));
        // A bad URL never reaches the filesystem either.
        assert!(matches!(
            start_clone(
                "file:///tmp/repo.git",
                parent.path().to_str().unwrap(),
                None
            ),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn clones_a_local_bare_repository_end_to_end() {
        let source = tempdir().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "canvas@example.test"],
            vec!["config", "user.name", "Canvas"],
        ] {
            Command::new("git")
                .args(&args)
                .current_dir(source.path())
                .status()
                .unwrap();
        }
        fs::write(source.path().join("README.md"), "hello\n").unwrap();
        commit_all(source.path(), "first");

        let bare = tempdir().unwrap();
        let bare_path = bare.path().join("fixture.git");
        Command::new("git")
            .args(["clone", "--bare", "-q"])
            .arg(source.path())
            .arg(&bare_path)
            .status()
            .unwrap();

        let destination = tempdir().unwrap();
        let target =
            prepare_new_directory(destination.path().to_str().unwrap(), "fixture").unwrap();
        let started =
            spawn_clone_job(bare_path.to_str().unwrap(), "fixture", target.clone()).unwrap();

        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            let status = clone_status(&started.job_id).unwrap();
            if status.state != CloneState::Running {
                break status;
            }
            assert!(Instant::now() < deadline, "clone did not finish");
            std::thread::sleep(Duration::from_millis(20));
        };

        assert_eq!(status.state, CloneState::Done, "{:?}", status.lines);
        assert_eq!(status.name, "fixture");
        assert!(target.join("README.md").exists());
        assert!(target.join(".git").is_dir());

        // An unknown job is a 404, and a finished one cannot be cancelled twice.
        assert!(matches!(clone_status("nope"), Err(AppError::NotFound(_))));
        assert!(cancel_clone(&started.job_id).is_ok());
    }

    #[test]
    fn preserves_unicode_paths() {
        let root = tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(root.path())
            .status()
            .unwrap();
        fs::write(root.path().join("需求说明.md"), "内容\n").unwrap();

        let diff = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
        assert_eq!(diff.files[0].path, "需求说明.md");
        assert!(diff.files[0].patch.contains("+内容"));
    }

    fn commit_all(root: &Path, message: &str) {
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "-m",
                message,
            ])
            .current_dir(root)
            .status()
            .unwrap();
    }

    fn init_repository(root: &Path) {
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(root)
            .status()
            .unwrap();
    }

    #[test]
    fn normalizes_porcelain_status_codes() {
        assert_eq!(normalize_file_status("??"), "?");
        assert_eq!(normalize_file_status(" M"), "M");
        assert_eq!(normalize_file_status("MM"), "M");
        assert_eq!(normalize_file_status("A "), "A");
        assert_eq!(normalize_file_status("AM"), "A");
        assert_eq!(normalize_file_status(" D"), "D");
        assert_eq!(normalize_file_status("R "), "R");
        assert_eq!(normalize_file_status("!!"), "?");
    }

    #[test]
    fn parses_porcelain_z_records() {
        // ` M` unstaged edit, `M ` staged edit, `MM` both, `??` untracked,
        // `R ` rename (origin path follows in its own field), `!!` ignored.
        let output = concat!(
            " M src/a.ts\0",
            "M  src/b.ts\0",
            "MM src/c.ts\0",
            "?? new file.ts\0",
            "R  dst.ts\0src.ts\0",
            "D  gone.ts\0",
            "!! build/out.js\0",
        );
        let entries = parse_porcelain_z(output);
        let by_path = |path: &str| {
            entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap_or_else(|| panic!("{path} missing"))
                .clone()
        };

        assert_eq!(entries.len(), 6, "the ignored entry is dropped");
        assert_eq!(
            by_path("src/a.ts"),
            GitFileStatus {
                path: "src/a.ts".into(),
                status: "M".into(),
                staged: false,
                unstaged: true,
            }
        );
        assert_eq!(
            by_path("src/b.ts"),
            GitFileStatus {
                path: "src/b.ts".into(),
                status: "M".into(),
                staged: true,
                unstaged: false,
            }
        );
        let both = by_path("src/c.ts");
        assert!(both.staged && both.unstaged);
        // A space in the path survives because `-z` never quotes.
        let untracked = by_path("new file.ts");
        assert_eq!(untracked.status, "?");
        assert!(!untracked.staged && untracked.unstaged);
        // The rename's origin field is consumed, not mistaken for a record.
        let renamed = by_path("dst.ts");
        assert_eq!(renamed.status, "R");
        assert!(renamed.staged);
        assert!(entries.iter().all(|entry| entry.path != "src.ts"));
        assert_eq!(by_path("gone.ts").status, "D");
    }

    #[test]
    fn reports_per_file_status_from_the_status_endpoint() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("kept.txt"), "one\n").unwrap();
        fs::write(root.path().join("edited.txt"), "one\n").unwrap();
        commit_all(root.path(), "initial");

        fs::write(root.path().join("edited.txt"), "two\n").unwrap();
        fs::write(root.path().join("added.txt"), "three\n").unwrap();
        stage_paths(root.path(), &["added.txt".to_owned()]).unwrap();
        fs::write(root.path().join("fresh.txt"), "four\n").unwrap();

        let status = read_status(root.path()).unwrap();
        assert_eq!(status.changed_count, 3);
        let file = |path: &str| {
            status
                .files
                .iter()
                .find(|entry| entry.path == path)
                .unwrap_or_else(|| panic!("{path} missing"))
        };
        assert_eq!(file("edited.txt").status, "M");
        assert!(!file("edited.txt").staged && file("edited.txt").unstaged);
        assert_eq!(file("added.txt").status, "A");
        assert!(file("added.txt").staged && !file("added.txt").unstaged);
        assert_eq!(file("fresh.txt").status, "?");
        assert!(status.files.iter().all(|entry| entry.path != "kept.txt"));
    }

    #[test]
    fn separates_worktree_and_staged_scopes() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
        commit_all(root.path(), "initial");

        fs::write(root.path().join("tracked.txt"), "two\n").unwrap();
        stage_paths(root.path(), &["tracked.txt".to_owned()]).unwrap();
        fs::write(root.path().join("tracked.txt"), "three\n").unwrap();
        fs::write(root.path().join("untracked.txt"), "new\n").unwrap();

        let worktree = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
        let staged = read_diff(
            root.path(),
            ".",
            &DiffRequest {
                scope: DiffScope::Staged,
                paths: vec![],
            },
        )
        .unwrap();

        // Untracked files only exist in the worktree scope.
        assert!(worktree.files.iter().any(|f| f.path == "untracked.txt"));
        assert!(staged.files.iter().all(|f| f.path != "untracked.txt"));

        let unstaged_patch = &worktree
            .files
            .iter()
            .find(|f| f.path == "tracked.txt")
            .unwrap()
            .patch;
        assert!(unstaged_patch.contains("+three"));
        assert!(!unstaged_patch.contains("+two"));

        let staged_file = staged
            .files
            .iter()
            .find(|f| f.path == "tracked.txt")
            .unwrap();
        assert!(staged_file.staged);
        assert!(staged_file.patch.contains("+two"));
        assert!(!staged_file.patch.contains("+three"));
        assert_eq!(staged_file.additions, 1);
        assert_eq!(staged_file.deletions, 1);
    }

    #[test]
    fn narrows_a_diff_to_the_requested_paths() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        fs::write(root.path().join("two.txt"), "two\n").unwrap();
        commit_all(root.path(), "initial");
        fs::write(root.path().join("one.txt"), "edited\n").unwrap();
        fs::write(root.path().join("two.txt"), "edited\n").unwrap();

        let diff = read_diff(
            root.path(),
            ".",
            &DiffRequest {
                scope: DiffScope::Worktree,
                paths: vec!["one.txt".to_owned()],
            },
        )
        .unwrap();
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "one.txt");

        assert!(matches!(
            read_diff(
                root.path(),
                ".",
                &DiffRequest {
                    scope: DiffScope::Worktree,
                    paths: vec!["../escape.txt".to_owned()],
                },
            ),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn reports_renames_with_the_destination_path() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("old name.txt"), "one\ntwo\nthree\n").unwrap();
        commit_all(root.path(), "initial");
        fs::rename(
            root.path().join("old name.txt"),
            root.path().join("new name.txt"),
        )
        .unwrap();
        stage_paths(root.path(), &["new name.txt".to_owned()]).unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root.path())
            .status()
            .unwrap();

        let staged = read_diff(
            root.path(),
            ".",
            &DiffRequest {
                scope: DiffScope::Staged,
                paths: vec![],
            },
        )
        .unwrap();
        assert!(staged.files.iter().any(|file| file.path == "new name.txt"));

        let status = read_status(root.path()).unwrap();
        let renamed = status
            .files
            .iter()
            .find(|entry| entry.path == "new name.txt")
            .expect("destination path listed");
        assert_eq!(renamed.status, "R");
        assert!(renamed.staged);
        assert!(
            status
                .files
                .iter()
                .all(|entry| entry.path != "old name.txt")
        );
    }

    #[test]
    fn unstages_without_touching_the_working_tree() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
        commit_all(root.path(), "initial");
        fs::write(root.path().join("tracked.txt"), "two\n").unwrap();
        stage_paths(root.path(), &["tracked.txt".to_owned()]).unwrap();
        assert!(
            read_status(root.path())
                .unwrap()
                .files
                .iter()
                .any(|entry| entry.path == "tracked.txt" && entry.staged)
        );

        let result = unstage_paths(root.path(), &["tracked.txt".to_owned()]).unwrap();
        assert_eq!(result.unstaged, vec!["tracked.txt".to_owned()]);
        let status = read_status(root.path()).unwrap();
        let entry = status
            .files
            .iter()
            .find(|entry| entry.path == "tracked.txt")
            .unwrap();
        assert!(!entry.staged && entry.unstaged);
        assert_eq!(
            fs::read_to_string(root.path().join("tracked.txt")).unwrap(),
            "two\n",
            "unstaging must never discard the edit"
        );

        assert!(matches!(
            unstage_paths(root.path(), &["../escape.txt".to_owned()]),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn unstages_a_new_file_before_the_first_commit() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("first.txt"), "one\n").unwrap();
        stage_paths(root.path(), &["first.txt".to_owned()]).unwrap();

        unstage_paths(root.path(), &["first.txt".to_owned()]).unwrap();
        let status = read_status(root.path()).unwrap();
        let entry = status
            .files
            .iter()
            .find(|entry| entry.path == "first.txt")
            .unwrap();
        assert_eq!(entry.status, "?");
        assert!(!entry.staged);
        assert!(root.path().join("first.txt").exists());
    }

    #[test]
    fn reads_branch_and_change_counts() {
        let root = tempdir().unwrap();
        assert!(!read_status(root.path()).unwrap().repository);

        init_repository(root.path());
        fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
        commit_all(root.path(), "initial");
        let clean = read_status(root.path()).unwrap();
        assert!(clean.repository);
        assert_eq!(clean.branch.as_deref(), Some("main"));
        assert_eq!(clean.changed_count, 0);
        assert_eq!(clean.ahead, None);
        assert_eq!(clean.behind, None);

        fs::write(root.path().join("tracked.txt"), "two\n").unwrap();
        fs::write(root.path().join("fresh.txt"), "new\n").unwrap();
        assert_eq!(read_status(root.path()).unwrap().changed_count, 2);
    }

    #[test]
    fn omits_divergence_keys_when_there_is_no_upstream() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
        commit_all(root.path(), "initial");

        let json = serde_json::to_value(read_status(root.path()).unwrap()).unwrap();
        assert_eq!(json["branch"], "main");
        assert_eq!(json["changedCount"], 0);
        assert!(json.get("ahead").is_none());
        assert!(json.get("behind").is_none());
    }

    #[test]
    fn stages_regular_files_and_refuses_traversal() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("seed.txt"), "seed\n").unwrap();
        commit_all(root.path(), "initial");
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/added.txt"), "added\n").unwrap();

        let staged = stage_paths(root.path(), &["src/added.txt".to_owned()]).unwrap();
        assert_eq!(staged.staged, vec!["src/added.txt".to_owned()]);
        // Staged and matching the worktree: it belongs to the `staged` scope
        // only, which is what the drawer's two sections rely on.
        assert!(
            read_diff(root.path(), ".", &DiffRequest::default())
                .unwrap()
                .files
                .is_empty()
        );
        let diff = read_diff(
            root.path(),
            ".",
            &DiffRequest {
                scope: DiffScope::Staged,
                paths: vec![],
            },
        )
        .unwrap();
        assert_eq!(diff.files[0].path, "src/added.txt");
        assert_eq!(diff.files[0].status, "A");
        assert!(diff.files[0].staged);

        assert!(matches!(
            stage_paths(root.path(), &["../escape.txt".to_owned()]),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            stage_paths(root.path(), &["/etc/hosts".to_owned()]),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            stage_paths(root.path(), &["src".to_owned()]),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            stage_paths(root.path(), &[]),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn reverts_tracked_edits_and_deletes_untracked_files() {
        let root = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("tracked.txt"), "original\n").unwrap();
        commit_all(root.path(), "initial");
        fs::write(root.path().join("tracked.txt"), "changed\n").unwrap();
        fs::write(root.path().join("untracked.txt"), "temporary\n").unwrap();

        let reverted = revert_paths(
            root.path(),
            &["tracked.txt".to_owned(), "untracked.txt".to_owned()],
        )
        .unwrap();
        assert_eq!(
            reverted.reverted,
            vec!["tracked.txt".to_owned(), "untracked.txt".to_owned()]
        );
        assert_eq!(
            fs::read_to_string(root.path().join("tracked.txt")).unwrap(),
            "original\n"
        );
        assert!(!root.path().join("untracked.txt").exists());
        assert!(read_status(root.path()).unwrap().changed_count == 0);
    }

    #[cfg(unix)]
    #[test]
    fn revert_refuses_directories_and_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        init_repository(root.path());
        fs::write(root.path().join("seed.txt"), "seed\n").unwrap();
        commit_all(root.path(), "initial");
        fs::create_dir(root.path().join("folder")).unwrap();
        fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("leak.txt"),
        )
        .unwrap();

        assert!(matches!(
            revert_paths(root.path(), &["folder".to_owned()]),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            revert_paths(root.path(), &["leak.txt".to_owned()]),
            Err(AppError::Forbidden(_))
        ));
        assert!(outside.path().join("secret.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_untracked_symlinks_that_point_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(root.path())
            .status()
            .unwrap();
        fs::write(outside.path().join("secret.txt"), "outside-secret\n").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("leak.txt"),
        )
        .unwrap();

        assert!(matches!(
            read_diff(root.path(), ".", &DiffRequest::default()),
            Err(AppError::Forbidden(_))
        ));
    }
}

#[cfg(test)]
mod untracked_binary_tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn untracked_binary_file_does_not_fail_the_scan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical");
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(&root)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q"]);
        std::fs::write(root.join("blob.bin"), [0u8, 159, 146, 150, 255, 0, 1]).expect("write");
        std::fs::write(root.join("note.txt"), "hello\n").expect("write");

        let diff =
            read_diff(&root, ".", &DiffRequest::default()).expect("diff succeeds despite binary");
        assert!(diff.repository);
        assert!(!diff.clean);
        let binary = diff
            .files
            .iter()
            .find(|file| file.path == "blob.bin")
            .expect("binary listed");
        assert_eq!(binary.additions, 0);
        assert!(!binary.previewable);
        assert_eq!(binary.patch, "");
        let text = diff
            .files
            .iter()
            .find(|file| file.path == "note.txt")
            .expect("text listed");
        assert_eq!(text.additions, 1);
        assert!(text.previewable);
        assert_eq!(text.patch, "+hello");
    }
}
