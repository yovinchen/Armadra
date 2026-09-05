//! Reading HEAD, committing (including amend) and `git init`.

use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// Short hash of the commit that was just created.
    pub commit: String,
    pub committed: Vec<String>,
    pub summary: String,
}

/// The commit `--amend` would rewrite, as the composer has to present it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadCommit {
    pub oid: String,
    pub subject: String,
    /// The full message, so an amend can start from it instead of silently
    /// dropping the body. Empty when `truncated`.
    pub message: String,
    /// The stored message is larger than an amend may resend; the composer
    /// must refuse rather than rewrite the commit with a shortened message.
    pub truncated: bool,
    /// At least one remote-tracking ref contains this commit, so rewriting it
    /// rewrites history other checkouts may already have fetched.
    pub published: bool,
}

/// `HEAD` as the amend controls describe it, or None on an unborn branch.
pub fn head_commit(workspace_root: &Path, requested: &str) -> AppResult<Option<HeadCommit>> {
    let context = require_repository(workspace_root, requested)?;
    let Ok(oid) = git(
        &context.repository,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    ) else {
        return Ok(None);
    };
    let oid = oid.trim().to_owned();
    if oid.is_empty() {
        return Ok(None);
    }
    let message = git(
        &context.repository,
        &[
            "log",
            "-1",
            "--no-show-signature",
            "--format=%B",
            &oid,
            "--",
        ],
    )?;
    // Trailing newlines are Git's own formatting, not part of the message.
    let message = message.trim_end_matches('\n').to_owned();
    let truncated = message.len() > 10_000;
    let subject = message.lines().next().unwrap_or_default().to_owned();
    let containing = git(
        &context.repository,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "--contains",
            &oid,
            "refs/remotes/",
        ],
    )?;
    Ok(Some(HeadCommit {
        oid,
        subject,
        message: if truncated { String::new() } else { message },
        truncated,
        published: !containing.trim().is_empty(),
    }))
}

/// An explicit rewrite of the current HEAD commit.
#[derive(Debug, Clone)]
pub struct AmendRequest {
    /// The commit the caller reviewed. A HEAD that moved since is refused
    /// rather than rewritten into something nobody looked at.
    pub expected_head: String,
    /// Acknowledges rewriting a commit a remote-tracking ref already contains.
    pub allow_published: bool,
}

/// `git commit [--amend] -m <message> [-- <paths>]`.
///
/// With `paths` the listed files are staged first (through the same validation
/// as `stage_paths`, so nothing outside the authorized workspace can be
/// committed) and the commit is scoped to them. Without `paths` whatever is
/// already staged is committed.
///
/// `amend` rewrites history and is therefore never implied: it needs the OID
/// the caller reviewed, and a commit any remote-tracking ref already contains
/// additionally needs an explicit acknowledgement. Nothing here force-pushes.
pub fn commit(
    workspace_root: &Path,
    requested: &str,
    message: &str,
    paths: Option<&[String]>,
    amend: Option<&AmendRequest>,
) -> AppResult<CommitResult> {
    let message = message.trim();
    if message.is_empty() || message.len() > 10_000 || message.contains('\0') {
        return Err(AppError::BadRequest("Commit message is invalid".into()));
    }
    let context = require_repository(workspace_root, requested)?;
    if let Some(amend) = amend {
        let current = head_commit(workspace_root, requested)?.ok_or_else(|| {
            AppError::Conflict("There is no commit to amend on this branch".into())
        })?;
        if current.oid != amend.expected_head {
            return Err(AppError::Conflict(
                "HEAD moved since the commit was reviewed; refresh before amending".into(),
            ));
        }
        if current.published && !amend.allow_published {
            return Err(AppError::Conflict(
                "This commit is already contained in a remote-tracking ref; amending rewrites published history and needs an explicit acknowledgement".into(),
            ));
        }
    }
    let committed = match paths {
        Some(paths) => stage_paths(workspace_root, requested, paths)?.staged,
        None => vec![],
    };

    let mut args: Vec<&str> = vec!["commit"];
    if amend.is_some() {
        args.push("--amend");
    }
    args.extend(["-m", message]);
    if !committed.is_empty() {
        args.push("--");
        args.extend(committed.iter().map(String::as_str));
    }
    let mut process = command::git_command();
    process.args(&args).current_dir(&context.repository);
    let output = command::run(process, Duration::from_secs(120))?;
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
            "Git could not commit: {}",
            command::sanitize(detail)
        )));
    }
    let summary = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let commit = git(&context.repository, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_owned();
    if let Some(amend) = amend {
        let current = git(&context.repository, &["rev-parse", "--verify", "HEAD"])?
            .trim()
            .to_owned();
        if current == amend.expected_head {
            return Err(AppError::Conflict(
                "Git reported success but HEAD still points at the original commit; inspect the repository".into(),
            ));
        }
    }
    Ok(CommitResult {
        commit,
        committed,
        summary,
    })
}

/* ---------------------------------- init ---------------------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub repository: bool,
    /// The unborn branch `git init` selected; None if Git left HEAD detached.
    pub branch: Option<String>,
    pub path: String,
}

/// `git init` for a workspace that does not belong to any repository yet.
///
/// A directory that already resolves to a Git directory — its own, an
/// ancestor's, or a bare one — is refused instead of nested: a second
/// repository inside an existing checkout silently shadows the outer index.
/// This is the one write path with no common Git directory to queue on,
/// because that queue key only exists once the repository does.
pub fn init_repository(workspace_root: &Path) -> AppResult<InitResult> {
    let root = canonical_directory(workspace_root)?;
    let mut probe = command::git_command();
    probe
        .args(["rev-parse", "--absolute-git-dir"])
        .current_dir(&root);
    let existing = command::run(probe, Duration::from_secs(30))?;
    if existing.status.success() {
        return Err(AppError::Conflict(
            "The workspace already belongs to a Git repository".into(),
        ));
    }
    let failure = String::from_utf8_lossy(&existing.stderr);
    if !failure.contains("not a git repository") {
        return Err(AppError::Internal(command::sanitize(&failure)));
    }
    git(&root, &["init"])?;
    // Report the repository Git actually created, never the request's intent.
    let context = repo_context(&root, ".")?
        .ok_or_else(|| AppError::Internal("Git did not create a working repository here".into()))?;
    if context.repository != root {
        return Err(AppError::Internal(
            "Git initialized a repository outside the workspace root".into(),
        ));
    }
    let branch = git(
        &context.repository,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .ok()
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty());
    Ok(InitResult {
        repository: true,
        branch,
        path: workspace_relative_root(&context.repository)?,
    })
}
