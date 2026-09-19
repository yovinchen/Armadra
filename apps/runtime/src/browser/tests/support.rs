//! The fixture every browser suite builds on: a workspace with a browser node
//! and an agent node linked to it.
//!
//! No page server and no browser any more — W3.5 moved the page into the
//! Electron shell, so nothing under this module opens a socket.

#![allow(dead_code, unused_imports)]

pub(super) use std::net::SocketAddr;

pub(super) use axum::{Router, routing::get};
pub(super) use serde_json::{Value, json};
pub(super) use tempfile::TempDir;

pub(super) use crate::{
    AppState, db,
    events::{EventHub, WorkspaceEvent},
    hook::HookService,
    model::{
        CanvasNode, ContextLink, DEFAULT_NODE_COLOR, Position, Size, Viewport as CanvasViewport,
    },
    settings::SettingsStore,
    terminal::TerminalManager,
};

pub(super) use super::super::{
    Admission, LoopbackPorts, NetworkPolicy, SessionState, UrlTarget, Viewport, admit_document,
    admit_subresource, admit_url, parse_target, safe_filename,
};

pub(super) struct Fixture {
    pub(super) state: AppState,
    pub(super) workspace_id: String,
    /// The browser node.
    pub(super) node_id: String,
    /// An agent terminal node linked to it.
    pub(super) agent_id: String,
    pub(super) directory: TempDir,
}

pub(super) async fn fixture(name: &str) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join(format!("{name}.db")).display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    // Node ids on a board are UUIDs; the browser session row is keyed by one.
    let node_id = uuid::Uuid::now_v7().to_string();
    let agent_id = uuid::Uuid::now_v7().to_string();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[
                canvas_node(
                    &board.id,
                    &node_id,
                    "browser",
                    "预览",
                    0.0,
                    json!({ "kind": "browser", "url": "" }),
                ),
                canvas_node(
                    &board.id,
                    &agent_id,
                    "terminal",
                    "Claude",
                    900.0,
                    json!({ "kind": "terminal", "cwd": ".", "agent": { "id": "claude" } }),
                ),
            ],
            edges: &[],
            viewport: CanvasViewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    db::put_context_links(
        &pool,
        &workspace.id,
        &agent_id,
        &[ContextLink {
            id: node_id.clone(),
            title: "预览".into(),
            kind: "browser".into(),
            content: None,
        }],
    )
    .await
    .unwrap();

    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    let data_dir = directory.path().join(format!("data-{name}"));
    std::fs::create_dir_all(&data_dir).unwrap();
    let state = AppState {
        language: Default::default(),
        askpass: Default::default(),
        remote: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: HookService::new(data_dir, None),
        events,
        pool,
    };
    Fixture {
        state,
        workspace_id: workspace.id,
        node_id,
        agent_id,
        directory,
    }
}

pub(super) fn canvas_node(
    board_id: &str,
    id: &str,
    node_type: &str,
    title: &str,
    x: f64,
    data: Value,
) -> CanvasNode {
    let now = chrono::Utc::now().to_rfc3339();
    CanvasNode {
        id: id.to_owned(),
        board_id: board_id.to_owned(),
        node_type: node_type.to_owned(),
        title: title.to_owned(),
        color: DEFAULT_NODE_COLOR.to_owned(),
        position: Position { x, y: 0.0 },
        size: Some(Size {
            width: 640.0,
            height: 440.0,
        }),
        collapsed: None,
        expanded_height: None,
        parent_id: None,
        labels: Vec::new(),
        note: String::new(),
        data,
        created_at: now.clone(),
        updated_at: now,
    }
}
