//! One-hunk mutations, reconstructed from a freshly observed Git diff.
//! Client input never contains patch bytes. The shared repository guard covers
//! application Git writers; external Git processes are still checked by apply.

use crate::{
    error::{AppError, AppResult},
    git_api::REPOSITORIES,
    git_repository::RepositoryContext,
    security::redact_secrets,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::LazyLock,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

#[cfg(test)]
mod tests;

const MAX_DIFF: usize = 8 * 1024 * 1024;
const MAX_ERROR: usize = 64 * 1024;
const MAX_HUNKS: usize = 4096;
static HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$").unwrap());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitHunkScope {
    Worktree,
    Staged,
}
/// The workspace root, for a request that names no checkout.
pub fn root_checkout() -> String {
    ".".to_owned()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitHunkAction {
    Stage,
    Unstage,
    Revert,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHunkMutation {
    /// Which checkout the file lives in, workspace-relative; `.` is the root.
    ///
    /// A nested repository's hunk used to be applied against the root's
    /// index — a different repository, and a patch that does not describe it.
    #[serde(default = "root_checkout")]
    pub path: String,
    pub file: String,
    pub scope: GitHunkScope,
    pub diff_digest: String,
    pub hunk_id: String,
    pub action: GitHunkAction,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    pub id: String,
    pub header: String,
    pub content: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkDiff {
    pub file: String,
    pub scope: GitHunkScope,
    pub diff_digest: String,
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub hunks: Vec<GitHunk>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkResult {
    pub applied: bool,
    pub file: String,
    pub scope: GitHunkScope,
    pub action: GitHunkAction,
    pub hunk_id: String,
}

struct Observed {
    public: GitHunkDiff,
    prefix: String,
}

pub async fn read_hunks(
    workspace_root: &Path,
    checkout: &str,
    file: &str,
    scope: GitHunkScope,
) -> AppResult<GitHunkDiff> {
    let guard = REPOSITORIES
        .mutation_guard(workspace_root, checkout)
        .await?;
    Ok(observe(&guard.context, file, scope).await?.public)
}

/// The task owns both child process and repository lock even if the HTTP
/// request disappears. A timeout is an error, never a claim of no side effects.
pub async fn apply_hunk(
    workspace_root: &Path,
    request: GitHunkMutation,
) -> AppResult<GitHunkResult> {
    let root = workspace_root.to_owned();
    tokio::spawn(async move {
        let guard = REPOSITORIES.mutation_guard(&root, &request.path).await?;
        let valid = matches!(
            (request.scope, request.action),
            (
                GitHunkScope::Worktree,
                GitHunkAction::Stage | GitHunkAction::Revert
            ) | (GitHunkScope::Staged, GitHunkAction::Unstage)
        );
        if !valid || !is_digest(&request.diff_digest) || !is_digest(&request.hunk_id) {
            return Err(bad("Hunk action, scope or identity is invalid"));
        }
        let observed = observe(&guard.context, &request.file, request.scope).await?;
        if !observed.public.supported {
            return Err(bad("This file does not support individual hunk operations"));
        }
        if observed.public.diff_digest != request.diff_digest {
            return Err(stale());
        }
        let hunk = observed
            .public
            .hunks
            .iter()
            .find(|hunk| hunk.id == request.hunk_id)
            .ok_or_else(stale)?;
        let patch = format!("{}{}\n{}", observed.prefix, hunk.header, hunk.content);
        let mut arguments = vec!["apply", "--whitespace=nowarn"];
        if request.action != GitHunkAction::Revert {
            arguments.push("--cached");
        }
        if request.action != GitHunkAction::Stage {
            arguments.push("--reverse");
        }
        let mut check = arguments.clone();
        check.extend(["--check", "-"]);
        git(&guard.context.repository, &check, Some(patch.as_bytes())).await?;
        // An editor is not a Git writer. Re-read after the check so edits made
        // during it also invalidate the full-file observation before applying.
        let rechecked = observe(&guard.context, &request.file, request.scope).await?;
        if !rechecked.public.supported || rechecked.public.diff_digest != request.diff_digest {
            return Err(stale());
        }
        arguments.push("-");
        git(
            &guard.context.repository,
            &arguments,
            Some(patch.as_bytes()),
        )
        .await?;
        Ok(GitHunkResult {
            applied: true,
            file: request.file,
            scope: request.scope,
            action: request.action,
            hunk_id: request.hunk_id,
        })
    })
    .await?
}

async fn observe(
    context: &RepositoryContext,
    raw_file: &str,
    scope: GitHunkScope,
) -> AppResult<Observed> {
    let file = safe_file(context, raw_file)?;
    let mut public = GitHunkDiff {
        file: raw_file.into(),
        scope,
        diff_digest: String::new(),
        supported: false,
        unsupported_reason: None,
        hunks: vec![],
    };
    let relative = file
        .strip_prefix(&context.repository)
        .map_err(|_| bad("File is outside the Git repository"))?
        .to_str()
        .ok_or_else(|| bad("File path must be UTF-8"))?
        .replace('\\', "/");
    // Refuse clean/smudge and working-tree encoding conversions before Git
    // reads content: their representation may not match an apply-able patch.
    let attributes = git(
        &context.repository,
        &[
            "check-attr",
            "-z",
            "filter",
            "working-tree-encoding",
            "--",
            &relative,
        ],
        None,
    )
    .await?;
    let attribute_fields: Vec<_> = attributes
        .strip_suffix(&[0])
        .ok_or_else(|| bad("Malformed Git attribute response"))?
        .split(|byte| *byte == 0)
        .collect();
    if attribute_fields.len() % 3 != 0 {
        return Err(bad("Malformed Git attribute response"));
    }
    if attribute_fields
        .chunks_exact(3)
        .any(|field| field[2] != b"unspecified" && field[2] != b"unset")
    {
        return unsupported(public, "filter");
    }
    let mut raw_args = vec![
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
    ];
    if scope == GitHunkScope::Staged {
        raw_args.push("--cached");
    }
    raw_args.extend(["--", &relative]);
    let raw = git(&context.repository, &raw_args, None).await?;
    if raw.is_empty() {
        return unsupported(public, "notTrackedModification");
    }
    let records: Vec<_> = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    if records.len() != 2 || records[1] != relative.as_bytes() {
        return unsupported(public, "unsupportedPatch");
    }
    let metadata = std::str::from_utf8(records[0]).map_err(|_| bad("Malformed Git raw diff"))?;
    let fields: Vec<_> = metadata.split_whitespace().collect();
    if fields.len() != 5 {
        return unsupported(public, "unsupportedPatch");
    }
    if fields[4] != "M" {
        return unsupported(public, "notTrackedModification");
    }
    if fields[0].trim_start_matches(':') != fields[1] {
        return unsupported(public, "modeChange");
    }
    if !matches!(fields[1], "100644" | "100755") {
        return unsupported(public, "notRegularFile");
    }
    let mut args = vec![
        "diff",
        "--patch",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
        "--inter-hunk-context=0",
    ];
    if scope == GitHunkScope::Staged {
        args.push("--cached");
    }
    args.extend(["--", &relative]);
    let bytes = git(&context.repository, &args, None).await?;
    if bytes.contains(&0) {
        return unsupported(public, "binary");
    }
    let patch = match std::str::from_utf8(&bytes) {
        Ok(patch) => patch,
        Err(_) => return unsupported(public, "nonUtf8"),
    };
    let head = git(
        &context.repository,
        &["rev-parse", "--verify", "HEAD"],
        None,
    )
    .await?;
    let branch = git(
        &context.repository,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        None,
    )
    .await?;
    let mut digest = Sha256::new();
    for part in [
        context.repository.to_string_lossy().as_bytes(),
        raw_file.as_bytes(),
        if scope == GitHunkScope::Staged {
            b"staged"
        } else {
            b"worktree"
        },
        &head,
        &branch,
        &bytes,
    ] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    public.diff_digest = format!("{:x}", digest.finalize());
    let Some((prefix, hunks)) = parse_patch(patch, &public.diff_digest) else {
        return unsupported(
            public,
            if patch.contains("Binary files ") || patch.contains("GIT binary patch") {
                "binary"
            } else {
                "unsupportedPatch"
            },
        );
    };
    if hunks.is_empty() {
        return unsupported(public, "notTrackedModification");
    }
    public.supported = true;
    public.hunks = hunks;
    Ok(Observed { public, prefix })
}

fn unsupported(mut public: GitHunkDiff, reason: &str) -> AppResult<Observed> {
    // Even an unsupported result has a stable display identity; it can never
    // authorize a write because apply_hunk rechecks `supported` independently.
    if public.diff_digest.is_empty() {
        public.diff_digest = format!(
            "{:x}",
            Sha256::digest(format!("{}:{:?}:{reason}", public.file, public.scope))
        );
    }
    public.unsupported_reason = Some(reason.into());
    Ok(Observed {
        public,
        prefix: String::new(),
    })
}

/// Resolve one file inside the checkout the guard opened.
///
/// The path is **repository-relative**, which is how every other Git read
/// spells a file and how the change tree already addresses one. It used to be
/// resolved against the workspace root, which was the same directory only
/// because the caller could not name any checkout but the root.
fn safe_file(context: &RepositoryContext, raw: &str) -> AppResult<PathBuf> {
    if raw.is_empty()
        || raw.len() > 4096
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
        || raw.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || part.eq_ignore_ascii_case(".git")
                || part.contains(':')
        })
    {
        return Err(bad("File must be a safe repository-relative path"));
    }
    let path = Path::new(raw);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(bad("File must be repository-relative"));
    }
    let mut current = context.repository.clone();
    for part in path.components() {
        current.push(part.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if indirect_file(&metadata) => {
                return Err(AppError::Forbidden(
                    "Git hunk paths must not traverse symlinks".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if !current.starts_with(&context.repository) {
        return Err(AppError::Forbidden(
            "File is outside the Git repository".into(),
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&current)
        && !metadata.is_file()
    {
        return Err(bad("Git hunks require a regular file"));
    }
    Ok(current)
}

fn indirect_file(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn parse_patch(patch: &str, digest: &str) -> Option<(String, Vec<GitHunk>)> {
    let lines: Vec<_> = patch.split_inclusive('\n').collect();
    if !lines.first()?.starts_with("diff --git ") {
        return None;
    }
    let first = lines.iter().position(|line| line.starts_with("@@ "))?;
    let prefix = lines[..first].concat();
    if lines[..first].iter().enumerate().any(|(index, line)| {
        index > 0
            && !(line.starts_with("index ") || line.starts_with("--- ") || line.starts_with("+++ "))
    }) {
        return None;
    }
    if !lines[..first]
        .iter()
        .any(|line| line.starts_with("--- a/") || line.starts_with("--- \"a/"))
        || !lines[..first]
            .iter()
            .any(|line| line.starts_with("+++ b/") || line.starts_with("+++ \"b/"))
    {
        return None;
    }
    let mut starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.starts_with("@@ ").then_some(index))
        .collect();
    if starts.len() > MAX_HUNKS {
        return None;
    }
    starts.push(lines.len());
    let mut hunks = Vec::new();
    for range in starts.windows(2) {
        let header = lines[range[0]].strip_suffix('\n')?;
        let captures = HEADER.captures(header)?;
        let old_start = captures.get(1)?.as_str().parse::<u32>().ok()?;
        let old_lines = captures
            .get(2)
            .map_or(Some(1), |value| value.as_str().parse::<u32>().ok())?;
        let new_start = captures.get(3)?.as_str().parse::<u32>().ok()?;
        let new_lines = captures
            .get(4)
            .map_or(Some(1), |value| value.as_str().parse::<u32>().ok())?;
        let body = &lines[range[0] + 1..range[1]];
        let (mut old, mut new) = (0_u32, 0_u32);
        for line in body {
            match line.as_bytes().first()? {
                b' ' => {
                    old = old.checked_add(1)?;
                    new = new.checked_add(1)?;
                }
                b'-' => old = old.checked_add(1)?,
                b'+' => new = new.checked_add(1)?,
                b'\\' if *line == "\\ No newline at end of file\n" => {}
                _ => return None,
            }
        }
        if old != old_lines || new != new_lines {
            return None;
        }
        let content = body.concat();
        let id = format!(
            "{:x}",
            Sha256::digest(format!("{digest}\0{header}\n{content}"))
        );
        hunks.push(GitHunk {
            id,
            header: header.into(),
            content,
            old_start,
            old_lines,
            new_start,
            new_lines,
        });
    }
    Some((prefix, hunks))
}

async fn limited(mut input: impl AsyncRead + Unpin, limit: usize) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut input)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(bad(
            "Git hunk output exceeds its byte limit; use whole-file operations",
        ));
    }
    Ok(bytes)
}

async fn git(directory: &Path, arguments: &[&str], input: Option<&[u8]>) -> AppResult<Vec<u8>> {
    let directory = directory.to_owned();
    let arguments = arguments
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect::<Vec<_>>();
    let input = input.map(<[u8]>::to_vec);
    tokio::spawn(async move {
    let lease=REPOSITORIES.command_lease()?;
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "color.ui=false",
            "-c",
            "core.quotepath=true",
            "-c",
            "apply.ignoreWhitespace=no",
            "-c",
            "apply.whitespace=nowarn",
            "-c",
            "diff.algorithm=myers",
            "-c",
            "diff.suppressBlankEmpty=false",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(arguments)
        .current_dir(directory)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy().to_ascii_uppercase();
        if matches!(
            key.as_str(),
            "GIT_DIR"
                | "GIT_WORK_TREE"
                | "GIT_COMMON_DIR"
                | "GIT_INDEX_FILE"
                | "GIT_OBJECT_DIRECTORY"
                | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
                | "GIT_NAMESPACE"
                | "GIT_CONFIG"
                | "GIT_CONFIG_COUNT"
                | "GIT_CONFIG_PARAMETERS"
                | "GIT_EXTERNAL_DIFF"
                | "GIT_DIFF_OPTS"
        ) || key.starts_with("GIT_CONFIG_KEY_")
            || key.starts_with("GIT_CONFIG_VALUE_")
            || key.starts_with("GIT_TRACE")
        {
            command.env_remove(name);
        }
    }
    if lease.cancellation_requested(){return Err(bad("Git hunk operation is stopping"));}
    let mut child = command.spawn()?;
    lease.mark_started();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| bad("Git stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| bad("Git stderr unavailable"))?;
    let stdin = child.stdin.take();
    let completion = async {
        let (stdout, stderr, status, _) = tokio::try_join!(
            limited(stdout, MAX_DIFF),
            limited(stderr, MAX_ERROR),
            async { child.wait().await.map_err(AppError::from) },
            async {
                if let Some(mut stdin) = stdin {
                    stdin.write_all(input.as_deref().unwrap_or_default()).await?;
                    stdin.shutdown().await?;
                }
                Ok::<_, AppError>(())
            }
        )?;
        if !status.success() {
            return Err(AppError::Conflict(format!(
                "Git hunk operation failed: {}",
                redact_secrets(&String::from_utf8_lossy(&stderr))
                    .chars()
                    .take(2000)
                    .collect::<String>()
            )));
        }
        Ok(stdout)
    };
    let result=tokio::select!{biased; _=lease.cancelled()=>None, value=tokio::time::timeout(Duration::from_secs(15),completion)=>Some(value)};
    match result {
        Some(Ok(Ok(output))) => {lease.mark_reaped();Ok(output)},
        other => {
            let _ = child.start_kill();
            if matches!(tokio::time::timeout(Duration::from_secs(2), child.wait()).await,Ok(Ok(_))) {lease.mark_reaped();}
            match other {
                Some(Ok(Err(error))) => Err(error),
                None => Err(bad("Git hunk operation cancelled because the Runtime is stopping")),
                _ => Err(AppError::Conflict(
                    "Git hunk operation timed out; re-read repository state before retrying".into(),
                )),
            }
        }
    }
 }).await?
}
fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn stale() -> AppError {
    AppError::Conflict("The file diff changed; reload its hunks before operating".into())
}
