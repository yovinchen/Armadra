//! The wire contract: what a report persists, broadcasts and leaves unread.

use super::support::*;

/// 0013 / 协作通道 §3.2. The source is stamped by the route from the provider,
/// stored on the row and published with it, so a client can draw "done (as
/// reported by a hook)" apart from "done, as far as the output pump can tell".
///
/// Two things are asserted rather than one: that the payload cannot name its
/// own channel — an extension and a forked client post identical bodies, so a
/// body that could claim `extension` could claim anything — and that a provider
/// with no adapter yet leaves the column alone instead of guessing.
#[tokio::test]
async fn a_report_records_the_channel_it_arrived_on_and_publishes_it() {
    let fixture = fixture("hook-state-source").await;
    let mut events = fixture.state.events.subscribe(&fixture.workspace_id);

    assert_eq!(
        fixture
            .report(json!({"hook_event_name":"UserPromptSubmit"}))
            .await,
        StatusCode::NO_CONTENT
    );
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("working"));
    assert_eq!(status.state_source.as_deref(), Some("hook"));

    let published = loop {
        match events.recv().await.unwrap() {
            crate::events::WorkspaceEvent::AgentStatus { status } => break status,
            _ => continue,
        }
    };
    assert_eq!(published.state_source.as_deref(), Some("hook"));
    assert_eq!(
        serde_json::to_value(&published).unwrap()["stateSource"],
        "hook"
    );

    // A body that says otherwise is not consulted: the route derives the source
    // from the provider it was posted to.
    assert_eq!(
        fixture
            .report(json!({"hook_event_name":"Stop","stateSource":"extension"}))
            .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fixture.status().await.unwrap().state_source.as_deref(),
        Some("hook")
    );
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
