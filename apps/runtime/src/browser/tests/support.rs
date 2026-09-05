//! The fixture every browser suite builds on: a workspace, a linked agent
//! node and a local page server.

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
    ReadMode, SessionState, Viewport, Visibility, admit_url, launch, safe_filename,
    session::{
        self, CreateRequest, InputEvent, InputRequest, NavigateRequest, Target, WaitRequest,
    },
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

impl Drop for Fixture {
    /// A test that panics must not leave a browser behind. The ordinary path
    /// is `session::close`; this is the safety net, and it is why the suite
    /// can be run repeatedly without collecting orphan renderers.
    fn drop(&mut self) {
        session::kill_all_now(&self.state);
    }
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

/* ------------------------------- the local page ---------------------------- */

/// The page every CDP test drives. Deliberately self-contained: no external
/// asset, no font, no network of any kind.
pub(super) const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>Armadra 受控浏览器</title></head><body style="font:24px sans-serif;margin:32px">
<h1 id="heading">受控浏览器测试页</h1>
<p id="result">Waiting</p>
<label>Name <input id="name"></label>
<button id="submit" onclick="document.getElementById('result').textContent='Hello ' + document.getElementById('name').value">Submit</button>
<a id="next" href="/second">Second page</a>
<div style="height:1500px"></div>
</body></html>"#;

pub(super) const SECOND: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>第二页</title></head><body><h1 id="heading">第二页</h1></body></html>"#;

pub(super) struct Page {
    address: SocketAddr,
    handle: tokio::task::JoinHandle<()>,
}

impl Page {
    pub(super) fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.address.port())
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Serves the fixture on an ephemeral loopback port, never one Armadra itself
/// uses.
pub(super) async fn serve_page() -> Page {
    let router = Router::new()
        .route("/", get(|| async { axum::response::Html(PAGE) }))
        .route("/second", get(|| async { axum::response::Html(SECOND) }));
    let listener = loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        if ![43120_u16, 43121, 1420, 1421].contains(&port) {
            break listener;
        }
    };
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Page { address, handle }
}

/// `None` plus a printed note when this machine has no browser to drive.
pub(super) fn browser_or_skip(state: &AppState, test: &str) -> Option<String> {
    let availability = launch::availability(&state.settings);
    if availability.available {
        return Some(availability.executable);
    }
    println!(
        "SKIPPED {test}: no Chromium-family browser on this host. Looked at: {}. \
         Set ARMADRA_BROWSER_PATH or CHROME_PATH to run it.",
        availability.searched.join(", ")
    );
    None
}
