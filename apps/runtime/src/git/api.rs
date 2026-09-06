//! Repository operations stay scoped to an authorized workspace at every poll.
//!
//! Every panel here runs where the repository is. On a remote workspace that
//! means the whole panel is proxied to the execution host (remote completion
//! design section 3.1): the mutation queue, the repository lock ordering and
//! the `git` invocations all live next to the worktree they serialize, and
//! this process keeps only the bookkeeping that says which workspace started
//! which operation. What a caller sees is the execution host's own status and
//! body, so a conflict on that machine reaches the panel as a conflict.
use armadra_protocol::v1::WorkerServiceOperation;

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    git_repository::*,
    remote::{self, JsonAnswer, service},
};
use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
};

static OWNERS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub static REPOSITORIES: LazyLock<RepositoryService> = LazyLock::new(RepositoryService::new);

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HunkQuery {
    file: String,
    scope: crate::git_hunks::GitHunkScope,
}

pub async fn message_providers(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Vec<crate::git_message::GitMessageProvider>>> {
    let workspace = workspace(&state, &id, false).await?;
    crate::git::access::require_execution(workspace.permissions.execute, "AI provider inspection")?;
    crate::git_message::providers().await.map(Json)
}
pub async fn message_source(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitMessageSource,
        &service::git::RootPayload {},
    )
    .await?
    {
        return Ok(answer);
    }
    crate::git::access::require_execution(
        workspace.permissions.execute,
        "AI staged-source inspection",
    )?;
    JsonAnswer::local(&crate::git_message::source(Path::new(&workspace.root_path)).await?)
}
pub async fn message_generate(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<crate::git_message::GitMessageRequest>,
) -> AppResult<Json<crate::git_message::GitMessageDraft>> {
    let workspace = workspace(&state, &id, false).await?;
    // The one panel action that is not proxied. Drafting runs a provider CLI
    // configured on this machine against a diff on the other one, and there is
    // no operation that splits it in two; saying so is better than running the
    // CLI against the controller's own disk.
    crate::remote::refuse_remote(&workspace, "Drafting a commit message with AI")?;
    crate::git::access::require_execution(workspace.permissions.execute, "AI generation")?;
    crate::git_message::generate(Path::new(&workspace.root_path), request)
        .await
        .map(Json)
}

pub async fn hunks(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HunkQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitHunks,
        &service::git::HunksPayload {
            file: query.file.clone(),
            scope: query.scope,
        },
    )
    .await?
    {
        return Ok(answer);
    }
    crate::git::access::require_execution(
        workspace.permissions.execute,
        "Git hunk worktree validation",
    )?;
    JsonAnswer::local(
        &crate::git_hunks::read_hunks(Path::new(&workspace.root_path), &query.file, query.scope)
            .await?,
    )
}

pub async fn apply_hunk(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<crate::git_hunks::GitHunkMutation>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, true).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitApplyHunk,
        &request,
    )
    .await?
    {
        return Ok(answer);
    }
    crate::git::access::require_execution(workspace.permissions.execute, "Git hunk writes")?;
    JsonAnswer::local(
        &crate::git_hunks::apply_hunk(Path::new(&workspace.root_path), request).await?,
    )
}

#[derive(Deserialize)]
pub struct RepositoryQuery {
    #[serde(default = "root_path")]
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StashQuery {
    #[serde(default = "root_path")]
    path: String,
    oid: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CherryPickQuery {
    #[serde(default = "root_path")]
    path: String,
    oid: String,
    mainline: Option<u32>,
}
pub async fn cherry_pick_preview(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<CherryPickQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitCherryPickPreview,
        &service::git::CherryPickPayload {
            path: query.path.clone(),
            oid: query.oid.clone(),
            mainline: query.mainline,
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .cherry_pick_preview(
                Path::new(&workspace.root_path),
                &query.path,
                &query.oid,
                query.mainline,
            )
            .await?,
    )
}
pub async fn stashes(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitStashes,
        &service::PathPayload {
            path: query.path.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .stashes(Path::new(&workspace.root_path), &query.path)
            .await?,
    )
}
pub async fn integration(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<IntegrationSnapshot>> {
    let workspace = workspace(&state, &id, false).await?;
    // Read wherever the repository is, but decide ownership here: the map of
    // which workspace started which session is the controller's, and a Worker
    // serving two workspaces must not be asked to keep it.
    let mut result = match remote::resolve(&state, &workspace)?.remote() {
        Some(worker) => {
            remote::read(
                worker,
                &workspace,
                WorkerServiceOperation::GitIntegration,
                &service::PathPayload {
                    path: query.path.clone(),
                },
            )
            .await?
        }
        None => {
            REPOSITORIES
                .with_execution(workspace.permissions.execute)
                .integration_status(Path::new(&workspace.root_path), &query.path)
                .await?
        }
    };
    let owners = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
    if result
        .session_id
        .as_ref()
        .and_then(|session| owners.get(session))
        != Some(&id)
    {
        result.owned = false;
        result.session_id = None;
        result.can_continue = false;
        result.can_skip = false;
        result.mainline = None;
        result.original_head = None;
    }
    Ok(Json(result))
}
pub async fn stash_detail(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<StashQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitStashDetail,
        &service::git::StashDetailPayload {
            path: query.path.clone(),
            oid: query.oid.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .stash_detail(Path::new(&workspace.root_path), &query.path, &query.oid)
            .await?,
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RepositoryListQuery {
    /// How deep below the workspace root the scan looks. Defaults to
    /// `git_discovery::DEFAULT_MAX_DEPTH`; the module caps it.
    max_depth: Option<usize>,
    /// Force a rescan instead of answering from the cache.
    #[serde(default)]
    refresh: bool,
}

/// `GET /api/workspaces/{id}/git/repositories` — every repository under the
/// workspace root, roadmap §4.1. The scan itself is filesystem-only; only the
/// dirty count needs Git, so it is omitted without an execution grant rather
/// than failing the request.
pub async fn repositories(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryListQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitRepositories,
        &service::git::RepositoriesPayload {
            max_depth: query.max_depth,
            refresh: query.refresh,
        },
    )
    .await?
    {
        return Ok(answer);
    }
    if query.refresh {
        crate::git_discovery::invalidate(&id);
    }
    let execute = workspace.permissions.execute;
    let root = workspace.root_path.clone();
    let depth = query.max_depth;
    let list = tokio::task::spawn_blocking(move || {
        crate::git_discovery::repositories(&id, Path::new(&root), depth, execute)
    })
    .await
    .map_err(|_| AppError::Internal("Repository discovery did not finish".into()))??;
    JsonAnswer::local(&list)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitDetailQuery {
    #[serde(default = "root_path")]
    path: String,
    oid: String,
    /// What the commit is compared against. Absent means its first parent;
    /// the graph's "compare to current" sends `HEAD`.
    base: Option<String>,
}

/// The files one commit changed (§4.1). Separate from the patch read, because
/// a commit can touch thousands of files.
pub async fn commit_detail(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<CommitDetailQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitCommitDetail,
        &service::git::CommitPayload {
            path: query.path.clone(),
            oid: query.oid.clone(),
            base: query.base.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .commit_detail(
                Path::new(&workspace.root_path),
                &query.path,
                &query.oid,
                query.base.as_deref(),
            )
            .await?,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitFileQuery {
    #[serde(default = "root_path")]
    path: String,
    oid: String,
    base: Option<String>,
    file: String,
}

pub async fn commit_file_diff(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<CommitFileQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitCommitFileDiff,
        &service::git::CommitFilePayload {
            path: query.path.clone(),
            oid: query.oid.clone(),
            base: query.base.clone(),
            file: query.file.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .commit_file_diff(
                Path::new(&workspace.root_path),
                &query.path,
                &query.oid,
                query.base.as_deref(),
                &query.file,
            )
            .await?,
    )
}

fn head_reference() -> String {
    "HEAD".into()
}
fn history_limit() -> usize {
    50
}
fn root_path() -> String {
    ".".into()
}
#[derive(Deserialize)]
pub struct RepositoryHistoryQuery {
    #[serde(default = "root_path")]
    path: String,
    #[serde(default = "head_reference")]
    reference: String,
    #[serde(default = "history_limit")]
    limit: usize,
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartOperation {
    #[serde(default = "root_path")]
    path: String,
    action: RepositoryAction,
    expected: ExpectedState,
}

async fn workspace(state: &AppState, id: &str, write: bool) -> AppResult<crate::model::Workspace> {
    let workspace = db::get_workspace(&state.pool, id).await?;
    if !workspace.permissions.read || (write && !workspace.permissions.write) {
        return Err(AppError::Forbidden(
            "Workspace does not allow this Git operation".into(),
        ));
    }
    Ok(workspace)
}

/// Proxy one panel read or write to the execution host, or `None` when the
/// workspace runs here. A helper because every handler below needs exactly
/// these three lines, and getting one of them wrong would mean answering about
/// the controller's own disk.
async fn proxied<T: serde::Serialize>(
    state: &AppState,
    workspace: &crate::model::Workspace,
    operation: WorkerServiceOperation,
    payload: &T,
) -> AppResult<Option<JsonAnswer>> {
    match remote::resolve(state, workspace)?.remote() {
        Some(worker) => remote::proxy(worker, workspace, operation, payload)
            .await
            .map(Some),
        None => Ok(None),
    }
}

pub async fn branches(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitBranches,
        &service::PathPayload {
            path: query.path.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .branches(Path::new(&workspace.root_path), &query.path)
            .await?,
    )
}
pub async fn history(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryHistoryQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitHistory,
        &service::git::HistoryPayload {
            path: query.path.clone(),
            reference: query.reference.clone(),
            limit: query.limit,
            cursor: query.cursor.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .history(
                Path::new(&workspace.root_path),
                &query.path,
                HistoryRequest {
                    reference: query.reference,
                    limit: query.limit,
                    cursor: query.cursor,
                },
            )
            .await?,
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RebaseTodoQuery {
    #[serde(default = "root_path")]
    path: String,
    onto: String,
}
/// The commits an interactive rebase would replay, in todo order.
pub async fn rebase_todo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RebaseTodoQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitRebaseTodo,
        &service::git::RebaseTodoPayload {
            path: query.path.clone(),
            onto: query.onto.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .rebase_todo_preview(Path::new(&workspace.root_path), &query.path, &query.onto)
            .await?,
    )
}
pub async fn tags(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitTags,
        &service::PathPayload {
            path: query.path.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .tags(Path::new(&workspace.root_path), &query.path)
            .await?,
    )
}
/// Remote URLs are redacted before they leave the service; Armadra stores none
/// of them, and a redacted value must not be sent back as an update.
pub async fn remotes(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitRemotes,
        &service::PathPayload {
            path: query.path.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .remote_records(Path::new(&workspace.root_path), &query.path)
            .await?,
    )
}
pub async fn worktrees(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<JsonAnswer> {
    let workspace = workspace(&state, &id, false).await?;
    if let Some(answer) = proxied(
        &state,
        &workspace,
        WorkerServiceOperation::GitWorktrees,
        &service::PathPayload {
            path: query.path.clone(),
        },
    )
    .await?
    {
        return Ok(answer);
    }
    JsonAnswer::local(
        &REPOSITORIES
            .with_execution(workspace.permissions.execute)
            .worktrees(Path::new(&workspace.root_path), &query.path)
            .await?,
    )
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
