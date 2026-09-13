//! Workspace repository discovery (roadmap §4.1).
//!
//! A workspace directory is not one repository. It may hold the root
//! repository, independent repositories in subdirectories, submodules, and
//! linked worktrees. The Git panel has to see all of them, so this module walks
//! the workspace once and turns every `.git` entry it finds into a
//! [`GitRepositoryRecord`].
//!
//! Design notes:
//!
//! * The walk is filesystem-only. Kind, common directory, and HEAD branch are
//!   read from `.git` itself, so a workspace with a dozen repositories costs a
//!   dozen file reads rather than a dozen child processes.
//! * `gitignore` is deliberately *not* consulted. An ignored directory is very
//!   often an independent repository (a vendored checkout, a scratch clone);
//!   skipping it would hide exactly the repositories this feature exists for.
//!   Only the fixed, cheap skip list below is applied.
//! * `dirtyCount` is the one field that needs Git to run, so it is `None`
//!   whenever the workspace has no execution grant. Discovery still succeeds:
//!   an unknown dirty count is a normal answer, not an error.
//! * `repositoryId` keeps the existing derivation — SHA-256 of the canonical
//!   *common directory* — so a record lines up with the `repositoryId` on every
//!   snapshot the repository service already returns. Linked worktrees share
//!   their main repository's id by construction (they are the same repository);
//!   `repositoryPath` is what identifies a checkout uniquely.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    security::canonical_directory,
};

/// Directory names never descended into. Not a gitignore: a fixed list of
/// places a repository is not expected to live, kept short on purpose.
const SKIPPED: [&str; 5] = ["node_modules", "target", "dist", ".git", ".armadra"];

/// How deep below the workspace root a repository is looked for. Depth 0 is the
/// root itself. The default keeps a monorepo's `apps/<name>/<vendor>` reachable
/// without walking an entire home directory.
pub const DEFAULT_MAX_DEPTH: usize = 4;
const MAX_ALLOWED_DEPTH: usize = 12;
/// A hard ceiling on one scan, so a pathological tree cannot pin a request.
const MAX_ENTRIES: usize = 20_000;
/// A hard ceiling on repositories reported, so the response stays bounded.
const MAX_REPOSITORIES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRepositoryKind {
    /// The workspace root itself is a repository.
    Root,
    /// An independent repository in a subdirectory.
    Nested,
    /// A `.git` file pointing into a superproject's `.git/modules`.
    Submodule,
    /// A `.git` file pointing into a repository's `worktrees/<name>`.
    Worktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryRecord {
    /// SHA-256 of the canonical common directory — the same value the branch,
    /// tag and stash snapshots report for this repository.
    pub repository_id: String,
    /// Workspace-relative, `.` for the root. This is what every other Git
    /// request takes as its `path`, and what identifies a checkout uniquely.
    pub repository_path: String,
    /// The last path segment, or the workspace directory name for the root.
    pub name: String,
    pub kind: GitRepositoryKind,
    /// The repository this one is nested in, or the main checkout of a linked
    /// worktree. `None` for the root.
    pub parent_repository_id: Option<String>,
    /// `None` on a detached HEAD.
    pub head_branch: Option<String>,
    /// `None` when the workspace has no execution grant, because counting
    /// changes runs `git status`, which may invoke repository filters.
    pub dirty_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryList {
    pub workspace_root: String,
    pub max_depth: usize,
    pub repositories: Vec<GitRepositoryRecord>,
    /// The walk stopped at a ceiling, so the list may be incomplete.
    pub truncated: bool,
    pub observed_at: String,
}

/* --------------------------------- cache ---------------------------------- */

struct CacheEntry {
    root: PathBuf,
    max_depth: usize,
    execute: bool,
    list: GitRepositoryList,
}

static CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Drop the cached list for a workspace. Called when a `file.changed` event
/// touches a `.git` entry, and whenever a repository operation adds or removes
/// a worktree.
pub fn invalidate(workspace_id: &str) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.remove(workspace_id);
    }
}

pub fn invalidate_all() {
    if let Ok(mut cache) = CACHE.lock() {
        cache.clear();
    }
}

/// Whether a changed path can add or remove a repository. Only `.git` entries
/// can: everything else leaves the set of repositories exactly as it was.
pub fn affects_repositories(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized == ".git"
        || normalized.ends_with("/.git")
        || normalized.contains("/.git/")
        || normalized.starts_with(".git/")
}

/// The cached list, rescanning when the cache is cold or was invalidated.
pub fn repositories(
    workspace_id: &str,
    workspace_root: &Path,
    max_depth: Option<usize>,
    execute: bool,
) -> AppResult<GitRepositoryList> {
    let root = canonical_directory(workspace_root)?;
    let depth = max_depth
        .unwrap_or(DEFAULT_MAX_DEPTH)
        .min(MAX_ALLOWED_DEPTH);
    if let Ok(cache) = CACHE.lock()
        && let Some(entry) = cache.get(workspace_id)
        && entry.root == root
        && entry.max_depth == depth
        && entry.execute == execute
    {
        return Ok(entry.list.clone());
    }
    let list = scan(&root, depth, execute)?;
    if let Ok(mut cache) = CACHE.lock() {
        // A workspace map that only ever grows would outlive the workspaces in
        // it; the ceiling is generous but finite.
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(
            workspace_id.to_owned(),
            CacheEntry {
                root,
                max_depth: depth,
                execute,
                list: list.clone(),
            },
        );
    }
    Ok(list)
}

/* ---------------------------------- scan ---------------------------------- */

/// Walk the workspace and describe every repository under it. Public for tests
/// and for callers that need a fresh read rather than the cached one.
pub fn scan(root: &Path, max_depth: usize, execute: bool) -> AppResult<GitRepositoryList> {
    let root = canonical_directory(root)?;
    let mut found: Vec<(PathBuf, PathBuf, GitRepositoryKind)> = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];
    let mut visited = 0_usize;
    let mut truncated = false;
    while let Some((directory, depth)) = queue.pop() {
        if visited >= MAX_ENTRIES || found.len() >= MAX_REPOSITORIES {
            truncated = true;
            break;
        }
        visited += 1;
        // An unreadable or malformed `.git` is not a repository this panel can
        // offer; it must not fail the whole scan either.
        if let Ok(Some((common_dir, kind))) = classify(&directory, directory == root) {
            found.push((directory.clone(), common_dir, kind));
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Symlinked directories are never followed: they can leave the
            // workspace, and a cycle would never terminate.
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if SKIPPED.contains(&name) {
                continue;
            }
            queue.push((entry.path(), depth + 1));
        }
    }
    found.sort_by(|left, right| left.0.cmp(&right.0));

    let mut records = Vec::with_capacity(found.len());
    for (path, common_dir, kind) in &found {
        let repository_id = derive_id(common_dir);
        let repository_path = relative_path(&root, path)?;
        let name = if repository_path == "." {
            root.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(".")
                .to_owned()
        } else {
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(repository_path.as_str())
                .to_owned()
        };
        let parent_repository_id = match kind {
            GitRepositoryKind::Root => None,
            GitRepositoryKind::Worktree => found
                .iter()
                .find(|(candidate, candidate_common, candidate_kind)| {
                    candidate != path
                        && candidate_common == common_dir
                        && *candidate_kind != GitRepositoryKind::Worktree
                })
                .map(|(_, candidate_common, _)| derive_id(candidate_common)),
            _ => found
                .iter()
                .filter(|(candidate, _, _)| candidate != path && path.starts_with(candidate))
                .max_by_key(|(candidate, _, _)| candidate.components().count())
                .map(|(_, candidate_common, _)| derive_id(candidate_common)),
        };
        records.push(GitRepositoryRecord {
            repository_id,
            repository_path,
            name,
            kind: *kind,
            parent_repository_id,
            head_branch: head_branch(common_dir, path),
            dirty_count: execute
                .then(|| crate::git::dirty_entry_count(path))
                .flatten(),
        });
    }
    Ok(GitRepositoryList {
        workspace_root: root.to_string_lossy().into_owned(),
        max_depth,
        repositories: records,
        truncated,
        observed_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn derive_id(common_dir: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(common_dir.to_string_lossy().as_bytes())
    )
}

fn relative_path(root: &Path, path: &Path) -> AppResult<String> {
    if path == root {
        return Ok(".".into());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::Internal("Repository escaped the workspace during scan".into()))?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// Read the `.git` entry of `directory` and report its common directory and
/// kind, or `None` when the directory is not a repository checkout.
fn classify(directory: &Path, is_root: bool) -> AppResult<Option<(PathBuf, GitRepositoryKind)>> {
    let dot_git = directory.join(".git");
    let Ok(metadata) = std::fs::symlink_metadata(&dot_git) else {
        return Ok(None);
    };
    if metadata.is_dir() {
        let common = canonical_directory(&dot_git)?;
        return Ok(Some((
            common,
            if is_root {
                GitRepositoryKind::Root
            } else {
                GitRepositoryKind::Nested
            },
        )));
    }
    if !metadata.is_file() {
        return Ok(None);
    }
    // A `.git` file is `gitdir: <path>` and nothing else. The path is absolute
    // for a submodule and may be relative for a linked worktree.
    let contents = std::fs::read_to_string(&dot_git)
        .map_err(|_| AppError::BadRequest("Git link file cannot be read".into()))?;
    let Some(target) = contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))
    else {
        return Ok(None);
    };
    let target = Path::new(target.trim());
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        directory.join(target)
    };
    let git_dir = canonical_directory(&resolved)?;
    // `<common>/worktrees/<name>` is a linked worktree; the repository's common
    // directory is two levels up. Anything else — `<super>/.git/modules/<name>`
    // above all — is its own common directory.
    let parent = git_dir.parent();
    if parent
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some("worktrees")
    {
        let common = parent
            .and_then(Path::parent)
            .ok_or_else(|| AppError::Internal("Linked worktree has no common directory".into()))?
            .to_path_buf();
        return Ok(Some((common, GitRepositoryKind::Worktree)));
    }
    Ok(Some((git_dir, GitRepositoryKind::Submodule)))
}

/// `refs/heads/<name>` from the checkout's own HEAD, or `None` when detached.
///
/// A linked worktree keeps its HEAD in `<common>/worktrees/<name>/HEAD`, which
/// is exactly the directory `.git` points at, so the checkout's `.git` entry is
/// re-resolved rather than reusing the shared common directory.
fn head_branch(common_dir: &Path, checkout: &Path) -> Option<String> {
    let dot_git = checkout.join(".git");
    let head_file = match std::fs::symlink_metadata(&dot_git) {
        Ok(metadata) if metadata.is_dir() => dot_git.join("HEAD"),
        Ok(metadata) if metadata.is_file() => {
            let contents = std::fs::read_to_string(&dot_git).ok()?;
            let target = contents
                .lines()
                .find_map(|line| line.trim().strip_prefix("gitdir:"))?;
            let target = Path::new(target.trim());
            let resolved = if target.is_absolute() {
                target.to_path_buf()
            } else {
                checkout.join(target)
            };
            resolved.join("HEAD")
        }
        _ => common_dir.join("HEAD"),
    };
    let head = std::fs::read_to_string(head_file).ok()?;
    let reference = head.trim().strip_prefix("ref:")?.trim();
    reference
        .strip_prefix("refs/heads/")
        .map(str::to_owned)
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(directory: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(directory)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git runs");
        assert!(
            status.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    /// A local repository named where Git expects a URL. Git reads the argument
    /// as one, so a Windows path goes in with forward slashes: a backslash is
    /// an escape there and a leading pair reads as a UNC hostname.
    fn local_source(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    fn repository(path: &Path) {
        std::fs::create_dir_all(path).expect("directory");
        git(path, &["init", "-q", "-b", "main"]);
        std::fs::write(path.join("README.md"), "seed\n").expect("seed file");
        git(path, &["add", "README.md"]);
        git(path, &["commit", "-qm", "seed"]);
    }

    struct Workspace(PathBuf);
    impl Workspace {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("armadra-discovery-{name}-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir_all(&root).expect("workspace root");
            Self(crate::paths::canonicalize(&root).expect("canonical workspace"))
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_the_root_and_nested_repositories() {
        let workspace = Workspace::new("nested");
        repository(workspace.path());
        repository(&workspace.path().join("apps/inner"));
        repository(&workspace.path().join("vendor/deep/lib"));

        let list = scan(workspace.path(), DEFAULT_MAX_DEPTH, false).expect("scan");
        let paths: Vec<&str> = list
            .repositories
            .iter()
            .map(|record| record.repository_path.as_str())
            .collect();
        assert_eq!(paths, [".", "apps/inner", "vendor/deep/lib"]);
        assert_eq!(list.repositories[0].kind, GitRepositoryKind::Root);
        assert_eq!(list.repositories[1].kind, GitRepositoryKind::Nested);
        assert_eq!(list.repositories[0].head_branch.as_deref(), Some("main"));
        assert_eq!(
            list.repositories[1].parent_repository_id.as_deref(),
            Some(list.repositories[0].repository_id.as_str())
        );
        // No execution grant means the dirty count is unknown, not zero.
        assert!(list.repositories[0].dirty_count.is_none());
    }

    #[test]
    fn skips_the_fixed_directory_list_but_not_ignored_directories() {
        let workspace = Workspace::new("skips");
        repository(workspace.path());
        repository(&workspace.path().join("node_modules/pkg"));
        repository(&workspace.path().join("target/scratch"));
        // An ignored directory is still scanned: ignored checkouts are exactly
        // the ones this feature has to surface.
        std::fs::write(workspace.path().join(".gitignore"), "ignored/\n").expect("gitignore");
        repository(&workspace.path().join("ignored/clone"));

        let list = scan(workspace.path(), DEFAULT_MAX_DEPTH, false).expect("scan");
        let paths: Vec<&str> = list
            .repositories
            .iter()
            .map(|record| record.repository_path.as_str())
            .collect();
        assert_eq!(paths, [".", "ignored/clone"]);
    }

    #[test]
    fn honours_the_depth_ceiling() {
        let workspace = Workspace::new("depth");
        repository(workspace.path());
        repository(&workspace.path().join("a/b/c/d/deep"));

        let shallow = scan(workspace.path(), 2, false).expect("scan");
        assert_eq!(shallow.repositories.len(), 1);
        let deep = scan(workspace.path(), 5, false).expect("scan");
        assert_eq!(deep.repositories.len(), 2);
    }

    #[test]
    fn classifies_a_linked_worktree_and_shares_its_repository_id() {
        let workspace = Workspace::new("worktree");
        repository(workspace.path());
        git(
            workspace.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                "checkouts/feature",
            ],
        );

        let list = scan(workspace.path(), DEFAULT_MAX_DEPTH, false).expect("scan");
        let linked = list
            .repositories
            .iter()
            .find(|record| record.repository_path == "checkouts/feature")
            .expect("linked worktree");
        assert_eq!(linked.kind, GitRepositoryKind::Worktree);
        assert_eq!(linked.head_branch.as_deref(), Some("feature"));
        // Same repository, different checkout: the id matches the main entry.
        assert_eq!(linked.repository_id, list.repositories[0].repository_id);
        assert_eq!(
            linked.parent_repository_id.as_deref(),
            Some(list.repositories[0].repository_id.as_str())
        );
    }

    #[test]
    fn classifies_a_submodule_with_its_own_repository_id() {
        let workspace = Workspace::new("submodule");
        let upstream = Workspace::new("submodule-upstream");
        repository(upstream.path());
        repository(workspace.path());
        git(
            workspace.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &local_source(upstream.path()),
                "libs/dep",
            ],
        );

        let list = scan(workspace.path(), DEFAULT_MAX_DEPTH, false).expect("scan");
        let submodule = list
            .repositories
            .iter()
            .find(|record| record.repository_path == "libs/dep")
            .expect("submodule");
        assert_eq!(submodule.kind, GitRepositoryKind::Submodule);
        assert_ne!(submodule.repository_id, list.repositories[0].repository_id);
        assert_eq!(
            submodule.parent_repository_id.as_deref(),
            Some(list.repositories[0].repository_id.as_str())
        );
    }

    #[test]
    fn counts_dirty_entries_when_execution_is_granted() {
        let workspace = Workspace::new("dirty");
        repository(workspace.path());
        std::fs::write(workspace.path().join("README.md"), "changed\n").expect("write");
        std::fs::write(workspace.path().join("new.txt"), "new\n").expect("write");

        let list = scan(workspace.path(), DEFAULT_MAX_DEPTH, true).expect("scan");
        assert_eq!(list.repositories[0].dirty_count, Some(2));
    }

    #[test]
    fn only_dot_git_paths_invalidate_the_cache() {
        assert!(affects_repositories(".git"));
        assert!(affects_repositories("apps/inner/.git"));
        assert!(affects_repositories("apps/inner/.git/HEAD"));
        assert!(!affects_repositories("apps/inner/src/main.rs"));
        assert!(!affects_repositories("digit.gitlab.yml"));
    }
}
