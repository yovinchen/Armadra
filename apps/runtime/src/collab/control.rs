//! `POST /control/{verb}` — an agent drives the canvas (plan §5.8).
//!
//! Every mutating verb goes through the ordinary board document: load, edit,
//! save with the same CAS the web app uses, then publish `board.changed` so the
//! canvas reloads. The agent never touches the front end, and the front end
//! never has to trust the agent — it re-reads the board it already knows how to
//! read.
//!
//! `list` is the only verb a `legacy` caller may run. Everything that changes
//! something requires a node token this runtime minted.

use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    AppState, db,
    events::WorkspaceEvent,
    model::{BoardDocument, CanvasEdge, CanvasNode, ContextLink, Position, Size},
};

use super::{
    Args, Caller, NODE_PALETTE, PLACEMENT_GAP, Refusal, collapse_newlines, default_size, mailbox,
    messaging,
};

pub const VERBS: &[&str] = &[
    "help",
    "post",
    "inbox",
    "ack",
    "list",
    "open-terminal",
    "open-agent",
    "sticky",
    "link",
    "rename",
    "color",
    "send",
    "reply",
    "notify",
    "close",
];

/// Verbs a caller with no node token may run: the read-only one.
const LEGACY_VERBS: &[&str] = &["list", "help"];

/// What a control verb answers with.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub message: String,
    pub result: Option<Value>,
    pub warning: Option<String>,
    /// A verb whose own reply shape *is* the answer (messaging's discriminated
    /// union). Rendered as the whole body rather than nested under `result`,
    /// so the agent reads `outcome` and `retryable` without unwrapping.
    pub raw: Option<Value>,
}

impl Outcome {
    fn with_result(message: impl Into<String>, result: Value) -> Self {
        Self {
            message: message.into(),
            result: Some(result),
            warning: None,
            raw: None,
        }
    }

    fn raw(body: Value, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            result: None,
            warning: None,
            raw: Some(body),
        }
    }

    fn warn(mut self, warning: impl Into<String>) -> Self {
        self.warning = Some(warning.into());
        self
    }

    pub fn to_json(&self) -> Value {
        if let Some(raw) = &self.raw {
            return raw.clone();
        }
        let mut value = json!({ "ok": true, "message": self.message });
        if let Some(result) = &self.result {
            value["result"] = result.clone();
        }
        if let Some(warning) = &self.warning {
            value["warning"] = json!(warning);
        }
        value
    }
}

/// One control verb. `Err` carries the status and the sentence to print.
pub async fn run(
    state: &AppState,
    caller: &Caller,
    verb: &str,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
    if !VERBS.contains(&verb) {
        return Err(Refusal::bad_request(format!(
            "未知的画布动词 `{verb}`，可用：{}。",
            VERBS.join(" / ")
        )));
    }
    if !LEGACY_VERBS.contains(&verb) {
        caller.require_verified(verb)?;
    }
    match verb {
        "help" => Ok(Outcome::with_result(
            mailbox::HELP,
            json!({ "protocol": "armadra.mailbox.v1" }),
        )),
        "post" | "inbox" | "ack" => {
            let result = mailbox::run(state, caller, verb, args).await?;
            Ok(Outcome::raw(result.clone(), result.to_string()))
        }
        "list" => list(state, caller).await,
        "open-terminal" => open_terminal(state, caller, args).await,
        "open-agent" => open_agent(state, caller, args).await,
        "sticky" => sticky(state, caller, args).await,
        "link" => link(state, caller, args).await,
        "rename" => rename(state, caller, args).await,
        "color" => color(state, caller, args).await,
        "send" | "reply" | "notify" => {
            // A refused delivery is an answer, not an error: the agent needs
            // `outcome` and `retryable` to decide what to do next, and a 4xx
            // would reduce both to one stderr line.
            let report = messaging::run(state, caller, verb, args).await?;
            Ok(Outcome::raw(report.to_json(), report.message.clone()))
        }
        "close" => close(state, caller, args).await,
        _ => unreachable!("verb was checked above"),
    }
}

/* ---------------------------------- list ---------------------------------- */

async fn list(state: &AppState, caller: &Caller) -> Result<Outcome, Refusal> {
    let document = load(state, caller).await?;
    let mut rows = Vec::new();
    let mut lines = Vec::new();
    for node in &document.nodes {
        let status = db::get_agent_status(&state.pool, &node.id)
            .await
            .map_err(internal)?;
        let agent = node
            .data
            .get("agent")
            .and_then(|agent| agent.get("id"))
            .and_then(Value::as_str);
        let state_name = status.as_ref().and_then(|status| status.state.clone());
        lines.push(format!(
            "- {} [{}]{}{}  id={}{}",
            node.title,
            node.node_type,
            agent.map(|id| format!(" {id}")).unwrap_or_default(),
            state_name
                .as_deref()
                .map(|state| format!(" · {state}"))
                .unwrap_or_default(),
            node.id,
            if node.id == caller.node.id {
                "  ← 你"
            } else {
                ""
            },
        ));
        rows.push(json!({
            "id": node.id,
            "type": node.node_type,
            "title": node.title,
            "agent": agent,
            "state": state_name,
            "self": node.id == caller.node.id,
        }));
    }
    let message = format!(
        "画布「{}」上有 {} 个节点：\n{}",
        document.board.name,
        document.nodes.len(),
        lines.join("\n")
    );
    Ok(Outcome::with_result(message, Value::Array(rows)))
}

/* -------------------------------- new nodes ------------------------------- */

async fn open_terminal(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
    let title = args.text("title").unwrap_or("终端").to_owned();
    let title = clean_title(&title)?;
    let mut document = load(state, caller).await?;
    let position = placement(&document, &caller.node.id, "terminal");
    let (width, height) = default_size("terminal");
    let data = json!({ "kind": "terminal" });

    if args.flag("dry-run") {
        return Ok(Outcome::with_result(
            format!("（演练）会在你右侧创建终端节点「{title}」。"),
            json!({ "dryRun": true, "type": "terminal", "title": title }),
        ));
    }
    let node = new_node(
        &document.board.id,
        "terminal",
        &title,
        position,
        Size { width, height },
        data,
    );
    let id = node.id.clone();
    document.nodes.push(node);
    save(state, caller, document).await?;
    Ok(Outcome::with_result(
        format!("已创建终端节点「{title}」。"),
        json!({ "id": id, "type": "terminal", "title": title }),
    ))
}

async fn open_agent(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
    let agent_id = args
        .text("agent")
        .ok_or_else(|| {
            Refusal::bad_request(
                "open-agent 需要 --agent claude|codex|gemini|opencode|pi|omp|copilot。",
            )
        })?
        .to_owned();
    if !db::valid_agent_id(&agent_id) {
        return Err(Refusal::bad_request(format!(
            "不认识的 agent `{agent_id}`；可用：claude / codex / gemini / opencode / pi / omp / copilot。"
        )));
    }
    let prompt = args.text("prompt").map(collapse_newlines);
    let prompt = prompt.filter(|prompt| !prompt.is_empty());
    let title = clean_title(args.text("title").unwrap_or(&agent_id))?;
    let after = args.list("after");
    let mut document = load(state, caller).await?;
    for id in &after {
        if !document.nodes.iter().any(|node| &node.id == id) {
            return Err(Refusal::bad_request(format!(
                "--after 里的 `{id}` 不是这块画布上的节点。"
            )));
        }
    }
    let (command, warning) = launch_command(&agent_id, prompt.as_deref());

    // The runtime never starts the process. The terminal node creates its PTY
    // when the canvas mounts it; `pendingLaunch` is what makes it wait first.
    let mut agent = Map::new();
    agent.insert("id".into(), json!(agent_id));
    if after.is_empty() {
        agent.insert(
            "initialCommand".into(),
            json!(if prompt.is_some() {
                command.clone()
            } else {
                String::new()
            }),
        );
    } else {
        agent.insert(
            "pendingLaunch".into(),
            json!({ "command": command, "after": after }),
        );
    }
    let data = json!({ "kind": "terminal", "agent": Value::Object(agent) });

    if args.flag("dry-run") {
        let outcome = Outcome::with_result(
            format!("（演练）会创建 {agent_id} 节点「{title}」，启动行：{command}"),
            json!({ "dryRun": true, "agent": agent_id, "title": title, "command": command, "after": after }),
        );
        return Ok(match warning {
            Some(warning) => outcome.warn(warning),
            None => outcome,
        });
    }

    let position = placement(&document, &caller.node.id, "terminal");
    let (width, height) = default_size("terminal");
    let node = new_node(
        &document.board.id,
        "terminal",
        &title,
        position,
        Size { width, height },
        data,
    );
    let id = node.id.clone();
    document.nodes.push(node);
    save(state, caller, document).await?;
    let message = if after.is_empty() {
        format!("已创建 {agent_id} 节点「{title}」，它会自己启动。")
    } else {
        format!(
            "已创建 {agent_id} 节点「{title}」，等待 {} 个依赖完成后启动。",
            after.len()
        )
    };
    let outcome = Outcome::with_result(
        message,
        json!({ "id": id, "agent": agent_id, "title": title, "command": command, "after": after }),
    );
    Ok(match warning {
        Some(warning) => outcome.warn(warning),
        None => outcome,
    })
}

async fn sticky(state: &AppState, caller: &Caller, args: &Args<'_>) -> Result<Outcome, Refusal> {
    let title = clean_title(args.text("title").unwrap_or("便签"))?;
    let content = args.text("content").unwrap_or("").to_owned();
    if content.chars().count() > 20_000 {
        return Err(Refusal::bad_request("便签内容太长了。"));
    }
    if args.flag("dry-run") {
        return Ok(Outcome::with_result(
            format!("（演练）会创建便签「{title}」。"),
            json!({ "dryRun": true, "type": "sticky", "title": title }),
        ));
    }
    let mut document = load(state, caller).await?;
    let position = placement(&document, &caller.node.id, "sticky");
    let (width, height) = default_size("sticky");
    let node = new_node(
        &document.board.id,
        "sticky",
        &title,
        position,
        Size { width, height },
        json!({ "kind": "sticky", "content": content }),
    );
    let id = node.id.clone();
    document.nodes.push(node);
    save(state, caller, document).await?;
    Ok(Outcome::with_result(
        format!("已创建便签「{title}」。"),
        json!({ "id": id, "type": "sticky", "title": title }),
    ))
}

/* ---------------------------------- edits --------------------------------- */

async fn link(state: &AppState, caller: &Caller, args: &Args<'_>) -> Result<Outcome, Refusal> {
    let mut document = load(state, caller).await?;
    let from = resolve_on_board(&document, args.text("from").unwrap_or(&caller.node.id))?;
    let to = resolve_on_board(
        &document,
        args.text("to")
            .ok_or_else(|| Refusal::bad_request("link 需要 --to <节点 id 或标题>。"))?,
    )?;
    if from.id == to.id {
        return Err(Refusal::bad_request("不能把节点连到它自己。"));
    }
    let (from_id, from_title, from_kind) =
        (from.id.clone(), from.title.clone(), from.node_type.clone());
    let (to_id, to_title, to_kind) = (to.id.clone(), to.title.clone(), to.node_type.clone());
    let exists = document
        .edges
        .iter()
        .any(|edge| edge.source == from_id && edge.target == to_id);
    if args.flag("dry-run") {
        return Ok(Outcome::with_result(
            format!(
                "（演练）会建立「{from_title}」→「{to_title}」的上下文链接{}。",
                if exists { "（已存在）" } else { "" }
            ),
            json!({ "dryRun": true, "from": from_id, "to": to_id, "exists": exists }),
        ));
    }
    if !exists {
        let now = chrono::Utc::now().to_rfc3339();
        let board_id = document.board.id.clone();
        document.edges.push(CanvasEdge {
            id: Uuid::now_v7().to_string(),
            board_id,
            source: from_id.clone(),
            target: to_id.clone(),
            kind: "link".into(),
            created_at: now.clone(),
            updated_at: now,
        });
    }
    save(state, caller, document).await?;

    // The link document is what the context-link verbs authorize against, so it
    // has to move in the same breath as the edge.
    add_link(state, caller, &from_id, &to_id, &to_title, &to_kind).await?;
    add_link(state, caller, &to_id, &from_id, &from_title, &from_kind).await?;
    Ok(Outcome::with_result(
        format!("已连接「{from_title}」↔「{to_title}」，两边都能读对方的上下文了。"),
        json!({ "from": from_id, "to": to_id }),
    ))
}

async fn add_link(
    state: &AppState,
    caller: &Caller,
    owner: &str,
    other: &str,
    title: &str,
    kind: &str,
) -> Result<(), Refusal> {
    let mut links = db::get_context_links(&state.pool, owner)
        .await
        .map_err(internal)?
        .links;
    if links.iter().any(|link| link.id == other) {
        return Ok(());
    }
    links.push(ContextLink {
        id: other.to_owned(),
        title: title.to_owned(),
        kind: kind.to_owned(),
        // `link` always joins two nodes; only the canvas mints shape links.
        content: None,
    });
    db::put_context_links(&state.pool, &caller.node.workspace_id, owner, &links)
        .await
        .map_err(internal)?;
    Ok(())
}

async fn rename(state: &AppState, caller: &Caller, args: &Args<'_>) -> Result<Outcome, Refusal> {
    let title = clean_title(
        args.text("title")
            .ok_or_else(|| Refusal::bad_request("rename 需要 --title \"新标题\"。"))?,
    )?;
    let mut document = load(state, caller).await?;
    let target = resolve_on_board(&document, args.text("node").unwrap_or(&caller.node.id))?;
    let id = target.id.clone();
    let previous = target.title.clone();
    for node in &mut document.nodes {
        if node.id == id {
            node.title = title.clone();
            node.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }
    save(state, caller, document).await?;
    Ok(Outcome::with_result(
        format!("「{previous}」已改名为「{title}」。"),
        json!({ "id": id, "title": title }),
    ))
}

async fn color(state: &AppState, caller: &Caller, args: &Args<'_>) -> Result<Outcome, Refusal> {
    let wanted = args
        .text("color")
        .ok_or_else(|| Refusal::bad_request("color 需要 --color <十六进制颜色>。"))?
        .to_lowercase();
    if !NODE_PALETTE.contains(&wanted.as_str()) {
        return Err(Refusal::bad_request(format!(
            "`{wanted}` 不在节点调色板里，可用：{}。",
            NODE_PALETTE.join(" ")
        )));
    }
    let mut document = load(state, caller).await?;
    let target = resolve_on_board(&document, args.text("node").unwrap_or(&caller.node.id))?;
    let id = target.id.clone();
    let title = target.title.clone();
    for node in &mut document.nodes {
        if node.id == id {
            node.color = wanted.clone();
            node.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }
    save(state, caller, document).await?;
    Ok(Outcome::with_result(
        format!("「{title}」的颜色已改为 {wanted}。"),
        json!({ "id": id, "color": wanted }),
    ))
}

/* ---------------------------------- close --------------------------------- */

/// How long a `close` waits for a human (plan §5.8). The hook client's own
/// wait is longer, so a refusal always reaches the agent as a sentence rather
/// than as a dropped connection.
pub const CONFIRM_TIMEOUT_SECS: u64 = 130;

/// Answers a pending confirmation. `false` means nothing was waiting any more:
/// the verb already timed out, or the id was never minted.
pub fn answer_confirm(state: &AppState, request_id: &str, approve: bool) -> bool {
    let collab = super::collab(state);
    let sender = {
        let mut confirms = collab
            .confirms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        confirms.remove(request_id)
    };
    match sender {
        // A closed receiver is the timeout racing us; treat it as "too late".
        Some(sender) => sender.send(approve).is_ok(),
        None => false,
    }
}

/// `close` — the one destructive verb, so it never runs on the agent's word
/// alone: the canvas gets a `control.confirm` frame, a human answers it, and
/// only then does the node leave the board and its PTY get destroyed.
///
/// Everything is re-derived *after* the wait: 130 seconds is long enough for
/// the board to have moved on, and acting on the pre-wait snapshot would
/// resurrect whatever changed in between.
async fn close(state: &AppState, caller: &Caller, args: &Args<'_>) -> Result<Outcome, Refusal> {
    let document = load(state, caller).await?;
    let wanted = args
        .text("node")
        .ok_or_else(|| Refusal::bad_request("close 需要 --node <节点 id 或标题>。"))?;
    let target = resolve_on_board(&document, wanted)?;
    let target_id = target.id.clone();
    let title = target.title.clone();
    let node_type = target.node_type.clone();
    if target_id == caller.node.id {
        return Err(Refusal::bad_request(
            "不能关闭你自己所在的节点；请让用户手动关闭。",
        ));
    }

    let summary = format!(
        "「{}」请求关闭节点「{title}」（{node_type}）。终端会被销毁，节点会从画布上移除。",
        caller.node.title
    );
    if args.flag("dry-run") {
        return Ok(Outcome::with_result(
            format!("（演练）会请用户确认关闭「{title}」。"),
            json!({ "dryRun": true, "id": target_id, "title": title, "summary": summary }),
        ));
    }

    let request_id = super::nonce(16);
    let (sender, receiver) = tokio::sync::oneshot::channel::<bool>();
    let collab = super::collab(state);
    collab
        .confirms
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(request_id.clone(), sender);

    let listeners = state.events.publish(
        &caller.node.workspace_id,
        WorkspaceEvent::ControlConfirm {
            request_id: request_id.clone(),
            verb: "close".to_owned(),
            node_id: target_id.clone(),
            summary: summary.clone(),
        },
    );
    // Nobody is watching this workspace, so nobody can confirm: say so now
    // instead of holding the agent for two minutes on a dialog that will
    // never be drawn.
    if listeners == 0 {
        forget_confirm(state, &request_id);
        return Err(Refusal::forbidden(
            "界面没有连接到这个工作空间，close 无法获得确认。",
        ));
    }

    let verdict = tokio::time::timeout(
        std::time::Duration::from_secs(CONFIRM_TIMEOUT_SECS),
        receiver,
    )
    .await;
    forget_confirm(state, &request_id);
    match verdict {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return Err(Refusal::forbidden(format!("用户拒绝了关闭「{title}」。"))),
        // The sender was dropped without an answer — treat it like a refusal.
        Ok(Err(_)) => return Err(Refusal::forbidden("确认请求已失效，close 已取消。")),
        Err(_) => {
            return Err(Refusal::forbidden(format!(
                "等待用户确认超过 {CONFIRM_TIMEOUT_SECS} 秒，关闭「{title}」已取消。"
            )));
        }
    }

    // The PTY first: a node that is gone from the board can no longer be
    // reached, so a session left running would be unreachable rather than
    // merely orphaned.
    if let Ok(Some(session)) = super::load_session(&state.pool, &target_id).await
        && let Err(error) = state
            .terminals
            .terminate(&session.session_id, crate::terminal::TerminateMode::Session)
            .await
    {
        tracing::warn!(%error, session = %session.session_id, "close: terminal already gone");
    }

    let mut document = load(state, caller).await?;
    let existed = document.nodes.iter().any(|node| node.id == target_id);
    document.nodes.retain(|node| node.id != target_id);
    // Members of a closed group outlive it; only the frame goes away.
    for node in &mut document.nodes {
        if node.parent_id.as_deref() == Some(target_id.as_str()) {
            node.parent_id = None;
            node.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }
    document
        .edges
        .retain(|edge| edge.source != target_id && edge.target != target_id);
    save(state, caller, document).await?;
    Ok(Outcome::with_result(
        if existed {
            format!("用户已确认，「{title}」已关闭。")
        } else {
            format!("用户已确认，但「{title}」在等待期间已经不在画布上了。")
        },
        json!({ "id": target_id, "title": title, "closed": existed }),
    ))
}

fn forget_confirm(state: &AppState, request_id: &str) {
    super::collab(state)
        .confirms
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(request_id);
}

/* --------------------------------- helpers -------------------------------- */

async fn load(state: &AppState, caller: &Caller) -> Result<BoardDocument, Refusal> {
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
async fn save(state: &AppState, caller: &Caller, document: BoardDocument) -> Result<(), Refusal> {
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

fn new_node(
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
fn placement(document: &BoardDocument, caller_id: &str, node_type: &str) -> Position {
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

fn resolve_on_board<'a>(
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

fn clean_title(title: &str) -> Result<String, Refusal> {
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
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn internal(error: crate::error::AppError) -> Refusal {
    match error {
        crate::error::AppError::BadRequest(message) => Refusal::bad_request(message),
        crate::error::AppError::NotFound(message) => Refusal::not_found(message),
        crate::error::AppError::Forbidden(message) => Refusal::forbidden(message),
        other => Refusal {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("画布操作失败：{other}"),
        },
    }
}
