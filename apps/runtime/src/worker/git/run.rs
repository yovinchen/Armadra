//! Running one queued operation (business migration §2.8, Git 设计 §10).
//!
//! Everything here goes through the same code the HTTP routes use. That is the
//! point: a `git commit` issued through the Host must be the same commit,
//! validated the same way, as one issued through the Runtime, or the switch
//! would change behaviour rather than move ownership.
//!
//! The outcome is read rather than assumed. A repository action is handed to
//! `RepositoryService::start`, which is where the preconditions are re-checked
//! and the repository lock is held, and then the operation is *observed* until
//! it reaches a final state — including `AWAITING_RESOLUTION`, which is a
//! conflict waiting for a person and not a failure.
//!
//! The one state this file will not produce is a lie. A command whose result
//! could not be read reports `UNKNOWN_OUTCOME`, and a caller cannot tell that
//! apart from any other unknown outcome, which is correct: they are the same
//! situation.

use std::path::Path;

use armadra_protocol::v1::{GitActionKind, GitOperation, GitOperationState};
use serde::Deserialize;
use tokio::time::{Duration, sleep};

use super::{action_body, action_kind, invalid, requested};
use crate::{
    error::{AppError, AppResult},
    git,
    git_repository::{ExpectedState, OperationState, RepositoryAction},
};

/// The body a repository action carries: exactly `StartOperation`, which is
/// what `POST /git/repository/operations` already takes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryBody {
    #[serde(default = "dot")]
    path: String,
    action: RepositoryAction,
    #[serde(default)]
    expected: ExpectedStateBody,
}

/// `ExpectedState` with a default, so an action that names no precondition is a
/// body this side can still read. The service refuses the ones that need one.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedStateBody {
    #[serde(default)]
    head_oid: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathsBody {
    paths: Vec<String>,
    #[serde(default = "dot")]
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreBody {
    paths: Vec<String>,
    #[serde(default = "dot")]
    path: String,
    #[serde(default)]
    source: git::RestoreSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitBody {
    message: String,
    #[serde(default)]
    paths: Option<Vec<String>>,
    #[serde(default = "dot")]
    path: String,
    #[serde(default)]
    amend: Option<AmendBody>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AmendBody {
    expected_head: String,
    #[serde(default)]
    allow_published: bool,
}

/// `git init` takes no parameters at all: it initialises the workspace root, or
/// refuses because the root already belongs to a repository. The body is still
/// parsed so an action carrying arguments nobody reads is refused rather than
/// silently ignored — a caller that thought it was initialising a subdirectory
/// has to be told it was not.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyBody {}

fn dot() -> String {
    ".".into()
}

fn parse<'a, T: Deserialize<'a>>(body: &'a [u8]) -> AppResult<T> {
    serde_json::from_slice(body)
        .map_err(|error| invalid(&format!("the action body does not parse: {error}")))
}

/// How long one operation may run before this side stops watching it. The Host
/// bounds the frame too; this bound exists so a wedged `git` reports an unknown
/// outcome rather than holding the frame until the connection dies, which would
/// look the same to the Host but leave nothing to read.
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Runs one operation and answers with what happened.
pub async fn execute(root: &Path, operation: GitOperation) -> GitOperation {
    let id = operation.operation_id.clone();
    match run(root, &operation).await {
        Ok(outcome) => outcome,
        Err(error) => GitOperation {
            operation_id: id,
            state: state_for(&error) as i32,
            message_code: message_for(&error),
            ..Default::default()
        },
    }
}

/// A refused command is a failure; an interrupted one is unknown. The
/// distinction is the whole of this domain, so it is made once, here, from the
/// error the Runtime itself produced rather than from a guess about what the
/// process did.
fn state_for(error: &AppError) -> GitOperationState {
    match error {
        AppError::BadRequest(_) | AppError::Forbidden(_) | AppError::NotFound(_) => {
            GitOperationState::Failed
        }
        AppError::Conflict(_) => GitOperationState::Failed,
        _ => GitOperationState::UnknownOutcome,
    }
}

fn message_for(error: &AppError) -> String {
    match error {
        AppError::BadRequest(_) => "git.operation.rejected".into(),
        AppError::Forbidden(_) => "git.operation.forbidden".into(),
        AppError::NotFound(_) => "git.operation.not_found".into(),
        // A conflict is the precondition failing: an external `git` moved HEAD
        // or the index between the decision and the execution. It is named
        // rather than folded into a generic failure, because it is the one a
        // person acts on by reloading and deciding again.
        AppError::Conflict(_) => "git.operation.conflict".into(),
        _ => "git.operation.interrupted".into(),
    }
}

async fn run(root: &Path, operation: &GitOperation) -> AppResult<GitOperation> {
    let body = action_body(operation)?;
    let kind = action_kind(operation)?;
    let scope = operation
        .scope
        .clone()
        .ok_or_else(|| invalid("the operation carries no scope"))?;
    let checkout = requested(root, &scope)?;
    let id = operation.operation_id.clone();
    let workspace = root.to_path_buf();

    let (affected, state, message) = match kind {
        GitActionKind::Stage => {
            let request: PathsBody = parse(body)?;
            let path = resolve(&checkout, &request.path);
            let result =
                blocking(move || git::stage_paths(&workspace, &path, &request.paths)).await?;
            (result.staged, GitOperationState::Succeeded, String::new())
        }
        GitActionKind::Unstage => {
            let request: PathsBody = parse(body)?;
            let path = resolve(&checkout, &request.path);
            let result =
                blocking(move || git::unstage_paths(&workspace, &path, &request.paths)).await?;
            (result.unstaged, GitOperationState::Succeeded, String::new())
        }
        GitActionKind::MarkResolved => {
            let request: PathsBody = parse(body)?;
            let path = resolve(&checkout, &request.path);
            let result =
                blocking(move || git::mark_resolved(&workspace, &path, &request.paths)).await?;
            (result.resolved, GitOperationState::Succeeded, String::new())
        }
        GitActionKind::Restore => {
            let request: RestoreBody = parse(body)?;
            let path = resolve(&checkout, &request.path);
            let source = request.source;
            let result =
                blocking(move || git::revert_paths(&workspace, &path, &request.paths, source))
                    .await?;
            (result.reverted, GitOperationState::Succeeded, String::new())
        }
        GitActionKind::Commit => {
            let request: CommitBody = parse(body)?;
            let path = resolve(&checkout, &request.path);
            let result = blocking(move || {
                let amend = request.amend.map(|amend| git::AmendRequest {
                    expected_head: amend.expected_head,
                    allow_published: amend.allow_published,
                });
                git::commit(
                    &workspace,
                    &path,
                    &request.message,
                    request.paths.as_deref(),
                    amend.as_ref(),
                )
            })
            .await?;
            (
                vec![result.commit],
                GitOperationState::Succeeded,
                String::new(),
            )
        }
        GitActionKind::Init => {
            let _: EmptyBody = parse(body)?;
            let result = blocking(move || git::init_repository(&workspace)).await?;
            (
                vec![result.path],
                GitOperationState::Succeeded,
                String::new(),
            )
        }
        GitActionKind::ApplyHunk => {
            let request: crate::git_hunks::GitHunkMutation = parse(body)?;
            let file = request.file.clone();
            crate::git_hunks::apply_hunk(&workspace, request).await?;
            (vec![file], GitOperationState::Succeeded, String::new())
        }
        // Everything else is a repository action, which is where the
        // preconditions and the repository lock live.
        _ => {
            let request: RepositoryBody = parse(body)?;
            let path = resolve(&checkout, &request.path);
            let expected = ExpectedState {
                head_oid: request.expected.head_oid,
                branch: request.expected.branch,
            };
            let started = crate::git_api::REPOSITORIES
                .start(workspace, path, request.action, expected)
                .await?;
            let settled = await_settled(&started.id, &id, &scope.repository_path).await?;
            (
                Vec::new(),
                match settled.state {
                    OperationState::Succeeded => GitOperationState::Succeeded,
                    OperationState::Failed => GitOperationState::Failed,
                    OperationState::Cancelled => GitOperationState::Cancelled,
                    OperationState::AwaitingResolution => GitOperationState::AwaitingResolution,
                    // Queued and Running are not reachable here -- the loop
                    // above only returns on a terminal state -- and mapping
                    // them to anything but "unknown" would be an invention.
                    _ => GitOperationState::UnknownOutcome,
                },
                settled
                    .message
                    .map(|_| "git.operation.reported".to_string())
                    .unwrap_or_default(),
            )
        }
    };
    Ok(GitOperation {
        operation_id: id,
        affected,
        progress: 100,
        state: state as i32,
        message_code: message,
        ..Default::default()
    })
}

/// The checkout the Host addressed, refined by the body's own `path`.
///
/// The Host names the checkout in the scope, and the Runtime's request bodies
/// carry a `path` of their own. When the body says nothing but `.`, the scope
/// wins; when it names something, it is taken relative to the scope. Two
/// disagreeing paths must not silently resolve to whichever is read last.
fn resolve(checkout: &str, body: &str) -> String {
    if body == "." || body.is_empty() {
        return checkout.to_owned();
    }
    if checkout == "." {
        return body.to_owned();
    }
    format!("{}/{}", checkout.trim_end_matches('/'), body)
}

async fn blocking<T, F>(action: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(action)
        .await
        .map_err(|_| AppError::Internal("The Git command could not be joined".into()))?
}

/// Waits for one repository operation to reach a final state, reporting what it
/// sees on the way (Git 设计 §10, 进度).
///
/// The service already runs it in the background and records what happened, so
/// this is a read loop rather than a second execution path: whatever the
/// operation ends as is what this reports, including a conflict that stopped
/// for a person.
///
/// The loop is also where progress leaves this process. It is reported only
/// when the number *changed*, so a fetch that spends a minute on one phase
/// costs one frame rather than two thousand four hundred, and the Host's own
/// rule — never backwards, never onto a settled entry — is what makes a frame
/// that arrives late harmless.
async fn await_settled(
    id: &str,
    operation_id: &str,
    repository_path: &str,
) -> AppResult<crate::git_repository::OperationSnapshot> {
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    let mut reported = 0;
    loop {
        let snapshot = crate::git_api::REPOSITORIES.operation(id)?;
        if snapshot.state.terminal() {
            return Ok(snapshot);
        }
        if snapshot.progress > reported {
            reported = snapshot.progress;
            super::progress::operation_progress(operation_id, repository_path, reported);
        }
        if tokio::time::Instant::now() >= deadline {
            // The command is still running and this side has stopped watching.
            // Reporting anything but "unknown" would be a claim about a process
            // that has not finished.
            return Err(AppError::Internal(
                "The Git operation did not finish in time".into(),
            ));
        }
        sleep(Duration::from_millis(25)).await;
    }
}
