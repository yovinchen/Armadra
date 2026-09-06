//! Shared fixtures for the API tests: a throwaway router, the request
//! helpers and the terminal / hook services a test may never take from the
//! developer's real data directory.

use tempfile::tempdir;

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::{
    AppState, api::*, db, error::AppError, events::EventHub, settings::SettingsStore,
    terminal::TerminalManager,
};

/// Terminals in tests always use the direct backend and a throwaway data
/// directory, so a run never touches the developer's tmux server.
pub(super) fn test_terminals(
    pool: &sqlx::SqlitePool,
    events: &EventHub,
    directory: &std::path::Path,
) -> (TerminalManager, SettingsStore) {
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    (
        TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.to_path_buf(),
        ),
        settings,
    )
}

/// Never the real data directory: a test must not touch the user's hook
/// secret, endpoint file or node tokens.
pub(super) fn test_hooks(directory: &std::path::Path) -> crate::hook::HookService {
    crate::hook::HookService::new(directory.join("hook-data"), Some(43199))
}

#[test]
fn websocket_origin_is_limited_to_local_app_origins() {
    let mut local = HeaderMap::new();
    local.insert(
        axum::http::header::ORIGIN,
        "http://127.0.0.1:1420".parse().unwrap(),
    );
    assert!(validate_websocket_origin(&local).is_ok());

    let mut remote = HeaderMap::new();
    remote.insert(
        axum::http::header::ORIGIN,
        "https://evil.example".parse().unwrap(),
    );
    assert!(matches!(
        validate_websocket_origin(&remote),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        validate_websocket_origin(&HeaderMap::new()),
        Err(AppError::Forbidden(_))
    ));
}

pub(super) async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder().method(method).uri(uri);
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => request.body(Body::empty()).unwrap(),
    };
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

/// The state a fixture router is built from. Exposed separately so a test that
/// has to reach past the routes — the write-ownership rows, say — works against
/// the same pool the router serves rather than a second database.
pub(super) async fn state_fixture(name: &str) -> (AppState, tempfile::TempDir) {
    let directory = tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join(format!("{name}.db")).display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let events = EventHub::new();
    let (terminals, settings) = test_terminals(&pool, &events, directory.path());
    (
        AppState {
            remote: Default::default(),
            language: Default::default(),
            resources: crate::resources::ResourceService::new(settings.clone()),
            terminals,
            usage: crate::usage::UsageService::new(settings.clone()),
            settings,
            hooks: test_hooks(directory.path()),
            events,
            pool,
        },
        directory,
    )
}

/// Never `crate::router`: that one reads the user's real settings file and
/// data directory, and a test must not touch either.
pub(super) async fn router_fixture(name: &str) -> (Router, tempfile::TempDir) {
    let (state, directory) = state_fixture(name).await;
    (crate::router_with_state(state), directory)
}

/// The 1×1 PNG every export / asset test uploads.
pub(super) const TINY_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

pub(super) async fn raw(
    router: &Router,
    method: &str,
    uri: &str,
    content_type: &str,
    body: Vec<u8>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", content_type)
        .body(Body::from(body))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, headers, bytes.to_vec())
}

pub(super) async fn asset_workspace(router: &Router, root: &str) -> String {
    let (status, workspace) = call(
        router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "Canvas", "rootPath": root })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    workspace["id"].as_str().unwrap().to_owned()
}
