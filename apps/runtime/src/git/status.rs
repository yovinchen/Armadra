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
    /// Where a renamed or copied entry came from, as the record's second `-z`
    /// field spells it; `null` for every other status.
    ///
    /// The porcelain already reports it — it is the field the parser used to
    /// read and drop — and the change tree needs it to draw one `new ← old`
    /// row instead of an addition beside an unexplained deletion.
    pub origin_path: Option<String>,
}

/// Parse `git status --porcelain=v1 -z` output.
///
/// Each record is `XY <path>`, NUL-terminated. `X` is the index status and `Y`
/// the working-tree status; for renames and copies the origin path follows as
/// its own NUL-terminated field. The entry is still addressed by its
/// destination — that is the path every write takes — and the origin travels
/// beside it so a row can say where the file came from.
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
        // The extra field is consumed whether or not the entry survives: leave
        // it in the iterator and the *next* record is read as a status line.
        let origin_path = if index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C' {
            fields
                .next()
                .filter(|origin| !origin.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
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
            origin_path,
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
    read_status_filtered(workspace_root, requested, &[])
}

/// `read_status_at` narrowed to a pathspec list (Git 设计 §3, 服务端筛选).
///
/// The filter is applied by Git rather than by the caller, and it is applied to
/// **both** passes — the summary and the per-file rows — so `changedCount` and
/// `files` describe the same set. A count taken over the whole checkout beside a
/// list taken over one directory is the shape that makes a panel say "3 changes"
/// above one row.
///
/// The branch, ahead and behind numbers are deliberately *not* narrowed: they
/// are facts about the checkout, and a pathspec does not change how far ahead
/// of its upstream a branch is.
pub fn read_status_filtered(
    workspace_root: &Path,
    requested: &str,
    pathspecs: &[String],
) -> AppResult<GitStatus> {
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
    let pathspecs = valid_pathspecs(pathspecs)?;
    let mut summary = vec![
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
    ];
    if !pathspecs.is_empty() {
        summary.push("--");
        summary.extend(pathspecs.iter().map(String::as_str));
    }
    let output = git(&context.repository, &summary)?;
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
        files: status_entries(&context.repository, &pathspecs)?,
    })
}

/* ------------------------------ batch status ------------------------------ */

/// Several checkouts' status in one request (Git 设计 §4.1 全部仓库聚合).
///
/// The aggregated Changes view used to make one round trip per repository, and
/// a workspace with a dozen checkouts paid a dozen. Worse, the answers were then
/// rendered as one list although each had been observed at a different moment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBatchRequest {
    /// The checkouts, as workspace-relative directories. `.` is the root.
    pub paths: Vec<String>,
    /// An optional pathspec filter, applied to every checkout in the batch.
    #[serde(default)]
    pub pathspecs: Vec<String>,
}

/// One checkout's answer. `status` and `error` are exclusive, and one of them is
/// always present: a repository that could not be read is reported as that
/// repository's failure rather than losing the whole batch, because one broken
/// checkout in a workspace of twelve must not blank the other eleven.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBatchEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<GitStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StatusBatchFailure>,
}

/// The Runtime's own `{ code, message }`, per repository.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBatchFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBatchResponse {
    pub repositories: Vec<StatusBatchEntry>,
    /// When this batch was taken. One timestamp for the whole answer, which is
    /// the honest thing to say: the checkouts were read in sequence, so this is
    /// "not older than", never "at this instant".
    pub observed_at: String,
}

/// The largest batch. A workspace with more checkouts than this asks twice —
/// which is still two round trips instead of sixty.
const MAX_STATUS_BATCH: usize = 64;

/// Reads every named checkout's status in one pass.
pub fn read_status_batch(
    workspace_root: &Path,
    request: &StatusBatchRequest,
) -> AppResult<StatusBatchResponse> {
    if request.paths.is_empty() || request.paths.len() > MAX_STATUS_BATCH {
        return Err(AppError::BadRequest(
            "Between one and 64 repositories may be read at once".into(),
        ));
    }
    // The pathspecs are validated once, before any Git runs. A malformed filter
    // is the caller's mistake for the whole request, not twelve identical
    // per-repository failures.
    valid_pathspecs(&request.pathspecs)?;
    let mut repositories = Vec::with_capacity(request.paths.len());
    let mut seen = std::collections::HashSet::new();
    for path in &request.paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let entry = match read_status_filtered(workspace_root, path, &request.pathspecs) {
            Ok(status) => StatusBatchEntry {
                path: path.clone(),
                status: Some(status),
                error: None,
            },
            Err(error) => {
                let (code, message) = error.code_and_message();
                StatusBatchEntry {
                    path: path.clone(),
                    status: None,
                    error: Some(StatusBatchFailure {
                        code: code.to_owned(),
                        message,
                    }),
                }
            }
        };
        repositories.push(entry);
    }
    Ok(StatusBatchResponse {
        repositories,
        observed_at: chrono::Utc::now().to_rfc3339(),
    })
}
