//! Repository operations stay scoped to an authorized workspace at every poll.
use crate::{
    AppState, db,
    error::{AppError, AppResult},
    git_repository::*,
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
) -> AppResult<Json<crate::git_message::GitMessageSource>> {
    let workspace = workspace(&state, &id, false).await?;
    crate::git::access::require_execution(
        workspace.permissions.execute,
        "AI staged-source inspection",
    )?;
    crate::git_message::source(Path::new(&workspace.root_path))
        .await
        .map(Json)
}
pub async fn message_generate(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<crate::git_message::GitMessageRequest>,
) -> AppResult<Json<crate::git_message::GitMessageDraft>> {
    let workspace = workspace(&state, &id, false).await?;
    crate::git::access::require_execution(workspace.permissions.execute, "AI generation")?;
    crate::git_message::generate(Path::new(&workspace.root_path), request)
        .await
        .map(Json)
}

pub async fn hunks(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HunkQuery>,
) -> AppResult<Json<crate::git_hunks::GitHunkDiff>> {
    let workspace = workspace(&state, &id, false).await?;
    crate::git::access::require_execution(
        workspace.permissions.execute,
        "Git hunk worktree validation",
    )?;
    crate::git_hunks::read_hunks(Path::new(&workspace.root_path), &query.file, query.scope)
        .await
        .map(Json)
}

pub async fn apply_hunk(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<crate::git_hunks::GitHunkMutation>,
) -> AppResult<Json<crate::git_hunks::GitHunkResult>> {
    let workspace = workspace(&state, &id, true).await?;
    crate::git::access::require_execution(workspace.permissions.execute, "Git hunk writes")?;
    crate::git_hunks::apply_hunk(Path::new(&workspace.root_path), request)
        .await
        .map(Json)
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
) -> AppResult<Json<CherryPickPreview>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .cherry_pick_preview(
            Path::new(&workspace.root_path),
            &query.path,
            &query.oid,
            query.mainline,
        )
        .await
        .map(Json)
}
pub async fn stashes(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<StashSnapshot>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .stashes(Path::new(&workspace.root_path), &query.path)
        .await
        .map(Json)
}
pub async fn integration(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<IntegrationSnapshot>> {
    let workspace = workspace(&state, &id, false).await?;
    let mut result = REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .integration_status(Path::new(&workspace.root_path), &query.path)
        .await?;
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
) -> AppResult<Json<StashDetail>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .stash_detail(Path::new(&workspace.root_path), &query.path, &query.oid)
        .await
        .map(Json)
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
) -> AppResult<Json<crate::git_discovery::GitRepositoryList>> {
    let workspace = workspace(&state, &id, false).await?;
    if query.refresh {
        crate::git_discovery::invalidate(&id);
    }
    let execute = workspace.permissions.execute;
    let root = workspace.root_path.clone();
    let depth = query.max_depth;
    tokio::task::spawn_blocking(move || {
        crate::git_discovery::repositories(&id, Path::new(&root), depth, execute)
    })
    .await
    .map_err(|_| AppError::Internal("Repository discovery did not finish".into()))?
    .map(Json)
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
) -> AppResult<Json<CommitDetail>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .commit_detail(
            Path::new(&workspace.root_path),
            &query.path,
            &query.oid,
            query.base.as_deref(),
        )
        .await
        .map(Json)
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
) -> AppResult<Json<CommitFileDiff>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .commit_file_diff(
            Path::new(&workspace.root_path),
            &query.path,
            &query.oid,
            query.base.as_deref(),
            &query.file,
        )
        .await
        .map(Json)
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
    // Branches, history, worktrees, stashes and the operation queue all reach
    // into the repository through a local path. A remote workspace gets an
    // explicit 501 here rather than an answer about the controller's own disk
    // (H02); the proxied subset lives in `api::git_*`.
    crate::remote::refuse_remote(&workspace, "This Git panel")?;
    Ok(workspace)
}

pub async fn branches(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<BranchSnapshot>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .branches(Path::new(&workspace.root_path), &query.path)
        .await
        .map(Json)
}
pub async fn history(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryHistoryQuery>,
) -> AppResult<Json<HistoryPage>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
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
        .await
        .map(Json)
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
) -> AppResult<Json<RebaseTodoPreview>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .rebase_todo_preview(Path::new(&workspace.root_path), &query.path, &query.onto)
        .await
        .map(Json)
}
pub async fn tags(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<TagSnapshot>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .tags(Path::new(&workspace.root_path), &query.path)
        .await
        .map(Json)
}
/// Remote URLs are redacted before they leave the service; Armadra stores none
/// of them, and a redacted value must not be sent back as an update.
pub async fn remotes(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<Vec<RemoteRecord>>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .remote_records(Path::new(&workspace.root_path), &query.path)
        .await
        .map(Json)
}
pub async fn worktrees(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<Vec<WorktreeRecord>>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .worktrees(Path::new(&workspace.root_path), &query.path)
        .await
        .map(Json)
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
    let result = REPOSITORIES
        .start(
            workspace.root_path.into(),
            request.path,
            request.action,
            request.expected,
        )
        .await?;
    if rescans {
        crate::git_discovery::invalidate(&id);
    }
    let mut owners = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
    owners.retain(|operation, _| REPOSITORIES.operation(operation).is_ok());
    owners.insert(result.id.clone(), id);
    Ok(Json(result))
}
pub async fn operations(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<Vec<OperationSnapshot>>> {
    let workspace = workspace(&state, &id, false).await?;
    let mut operations = REPOSITORIES
        .with_execution(workspace.permissions.execute)
        .list_operations(Path::new(&workspace.root_path), &query.path)
        .await?;
    let owners = OWNERS
        .lock()
        .map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
    operations.retain(|operation| owners.get(&operation.id) == Some(&id));
    Ok(Json(operations))
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
    let operation = REPOSITORIES.operation(operation_id)?;
    let root = crate::security::canonical_directory(&workspace.root_path)?;
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
) -> AppResult<Json<OperationSnapshot>> {
    scoped_operation(&state, &workspace_id, &id, true).await?;
    REPOSITORIES.cancel(&id).map(Json)
}
