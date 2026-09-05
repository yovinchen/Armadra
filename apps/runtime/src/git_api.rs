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

pub async fn message_providers(State(state): State<AppState>, AxumPath(id): AxumPath<String>) -> AppResult<Json<Vec<crate::git_message::GitMessageProvider>>> {
    workspace(&state, &id, false).await?;
    crate::git_message::providers().await.map(Json)
}
pub async fn message_source(State(state): State<AppState>, AxumPath(id): AxumPath<String>) -> AppResult<Json<crate::git_message::GitMessageSource>> {
    let workspace = workspace(&state, &id, false).await?;
    crate::git_message::source(Path::new(&workspace.root_path)).await.map(Json)
}
pub async fn message_generate(State(state): State<AppState>, AxumPath(id): AxumPath<String>, Json(request): Json<crate::git_message::GitMessageRequest>) -> AppResult<Json<crate::git_message::GitMessageDraft>> {
    let workspace = workspace(&state, &id, false).await?;
    if !workspace.permissions.execute { return Err(AppError::Forbidden("Workspace does not allow AI execution".into())); }
    crate::git_message::generate(Path::new(&workspace.root_path), request).await.map(Json)
}

pub async fn hunks(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HunkQuery>,
) -> AppResult<Json<crate::git_hunks::GitHunkDiff>> {
    let workspace = workspace(&state, &id, false).await?;
    crate::git_hunks::read_hunks(Path::new(&workspace.root_path), &query.file, query.scope).await.map(Json)
}

pub async fn apply_hunk(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<crate::git_hunks::GitHunkMutation>,
) -> AppResult<Json<crate::git_hunks::GitHunkResult>> {
    let workspace = workspace(&state, &id, true).await?;
    crate::git_hunks::apply_hunk(Path::new(&workspace.root_path), request).await.map(Json)
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
pub async fn stashes(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Query(query):Query<RepositoryQuery>) -> AppResult<Json<StashSnapshot>> {
    let workspace=workspace(&state,&id,false).await?;
    REPOSITORIES.stashes(Path::new(&workspace.root_path),&query.path).await.map(Json)
}
pub async fn stash_detail(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Query(query):Query<StashQuery>) -> AppResult<Json<StashDetail>> {
    let workspace=workspace(&state,&id,false).await?;
    REPOSITORIES.stash_detail(Path::new(&workspace.root_path),&query.path,&query.oid).await.map(Json)
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

pub async fn branches(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<BranchSnapshot>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
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
pub async fn worktrees(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RepositoryQuery>,
) -> AppResult<Json<Vec<WorktreeRecord>>> {
    let workspace = workspace(&state, &id, false).await?;
    REPOSITORIES
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
    let result = REPOSITORIES
        .start(
            workspace.root_path.into(),
            request.path,
            request.action,
            request.expected,
        )
        .await?;
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
    let mut operations = REPOSITORIES.list_operations(Path::new(&workspace.root_path), &query.path).await?;
    let owners = OWNERS.lock().map_err(|_| AppError::Internal("Git operation scope lock failed".into()))?;
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
    scoped_operation(&state, &workspace_id, &id, false)
        .await
        .map(Json)
}
pub async fn cancel(
    State(state): State<AppState>,
    AxumPath((workspace_id, id)): AxumPath<(String, String)>,
) -> AppResult<Json<OperationSnapshot>> {
    scoped_operation(&state, &workspace_id, &id, true).await?;
    REPOSITORIES.cancel(&id).map(Json)
}
