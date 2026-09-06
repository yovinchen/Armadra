//! The repository operation queue, scoped to the workspace that started it.
//!
//! The queue itself runs where the worktree is — in the Worker process for a
//! remote workspace, in this one otherwise. What never moves is the record of
//! *which workspace* owns an operation: a Worker can serve two workspaces
//! rooted in the same directory and has no way to tell them apart, so the map
//! below stays on the controller and every answer is filtered through it.

use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
};

use armadra_protocol::v1::WorkerServiceOperation;
use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};

use super::{REPOSITORIES, RepositoryQuery, StartOperation, proxied, workspace};
use crate::{
    AppState,
    error::{AppError, AppResult},
    git_repository::*,
    remote::{self, JsonAnswer, service},
};

/// Which workspace started which operation. Read by the integration
/// snapshot too, which redacts a session this workspace does not own.
pub(super) static OWNERS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The operations this workspace started that have not finished.
///
/// Used by the execution-host switch: a repository mutation this Runtime owns
/// is running against a path on the current host, and rebinding underneath it
/// would leave the operation writing somewhere the workspace no longer points
/// (remote completion design §3.3).
pub fn owned_operations(workspace_id: &str) -> AppResult<Vec<String>> {
    let owners = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
    Ok(owners
        .iter()
        .filter(|(operation, owner)| {
            owner.as_str() == workspace_id
                && REPOSITORIES
                    .operation(operation)
                    .is_ok_and(|snapshot| !snapshot.state.terminal())
        })
        .map(|(operation, _)| operation.clone())
        .collect())
}

pub async fn start(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<StartOperation>,
) -> AppResult<Json<OperationSnapshot>> {
    let workspace = workspace(&state, &id, true).await?;
    crate::git::access::require_execution(
        workspace.permissions.execute,
        "Git repository writes and synchronization",
    )?;
    match &request.action {
        RepositoryAction::ContinueIntegration { session_id, .. }
        | RepositoryAction::AbortIntegration { session_id, .. }
        | RepositoryAction::SkipIntegration { session_id, .. } => {
            scoped_operation(&state, &id, session_id, true).await?;
        }
        _ => {}
    }
    // Adding or removing a checkout changes the set of repositories under the
    // workspace. The scan is cached, and nothing else observes a worktree
    // appearing — `file.changed` only covers files an editor has open — so the
    // cache is dropped here and the next list rescans (roadmap §4.1).
    let rescans = matches!(
        request.action,
        RepositoryAction::CreateWorktree { .. } | RepositoryAction::RemoveWorktree { .. }
    );
    // The queue itself runs where the worktree is; what stays here is the
    // record of which workspace owns the operation, because that is a
    // controller concept and a Worker serving two workspaces has no way to
    // decide it.
    let result: OperationSnapshot = match remote::resolve(&state, &workspace)?.remote() {
        Some(worker) => {
            remote::read(
                worker,
                &workspace,
                WorkerServiceOperation::GitOperationStart,
                &service::git::StartOperationPayload {
                    path: request.path,
                    action: request.action,
                    expected: request.expected,
                },
            )
            .await?
        }
        None => {
            REPOSITORIES
                .start(
                    workspace.root_path.into(),
                    request.path,
                    request.action,
                    request.expected,
                )
                .await?
        }
    };
    if rescans {
        crate::git_discovery::invalidate(&id);
    }
    let mut owners = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
    // Only local records can be checked for liveness from here; a remote
    // operation's record lives in the Worker, and forgetting its owner would
    // make it unreachable rather than tidy.
    owners.retain(|operation, owner| owner != &id || REPOSITORIES.operation(operation).is_ok());
    owners.insert(result.id.clone(), id);
    Ok(Json(result))
}
pub async fn operations(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<Vec<OperationSnapshot>>> {
    let workspace = workspace(&state, &id, false).await?;
    let mut operations: Vec<OperationSnapshot> = match remote::resolve(&state, &workspace)?.remote()
    {
        Some(worker) => {
            remote::read(
                worker,
                &workspace,
                WorkerServiceOperation::GitOperations,
                &service::PathPayload {
                    path: query.path.clone(),
                },
            )
            .await?
        }
        None => {
            REPOSITORIES
                .with_execution(workspace.permissions.execute)
                .list_operations(Path::new(&workspace.root_path), &query.path)
                .await?
        }
    };
    let owners = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
    operations.retain(|operation| owners.get(&operation.id) == Some(&id));
    Ok(Json(operations))
}
/// The workspace an operation belongs to, having proved that it does. Used by
/// the actions that then have to know *where* the workspace runs.
async fn scoped_workspace(
    state: &AppState,
    workspace_id: &str,
    operation_id: &str,
    write: bool,
) -> AppResult<crate::model::Workspace> {
    scoped_operation(state, workspace_id, operation_id, write).await?;
    workspace(state, workspace_id, write).await
}

async fn scoped_operation(
    state: &AppState,
    workspace_id: &str,
    operation_id: &str,
    write: bool,
) -> AppResult<OperationSnapshot> {
    let workspace = workspace(state, workspace_id, write).await?;
    let owner = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?
        .get(operation_id)
        .cloned();
    if owner.as_deref() != Some(workspace_id) {
        return Err(AppError::NotFound(
            "Git operation not found in this workspace".into(),
        ));
    }
    let (operation, root) = match remote::resolve(state, &workspace)?.remote() {
        Some(worker) => {
            let operation: OperationSnapshot = remote::read(
                worker,
                &workspace,
                WorkerServiceOperation::GitOperationGet,
                &service::git::OperationPayload {
                    id: operation_id.to_owned(),
                },
            )
            .await?;
            // The root the Worker reports is already canonical on its own
            // machine, and the workspace's stored path is that same canonical
            // path, so comparing them is the same check as locally.
            (operation, std::path::PathBuf::from(&workspace.root_path))
        }
        None => (
            REPOSITORIES.operation(operation_id)?,
            crate::security::canonical_directory(&workspace.root_path)?,
        ),
    };
    if root != Path::new(&operation.workspace_root) {
        return Err(AppError::NotFound(
            "Git operation not found in this workspace".into(),
        ));
    }
    Ok(operation)
}
pub async fn operation(
    State(state): State<AppState>,
    AxumPath((workspace_id, id)): AxumPath<(String, String)>,
) -> AppResult<Json<OperationSnapshot>> {
    let snapshot = scoped_operation(&state, &workspace_id, &id, false).await?;
    // A worktree operation only changes the set of checkouts once it actually
    // finishes, and `start` fires before that. Dropping the cache here means
    // the client's next repository list — the one it reads right after seeing
    // this state — rescans rather than reporting the checkout as missing.
    if snapshot.state.terminal()
        && matches!(
            snapshot.action,
            RepositoryAction::CreateWorktree { .. } | RepositoryAction::RemoveWorktree { .. }
        )
    {
        crate::git_discovery::invalidate(&workspace_id);
    }
    Ok(Json(snapshot))
}
pub async fn cancel(
    State(state): State<AppState>,
    AxumPath((workspace_id, id)): AxumPath<(String, String)>,
) -> AppResult<JsonAnswer> {
    let workspace = scoped_workspace(&state, &workspace_id, &id, true).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitOperationCancel,
        &service::git::OperationPayload { id: id.clone() },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(&REPOSITORIES.cancel(&id)?)
}
