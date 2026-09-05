//! Loading and saving the board document, plus the placement and naming
//! rules every verb shares.

use super::*;

/* --------------------------------- helpers -------------------------------- */

pub(super) async fn load(state: &AppState, caller: &Caller) -> Result<BoardDocument, Refusal> {
    db::load_board(
        &state.pool,
        &caller.node.workspace_id,
        &caller.node.board_id,
    )
    .await
    .map_err(internal)
}

/// Saves through the same optimistic-concurrency path the canvas uses and tells
/// every client to reload. A conflict means a human moved something in the last
/// instant; asking the agent to retry is the honest answer.
pub(super) async fn save(
    state: &AppState,
    caller: &Caller,
    document: BoardDocument,
) -> Result<(), Refusal> {
    let saved = db::save_board(
        &state.pool,
        &caller.node.workspace_id,
        &caller.node.board_id,
        db::SaveBoardRequest {
            expected_updated_at: &document.board.updated_at,
            nodes: &document.nodes,
            edges: &document.edges,
            viewport: document.board.viewport,
            // The control verbs add and move nodes; the kanban is not theirs to
            // touch, so it is carried through untouched.
            whiteboard: None,
        },
    )
    .await
    .map_err(|error| match error {
        crate::error::AppError::Conflict(_) => {
            Refusal::bad_request("画布刚刚被改动过，请再试一次。")
        }
        other => internal(other),
    })?;
    state.events.publish(
        &caller.node.workspace_id,
        WorkspaceEvent::BoardChanged {
            board_id: saved.board.id.clone(),
            updated_at: saved.board.updated_at.clone(),
        },
    );
    Ok(())
}

pub(super) fn new_node(
    board_id: &str,
    node_type: &str,
    title: &str,
    position: Position,
    size: Size,
    data: Value,
) -> CanvasNode {
    let now = chrono::Utc::now().to_rfc3339();
    CanvasNode {
        id: Uuid::now_v7().to_string(),
        board_id: board_id.to_owned(),
        node_type: node_type.to_owned(),
        title: title.to_owned(),
        color: crate::model::DEFAULT_NODE_COLOR.to_owned(),
        position,
        size: Some(size),
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

/// To the right of the caller, same y — and pushed down if something is already
/// standing there, because two nodes at identical coordinates look like one.
pub(super) fn placement(document: &BoardDocument, caller_id: &str, node_type: &str) -> Position {
    let anchor = document.nodes.iter().find(|node| node.id == caller_id);
    let (mut x, mut y) = match anchor {
        Some(node) => {
            let width = node
                .size
                .as_ref()
                .map_or_else(|| default_size(&node.node_type).0, |size| size.width);
            (node.position.x + width + PLACEMENT_GAP, node.position.y)
        }
        None => (PLACEMENT_GAP, PLACEMENT_GAP),
    };
    let (_, height) = default_size(node_type);
    for _ in 0..64 {
        let taken = document
            .nodes
            .iter()
            .any(|node| (node.position.x - x).abs() < 24.0 && (node.position.y - y).abs() < 24.0);
        if !taken {
            break;
        }
        y += height + 40.0;
    }
    if !x.is_finite() || !y.is_finite() {
        x = PLACEMENT_GAP;
        y = PLACEMENT_GAP;
    }
    Position { x, y }
}

pub(super) fn resolve_on_board<'a>(
    document: &'a BoardDocument,
    wanted: &str,
) -> Result<&'a CanvasNode, Refusal> {
    let wanted = wanted.trim();
    if let Some(node) = document.nodes.iter().find(|node| node.id == wanted) {
        return Ok(node);
    }
    let lowered = wanted.to_lowercase();
    let exact: Vec<&CanvasNode> = document
        .nodes
        .iter()
        .filter(|node| node.title.to_lowercase() == lowered)
        .collect();
    match exact.as_slice() {
        [only] => return Ok(only),
        [] => {}
        many => {
            return Err(Refusal::bad_request(format!(
                "「{wanted}」同时匹配 {} 个节点，请改用节点 ID。",
                many.len()
            )));
        }
    }
    let partial: Vec<&CanvasNode> = document
        .nodes
        .iter()
        .filter(|node| node.title.to_lowercase().contains(&lowered))
        .collect();
    match partial.as_slice() {
        [only] => Ok(only),
        [] => Err(Refusal::not_found(format!(
            "这块画布上没有叫「{wanted}」的节点。"
        ))),
        many => Err(Refusal::bad_request(format!(
            "「{wanted}」同时匹配 {} 个节点，请改用节点 ID。",
            many.len()
        ))),
    }
}

pub(super) fn clean_title(title: &str) -> Result<String, Refusal> {
    let title = collapse_newlines(title);
    if title.is_empty() {
        return Err(Refusal::bad_request("标题不能是空的。"));
    }
    if title.chars().count() > 160 {
        return Err(Refusal::bad_request("标题最长 160 个字符。"));
    }
    Ok(title)
}

/// The launch line the terminal node will type. The runtime only knows the
/// program and the prompt flag; everything else (model, permission mode) is the
/// canvas's business.
pub fn launch_command(agent_id: &str, prompt: Option<&str>) -> (String, Option<String>) {
    let program = match agent_id {
        "claude" | "codex" | "gemini" | "opencode" | "pi" | "omp" | "copilot" => {
            agent_id.to_owned()
        }
        other => other.strip_prefix("custom:").unwrap_or(other).to_owned(),
    };
    let Some(prompt) = prompt.map(collapse_newlines).filter(|p| !p.is_empty()) else {
        return (program, None);
    };
    match agent_id {
        "gemini" => (
            format!("{program} --prompt-interactive {}", quote(&prompt)),
            None,
        ),
        "opencode" => (format!("{program} --prompt {}", quote(&prompt)), None),
        "copilot" => (format!("{program} --interactive {}", quote(&prompt)), None),
        _ => (format!("{program} {}", quote(&prompt)), None),
    }
}

/// Single quotes, because the line is typed into a shell rather than exec'd.
pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
