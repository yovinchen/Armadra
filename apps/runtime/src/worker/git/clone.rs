//! Clones on the Worker channel (Git 设计 §3 Init/Clone, business migration
//! §2.8).
//!
//! A clone is the one thing in this domain with no repository behind it. There
//! is nothing to lock, no worktree to serialize against and no precondition to
//! have been decided against, which is why it travels on the read channel and
//! never enters the Host's queue.
//!
//! What it *does* have is a lifetime longer than the frame that starts it. The
//! job lives in this process's registry and its `git` child keeps running after
//! the answer has been written, so the Host has to hold this Worker open to
//! poll it — a resident clone Worker, which is exactly what
//! `cmd/armadra-host/git.go` keeps for these three methods. A Worker started
//! per operation would begin a clone that no later process could reach, which
//! is why this used to answer UNSUPPORTED.
//!
//! The URL is the other thing worth stating. It arrives here and goes no
//! further: what leaves is the redacted form, produced by this side because
//! this is the side that held the original. A `https://user:token@host/repo`
//! that reached the Host's database would turn a row read into a credential
//! leak.

use std::path::{Path, PathBuf};

use armadra_protocol::v1::{GitOperationState, GitReadResult};
use serde::{Deserialize, Serialize};

use super::{invalid, progress, result};
use crate::{
    error::{AppError, AppResult},
    git,
    security::resolve_in_root,
};

/// What the Host sends to start one. It is the same version-locked JSON every
/// other forwarded read uses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBody {
    url: String,
    /// Where the clone should land, workspace-relative. Empty lets the
    /// directory name be derived from the URL, which is what the dialog does
    /// when a person leaves the field alone.
    #[serde(default)]
    target_path: Option<String>,
}

/// The answer, in the shape `githost/clone.go` decodes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    job_id: String,
    /// Credentials already removed, by the side that held them.
    display_url: String,
    target_path: String,
    progress: u32,
    /// `running`, `succeeded`, `failed` or `cancelled`.
    state: &'static str,
    message_code: String,
}

fn answer(outcome: &Outcome) -> AppResult<GitReadResult> {
    let body = serde_json::to_vec(outcome)
        .map_err(|_| AppError::Internal("The clone answer could not be encoded".into()))?;
    Ok(result(200, body))
}

/// The three terminal words the Host's own enum uses, plus `running`.
///
/// A cancelled clone is not a failed one: the directory it was writing was left
/// where it is on purpose, and telling a person "the clone failed" would send
/// them looking for a reason that does not exist.
fn state_of(status: &git::CloneStatus) -> &'static str {
    match status.state {
        git::CloneState::Running => "running",
        git::CloneState::Done => "succeeded",
        git::CloneState::Error if status.cancelled => "cancelled",
        git::CloneState::Error => "failed",
    }
}

fn message_of(status: &git::CloneStatus) -> String {
    match status.state {
        git::CloneState::Running => "git.clone.running".into(),
        git::CloneState::Done => "git.clone.succeeded".into(),
        git::CloneState::Error if status.cancelled => "git.clone.cancelled".into(),
        git::CloneState::Error => "git.clone.failed".into(),
    }
}

/// The clone's destination, resolved inside the registered workspace root.
///
/// The Host said where the files are; this side decides that the target is
/// under it. A caller-supplied absolute path is refused rather than resolved,
/// which is the same rule every other git frame follows: a root is a claim, not
/// a permission.
fn destination(workspace: &Path, target: Option<&str>) -> AppResult<(PathBuf, Option<String>)> {
    let requested = target.map(str::trim).unwrap_or_default();
    if requested.is_empty() {
        // No destination named: the parent is the workspace root and the
        // directory name comes from the URL, which is what the dialog does.
        return Ok((resolve_in_root(workspace, ".")?, None));
    }
    if Path::new(requested).is_absolute() {
        return Err(AppError::BadRequest(
            "A clone destination is workspace-relative".into(),
        ));
    }
    let (parent, name) = match requested.trim_end_matches('/').rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => (".", requested),
    };
    if name.is_empty() {
        return Err(AppError::BadRequest(
            "A clone destination names no directory".into(),
        ));
    }
    // Only the parent is resolved: the destination itself must not exist yet,
    // and `start_clone` is what creates it after checking that.
    Ok((resolve_in_root(workspace, parent)?, Some(name.to_owned())))
}

/// The source, as this side will hand it to `git clone`.
///
/// A remote URL goes through the Runtime's own allowlist unchanged: `https://`,
/// `ssh://` and the scp-like form, and nothing else — `ext::` and friends are
/// refused there for the reason they have always been refused.
///
/// A **local** source is the one thing this path allows that the HTTP route
/// does not, and the difference is the registered root. The HTTP route clones
/// into a parent directory the caller names, so a local source there would be
/// one arbitrary path copied to another. Here both ends are inside the root the
/// filesystem domain registered for this workspace, which is what makes cloning
/// a bare mirror that sits beside the project — the ordinary way to work
/// offline, and the shape a `git worktree`-style layout already has — a
/// bounded operation rather than an open one.
fn source(workspace: &Path, url: &str) -> AppResult<String> {
    if let Ok(remote) = git::validate_clone_url(url) {
        return Ok(remote);
    }
    let candidate = if Path::new(url).is_absolute() {
        let resolved = std::fs::canonicalize(url)
            .map_err(|_| AppError::BadRequest("Repository URL is invalid".into()))?;
        let root = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf());
        if !resolved.starts_with(&root) {
            return Err(AppError::Forbidden(
                "A local clone source must be inside the workspace".into(),
            ));
        }
        resolved
    } else {
        resolve_in_root(workspace, url)?
    };
    if !candidate.is_dir() {
        return Err(AppError::BadRequest("Repository URL is invalid".into()));
    }
    candidate
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::BadRequest("Clone source must be a UTF-8 path".into()))
}

/// Starts one clone and answers with the job the Host will poll.
pub async fn start(workspace: &Path, request_json: &[u8]) -> AppResult<GitReadResult> {
    let body: StartBody = serde_json::from_slice(request_json)
        .map_err(|error| invalid(&format!("the clone body does not parse: {error}")))?;
    let (parent, name) = destination(workspace, body.target_path.as_deref())?;
    let parent = parent
        .to_str()
        .ok_or_else(|| AppError::BadRequest("Clone destination must be a UTF-8 path".into()))?
        .to_owned();
    let url = source(workspace, body.url.trim())?;
    let started =
        tokio::task::spawn_blocking(move || git::start_clone_from(&url, &parent, name.as_deref()))
            .await
            .map_err(|_| AppError::Internal("The clone could not be started".into()))??;
    // The status is read back rather than assembled from the request: the
    // redacted URL and the resolved target are facts this process produced, and
    // reporting the request's own values would report what was asked for
    // instead of what happened.
    let status = git::clone_status(&started.job_id)?;
    watch(started.job_id.clone());
    answer(&Outcome {
        job_id: started.job_id,
        display_url: status.display_url.clone(),
        target_path: status.target.to_string_lossy().into_owned(),
        progress: status.percent,
        state: state_of(&status),
        message_code: message_of(&status),
    })
}

/// One clone's current state.
pub fn status(job_id: &str) -> AppResult<GitReadResult> {
    let status = git::clone_status(job_id)?;
    answer(&Outcome {
        job_id: job_id.to_owned(),
        display_url: status.display_url.clone(),
        target_path: status.target.to_string_lossy().into_owned(),
        progress: status.percent,
        state: state_of(&status),
        message_code: message_of(&status),
    })
}

/// Asks the clone to stop. The partial destination is kept: it is a directory a
/// person named, and deleting it on the way out of a cancellation is how a
/// cancel becomes a data loss.
pub fn cancel(job_id: &str) -> AppResult<GitReadResult> {
    git::cancel_clone(job_id)?;
    status(job_id)
}

/// Watches one job to its end so the Host learns it finished without polling.
///
/// It is a supplement to `GetClone`, never a replacement: the Host still reads
/// the job when it is asked to, because an upcall that never arrives must cost
/// a slower answer rather than a job that appears to run forever.
fn watch(job_id: String) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    handle.spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let Ok(status) = git::clone_status(&job_id) else {
                return;
            };
            if status.state == git::CloneState::Running {
                continue;
            }
            progress::clone_finished(
                &job_id,
                &status.target.to_string_lossy(),
                match status.state {
                    git::CloneState::Done => GitOperationState::Succeeded,
                    _ if status.cancelled => GitOperationState::Cancelled,
                    _ => GitOperationState::Failed,
                },
                &message_of(&status),
            );
            return;
        }
    });
}
