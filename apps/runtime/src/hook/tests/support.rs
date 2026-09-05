//! The router-plus-workspace fixture the hook suites report through.

#![allow(dead_code, unused_imports)]

pub(super) use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
pub(super) use serde_json::{Value, json};
pub(super) use tempfile::TempDir;
pub(super) use tower::ServiceExt;

pub(super) use crate::{
    AppState, db,
    events::EventHub,
    hook::{HookService, sweep_once},
    model::{CanvasNode, DEFAULT_NODE_COLOR, Position},
    settings::SettingsStore,
    terminal::TerminalManager,
};

pub(super) use super::super::*;

pub(super) struct Fixture {
    pub(super) router: Router,
    pub(super) state: AppState,
    pub(super) workspace_id: String,
    pub(super) node_id: String,
    pub(super) bearer: String,
    pub(super) _directory: TempDir,
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
    let node_id = uuid::Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[CanvasNode {
                id: node_id.clone(),
                board_id: board.id.clone(),
                node_type: "terminal".into(),
                title: "Claude".into(),
                color: DEFAULT_NODE_COLOR.into(),
                position: Position { x: 0.0, y: 0.0 },
                size: None,
                collapsed: None,
                expanded_height: None,
                parent_id: None,
                labels: Vec::new(),
                note: String::new(),
                data: json!({ "kind": "terminal", "cwd": ".", "agent": { "id": "claude" } }),
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            edges: &[],
            viewport: crate::model::Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    let hooks = HookService::new(directory.path().join("hook-data"), Some(43199));
    let bearer = {
        hooks.publish_endpoint(Some(43199)).unwrap();
        crate::hook::endpoint::read(&hooks.endpoint_file())["ARMADRA_HOOK_TOKEN"].clone()
    };
    let state = AppState {
        language: Default::default(),
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
        hooks,
        events,
        pool,
    };
    Fixture {
        router: crate::router_with_state(state.clone()),
        state,
        workspace_id: workspace.id,
        node_id,
        bearer,
        _directory: directory,
    }
}

impl Fixture {
    pub(super) async fn post_hook(
        &self,
        agent_path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> StatusCode {
        let mut request = Request::builder()
            .method("POST")
            .uri(format!("/hook/{agent_path}"))
            .header(header::CONTENT_TYPE, "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        self.router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
            .status()
    }

    /// The happy path: correct bearer, correct node token.
    pub(super) async fn report(&self, payload: Value) -> StatusCode {
        let token = self.state.hooks.issue_node_token(&self.node_id).unwrap();
        self.post_hook(
            "claude",
            json!({ "nodeId": self.node_id, "version": 1, "payload": payload }),
            &[
                ("x-armadra-hook-token", &self.bearer),
                ("x-armadra-node-token", &token),
                ("x-armadra-hook-client", "1"),
            ],
        )
        .await
    }

    pub(super) async fn status(&self) -> Option<crate::model::AgentStatus> {
        db::get_agent_status(&self.state.pool, &self.node_id)
            .await
            .unwrap()
    }
}
