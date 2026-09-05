//! The canvas control verbs the agent skill drives.

use super::support::*;

/* --------------------------------- control -------------------------------- */

#[tokio::test]
async fn list_is_open_to_legacy_callers_and_everything_else_is_not() {
    let fixture = fixture("collab-identity").await;

    let (status, body) = fixture
        .call_legacy("/control/list", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let listed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(listed["ok"], true);
    assert_eq!(listed["result"].as_array().unwrap().len(), 3);
    assert!(listed["message"].as_str().unwrap().contains("Codex 审阅"));

    let (status, body) = fixture
        .call_legacy(
            "/control/sticky",
            &fixture.caller_id,
            json!({ "title": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("节点令牌"), "{body}");

    // A token minted for a different node is a forgery, not a downgrade.
    let other = fixture
        .state
        .hooks
        .issue_node_token(&fixture.peer_id)
        .unwrap();
    let (status, _) = fixture
        .request(
            "/control/list",
            &fixture.caller_id,
            json!({}),
            Some(&other),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn open_agent_arms_the_node_without_starting_a_process() {
    let fixture = fixture("collab-open-agent").await;
    let (status, body) = fixture
        .json(
            "/control/open-agent",
            &fixture.caller_id,
            json!({ "agent": "claude", "title": "审阅", "prompt": "复查 src/\n的改动" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    let id = body["result"]["id"].as_str().unwrap().to_owned();

    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    let created = document.nodes.iter().find(|node| node.id == id).unwrap();
    assert_eq!(created.node_type, "terminal");
    assert_eq!(created.title, "审阅");
    assert_eq!(created.data["agent"]["id"], "claude");
    // The prompt is one line, because it is typed into a shell.
    assert_eq!(
        created.data["agent"]["initialCommand"],
        "claude '复查 src/ 的改动'"
    );
    assert!(created.data["agent"]["pendingLaunch"].is_null());
    // Placed to the right of the caller, which is 640 wide at x = 0.
    assert_eq!(created.position.x, 700.0);
    assert_eq!(created.position.y, 0.0);
    // No terminal session was created: the canvas starts the PTY.
    assert!(
        db::list_sessions(&fixture.state.pool, &fixture.workspace_id)
            .await
            .unwrap()
            .is_empty()
    );

    // `--after` arms it instead, and only accepts nodes on this board.
    let (_, body) = fixture
        .json(
            "/control/open-agent",
            &fixture.caller_id,
            json!({ "agent": "codex", "after": [&fixture.peer_id], "prompt": "接着做" }),
        )
        .await;
    let armed = body["result"]["id"].as_str().unwrap().to_owned();
    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    let armed = document.nodes.iter().find(|node| node.id == armed).unwrap();
    assert_eq!(
        armed.data["agent"]["pendingLaunch"]["command"],
        "codex '接着做'"
    );
    assert_eq!(
        armed.data["agent"]["pendingLaunch"]["after"],
        json!([fixture.peer_id])
    );
    assert!(armed.data["agent"]["initialCommand"].is_null());

    let (status, body) = fixture
        .json(
            "/control/open-agent",
            &fixture.caller_id,
            json!({ "agent": "codex", "after": "11111111-1111-4111-8111-111111111111" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["ok"], false);
}

#[test]
fn the_launch_line_follows_each_cli_prompt_mode() {
    assert_eq!(
        control::launch_command("claude", None),
        ("claude".into(), None)
    );
    assert_eq!(
        control::launch_command("claude", Some("it's fine")).0,
        r"claude 'it'\''s fine'"
    );
    assert_eq!(
        control::launch_command("gemini", Some("看一下")).0,
        "gemini --prompt-interactive '看一下'"
    );
    // OpenCode and Copilot keep prompts in their interactive interfaces.
    let (command, warning) = control::launch_command("opencode", Some("看一下"));
    assert_eq!(command, "opencode --prompt '看一下'");
    assert!(warning.is_none());
    assert_eq!(
        control::launch_command("copilot", Some("review")).0,
        "copilot --interactive 'review'"
    );
}

#[tokio::test]
async fn dry_run_reports_without_touching_the_board() {
    let fixture = fixture("collab-dry-run").await;
    let before = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();

    for (path, args) in [
        (
            "/control/open-terminal",
            json!({ "dry-run": true, "title": "构建" }),
        ),
        (
            "/control/open-agent",
            json!({ "dry-run": true, "agent": "claude" }),
        ),
        (
            "/control/sticky",
            json!({ "dry-run": true, "title": "结论 2" }),
        ),
        (
            "/control/link",
            json!({ "dry-run": true, "to": &fixture.peer_id }),
        ),
    ] {
        let (status, body) = fixture.json(path, &fixture.caller_id, args).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(body["result"]["dryRun"], true, "{path}");
        assert!(
            body["message"].as_str().unwrap().starts_with("（演练）"),
            "{path}"
        );
    }

    let after = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    assert_eq!(after.nodes.len(), before.nodes.len());
    assert_eq!(after.edges.len(), 0);
    assert_eq!(after.board.updated_at, before.board.updated_at);
}

#[tokio::test]
async fn link_writes_the_edge_and_both_link_documents() {
    let fixture = fixture("collab-link").await;
    let mut events = fixture.state.events.subscribe(&fixture.workspace_id);

    let (status, body) = fixture
        .json(
            "/control/link",
            &fixture.caller_id,
            json!({ "to": "Codex 审阅" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    assert_eq!(document.edges.len(), 1);
    assert_eq!(document.edges[0].kind, "link");
    assert_eq!(document.edges[0].source, fixture.caller_id);
    assert_eq!(document.edges[0].target, fixture.peer_id);

    // Both sides can now read each other.
    let mine = db::get_context_links(&fixture.state.pool, &fixture.caller_id)
        .await
        .unwrap();
    assert_eq!(mine.links.len(), 1);
    assert_eq!(mine.links[0].id, fixture.peer_id);
    assert_eq!(mine.links[0].kind, "terminal");
    let theirs = db::get_context_links(&fixture.state.pool, &fixture.peer_id)
        .await
        .unwrap();
    assert_eq!(theirs.links[0].id, fixture.caller_id);

    // The canvas is told to reload rather than being driven directly.
    let event = events.try_recv().unwrap();
    assert!(matches!(
        event,
        crate::events::WorkspaceEvent::BoardChanged { .. }
    ));

    // Linking twice adds nothing.
    fixture
        .json(
            "/control/link",
            &fixture.caller_id,
            json!({ "to": "Codex 审阅" }),
        )
        .await;
    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    assert_eq!(document.edges.len(), 1);
    assert_eq!(
        db::get_context_links(&fixture.state.pool, &fixture.caller_id)
            .await
            .unwrap()
            .links
            .len(),
        1
    );
}

#[tokio::test]
async fn rename_and_color_stay_inside_the_palette() {
    let fixture = fixture("collab-style").await;

    let (status, _) = fixture
        .json(
            "/control/rename",
            &fixture.caller_id,
            json!({ "node": &fixture.sticky_id, "title": "结论  v2" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = fixture
        .json(
            "/control/color",
            &fixture.caller_id,
            json!({ "node": "结论 v2", "color": "#32D74B" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    let sticky = document
        .nodes
        .iter()
        .find(|node| node.id == fixture.sticky_id)
        .unwrap();
    assert_eq!(sticky.title, "结论 v2");
    assert_eq!(sticky.color, "#32d74b");

    let (status, body) = fixture
        .json(
            "/control/color",
            &fixture.caller_id,
            json!({ "node": &fixture.sticky_id, "color": "#123456" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("调色板"));
}

#[tokio::test]
async fn close_needs_a_human_and_unknown_verbs_are_named() {
    let fixture = fixture("collab-close").await;
    // Nobody is subscribed to this workspace, so there is no dialog to answer:
    // the verb refuses immediately rather than holding the agent for 130s.
    let (status, body) = fixture
        .json(
            "/control/close",
            &fixture.caller_id,
            json!({ "node": &fixture.peer_id }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().contains("界面没有连接"));

    // Closing your own node would kill the PTY the answer travels through.
    let (status, body) = fixture
        .json(
            "/control/close",
            &fixture.caller_id,
            json!({ "node": &fixture.caller_id }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("不能关闭你自己"));

    let (status, body) = fixture
        .json("/control/detonate", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("detonate"));

    // The board is untouched by either.
    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    assert_eq!(document.nodes.len(), 3);
}

#[tokio::test]
async fn a_control_verb_answers_prose_when_the_caller_asks_for_it() {
    let fixture = fixture("collab-accept").await;
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.caller_id)
        .unwrap();
    let (status, body) = fixture
        .request(
            "/control/list",
            &fixture.caller_id,
            json!({}),
            Some(&token),
            Some("text/plain"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.starts_with('{'), "{body}");
    assert!(body.contains("Claude"), "{body}");
}

/* ------------------------------ close confirm ----------------------------- */

/// The whole §5.8 round trip: the verb blocks, the canvas gets a
/// `control.confirm` frame, a human answers it over REST, and only then does
/// the node leave the board.
#[tokio::test]
async fn close_waits_for_the_canvas_and_then_removes_the_node() {
    let fixture = fixture("collab-close-confirm").await;
    let mut events = fixture.state.events.subscribe(&fixture.workspace_id);

    let state = fixture.state.clone();
    let caller = fixture.caller(fixture.node_ref(&fixture.caller_id).await);
    let peer_id = fixture.peer_id.clone();
    let verb = tokio::spawn(async move {
        let args = json!({ "node": peer_id });
        let map = args.as_object().unwrap().clone();
        control::run(&state, &caller, "close", &Args(&map)).await
    });

    let request_id = loop {
        match events.recv().await.unwrap() {
            crate::events::WorkspaceEvent::ControlConfirm {
                request_id,
                verb,
                node_id,
                summary,
            } => {
                assert_eq!(verb, "close");
                assert_eq!(node_id, fixture.peer_id);
                assert!(summary.contains("Codex 审阅"));
                break request_id;
            }
            _ => continue,
        }
    };

    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/control/confirm/{request_id}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "approve": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["accepted"], true);

    let outcome = verb.await.unwrap().unwrap();
    assert!(outcome.message.contains("已关闭"), "{}", outcome.message);

    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    assert_eq!(document.nodes.len(), 2);
    assert!(!document.nodes.iter().any(|node| node.id == fixture.peer_id));

    // An answer for a request nobody is waiting on is reported, not an error.
    assert!(!control::answer_confirm(&fixture.state, &request_id, true));
}

/// A refusal is a refusal: the board keeps every node it had.
#[tokio::test]
async fn a_refused_close_leaves_the_board_alone() {
    let fixture = fixture("collab-close-refuse").await;
    let mut events = fixture.state.events.subscribe(&fixture.workspace_id);

    let state = fixture.state.clone();
    let caller = fixture.caller(fixture.node_ref(&fixture.caller_id).await);
    let sticky_id = fixture.sticky_id.clone();
    let verb = tokio::spawn(async move {
        let args = json!({ "node": sticky_id });
        let map = args.as_object().unwrap().clone();
        control::run(&state, &caller, "close", &Args(&map)).await
    });

    let request_id = loop {
        if let crate::events::WorkspaceEvent::ControlConfirm { request_id, .. } =
            events.recv().await.unwrap()
        {
            break request_id;
        }
    };
    assert!(control::answer_confirm(&fixture.state, &request_id, false));

    let refusal = verb.await.unwrap().unwrap_err();
    assert_eq!(refusal.status, StatusCode::FORBIDDEN);
    assert!(refusal.message.contains("拒绝"));

    let document = db::load_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &fixture.board_id,
    )
    .await
    .unwrap();
    assert_eq!(document.nodes.len(), 3);
}

#[test]
fn the_palette_and_the_default_sizes_match_the_plan() {
    assert_eq!(NODE_PALETTE.len(), 7);
    assert_eq!(NODE_PALETTE[0], crate::model::DEFAULT_NODE_COLOR);
    assert_eq!(default_size("terminal"), (640.0, 440.0));
    assert_eq!(default_size("sticky"), (240.0, 200.0));
}
