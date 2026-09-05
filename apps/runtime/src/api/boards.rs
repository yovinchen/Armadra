//! `/api/workspaces/{id}/boards` — board records and the canvas document
//! load/save pair.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::Deserialize;

use crate::{
    AppState,
    db::{self, SaveBoardRequest},
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    model::{Board, BoardDocument, CanvasEdge, CanvasNode, Viewport},
    ownership,
};

pub async fn list_boards(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> AppResult<Json<Vec<Board>>> {
    Ok(Json(db::list_boards(&state.pool, &workspace_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBoardRequest {
    name: String,
}

pub async fn create_board(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<CreateBoardRequest>,
) -> AppResult<Json<Board>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    Ok(Json(
        db::create_board(&state.pool, &workspace_id, &request.name).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBoardRequest {
    name: Option<String>,
    sort_order: Option<i64>,
}

pub async fn update_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
    Json(request): Json<UpdateBoardRequest>,
) -> AppResult<Json<Board>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    Ok(Json(
        db::update_board(
            &state.pool,
            &workspace_id,
            &board_id,
            request.name,
            request.sort_order,
        )
        .await?,
    ))
}

pub async fn delete_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
) -> AppResult<axum::http::StatusCode> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    db::delete_board(&state.pool, &workspace_id, &board_id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn load_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
) -> AppResult<Json<BoardDocument>> {
    Ok(Json(
        db::load_board(&state.pool, &workspace_id, &board_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBoardDocumentRequest {
    expected_updated_at: String,
    nodes: Vec<CanvasNode>,
    edges: Vec<CanvasEdge>,
    viewport: Viewport,
    /// Omitting this field preserves the whiteboard snapshot.
    #[serde(default)]
    whiteboard: Option<String>,
    // Preserve prior compatibility for other obsolete fields, but reject a
    // retired board write explicitly instead of silently discarding its data.
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

pub async fn save_board(
    State(state): State<AppState>,
    AxumPath((workspace_id, board_id)): AxumPath<(String, String)>,
    Json(request): Json<SaveBoardDocumentRequest>,
) -> AppResult<Json<BoardDocument>> {
    if request.extra.contains_key("kanban") {
        return Err(AppError::BadRequest(
            "Task-board writes are retired; historical records are available as read-only archives"
                .into(),
        ));
    }
    // After the retirement check, which is request validation and must answer
    // the same way whoever owns the canvas, and before the first stored byte.
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Canvas).await?;
    let document = db::save_board(
        &state.pool,
        &workspace_id,
        &board_id,
        SaveBoardRequest {
            expected_updated_at: &request.expected_updated_at,
            nodes: &request.nodes,
            edges: &request.edges,
            viewport: request.viewport,
            whiteboard: request.whiteboard.as_deref(),
        },
    )
    .await?;
    state.events.publish(
        &workspace_id,
        WorkspaceEvent::BoardChanged {
            board_id: document.board.id.clone(),
            updated_at: document.board.updated_at.clone(),
        },
    );
    Ok(Json(document))
}
