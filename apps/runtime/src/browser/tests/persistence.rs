//! A kept session across a Runtime restart, and a linked agent driving it.

use super::support::*;

/// A Runtime restart brings the session back from its own profile at the URL
/// it was on. A second `AppState` with its own data directory is exactly what
/// a restarted process looks like to this module: a fresh live registry over
/// the same database rows and the same profiles on disk.
#[tokio::test]
async fn a_kept_session_comes_back_after_a_runtime_restart() {
    let fixture = fixture("cdp-restore").await;
    if browser_or_skip(&fixture.state, "a_kept_session_comes_back…").is_none() {
        return;
    }
    let page = serve_page().await;
    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let first = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            url: Some(page.url("/second")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(first.keep_alive, "sessions are kept by default (design §9)");
    let profile = session::require_live(&fixture.state, &first.session_id)
        .await
        .unwrap()
        .profile
        .clone();

    // The Runtime goes away: browsers die, rows and profiles do not.
    session::shutdown(&fixture.state).await;
    assert!(profile.exists());

    let restarted = AppState {
        remote: Default::default(),
        hooks: HookService::new(fixture.directory.path().join("data-restarted"), None),
        ..fixture.state.clone()
    };
    assert_eq!(session::restore(&restarted).await.unwrap(), 1);
    let live = crate::browser::service(&restarted)
        .live(&first.session_id)
        .expect("the session should be running again");
    let second = live.snapshot();
    assert_eq!(second.session_id, first.session_id);
    assert_eq!(second.url, page.url("/second"));
    assert_eq!(
        second.generation,
        first.generation + 1,
        "a relaunch is a new generation, so a client can tell"
    );
    assert_eq!(second.node_id, fixture.node_id);
    // The same profile, so whatever was logged in still is.
    assert_eq!(live.profile, profile);
    let read = session::read(&live, ReadMode::Text, 10, 4_096)
        .await
        .unwrap();
    assert!(read.text.contains("第二页"), "got {:?}", read.text);

    // Terminating is the only thing that removes the profile.
    session::close(&restarted, &first.session_id, true)
        .await
        .unwrap();
    assert!(!profile.exists());
    assert!(
        crate::browser::stored(&restarted.pool, &first.session_id)
            .await
            .unwrap()
            .is_none()
    );
    drop(page);
}

/// The agent surface drives the same session a person would, and `read`
/// answers with the page's own text.
#[tokio::test]
async fn a_linked_agent_reads_and_drives_the_same_session() {
    let fixture = fixture("cdp-agent").await;
    if browser_or_skip(&fixture.state, "a_linked_agent_reads…").is_none() {
        return;
    }
    let page = serve_page().await;
    // The node's data carries the URL, which is what the verb opens.
    let node = crate::collab::load_node(&fixture.state.pool, &fixture.node_id)
        .await
        .unwrap()
        .unwrap();
    let board_id = node.board_id.clone();
    let board = db::load_board(&fixture.state.pool, &fixture.workspace_id, &board_id)
        .await
        .unwrap();
    let mut nodes = board.nodes.clone();
    for node in &mut nodes {
        if node.id == fixture.node_id {
            node.data = json!({ "kind": "browser", "url": page.url("/") });
        }
    }
    db::save_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &board_id,
        db::SaveBoardRequest {
            expected_updated_at: &board.board.updated_at,
            nodes: &nodes,
            edges: &board.edges,
            viewport: board.board.viewport,
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    let agent = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    let caller = crate::collab::Caller {
        node: agent,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let args = serde_json::Map::new();
    let body =
        crate::browser::agent::run(&fixture.state, &caller, "read", &crate::collab::Args(&args))
            .await
            .unwrap();
    assert!(body.contains("受控浏览器测试页"), "got {body}");
    assert!(body.contains("Armadra 受控浏览器"));

    // The verb opened one session, bound to the node — the same one a person
    // driving that node would be looking at.
    let stored = crate::browser::stored_for_node(&fixture.state.pool, &fixture.node_id)
        .await
        .unwrap()
        .expect("the verb should have opened the node's session");
    let live = session::require_live(&fixture.state, &stored.id)
        .await
        .unwrap();

    // Typing and clicking through the agent surface changes that same page.
    let mut typed = serde_json::Map::new();
    typed.insert("selector".into(), json!("#name"));
    typed.insert("text".into(), json!("代理"));
    crate::browser::agent::run(
        &fixture.state,
        &caller,
        "type",
        &crate::collab::Args(&typed),
    )
    .await
    .unwrap();
    let mut clicked = serde_json::Map::new();
    clicked.insert("selector".into(), json!("#submit"));
    crate::browser::agent::run(
        &fixture.state,
        &caller,
        "click",
        &crate::collab::Args(&clicked),
    )
    .await
    .unwrap();
    let read = session::read(&live, ReadMode::Text, 40, crate::browser::MAX_TEXT_BYTES)
        .await
        .unwrap();
    assert!(read.text.contains("Hello 代理"), "got {:?}", read.text);

    // The activity trace records what the agent did to the node.
    let log = std::fs::read_to_string(
        std::path::Path::new(&fixture.directory.path()).join(".armadra/board-log.jsonl"),
    )
    .unwrap();
    assert!(log.contains("browser.read"), "got {log}");
    assert!(log.contains("browser.click"));
    assert!(log.contains(&fixture.node_id));

    session::close(&fixture.state, &stored.id, true)
        .await
        .unwrap();
    drop(page);
}
