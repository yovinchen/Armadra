//! Porcelain status parsing and the repository status summary.

use super::*;

/// The number of changed entries in a checkout, for repository discovery
/// (roadmap §4.1). `None` whenever Git cannot answer — a repository mid-rebase,
/// a broken filter, a checkout that vanished — because an unknown count is a
/// normal answer for a list of repositories and a wrong one is not.
///
/// This runs `git status`, which may invoke repository filters, so callers must
/// already hold the workspace execution grant.
pub fn dirty_entry_count(checkout: &Path) -> Option<u64> {
    let output = git(
        checkout,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )
    .ok()?;
    Some(
        output
            .split('\0')
            .filter(|entry| !entry.trim().is_empty())
            .count() as u64,
    )
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
/// Configured filters/fsmonitor can execute during this trusted inspection;
/// workspace-scoped callers must require execution permission first.
pub fn read_status(workspace_root: &Path) -> AppResult<GitStatus> {
    read_status_at(workspace_root, ".")
}

/// `read_status` scoped to one repository under the workspace (roadmap §4.1).
pub fn read_status_at(workspace_root: &Path, requested: &str) -> AppResult<GitStatus> {
    let Some(context) = repo_context(workspace_root, requested)? else {
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
