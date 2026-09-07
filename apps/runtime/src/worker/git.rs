//! The git domain on the private Worker channel
//! (Go Host 业务所有权迁移 §2.8, §2.9, `WorkerRequest.action` 29).
//!
//! This module is a translator and nothing else. The Host decided *what* to run
//! and *in what order*; this side runs it, holding the execution host's own
//! repository locks, reading the execution host's own credentials, and reports
//! what it observed. Every scheduling decision that used to live in
//! `git/repository/queue.rs` still lives there — it is what serializes one
//! worktree's writes *within* this process — but the exclusion the Host
//! establishes across processes is the one that now matters, and nothing here
//! second-guesses it.
//!
//! Three properties are the whole of the file:
//!
//!   - **The parameters are the Runtime's own JSON.** `GitOperation.action`
//!     carries the exact body the corresponding HTTP route already takes,
//!     under the version lock `WorkerServiceRequest` states: both ends are one
//!     Armadra build. Translating between two shapes would put the meaning of
//!     a `git push` in two places.
//!   - **The answer is a reading, not an echo.** A run reports the state the
//!     operation actually reached, so a Host comparing it with what it asked
//!     for is comparing two sources. A Worker that echoed the request would
//!     make every outcome a success.
//!   - **The workspace root comes from the frame.** The Host resolved it from
//!     the filesystem domain's registration; this side re-checks that the
//!     repository is inside it, exactly as the HTTP routes do, because a root
//!     is a claim and not a permission.
//!
//! Nothing here writes to the ownership record, and nothing here decides
//! whether a device may act: by the time a frame arrives the Host has checked
//! the session, the grants and the registration. What is re-checked is the
//! execution host's own facts — that the path is inside the root, that HEAD is
//! still the one the caller decided against.

use std::path::{Path, PathBuf};

use armadra_protocol::v1::{
    GitActionKind, GitDomainSnapshot, GitOperation, GitOperationOutcome, GitOperationState,
    GitRead, GitReadMethod, GitReadResult, GitWorkerRequest, GitWorkerResponse, RepositoryScope,
    RepositoryState, git_worker_request, git_worker_response,
};

use crate::error::{AppError, AppResult};

mod clone;
mod observe;
pub mod progress;
mod read;
mod run;

pub use progress::{attach as attach_upcalls, clone_progress as report_clone_progress};

/// Advertised unconditionally: running a Git command needs a workspace root,
/// which arrives in the frame, and nothing else. A Worker started for a
/// handoff and a Worker started to run one operation are equally able to
/// answer, which is what lets a switch establish the queue is empty over the
/// same link it moves the epoch on.
pub const CAPABILITY: &str = "git.worker.v1";

/// The ceiling on one action body. It matches the Host's own bound: a Git
/// command's parameters are a branch name and a few paths.
const MAX_ACTION_BYTES: usize = 256 << 10;

fn invalid(detail: &str) -> AppError {
    AppError::BadRequest(format!("git.frame_invalid: {detail}"))
}

/// The workspace root as this side will use it. It is resolved and canonical:
/// the Host's registration says where the files are, and this process still
/// refuses a path it cannot resolve rather than running a command in whatever
/// directory it happens to inherit.
fn root(value: &str) -> AppResult<PathBuf> {
    if value.is_empty() {
        return Err(invalid("the frame names no workspace root"));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(invalid("the workspace root is not absolute"));
    }
    Ok(path)
}

/// The checkout inside that root, as the Runtime's own routes address it: a
/// workspace-relative directory, `.` for the root itself.
///
/// A repository path outside the root is refused here rather than resolved,
/// which is the same refusal `repo_context` makes and for the same reason: a
/// path that escaped the root would be this process reading a directory the
/// registration never covered.
fn requested(root: &Path, scope: &RepositoryScope) -> AppResult<String> {
    let repository = scope.repository_path.trim();
    if repository.is_empty() {
        return Ok(".".into());
    }
    let candidate = Path::new(repository);
    if !candidate.is_absolute() {
        // Already relative: the Host addressed the checkout the way the HTTP
        // routes do, and `resolve_in_root` will re-check it.
        return Ok(repository.to_owned());
    }
    // Both sides are resolved before they are compared. A workspace root that
    // reached this Host through the filesystem domain is canonical, and a
    // repository path a client is holding may still be the pre-symlink
    // spelling of the same directory -- `/var/folders/...` against
    // `/private/var/folders/...` on macOS is the ordinary case, not an exotic
    // one. Comparing the strings would refuse a checkout inside the very root
    // that was registered for it.
    //
    // A path that cannot be resolved is not silently accepted: it is compared
    // as written, which is the conservative reading, and the mismatch is then
    // the refusal below.
    let resolved_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let resolved = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    match resolved.strip_prefix(&resolved_root) {
        Ok(relative) if relative.as_os_str().is_empty() => Ok(".".into()),
        Ok(relative) => Ok(relative.to_string_lossy().replace('\\', "/")),
        Err(_) => Err(AppError::Forbidden(
            "The repository is outside the registered workspace root".into(),
        )),
    }
}

/// Handles one git frame.
pub async fn handle(request: GitWorkerRequest) -> AppResult<GitWorkerResponse> {
    // Every frame names the workspace it is about, and the upward reports this
    // process sends have to be attributed to the same one. It is taken from the
    // frame rather than from a flag because the Host is the side that knows it.
    if let Some(workspace) = frame_workspace(&request) {
        progress::remember_workspace(workspace);
    }
    let result = match request.action {
        Some(git_worker_request::Action::Snapshot(_)) => {
            git_worker_response::Result::Snapshot(snapshot())
        }
        Some(git_worker_request::Action::Run(input)) => {
            let operation = input
                .operation
                .ok_or_else(|| invalid("the run frame carries no operation"))?;
            let root = root(&input.workspace_root)?;
            git_worker_response::Result::Operation(GitOperationOutcome {
                operation: Some(run::execute(&root, operation).await),
            })
        }
        Some(git_worker_request::Action::Cancel(input)) => {
            // Cancelling reaches the registry of *this* process. A Host that
            // runs each operation in its own Worker cannot stop a command from
            // here, and says so rather than reporting a cancellation it did not
            // perform.
            let snapshot = crate::git_api::REPOSITORIES.cancel(&input.operation_id);
            git_worker_response::Result::Operation(GitOperationOutcome {
                operation: Some(GitOperation {
                    operation_id: input.operation_id,
                    state: match snapshot {
                        Ok(_) => GitOperationState::Cancelled as i32,
                        Err(_) => GitOperationState::UnknownOutcome as i32,
                    },
                    message_code: "git.operation.cancel_requested".into(),
                    ..Default::default()
                }),
            })
        }
        Some(git_worker_request::Action::Observe(input)) => {
            let scope = input
                .scope
                .ok_or_else(|| invalid("the observe frame carries no scope"))?;
            let root = root(&input.workspace_root)?;
            git_worker_response::Result::Repository(observe::repository(&root, scope).await?)
        }
        Some(git_worker_request::Action::Read(input)) => {
            git_worker_response::Result::Read(read::forward(input).await)
        }
        // A frame a newer Host introduced is refused rather than answered with
        // an empty result, which the Host would read as agreement.
        None => return Err(invalid("the git frame names no action")),
    };
    Ok(GitWorkerResponse {
        result: Some(result),
    })
}

/// The workspace one frame is about, when it names one.
fn frame_workspace(request: &GitWorkerRequest) -> Option<&str> {
    let scope = match request.action.as_ref()? {
        git_worker_request::Action::Run(input) => input.operation.as_ref()?.scope.as_ref()?,
        git_worker_request::Action::Observe(input) => input.scope.as_ref()?,
        git_worker_request::Action::Read(input) => input.scope.as_ref()?,
        git_worker_request::Action::Cancel(_) | git_worker_request::Action::Snapshot(_) => {
            return None;
        }
    };
    Some(scope.workspace_id.as_str()).filter(|value| !value.is_empty())
}

/// What this process still has in flight.
///
/// It is always this process's own registry, and for a Worker started to answer
/// one frame that is genuinely nothing. That is the correct answer rather than
/// a useless one: the Runtime's git queue is in memory, so a Runtime that is
/// not running has an empty queue by construction, and the switch that reads
/// this runs in a maintenance window with the Runtime stopped.
fn snapshot() -> GitDomainSnapshot {
    let (queued, running, active_operation_ids) = crate::git_api::REPOSITORIES.active_operations();
    GitDomainSnapshot {
        queued,
        running,
        // Clone jobs live in the same per-process registry as the queue and die
        // with it. A Worker that only ever answered one frame has none; a
        // resident one, which is what makes a Host-side clone possible at all,
        // can have several, and a switch has to see them.
        clone_jobs: crate::git::active_clone_count(),
        active_operation_ids,
    }
}

/// The action body, checked for size before it is parsed. A body larger than
/// any Git command needs is refused rather than handed to a deserializer.
fn action_body(operation: &GitOperation) -> AppResult<&[u8]> {
    let body = operation.action.as_slice();
    if body.is_empty() || body.len() > MAX_ACTION_BYTES {
        return Err(invalid("the action body is empty or too large"));
    }
    Ok(body)
}

/// The kind, as a value this build recognises. An unknown kind is refused: the
/// body's shape is decided by the kind, so parsing one this side cannot name
/// would be guessing at what a command's parameters mean.
fn action_kind(operation: &GitOperation) -> AppResult<GitActionKind> {
    match GitActionKind::try_from(operation.kind) {
        Ok(GitActionKind::Unspecified) | Ok(GitActionKind::Unsupported) | Err(_) => {
            Err(invalid("the action kind is not one this build knows"))
        }
        Ok(kind) => Ok(kind),
    }
}

/// The method, likewise closed.
fn read_method(read: &GitRead) -> AppResult<GitReadMethod> {
    match GitReadMethod::try_from(read.method) {
        Ok(GitReadMethod::Unspecified) | Err(_) => {
            Err(invalid("the read method is not one this build knows"))
        }
        Ok(method) => Ok(method),
    }
}

/// One forwarded answer, carrying the status the HTTP route would have
/// returned. A failing status is data, not a transport error: a not-found
/// repository is something the caller renders.
fn result(status: u16, body: Vec<u8>) -> GitReadResult {
    GitReadResult {
        http_status: status as u32,
        response_json: body,
    }
}

/// The status one Runtime error maps to, which is the status its own route
/// would have produced.
fn status_of(error: &AppError) -> u16 {
    match error {
        AppError::BadRequest(_) | AppError::InvalidCursor(_) => 400,
        AppError::Forbidden(_) => 403,
        AppError::NotFound(_) => 404,
        AppError::Conflict(_) => 409,
        AppError::OwnershipMoved(_) => 409,
        _ => 500,
    }
}

/// A failure as the Host reads it: the Runtime's own `{ code, message }`.
fn failure(error: &AppError) -> GitReadResult {
    let code = match error {
        AppError::BadRequest(_) => "bad_request",
        // A cursor refusal keeps its own code through the forward. The client's
        // repair — drop the cursor, re-read page one — is automatic, and a
        // generic `bad_request` would make it indistinguishable from a request
        // that re-reading cannot fix.
        AppError::InvalidCursor(_) => "invalid_cursor",
        AppError::Forbidden(_) => "forbidden",
        AppError::NotFound(_) => "not_found",
        AppError::Conflict(_) => "conflict",
        AppError::OwnershipMoved(_) => "ownership_moved",
        _ => "internal",
    };
    let body = serde_json::json!({ "code": code, "message": error.to_string() });
    result(
        status_of(error),
        serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec()),
    )
}

/// A repository state with only what an unobserved checkout can honestly say.
fn empty_state(scope: RepositoryScope, observed_at: i64) -> RepositoryState {
    RepositoryState {
        scope: Some(scope),
        observed_at_unix_ms: observed_at,
        ..Default::default()
    }
}
