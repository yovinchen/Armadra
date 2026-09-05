//! End-to-end tests for the hook surface: the wire contract the `armadra-hook`
//! client depends on, and the two API routes that close the loop (the unread
//! receipt and the stale sweep).

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::{
    AppState, db,
    events::EventHub,
    hook::{HookService, sweep_once},
    model::{CanvasNode, DEFAULT_NODE_COLOR, Position},
    settings::SettingsStore,
    terminal::TerminalManager,
};

struct Fixture {
    router: Router,
    state: AppState,
    workspace_id: String,
    node_id: String,
    bearer: String,
    _directory: TempDir,
}

#[tokio::test]
async fn disabled_custom_hooks_are_not_processed() {
    let fixture = fixture("disabled-hook-capability").await;
    fixture.state.settings.patch(&json!({"agents":{"custom":[{"id":"custom:narrow","label":"Narrow","launchCmd":"wrapper","baseAgent":"claude","disabledCapabilities":["hooks"]}]}})).unwrap();
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    assert_eq!(
        fixture
            .post_hook(
                "custom%3Anarrow",
                json!({"nodeId":fixture.node_id,"payload":{"hook_event_name":"Stop"}}),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &token)
                ]
            )
            .await,
        StatusCode::NO_CONTENT
    );
    assert!(fixture.status().await.is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn context_reports_require_verified_current_pty_and_publish_only_invalidation() {
    use crate::{
        context_usage::{ContextQuery, get_snapshot},
        terminal::{SpawnRequest, TerminateMode},
    };
    let fixture = fixture("context-observation").await;
    let session = fixture
        .state
        .terminals
        .spawn(SpawnRequest {
            workspace_id: fixture.workspace_id.clone(),
            cwd: fixture._directory.path().to_string_lossy().into_owned(),
            command: Some("/bin/cat".into()),
            owner_node_id: Some(fixture.node_id.clone()),
            agent_id: Some("claude".into()),
            env: crate::terminal::agent_environment(&fixture.node_id, "claude"),
            ..SpawnRequest::plain(
                fixture.workspace_id.clone(),
                fixture._directory.path().to_string_lossy().into_owned(),
            )
        })
        .await
        .unwrap();
    let query = ContextQuery {
        session_id: session.id.clone(),
        generation: session.generation as u64,
        // Claude reports its own model; the hint is never consulted here.
        model_id: None,
    };
    let data = json!({"session_id":"fixture-provider", "model":{"id":"fixture-model"},
        "context_window":{"context_window_size":200000,"current_usage":{
            "input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":300}}});
    let report = |generation, revision| {
        json!({"armadraContextUsage":{
        "sessionId":session.id,"generation":generation,"sourceRevision":revision,"data":data}})
    };
    fixture
        .post_hook(
            "claude",
            json!({"nodeId":fixture.node_id,"payload":report(session.generation,"1")}),
            &[("x-armadra-hook-token", &fixture.bearer)],
        )
        .await;
    assert_eq!(
        get_snapshot(
            &fixture.state,
            &fixture.workspace_id,
            &fixture.node_id,
            &query
        )
        .await
        .unwrap()
        .quality,
        "unknown"
    );
    let mut events = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(
        fixture.report(report(session.generation, "2")).await,
        StatusCode::NO_CONTENT
    );
    let snapshot = get_snapshot(
        &fixture.state,
        &fixture.workspace_id,
        &fixture.node_id,
        &query,
    )
    .await
    .unwrap();
    assert_eq!(snapshot.used_tokens, Some(600));
    assert!(matches!(
        events.try_recv().unwrap(),
        crate::events::WorkspaceEvent::AgentContext { generation: 1, .. }
    ));
    fixture.report(report(session.generation + 1, "3")).await;
    assert_eq!(
        get_snapshot(
            &fixture.state,
            &fixture.workspace_id,
            &fixture.node_id,
            &query
        )
        .await
        .unwrap()
        .source_revision
        .as_deref(),
        Some("2")
    );
    assert!(
        get_snapshot(
            &fixture.state,
            &fixture.workspace_id,
            "another-node",
            &query
        )
        .await
        .is_err()
    );
    fixture
        .state
        .terminals
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
    assert_eq!(
        get_snapshot(
            &fixture.state,
            &fixture.workspace_id,
            &fixture.node_id,
            &query
        )
        .await
        .unwrap()
        .quality,
        "unknown"
    );
    fixture.report(report(session.generation, "4")).await;
    assert_eq!(
        fixture
            .state
            .hooks
            .context_usage()
            .snapshot(
                &fixture.node_id,
                &session.id,
                query.generation,
                chrono::Utc::now().timestamp_millis()
            )
            .source_revision
            .as_deref(),
        Some("2")
    );
}

async fn fixture(name: &str) -> Fixture {
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
    let hooks = HookService::new(directory.path().join("hook-data"), 43199);
    let bearer = {
        hooks.publish_endpoint(43199).unwrap();
        super::endpoint::read(&hooks.endpoint_file())["ARMADRA_HOOK_TOKEN"].clone()
    };
    let state = AppState {
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
    async fn post_hook(
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
    async fn report(&self, payload: Value) -> StatusCode {
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

    async fn status(&self) -> Option<crate::model::AgentStatus> {
        db::get_agent_status(&self.state.pool, &self.node_id)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn the_bearer_gates_every_hook_route() {
    let fixture = fixture("hook-bearer").await;

    // No bearer at all.
    assert_eq!(
        fixture
            .post_hook("claude", json!({ "nodeId": fixture.node_id }), &[])
            .await,
        StatusCode::FORBIDDEN
    );
    // The client sends the header even when the endpoint file had no token.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": fixture.node_id }),
                &[("x-armadra-hook-token", "")],
            )
            .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": fixture.node_id }),
                &[("x-armadra-hook-token", "not-the-token")],
            )
            .await,
        StatusCode::FORBIDDEN
    );

    let verify = |token: Option<&str>| {
        let mut request = Request::builder().method("GET").uri("/verify");
        if let Some(token) = token {
            request = request.header("x-armadra-hook-token", token);
        }
        fixture
            .router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
    };
    assert_eq!(
        verify(Some(&fixture.bearer)).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(verify(None).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_forged_node_token_is_refused_and_a_missing_one_is_merely_legacy() {
    let fixture = fixture("hook-verdict").await;
    let good = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let (kid, _) = good.split_once('.').unwrap();

    // Our key id, wrong MAC: someone is guessing.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": fixture.node_id, "payload": { "hook_event_name": "Stop" } }),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &format!("{kid}.wrong")),
                ],
            )
            .await,
        StatusCode::FORBIDDEN
    );
    assert!(fixture.status().await.is_none(), "nothing was written");

    // No node token at all: accepted, but flagged unverified.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({
                    "nodeId": fixture.node_id,
                    "payload": { "hook_event_name": "UserPromptSubmit" }
                }),
                &[("x-armadra-hook-token", &fixture.bearer)],
            )
            .await,
        StatusCode::NO_CONTENT
    );
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("working"));
    assert!(!status.verified);

    // With the real token the row is verified.
    assert_eq!(
        fixture.report(json!({ "hook_event_name": "Stop" })).await,
        StatusCode::NO_CONTENT
    );
    assert!(fixture.status().await.unwrap().verified);
}

#[tokio::test]
async fn a_turn_is_persisted_and_broadcast_and_leaves_the_node_unread() {
    let fixture = fixture("hook-turn").await;
    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);

    assert_eq!(
        fixture
            .report(json!({
                "hook_event_name": "SessionStart",
                "session_id": "s-1",
                "transcript_path": "/tmp/t.jsonl"
            }))
            .await,
        StatusCode::NO_CONTENT
    );
    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert_eq!(event["type"], "agent.status");
    assert_eq!(event["status"]["nodeId"], fixture.node_id.as_str());
    assert_eq!(event["status"]["sessionId"], "s-1");
    assert!(
        event["status"].get("state").is_none(),
        "a fresh session is idle"
    );

    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    fixture
        .report(json!({ "hook_event_name": "Stop", "last_assistant_message": "all done" }))
        .await;

    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    assert!(status.unread);
    assert_eq!(status.session_id.as_deref(), Some("s-1"));
    assert_eq!(status.transcript_path.as_deref(), Some("/tmp/t.jsonl"));
    assert!(status.last_event_at.is_some());

    // The published copy carries the CLI's last message; the row does not.
    let mut last_message = None;
    while let Ok(event) = subscriber.try_recv() {
        let event = serde_json::to_value(&event).unwrap();
        if event["status"]["state"] == "done" {
            last_message = event["status"]["lastMessage"].as_str().map(str::to_owned);
        }
    }
    assert_eq!(last_message.as_deref(), Some("all done"));

    // The read receipt clears the badge and tells everyone.
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/agent-status/{}/read", fixture.node_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!fixture.status().await.unwrap().unread);
    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert_eq!(event["type"], "agent.status");
    assert_eq!(event["status"]["unread"], false);

    // A focused client fires the receipt on its own every time a turn ends, so
    // "already read" is routine: answer it, but do not put a frame that says
    // nothing on every socket in the workspace.
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/agent-status/{}/read", fixture.node_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        subscriber.try_recv().is_err(),
        "a receipt for an already-read node must not broadcast"
    );

    // A node that never reported has no badge to clear.
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agent-status/00000000-0000-4000-8000-000000000000/read")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// The web pill needs to tell a failed turn from a clean one, so `errored` and
/// `interrupted` have to survive the reducer, SQLite and the broadcast.
#[tokio::test]
async fn a_failed_turn_is_distinguishable_on_the_wire() {
    let fixture = fixture("hook-outcome").await;

    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    // A turn in flight has no verdict at all.
    let status = fixture.status().await.unwrap();
    assert!(status.errored.is_none());
    assert!(status.interrupted.is_none());

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    fixture
        .report(json!({ "hook_event_name": "StopFailure" }))
        .await;

    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    assert_eq!(status.errored, Some(true));
    assert_eq!(status.interrupted, Some(false));

    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert_eq!(event["status"]["errored"], true);
    assert_eq!(event["status"]["interrupted"], false);

    // The next turn clears the verdict rather than leaving TURN FAILED up.
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    let status = fixture.status().await.unwrap();
    assert!(
        status.errored.is_none(),
        "the verdict belongs to the old turn"
    );
    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert!(event["status"].get("errored").is_none());

    // And a clean Stop says so explicitly.
    fixture.report(json!({ "hook_event_name": "Stop" })).await;
    let status = fixture.status().await.unwrap();
    assert_eq!(status.errored, Some(false));
    assert_eq!(status.interrupted, Some(false));
}

#[tokio::test]
async fn a_permission_request_becomes_a_pending_approval() {
    let fixture = fixture("hook-approval").await;
    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();

    let status = fixture
        .post_hook(
            "claude",
            json!({
                "nodeId": fixture.node_id,
                "pendingId": "pend-1",
                "payload": {
                    "hook_event_name": "PermissionRequest",
                    "tool_name": "Bash",
                    "tool_input": { "command": "rm -rf ." }
                }
            }),
            &[
                ("x-armadra-hook-token", &fixture.bearer),
                ("x-armadra-node-token", &token),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("blocked"));
    assert_eq!(status.pending_id.as_deref(), Some("pend-1"));

    let approval = db::get_approval(&fixture.state.pool, "pend-1")
        .await
        .unwrap();
    assert_eq!(approval.request["tool_name"], "Bash");
    assert_eq!(approval.request["tool_input"]["command"], "rm -rf .");
    assert!(approval.answer.is_none());

    let mut kinds = Vec::new();
    while let Ok(event) = subscriber.try_recv() {
        kinds.push(
            serde_json::to_value(&event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert!(kinds.contains(&"agent.approval".to_owned()));
    assert!(kinds.contains(&"agent.status".to_owned()));
}

#[tokio::test]
async fn subagent_events_are_broadcast_without_touching_the_row() {
    let fixture = fixture("hook-subagent").await;
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);

    fixture
        .report(json!({
            "hook_event_name": "SubagentStart",
            "tool_use_id": "tu-1",
            "subagent_type": "Explore"
        }))
        .await;
    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert_eq!(event["type"], "agent.subagent");
    assert_eq!(event["event"]["kind"], "subagent-start");
    assert_eq!(event["event"]["subagentType"], "Explore");
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working"),
        "the parent is unchanged"
    );
}

#[tokio::test]
async fn reports_we_cannot_place_are_accepted_and_dropped() {
    let fixture = fixture("hook-drop").await;
    let headers: &[(&str, &str)] = &[("x-armadra-hook-token", &fixture.bearer)];

    // Unknown node.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({
                    "nodeId": "00000000-0000-4000-8000-000000000000",
                    "payload": { "hook_event_name": "Stop" }
                }),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    // A node id that could escape the token directory.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": "../../etc", "payload": { "hook_event_name": "Stop" } }),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    // Non-JSON stdin, wrapped by the client.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({
                    "nodeId": fixture.node_id,
                    "payload": { "raw": "a banner line", "truncated": true }
                }),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    // An event we never subscribed to.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({
                    "nodeId": fixture.node_id,
                    "payload": { "hook_event_name": "PreCompact" }
                }),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    assert!(
        fixture.status().await.is_none(),
        "none of those wrote a row"
    );
}

#[tokio::test]
async fn a_percent_encoded_custom_agent_id_reaches_the_handler() {
    let fixture = fixture("hook-custom").await;
    fixture.state.settings.patch(&json!({"agents":{"custom":[{"id":"custom:wrapper","label":"Wrapper","launchCmd":"wrapper","baseAgent":"claude"}]}})).unwrap();
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    assert_eq!(
        fixture
            .post_hook(
                "custom%3Awrapper",
                json!({
                    "nodeId": fixture.node_id,
                    "payload": { "hook_event_name": "Stop" }
                }),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &token),
                ],
            )
            .await,
        StatusCode::NO_CONTENT
    );
    let status = fixture.status().await.unwrap();
    assert_eq!(status.agent_id, "custom:wrapper");
    assert_eq!(status.state.as_deref(), Some("done"));
}

/// The collaboration routes are mounted on the same surface as the reports and
/// behind the same bearer. What they *do* is covered by the collab suite; what
/// matters here is that the hook router carries them and refuses an anonymous
/// caller before looking at the body.
#[tokio::test]
async fn the_collaboration_routes_are_mounted_behind_the_bearer() {
    let fixture = fixture("hook-collab-routes").await;
    for uri in ["/control/list", "/context-link/summary"] {
        let unauthorized = fixture
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::FORBIDDEN, "{uri}");

        // With the bearer but a node that is not on any board, the answer is
        // "no such node" rather than the 501 the Phase 2 stubs gave.
        let authorized = fixture
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-armadra-hook-token", &fixture.bearer)
                    .body(Body::from(
                        r#"{"nodeId":"3a1b0d5e-1111-4111-8111-111111111111","args":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::NOT_FOUND, "{uri}");
    }

    // And the real node answers.
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let listed = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/control/list")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-armadra-hook-token", &fixture.bearer)
                .header("x-armadra-node-token", &token)
                .body(Body::from(format!(
                    r#"{{"nodeId":"{}","args":{{}}}}"#,
                    fixture.node_id
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
}

#[tokio::test]
async fn the_sweep_closes_a_node_that_stopped_reporting() {
    let fixture = fixture("hook-sweep").await;
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // Nothing to do while the report is fresh.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);

    let long_ago = (chrono::Utc::now() - chrono::Duration::minutes(21)).to_rfc3339();
    sqlx::query("UPDATE agent_status SET last_event_at = ? WHERE node_id = ?")
        .bind(&long_ago)
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 1);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    assert!(status.unread);

    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert!(
        event["status"]["lastMessage"]
            .as_str()
            .unwrap()
            .contains("stale=true")
    );
    // A closed node is not swept twice.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
}

/// A terminal killed mid-turn leaves a node that will never report again. The
/// CLI gets no chance to fire `Stop` (terminate_tree kills it outright, and
/// SIGKILL runs no hooks), so without this the node claims RUNNING until the
/// 20-minute silence sweep notices.
#[tokio::test]
async fn a_node_whose_terminal_died_is_closed_out() {
    let fixture = fixture("hook-terminal-gone").await;

    // A session for the node, and a turn in flight.
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id,          agent_id, status, created_at, session_key, backend_kind, generation, attach_state)          VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'running', ?, ?, 'direct', 0, 'live')",
    )
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&fixture.node_id)
    .execute(&fixture.state.pool)
    .await
    .unwrap();

    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
    // While the terminal lives, the sweep leaves it alone.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);

    // The user kills it. A `Stop` may still be in flight, so the grace window
    // holds the sweep off rather than racing the real report.
    sqlx::query(
        "UPDATE terminal_sessions SET status = 'terminated', ended_at = ? WHERE id = 'sess-1'",
    )
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    assert_eq!(
        sweep_once(&fixture.state).await.unwrap(),
        0,
        "a just-ended terminal is given time to report its own Stop"
    );

    sqlx::query("UPDATE terminal_sessions SET ended_at = ? WHERE id = 'sess-1'")
        .bind((chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339())
        .execute(&fixture.state.pool)
        .await
        .unwrap();

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 1);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    // A plain clean end. `interrupted` stays false: it means the *user* stopped
    // the agent, and overloading it here would make PAUSED mean two things.
    assert_eq!(status.interrupted, Some(false));
    assert_eq!(status.errored, Some(false));
    // No badge — the terminal's own exit already says what happened.
    assert!(!status.unread);
    // No hook presented a token for a synthetic close, so the row is honestly
    // unverified. That also keeps §5.7 from ever choosing a dead node as a
    // message target: its idle gate requires a `done` that is verified.
    assert!(!status.verified);

    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert_eq!(event["status"]["interrupted"], false);
    assert_eq!(event["status"]["unread"], false);
    // The cause travels in the marker, which a client can match on.
    assert!(
        event["status"]["lastMessage"]
            .as_str()
            .unwrap()
            .starts_with("terminated=true")
    );
    // Closed once, not on every tick.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
}

/// The close-out raises no badge, but it must not take one down either: output
/// from an earlier finished turn is still unread, and only the read receipt
/// says the user looked at it.
#[tokio::test]
async fn closing_a_dead_terminal_leaves_an_earlier_unread_turn_alone() {
    let fixture = fixture("hook-terminal-unread").await;
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, \
         agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state) \
         VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'exited', ?, ?, ?, 'direct', 0, 'exited')",
    )
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind((chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339())
    .bind(&fixture.node_id)
    .execute(&fixture.state.pool)
    .await
    .unwrap();

    // A turn finished and nobody read it, then a second turn started and the
    // terminal died under it.
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    fixture.report(json!({ "hook_event_name": "Stop" })).await;
    assert!(fixture.status().await.unwrap().unread);
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;

    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 1);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    assert!(
        status.unread,
        "the first turn's output is still unread; the close-out must not hide it"
    );
}

/// The two guards on that query, which are what keep it from closing nodes it
/// has no business touching.
#[tokio::test]
async fn the_dead_terminal_sweep_leaves_other_nodes_alone() {
    let fixture = fixture("hook-terminal-guards").await;
    let long_ago = (chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();

    // 1. A node with no session at all: the CLI may be running in a terminal the
    //    user opened themselves, having exported ARMADRA_NODE_ID.
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    assert_eq!(
        sweep_once(&fixture.state).await.unwrap(),
        0,
        "a node without a session is not ours to close"
    );
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // 2. A recycled node: the old session ended long ago, but a newer one runs.
    for (id, status, ended) in [
        ("sess-old", "exited", Some(long_ago.as_str())),
        ("sess-new", "running", None),
    ] {
        sqlx::query(
            "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id,              agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state)              VALUES (?, ?, '/tmp', 'sh', 'terminal', ?, 'claude', ?, ?, ?, ?, 'direct', 0, 'live')",
        )
        .bind(id)
        .bind(&fixture.workspace_id)
        .bind(&fixture.node_id)
        .bind(status)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(ended)
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    }
    assert_eq!(
        sweep_once(&fixture.state).await.unwrap(),
        0,
        "one live session keeps the node alive however many dead ones it has"
    );
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // 3. An already-finished node is not closed twice.
    fixture.report(json!({ "hook_event_name": "Stop" })).await;
    sqlx::query(
        "UPDATE terminal_sessions SET status = 'exited', ended_at = ? WHERE id = 'sess-new'",
    )
    .bind(&long_ago)
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.interrupted, Some(false));
    assert!(
        status.unread,
        "the real Stop stands with its badge; no silent close overwrote it"
    );
}

/// Neither `agent_status` nor `terminal_sessions` has a foreign key to `nodes`,
/// so both rows survive a node the user deleted from the canvas. Sweeping one
/// would publish an `agent.status` for something no client can show — which is
/// a frame every mirror then has to defend against.
#[tokio::test]
async fn neither_sweep_speaks_for_a_deleted_node() {
    let fixture = fixture("hook-deleted-node").await;
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, \
         agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state) \
         VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'exited', ?, ?, ?, 'direct', 0, 'exited')",
    )
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind((chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339())
    .bind(&fixture.node_id)
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;

    // While the node is on the canvas, the dead terminal closes it out.
    // Delete the node first and neither sweep has anything to say.
    sqlx::query("DELETE FROM nodes WHERE id = ?")
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    // Old enough for the silence sweep too, so both queries are exercised.
    sqlx::query("UPDATE agent_status SET last_event_at = ? WHERE node_id = ?")
        .bind((chrono::Utc::now() - chrono::Duration::minutes(30)).to_rfc3339())
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
    assert!(
        subscriber.try_recv().is_err(),
        "no frame for a node that is not on the canvas"
    );
    // The orphan row is left as it was rather than rewritten.
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
}

/// The deliberate asymmetry to the sweep guard above, and the reason it must
/// stay: a *real* hook report is accepted even when the node is not in `nodes`.
///
/// A terminal is created before the board save that adds its node necessarily
/// lands — `create_terminal` only checks that the id parses as a UUID — so a
/// brand-new agent's `SessionStart` routinely arrives while the node row is
/// still in flight. Requiring node existence here would drop it. The sweep can
/// afford the guard because it is a background correction with no deadline; a
/// hook cannot, because there is no second chance at a report.
///
/// The cost is that a deleted node whose PTY outlived it keeps reporting. That
/// is a real gap, but its root cause is the delete path not terminating the
/// terminal, and papering over it here would break new-node reporting.
#[tokio::test]
async fn a_real_report_is_accepted_for_a_node_the_board_has_not_saved_yet() {
    let fixture = fixture("hook-node-not-saved").await;
    let orphan = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, \
         agent_id, status, created_at, session_key, backend_kind, generation, attach_state) \
         VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'running', ?, ?, 'direct', 0, 'live')",
    )
    .bind(&fixture.workspace_id)
    .bind(&orphan)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&orphan)
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    assert!(
        sqlx::query("SELECT 1 FROM nodes WHERE id = ?")
            .bind(&orphan)
            .fetch_optional(&fixture.state.pool)
            .await
            .unwrap()
            .is_none(),
        "the node row has not landed yet"
    );

    let token = fixture.state.hooks.issue_node_token(&orphan).unwrap();
    let status = fixture
        .post_hook(
            "claude",
            json!({
                "nodeId": orphan,
                "payload": { "hook_event_name": "SessionStart", "session_id": "s-1" }
            }),
            &[
                ("x-armadra-hook-token", &fixture.bearer),
                ("x-armadra-node-token", &token),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let row = db::get_agent_status(&fixture.state.pool, &orphan)
        .await
        .unwrap()
        .expect("a real report is never dropped for want of a node row");
    assert_eq!(row.session_id.as_deref(), Some("s-1"));
}

#[tokio::test]
async fn health_reports_the_hook_endpoint() {
    let fixture = fixture("hook-health").await;
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["hook"]["port"], 43199);
    assert_eq!(body["hook"]["ok"], true);
    #[cfg(unix)]
    assert!(
        body["hook"]["sock"]
            .as_str()
            .unwrap()
            .ends_with("hook.sock")
    );
}

#[tokio::test]
async fn creating_an_agent_terminal_mints_its_node_token() {
    let fixture = fixture("hook-token-mint").await;
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/terminals")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "workspaceId": fixture.workspace_id,
                        "cwd": ".",
                        "nodeId": fixture.node_id,
                        "agent": { "id": "claude" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();

    let token_file = fixture.state.hooks.node_token_dir().join(&fixture.node_id);
    assert!(
        token_file.exists(),
        "the client looks the token up by node name"
    );
    let token = std::fs::read_to_string(&token_file).unwrap();
    assert!(
        fixture
            .state
            .hooks
            .verdict(&fixture.node_id, Some(&token))
            .is_verified()
    );

    // And the refresh route re-mints it for a session whose token was lost.
    std::fs::remove_file(&token_file).unwrap();
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/terminals/{}/node-token/refresh",
                    session["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(std::fs::read_to_string(&token_file).unwrap(), token);

    fixture.state.terminals.shutdown_all().await;
}

#[tokio::test]
async fn the_install_routes_record_what_they_wrote() {
    let fixture = fixture("hook-install").await;
    let home = fixture._directory.path().join("claude-home");
    let client = fixture._directory.path().join("armadra-hook");
    std::fs::write(&client, "#!/bin/sh\n").unwrap();

    // The installer itself is exercised per provider in its own module; here we
    // only prove the route wires it to `hook_installs` and to `GET /api/agents`.
    let report = super::install::claude::install(&home, &client).unwrap();
    db::upsert_hook_install(
        &fixture.state.pool,
        &report.agent_id,
        report.client_revision,
        Some(&report.config_path),
    )
    .await
    .unwrap();

    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let agents: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let claude = agents
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == "claude")
        .unwrap();
    assert_eq!(
        claude["clientRevision"],
        super::install::HOOK_CLIENT_REVISION
    );
    let others = agents
        .as_array()
        .unwrap()
        .iter()
        .filter(|agent| agent["id"] != "claude");
    for agent in others {
        assert!(agent["clientRevision"].is_null(), "{}", agent["id"]);
    }

    // Uninstalling clears the record.
    super::install::claude::uninstall(&home).unwrap();
    db::remove_hook_install(&fixture.state.pool, "claude")
        .await
        .unwrap();
    assert!(
        db::list_hook_installs(&fixture.state.pool)
            .await
            .unwrap()
            .is_empty()
    );
}

/// The socket is the client's preferred path, and it is served by the same
/// router as the TCP port. This drives it the way the client does: a raw
/// HTTP/1.1 request with `Connection: close`.
#[cfg(unix)]
#[tokio::test]
async fn the_unix_socket_serves_the_hook_router() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let fixture = fixture("hook-socket").await;
    let socket = fixture.state.hooks.socket_path().unwrap();
    super::start(fixture.state.clone(), 43199);

    // The listener binds on a spawned task; give it a moment to appear.
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(socket.exists(), "the hook socket was never bound");

    let send = async |request: String| {
        let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    };

    let response = send(format!(
        "GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Armadra-Hook-Token: {}\r\nConnection: close\r\n\r\n",
        fixture.bearer
    ))
    .await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response}");

    let response =
        send("GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".into()).await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");

    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let body = json!({
        "nodeId": fixture.node_id,
        "version": 1,
        "payload": { "hook_event_name": "UserPromptSubmit" }
    })
    .to_string();
    let response = send(format!(
        "POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         X-Armadra-Hook-Token: {}\r\nX-Armadra-Node-Token: {token}\r\nX-Armadra-Hook-Client: 1\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        fixture.bearer,
        body.len(),
    ))
    .await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response}");
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
}

/// A custom agent has no hooks of its own: the hook line the installer wrote
/// runs `armadra-hook <base>`, so the report arrives on the *base* provider's path
/// while the node is a `custom:` one. The node must keep its own id and the
/// payload must be read with the base's vocabulary (plan §24.1).
#[tokio::test]
async fn a_custom_agent_reports_through_its_base_provider() {
    let fixture = fixture("hook-custom-base").await;
    fixture
        .state
        .settings
        .patch(&json!({ "agents": { "custom": [{
            "id": "custom:echo", "label": "Echo",
            "launchCmd": "/bin/echo", "baseAgent": "gemini",
        }] } }))
        .unwrap();
    // The session row is what tells the ingest which agent owns the node.
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind, \
         owner_node_id, agent_id, status, created_at, session_key, backend_kind, \
         generation, attach_state, termination_intent) \
         VALUES (?, ?, '.', 'sh', NULL, 'terminal', ?, 'custom:echo', 'running', ?, ?, \
         'direct', 1, 'detached', 'none')",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(format!("armadra:{}", fixture.node_id))
    .execute(&fixture.state.pool)
    .await
    .unwrap();

    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    // Gemini's vocabulary on Gemini's path — the Claude adapter reads nothing
    // out of `AfterAgent`, so a `done` here proves the base picked the parser.
    assert_eq!(
        fixture
            .post_hook(
                "gemini",
                json!({
                    "nodeId": fixture.node_id,
                    "payload": { "hook_event_name": "AfterAgent" }
                }),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &token),
                ],
            )
            .await,
        StatusCode::NO_CONTENT
    );
    let status = fixture.status().await.unwrap();
    assert_eq!(status.agent_id, "custom:echo");
    assert_eq!(status.state.as_deref(), Some("done"));
}
