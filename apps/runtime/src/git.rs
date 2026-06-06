use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
};

use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, resolve_in_root},
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub repository: bool,
    pub clean: bool,
    pub files: Vec<GitFileDiff>,
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

pub fn read_diff(workspace_root: &Path, requested: &str) -> AppResult<GitDiff> {
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

    let status_args = if pathspec.is_empty() {
        vec!["status", "--porcelain=v1", "--untracked-files=all"]
    } else {
        vec![
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            pathspec.as_str(),
        ]
    };
    let status_output = git(&repository, &status_args)?;
    let mut files = BTreeMap::<String, GitFileDiff>::new();
    for line in status_output.lines() {
        if line.len() < 4 {
            continue;
        }
        let raw_status = &line[..2];
        let untracked = raw_status.starts_with('?');
        let status = normalize_file_status(raw_status);
        let raw_path = line[3..].split(" -> ").last().unwrap_or_default();
        let path = raw_path.trim_matches('"').replace("\\\"", "\"");
        files.insert(
            path.clone(),
            GitFileDiff {
                path,
                status,
                untracked,
                additions: 0,
                deletions: 0,
                patch: String::new(),
                previewable: true,
            },
        );
    }

    for mut args in [
        vec!["diff", "--numstat", "--"],
        vec!["diff", "--cached", "--numstat", "--"],
    ] {
        if !pathspec.is_empty() {
            args.push(pathspec.as_str());
        }
        for line in git(&repository, &args)?.lines() {
            let mut parts = line.splitn(3, '\t');
            let additions = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            let deletions = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            if let Some(path) = parts.next()
                && let Some(file) = files.get_mut(path)
            {
                file.additions += additions;
                file.deletions += deletions;
            }
        }
    }

    for file in files.values_mut() {
        if !file.untracked {
            let unstaged = git(&repository, &["diff", "--", &file.path])?;
            let staged = git(&repository, &["diff", "--cached", "--", &file.path])?;
            file.patch = [staged, unstaged]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
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
}

/// `git status --porcelain=v2 --branch`, summarized for the top bar.
pub fn read_status(workspace_root: &Path) -> AppResult<GitStatus> {
    let Some(context) = repo_context(workspace_root, ".")? else {
        return Ok(GitStatus {
            repository: false,
            branch: None,
            changed_count: 0,
            ahead: None,
            behind: None,
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
        let relative = validate_relative_path(requested)?;
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

fn validate_relative_path(requested: &str) -> AppResult<String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() || trimmed.len() > 4_096 {
        return Err(AppError::BadRequest("Requested path is invalid".into()));
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute()
        || !candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(AppError::BadRequest(
            "Requested path must be relative to the workspace root".into(),
        ));
    }
    Ok(candidate.to_string_lossy().replace('\\', "/"))
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
        assert!(!read_diff(root.path(), ".").unwrap().repository);

        Command::new("git")
            .args(["init", "-q"])
            .current_dir(root.path())
            .status()
            .unwrap();
        fs::write(root.path().join("new.txt"), "one\ntwo\n").unwrap();
        let diff = read_diff(root.path(), ".").unwrap();
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
            read_diff(&workspace, "."),
            Err(AppError::Forbidden(_))
        ));
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

        let diff = read_diff(root.path(), "src").unwrap();
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "src/new.txt");
        assert_eq!(diff.files[0].additions, 2);
        assert!(diff.files[0].patch.contains("+one"));
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

        let diff = read_diff(root.path(), ".").unwrap();
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
        let diff = read_diff(root.path(), ".").unwrap();
        assert_eq!(diff.files[0].path, "src/added.txt");
        assert_eq!(diff.files[0].status, "A");

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
            read_diff(root.path(), "."),
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

        let diff = read_diff(&root, ".").expect("diff succeeds despite binary");
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
