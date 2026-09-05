//! Working-tree and index diffs: `git diff` and `git diff --cached`.

use super::*;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
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
    /// `--ignore-all-space`: hides whitespace-only differences from the patch
    /// and from the line counts. This is a display option — nothing is staged,
    /// applied, or committed from a whitespace-ignoring diff.
    pub ignore_whitespace: bool,
}

/// `GET /api/workspaces/{id}/git/diff?scope=&paths=`.
///
/// `scope` picks the side of the index: `worktree` is `git diff` plus untracked
/// files, `staged` is `git diff --cached` and never lists untracked files
/// (there is nothing staged about them).
/// Trusted internal entry point: configured helpers may run. Workspace-scoped
/// callers must pass their grant to `read_diff_with_execution` instead.
pub fn read_diff(
    workspace_root: &Path,
    requested: &str,
    request: &DiffRequest,
) -> AppResult<GitDiff> {
    read_diff_with_execution(workspace_root, requested, request, true)
}
pub fn read_diff_with_execution(
    workspace_root: &Path,
    requested: &str,
    request: &DiffRequest,
    execute: bool,
) -> AppResult<GitDiff> {
    if request.scope == DiffScope::Worktree {
        access::require_execution(execute, "Git worktree diff")?;
    }
    let Some(context) = repo_context_with_execution(workspace_root, requested, execute)? else {
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
    for (status, path) in diff_name_status(&repository, cached, &pathspecs, execute)? {
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

    // The file list itself never ignores whitespace: a whitespace-only edit is
    // still a change, and hiding the row would contradict `git status`. Only
    // the rendered patch and its line counts honour the option, so such a file
    // shows up with an empty patch and 0/0 — which is exactly what it is.
    for (additions, deletions, path) in diff_numstat(
        &repository,
        cached,
        &pathspecs,
        execute,
        request.ignore_whitespace,
    )? {
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
            if request.ignore_whitespace {
                args.push(IGNORE_WHITESPACE);
            }
            args.extend(["--", path.as_str()]);
            file.patch = git_with_execution(&repository, &args, execute)?
                .trim_end_matches('\n')
                .to_owned();
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
    execute: bool,
) -> AppResult<Vec<(String, String)>> {
    let output = git_with_execution(
        repository,
        &diff_args("--name-status", cached, pathspecs),
        execute,
    )?;
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
    execute: bool,
    ignore_whitespace: bool,
) -> AppResult<Vec<(u64, u64, String)>> {
    let mut args = diff_args("--numstat", cached, pathspecs);
    if ignore_whitespace {
        // Before the `--` separator, so it is read as an option and not as a
        // pathspec.
        args.insert(if cached { 2 } else { 1 }, IGNORE_WHITESPACE);
    }
    let output = git_with_execution(repository, &args, execute)?;
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
