//! Document validation: the accepted node kinds, the retired ones and the
//! annotation bounds.

use super::support::*;
use crate::db::*;
use crate::model::*;
use uuid::Uuid;

#[tokio::test]
async fn accepts_every_v3_node_kind() {
    let (pool, _directory, workspace) = fixture("v3-kinds").await;
    let board = default_board(&pool, &workspace.id).await;
    let payloads = [
        serde_json::json!({"kind":"terminal","cwd":".","shell":"/bin/zsh","agent":{"id":"claude","permissionMode":"plan","model":"opus","initialCommand":"claude --permission-mode plan"}}),
        serde_json::json!({"kind":"sticky","content":"hello"}),
        serde_json::json!({"kind":"group"}),
        serde_json::json!({"kind":"editor","path":"src/App.tsx","language":"tsx","readonly":false}),
        serde_json::json!({"kind":"diff","repoPath":".","scope":"staged","paths":["a.ts"]}),
        serde_json::json!({"kind":"files","path":"src"}),
        serde_json::json!({"kind":"browser","url":"https://example.com"}),
        serde_json::json!({"kind":"automation","planId":"plan-1","planWorkspaceId":"workspace-1","executionHostId":"0123456789abcdef0123456789abcdef","scheduleKind":"interval"}),
        serde_json::json!({"kind":"agentActivity","sourceNodeId":"3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21","source":"subagent"}),
    ];
    assert_eq!(payloads.len(), NODE_TYPES.len());
    let mut nodes = payloads
        .into_iter()
        .map(|data| {
            let mut node = sticky_node(&board.id);
            node.node_type = data["kind"].as_str().unwrap().to_owned();
            node.title = node.node_type.clone();
            node.data = data;
            node
        })
        .collect::<Vec<_>>();
    // Park the sticky inside the group to exercise parent/child validation.
    let group_id = nodes
        .iter()
        .find(|node| node.node_type == "group")
        .map(|node| node.id.clone())
        .unwrap();
    nodes[1].parent_id = Some(group_id);
    nodes[1].collapsed = Some(true);
    nodes[1].expanded_height = Some(200.0);

    let edge = CanvasEdge {
        id: Uuid::now_v7().to_string(),
        board_id: board.id.clone(),
        source: nodes[0].id.clone(),
        target: nodes[1].id.clone(),
        kind: "link".into(),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
    };

    let saved = save_board(
        &pool,
        &workspace.id,
        &board.id,
        SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &nodes,
            edges: std::slice::from_ref(&edge),
            viewport: Viewport {
                x: 12.0,
                y: -8.0,
                zoom: 0.75,
            },
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.nodes.len(), NODE_TYPES.len());
    assert_eq!(saved.edges.len(), 1);
    assert_eq!(saved.edges[0].kind, "link");
    assert_eq!(saved.board.viewport.zoom, 0.75);
    let sticky = saved
        .nodes
        .iter()
        .find(|node| node.node_type == "sticky")
        .unwrap();
    assert_eq!(sticky.collapsed, Some(true));
    assert_eq!(sticky.expanded_height, Some(200.0));
    assert!(sticky.parent_id.is_some());
}

#[tokio::test]
async fn rejects_retired_types_statuses_and_edge_kinds() {
    let (pool, _directory, workspace) = fixture("v2-rejected").await;
    let board = default_board(&pool, &workspace.id).await;

    for retired in ["task", "agent", "note", "file", "context", "log"] {
        let mut node = sticky_node(&board.id);
        node.node_type = retired.into();
        node.data = serde_json::json!({ "kind": retired, "content": "x" });
        assert!(
            matches!(
                validate_document(&board.id, &[node], &[]),
                Err(AppError::BadRequest(_))
            ),
            "{retired} was accepted"
        );
    }

    let source = sticky_node(&board.id);
    let target = sticky_node(&board.id);
    let edge = CanvasEdge {
        id: Uuid::now_v7().to_string(),
        board_id: board.id.clone(),
        source: source.id.clone(),
        target: target.id.clone(),
        kind: "dispatch".into(),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
    };
    assert!(matches!(
        validate_document(&board.id, &[source, target], &[edge]),
        Err(AppError::BadRequest(_))
    ));
}

#[tokio::test]
async fn rejects_invalid_headers_parents_and_agents() {
    let (pool, _directory, workspace) = fixture("guards").await;
    let board = default_board(&pool, &workspace.id).await;

    let mut untitled = sticky_node(&board.id);
    untitled.title = String::new();
    assert!(validate_document(&board.id, &[untitled], &[]).is_err());

    let mut bad_color = sticky_node(&board.id);
    bad_color.color = "red".into();
    assert!(validate_document(&board.id, &[bad_color], &[]).is_err());

    // A parent that is not a group node in the same document is rejected.
    let parent = sticky_node(&board.id);
    let mut child = sticky_node(&board.id);
    child.parent_id = Some(parent.id.clone());
    assert!(validate_document(&board.id, &[parent, child], &[]).is_err());

    let mut agent = sticky_node(&board.id);
    agent.node_type = "terminal".into();
    agent.data = serde_json::json!({ "kind": "terminal", "agent": { "id": "unknown-cli" } });
    assert!(validate_document(&board.id, &[agent.clone()], &[]).is_err());
    for id in crate::agent::AGENT_IDS {
        agent.data = serde_json::json!({ "kind": "terminal", "agent": { "id": id } });
        validate_document(&board.id, &[agent.clone()], &[]).unwrap();
    }
    agent.data = serde_json::json!({ "kind": "terminal", "agent": { "id": "custom:mytool" } });
    validate_document(&board.id, &[agent.clone()], &[]).unwrap();
    agent.data = serde_json::json!({
        "kind": "terminal",
        "agent": { "id": "claude", "permissionMode": "yolo" }
    });
    assert!(validate_document(&board.id, &[agent], &[]).is_err());
}

#[test]
fn labels_and_notes_are_bounded() {
    let board_id = Uuid::now_v7().to_string();
    let mut node = sticky_node(&board_id);

    node.labels = (0..9).map(|index| format!("l{index}")).collect();
    assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

    node.labels = vec!["x".repeat(25)];
    assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

    node.labels = vec!["  ".into()];
    assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

    node.labels = vec!["ok".into()];
    node.note = "n".repeat(4_001);
    assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_err());

    node.note = "n".repeat(4_000);
    assert!(validate_document(&board_id, std::slice::from_ref(&node), &[]).is_ok());
}
