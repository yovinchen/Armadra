//! The board fixture every collaboration suite calls through.

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
    hook::HookService,
    model::{CanvasNode, ContextLink, DEFAULT_NODE_COLOR, Position, Size, Viewport},
    settings::SettingsStore,
    terminal::TerminalManager,
};

pub(super) use super::super::*;

pub(super) struct Fixture {
    pub(super) router: Router,
    pub(super) state: AppState,
    pub(super) workspace_id: String,
    pub(super) board_id: String,
    /// The caller: an agent terminal node called "Claude".
    pub(super) caller_id: String,
    /// A second agent terminal node called "Codex 审阅".
    pub(super) peer_id: String,
    /// A sticky called "结论".
    pub(super) sticky_id: String,
    pub(super) bearer: String,
    pub(super) directory: TempDir,
}

pub(super) fn node(
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

    let caller_id = uuid::Uuid::now_v7().to_string();
    let peer_id = uuid::Uuid::now_v7().to_string();
    let sticky_id = uuid::Uuid::now_v7().to_string();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[
                node(
                    &board.id,
                    &caller_id,
                    "terminal",
                    "Claude",
                    0.0,
                    json!({ "kind": "terminal", "cwd": ".", "agent": { "id": "claude" } }),
                ),
                node(
                    &board.id,
                    &peer_id,
                    "terminal",
                    "Codex 审阅",
                    900.0,
                    json!({ "kind": "terminal", "cwd": ".", "agent": { "id": "codex" } }),
                ),
                node(
                    &board.id,
                    &sticky_id,
                    "sticky",
                    "结论",
                    1800.0,
                    json!({ "kind": "sticky", "content": "先修好构建，再看测试。" }),
                ),
            ],
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    let hooks = HookService::new(directory.path().join(format!("hook-{name}")), Some(43199));
    hooks.publish_endpoint(Some(43199)).unwrap();
    let bearer = crate::hook::endpoint::read(&hooks.endpoint_file())["ARMADRA_HOOK_TOKEN"].clone();
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
        hooks,
        events,
        pool,
    };
    Fixture {
        router: crate::router_with_state(state.clone()),
        state,
        workspace_id: workspace.id,
        board_id: board.id,
        caller_id,
        peer_id,
        sticky_id,
        bearer,
        directory,
    }
}

/* --------------------------- content sources (§21) ------------------------- */

/// Adds one content node to the fixture board and links the caller to it.
///
/// The board is rewritten whole (that is what `save_board` does), so the three
/// nodes the fixture already created are read back and passed through: a test
/// that adds an editor must not delete the caller it is calling as.
pub(super) async fn add_linked_node(
    fixture: &Fixture,
    node_type: &str,
    title: &str,
    data: Value,
) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    let mut nodes = document.nodes;
    nodes.push(node(
        &document.board.id,
        &id,
        node_type,
        title,
        2_700.0,
        data,
    ));
    db::save_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
        db::SaveBoardRequest {
            expected_updated_at: &document.board.updated_at,
            nodes: &nodes,
            edges: &[],
            viewport: Viewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    // Appended, not replaced: a test that links two content nodes must keep
    // both in the caller's document.
    let mut links = db::get_context_links(&fixture.state.pool, &fixture.caller_id)
        .await
        .unwrap()
        .links;
    links.push(ContextLink {
        id: id.clone(),
        title: title.to_owned(),
        kind: node_type.to_owned(),
        content: None,
    });
    db::put_context_links(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.caller_id,
        &links,
    )
    .await
    .unwrap();
    id
}

/// Adds a `shape` link — a whiteboard record with no node behind it — to the
/// caller's document (tldraw plan §6.3).
pub(super) async fn add_shape_link(
    fixture: &Fixture,
    title: &str,
    content: Option<crate::model::ContextLinkContent>,
) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    let mut links = db::get_context_links(&fixture.state.pool, &fixture.caller_id)
        .await
        .unwrap()
        .links;
    links.push(ContextLink {
        id: id.clone(),
        title: title.to_owned(),
        kind: "shape".to_owned(),
        content,
    });
    db::put_context_links(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.caller_id,
        &links,
    )
    .await
    .unwrap();
    id
}

impl Fixture {
    /// A call with a valid node token — the `verified` identity.
    pub(super) async fn call(
        &self,
        path: &str,
        node_id: &str,
        args: Value,
    ) -> (StatusCode, String) {
        let token = self.state.hooks.issue_node_token(node_id).unwrap();
        self.request(path, node_id, args, Some(&token), None).await
    }

    /// A call with no node token — the `legacy` identity.
    pub(super) async fn call_legacy(
        &self,
        path: &str,
        node_id: &str,
        args: Value,
    ) -> (StatusCode, String) {
        self.request(path, node_id, args, None, None).await
    }

    pub(super) async fn request(
        &self,
        path: &str,
        node_id: &str,
        args: Value,
        node_token: Option<&str>,
        accept: Option<&str>,
    ) -> (StatusCode, String) {
        let mut request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-armadra-hook-token", &self.bearer);
        if let Some(token) = node_token {
            request = request.header("x-armadra-node-token", token);
        }
        if let Some(accept) = accept {
            request = request.header(header::ACCEPT, accept);
        }
        let body = json!({ "nodeId": node_id, "args": args }).to_string();
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    pub(super) async fn json(&self, path: &str, node_id: &str, args: Value) -> (StatusCode, Value) {
        let (status, body) = self.call(path, node_id, args).await;
        (
            status,
            serde_json::from_str(&body).unwrap_or_else(|_| json!({ "raw": body })),
        )
    }

    pub(super) fn caller(&self, node: NodeRef) -> Caller {
        let _ = self;
        Caller {
            node,
            verdict: crate::hook::auth::Verdict::Verified,
        }
    }

    pub(super) async fn node_ref(&self, node_id: &str) -> NodeRef {
        load_node(&self.state.pool, node_id).await.unwrap().unwrap()
    }

    /// Marks a node idle and verified, the way a finished turn would.
    pub(super) async fn mark_done(&self, node_id: &str, agent_id: &str) {
        db::upsert_agent_status(
            &self.state.pool,
            db::AgentStatusPatch {
                node_id: node_id.to_owned(),
                workspace_id: self.workspace_id.clone(),
                agent_id: agent_id.to_owned(),
                state: Some("done".to_owned()),
                unread: true,
                session_id: Some("session-1".to_owned()),
                pending_id: None,
                verified: true,
                transcript_path: None,
                session_phase: None,
                errored: None,
                interrupted: None,
                last_event_at: Some(chrono::Utc::now().to_rfc3339()),
            },
        )
        .await
        .unwrap();
    }

    pub(super) fn enable_messaging(&self) {
        self.state
            .settings
            .patch(&json!({
                "workspaces": { self.workspace_id.clone(): { "agentMessaging": true } }
            }))
            .unwrap();
    }

    pub(super) async fn link_caller_to(&self, target: &str, title: &str, kind: &str) {
        db::put_context_links(
            &self.state.pool,
            &self.workspace_id,
            &self.caller_id,
            &[ContextLink {
                id: target.to_owned(),
                title: title.to_owned(),
                kind: kind.to_owned(),
                content: None,
            }],
        )
        .await
        .unwrap();
    }
}
