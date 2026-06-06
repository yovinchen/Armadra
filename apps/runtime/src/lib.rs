pub mod acp;
pub mod agent;
pub mod api;
pub mod db;
pub mod error;
pub mod files;
pub mod git;
pub mod model;
pub mod pty;
pub mod security;

use axum::{
    Router,
    http::{HeaderValue, Method},
    routing::{get, patch, post},
};
use sqlx::SqlitePool;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

use crate::{acp::AcpManager, pty::PtyManager};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub pty: PtyManager,
    pub acp: AcpManager,
}

pub fn router(pool: SqlitePool) -> Router {
    router_with_state(AppState {
        pty: PtyManager::new(pool.clone()),
        acp: AcpManager::new(pool.clone()),
        pool,
    })
}

pub fn router_with_state(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE])
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin.to_str().is_ok_and(|origin| {
                origin.starts_with("http://127.0.0.1:")
                    || origin.starts_with("http://localhost:")
                    || origin == "tauri://localhost"
                    || origin == "https://tauri.localhost"
            })
        }));

    Router::new()
        .route("/health", get(api::health))
        .route(
            "/api/workspaces",
            get(api::list_workspaces).post(api::create_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}",
            patch(api::update_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/open",
            post(api::open_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/boards",
            get(api::list_boards).post(api::create_board),
        )
        .route(
            "/api/workspaces/{workspace_id}/boards/{board_id}",
            patch(api::update_board).delete(api::delete_board),
        )
        .route(
            "/api/workspaces/{workspace_id}/boards/{board_id}/document",
            get(api::load_board).put(api::save_board),
        )
        .route("/api/workspaces/{workspace_id}/files", get(api::list_files))
        .route("/api/workspaces/{workspace_id}/file", get(api::read_file))
        .route(
            "/api/workspaces/{workspace_id}/git/status",
            get(api::git_status),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/diff",
            get(api::git_diff),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/stage",
            post(api::git_stage),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/revert",
            post(api::git_revert),
        )
        .route("/api/gateway", get(api::gateway))
        .route("/api/terminals", post(api::create_terminal))
        .route("/api/terminals/{session_id}", get(api::get_terminal))
        .route(
            "/api/terminals/{session_id}/terminate",
            post(api::terminate_terminal),
        )
        .route("/api/terminals/{session_id}/ws", get(api::terminal_socket))
        .route("/api/agents", get(api::adapters))
        .route("/api/agents/context-preview", post(api::context_preview))
        .route("/api/agents/run", post(api::run_agent))
        .route("/api/agents/{session_id}/ws", get(api::agent_socket))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
