//! Agent-to-agent messages — plan §5.7.
//!
//! One agent asks us to type something into another agent's terminal. That is a
//! remote code execution primitive dressed as a courtesy, so the request passes
//! seven gates before a byte is written, and the *application* builds the frame:
//! the sender supplies a body and nothing else.
//!
//! ```text
//! identity → scope → workspace switch → flow control → idle gate → pane gate → deliver
//! ```
//!
//! Each gate has its own outcome so a refusal is diagnosable from the reply
//! alone, and every outcome carries `retryable` so the calling agent knows
//! whether waiting would help.

use std::time::Duration;

use chrono::Utc;
use serde_json::{Value, json};
use sqlx::Row;

use crate::{AppState, db, events::WorkspaceEvent, terminal::backend::ForegroundInfo};

use super::{
    Args, Caller, CollabState, NodeRef, Refusal, board_log, collab, collapse_newlines,
    delivery_queue::{self, Queued},
    expected_processes, load_node, load_session, nonce, strip_control,
};

/// A pair may deliver at most once per this interval.
pub const PAIR_INTERVAL_SECONDS: i64 = 10;
/// A sender may write to at most this many distinct targets per turn.
pub const TARGETS_PER_TURN: usize = 4;
/// How long we wait for the target to react before calling the write `stalled`.
pub const RECEIPT_WINDOW: Duration = Duration::from_secs(8);
/// Longest body we will paste.
pub const MAX_BODY_CHARS: usize = 4_000;
/// Length of the frame nonce.
const NONCE_LENGTH: usize = 12;

/* --------------------------------- outcomes ------------------------------- */

/// The discriminated union of plan §5.7, plus its `retryable` map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    Queued,
    Stalled,
    Expired,
    RateLimited,
    QueueFull,
    TargetBusy,
    TargetStatusUnverified,
    TargetStatusStale,
    TargetNotAgentPane,
    TargetGone,
    NotPermitted,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Queued => "queued",
            Self::Stalled => "stalled",
            Self::Expired => "expired",
            Self::RateLimited => "rateLimited",
            Self::QueueFull => "queueFull",
            Self::TargetBusy => "targetBusy",
            Self::TargetStatusUnverified => "targetStatusUnverified",
            Self::TargetStatusStale => "targetStatusStale",
            Self::TargetNotAgentPane => "targetNotAgentPane",
            Self::TargetGone => "targetGone",
            Self::NotPermitted => "notPermitted",
        }
    }

    /// Would trying again later plausibly work?
    pub fn retryable(self) -> bool {
        match self {
            // Nothing to retry.
            Self::Delivered | Self::Queued => false,
            // The target's own state is what blocked it, and that changes.
            Self::Stalled
            | Self::Expired
            | Self::RateLimited
            | Self::QueueFull
            | Self::TargetBusy
            | Self::TargetStatusStale
            | Self::TargetNotAgentPane => true,
            // Configuration or authorization: retrying changes nothing.
            Self::TargetStatusUnverified | Self::TargetGone | Self::NotPermitted => false,
        }
    }

    pub fn is_ok(self) -> bool {
        matches!(self, Self::Delivered | Self::Queued)
    }
}

/// What a verb answers with. Rendered as JSON, or as `message` alone when the
/// caller asked for prose.
#[derive(Debug, Clone)]
pub struct Report {
    pub outcome: Outcome,
    pub message: String,
    pub trace_id: Option<String>,
    pub receipt: Option<String>,
    /// The gate that produced this outcome, when the outcome alone is ambiguous
    /// (`notPermitted` covers four different refusals).
    pub reason: Option<&'static str>,
    pub traced: Option<&'static str>,
}

impl Report {
    fn refused(outcome: Outcome, reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            outcome,
            message: message.into(),
            trace_id: None,
            receipt: None,
            reason: Some(reason),
            traced: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "ok": self.outcome.is_ok(),
            "outcome": self.outcome.as_str(),
            "retryable": self.outcome.retryable(),
            "message": self.message,
        });
        if let Some(trace_id) = &self.trace_id {
            value["traceId"] = json!(trace_id);
        }
        if let Some(receipt) = &self.receipt {
            value["receipt"] = json!(receipt);
        }
        if let Some(reason) = self.reason {
            value["reason"] = json!(reason);
        }
        if let Some(traced) = self.traced {
            value["traced"] = json!(traced);
        }
        value
    }
}

/* --------------------------------- envelope ------------------------------- */

/// The five-line frame of plan §5.7. The sender never sees the nonce and never
/// supplies a header field, so it cannot forge a frame around its own body: the
/// header fields are newline-collapsed and the body loses its ESC bytes.
pub fn envelope(from_title: &str, from_id: &str, body: &str) -> String {
    let nonce = nonce(NONCE_LENGTH);
    frame(&nonce, from_title, from_id, body)
}

pub fn frame(nonce: &str, from_title: &str, from_id: &str, body: &str) -> String {
    let title = collapse_newlines(from_title);
    let id = collapse_newlines(from_id);
    let body = strip_control(body);
    format!(
        "--- ARMADRA MESSAGE {nonce} ---\nfrom: {title} ({id})\nreply-to: {id}\n{}\n--- END ARMADRA MESSAGE {nonce} ---",
        body.trim_end()
    )
}

/// The fixed `notify` body. The sender cannot inject instructions through it.
pub fn notify_body(source_title: &str) -> String {
    format!(
        "{} 已完成一轮工作，可读取其上下文。",
        collapse_newlines(source_title)
    )
}

/* ----------------------------------- verb --------------------------------- */

/// `send` / `reply` / `notify`.
pub async fn run(
    state: &AppState,
    caller: &Caller,
    verb: &str,
    args: &Args<'_>,
) -> Result<Report, Refusal> {
    caller.require_verified(verb)?;

    let target = resolve_target(state, caller, verb, args).await?;
    let body = match verb {
        "notify" => notify_body(&caller.node.title),
        _ => {
            let body = args
                .text("body")
                .or_else(|| args.text("message"))
                .ok_or_else(|| {
                    Refusal::bad_request(format!("`{verb}` 需要 --body \"要发送的内容\"。"))
                })?;
            let body = strip_control(body);
            if body.trim().is_empty() {
                return Err(Refusal::bad_request("消息正文是空的，没有发送。"));
            }
            if body.chars().count() > MAX_BODY_CHARS {
                return Err(Refusal::bad_request(format!(
                    "消息正文超过 {MAX_BODY_CHARS} 字，请自己先压缩。"
                )));
            }
            body
        }
    };
    Ok(deliver(state, caller, &target, verb, &body, RECEIPT_WINDOW).await)
}

/// Resolves `--to` inside the caller's own workspace.
async fn resolve_target(
    state: &AppState,
    caller: &Caller,
    verb: &str,
    args: &Args<'_>,
) -> Result<NodeRef, Refusal> {
    let wanted = args.text("to").or_else(|| args.text("node"));
    let wanted = match (wanted, verb) {
        (Some(wanted), _) => wanted.to_owned(),
        // `reply` with no target answers whoever wrote last.
        (None, "reply") => last_sender(state, caller)
            .await?
            .ok_or_else(|| Refusal::bad_request("没有可回复的对象，请用 --to 指明。"))?,
        _ => {
            return Err(Refusal::bad_request(format!(
                "`{verb}` 需要 --to <节点 id 或标题>。"
            )));
        }
    };
    let candidates = workspace_nodes(state, &caller.node.workspace_id)
        .await
        .map_err(internal)?;
    let matched = match_node(&candidates, &wanted)?;
    Ok(matched)
}

async fn last_sender(state: &AppState, caller: &Caller) -> Result<Option<String>, Refusal> {
    let row = sqlx::query(
        "SELECT source_node_id FROM agent_deliveries WHERE workspace_id = ? AND target_node_id = ? \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&caller.node.workspace_id)
    .bind(&caller.node.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| internal(error.into()))?;
    Ok(match row {
        Some(row) => Some(
            row.try_get("source_node_id")
                .map_err(|error| internal(crate::error::AppError::from(error)))?,
        ),
        None => None,
    })
}

async fn workspace_nodes(
    state: &AppState,
    workspace_id: &str,
) -> crate::error::AppResult<Vec<NodeRef>> {
    let rows = sqlx::query(
        "SELECT n.id AS id, n.board_id AS board_id, n.title AS title, n.type AS type, \
                n.data_json AS data_json, b.workspace_id AS workspace_id \
         FROM nodes n JOIN boards b ON b.id = n.board_id WHERE b.workspace_id = ? \
         ORDER BY n.created_at",
    )
    .bind(workspace_id)
    .fetch_all(&state.pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let data_json: String = row.try_get("data_json")?;
            let data: Value = serde_json::from_str(&data_json).unwrap_or(Value::Null);
            Ok(NodeRef {
                id: row.try_get("id")?,
                board_id: row.try_get("board_id")?,
                workspace_id: row.try_get("workspace_id")?,
                title: row.try_get("title")?,
                node_type: row.try_get("type")?,
                agent_id: data
                    .get("agent")
                    .and_then(|agent| agent.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                data,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(crate::error::AppError::from)
}

/// Id, then exact title, then unique substring. Ambiguity is a refusal.
pub fn match_node(candidates: &[NodeRef], wanted: &str) -> Result<NodeRef, Refusal> {
    let wanted = wanted.trim();
    if let Some(node) = candidates.iter().find(|node| node.id == wanted) {
        return Ok(node.clone());
    }
    let lowered = wanted.to_lowercase();
    let exact: Vec<&NodeRef> = candidates
        .iter()
        .filter(|node| node.title.to_lowercase() == lowered)
        .collect();
    match exact.as_slice() {
        [only] => return Ok((*only).clone()),
        [] => {}
        many => return Err(ambiguous(wanted, many)),
    }
    let partial: Vec<&NodeRef> = candidates
        .iter()
        .filter(|node| node.title.to_lowercase().contains(&lowered))
        .collect();
    match partial.as_slice() {
        [only] => Ok((*only).clone()),
        [] => Err(Refusal::not_found(format!(
            "当前工作空间里没有叫「{wanted}」的节点。"
        ))),
        many => Err(ambiguous(wanted, many)),
    }
}

fn ambiguous(wanted: &str, matches: &[&NodeRef]) -> Refusal {
    Refusal::bad_request(format!(
        "「{wanted}」同时匹配 {} 个节点，请改用节点 ID。",
        matches.len()
    ))
}

/* --------------------------------- delivery ------------------------------- */

/// The gate chain. Also the queue-flush path, which is why it takes the target
/// as a resolved node and re-derives everything else.
pub async fn deliver(
    state: &AppState,
    caller: &Caller,
    target: &NodeRef,
    verb: &str,
    body: &str,
    receipt_window: Duration,
) -> Report {
    let collab = collab(state);
    let trace_id = nonce(16);

    // 2 — scope.
    if target.id == caller.node.id {
        return Report::refused(Outcome::NotPermitted, "selfSend", "不能给自己发消息。");
    }
    if target.workspace_id != caller.node.workspace_id {
        return Report::refused(
            Outcome::NotPermitted,
            "crossWorkspace",
            "目标节点不在同一个工作空间，已拒绝。",
        );
    }
    if target.node_type != "terminal" {
        return Report::refused(
            Outcome::NotPermitted,
            "targetNotTerminal",
            format!("「{}」不是终端节点，无法接收消息。", target.title),
        );
    }

    // 3 — the workspace switch, off by default.
    if !messaging_enabled(state, &caller.node.workspace_id) {
        return Report::refused(
            Outcome::NotPermitted,
            "workspaceSwitchOff",
            "这个工作空间没有开启 Agent 互发消息（设置 → 工作空间 → agentMessaging）。",
        );
    }

    // 4 — flow control.
    if let Err(report) = check_flow(&collab, &caller.node.id, &target.id) {
        return report;
    }

    // 5 — the idle gate. A busy target is queued, never interrupted.
    let status = match db::get_agent_status(&state.pool, &target.id).await {
        Ok(status) => status,
        Err(error) => {
            return Report::refused(
                Outcome::TargetGone,
                "statusUnreadable",
                format!("读取目标状态失败：{error}"),
            );
        }
    };
    let Some(status) = status else {
        return Report::refused(
            Outcome::TargetStatusStale,
            "neverReported",
            format!("「{}」还没有报告过状态，无法确认它是否空闲。", target.title),
        );
    };
    if !status.verified {
        return Report::refused(
            Outcome::TargetStatusUnverified,
            "unverifiedStatus",
            format!(
                "「{}」的状态来自未验证的 hook 客户端，不投递。",
                target.title
            ),
        );
    }
    if status.restored {
        return Report::refused(
            Outcome::TargetStatusStale,
            "restoredStatus",
            format!(
                "「{}」的状态是运行时重启前留下的，等它自己报告一次再试。",
                target.title
            ),
        );
    }
    if status.state.as_deref() != Some("done") {
        return queue(
            state,
            &collab,
            caller,
            target,
            verb,
            body,
            &trace_id,
            status.state.as_deref().unwrap_or("未知"),
        )
        .await;
    }

    // 6 — the pane gate.
    let Ok(Some(session)) = load_session(&state.pool, &target.id).await else {
        return finish(
            state,
            &collab,
            caller,
            target,
            &trace_id,
            body,
            Outcome::TargetGone,
            Some("noSession"),
            None,
            format!("「{}」没有运行中的终端会话。", target.title),
        )
        .await;
    };
    let agent_id = target
        .agent_id
        .clone()
        .unwrap_or_else(|| status.agent_id.clone());
    let expected = expected_processes(&agent_id);
    let foreground = state.terminals.foreground(&session.session_id).await.ok();
    let Some(foreground) = foreground.filter(|info| pane_runs_agent(info, &expected)) else {
        return finish(
            state,
            &collab,
            caller,
            target,
            &trace_id,
            body,
            Outcome::TargetNotAgentPane,
            Some("paneMismatch"),
            None,
            format!(
                "「{}」的终端当前没有在跑 {agent_id}，不往里写东西。",
                target.title
            ),
        )
        .await;
    };
    let pid_before = foreground.pid;

    // 7 — deliver. The receipt watcher subscribes *before* the write, so a fast
    // agent that reacts in 50ms is not missed.
    let mut events = state.events.subscribe(&caller.node.workspace_id);
    let text = envelope(&caller.node.title, &caller.node.id, body);
    if let Err(error) = state
        .terminals
        .paste(&session.session_id, &text, true)
        .await
    {
        return finish(
            state,
            &collab,
            caller,
            target,
            &trace_id,
            body,
            Outcome::TargetGone,
            Some("writeFailed"),
            None,
            format!("写入「{}」的终端失败：{error}", target.title),
        )
        .await;
    }
    note_delivery(&collab, &caller.node.id, &target.id);

    // 8 — the receipt.
    let reacted = wait_for_reaction(&mut events, &target.id, receipt_window).await;
    let pid_after = state
        .terminals
        .foreground(&session.session_id)
        .await
        .ok()
        .and_then(|info| info.pid);
    let (outcome, receipt, message) = if reacted {
        (
            Outcome::Delivered,
            "reacted",
            format!("已投递给「{}」，它已经开始处理。", target.title),
        )
    } else if pid_before.is_some() && pid_after != pid_before {
        (
            Outcome::Stalled,
            "pane-changed",
            format!(
                "已写入「{}」，但它的前台进程在此期间换了，无法确认收到。",
                target.title
            ),
        )
    } else {
        (
            Outcome::Stalled,
            "no-reaction",
            format!(
                "已写入「{}」，但 {} 秒内没有反应；它可能停在别的提示上。",
                target.title,
                receipt_window.as_secs()
            ),
        )
    };
    finish(
        state,
        &collab,
        caller,
        target,
        &trace_id,
        body,
        outcome,
        None,
        Some(receipt),
        message,
    )
    .await
}

/// Whether `agentMessaging` is on for this workspace (plan §5.7 step 3).
/// Read from `settings.json` under `workspaces.<id>.agentMessaging`, so the
/// existing `GET`/`PATCH /api/settings` deep merge is the only editor needed.
pub fn messaging_enabled(state: &AppState, workspace_id: &str) -> bool {
    state
        .settings
        .document()
        .get("workspaces")
        .and_then(|workspaces| workspaces.get(workspace_id))
        .and_then(|workspace| workspace.get("agentMessaging"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn check_flow(collab: &CollabState, source: &str, target: &str) -> Result<(), Report> {
    let now = Utc::now();
    let flow = collab
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(last) = flow.get(&(source.to_owned(), target.to_owned()))
        && (now - *last).num_seconds() < PAIR_INTERVAL_SECONDS
    {
        return Err(Report::refused(
            Outcome::RateLimited,
            "pairInterval",
            format!("同一对节点之间每 {PAIR_INTERVAL_SECONDS} 秒最多投递一次，稍后再试。"),
        ));
    }
    drop(flow);

    let turns = collab
        .turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(written) = turns.get(source)
        && !written.iter().any(|id| id == target)
        && written.len() >= TARGETS_PER_TURN
    {
        return Err(Report::refused(
            Outcome::RateLimited,
            "turnFanOut",
            format!("这一回合已经给 {TARGETS_PER_TURN} 个节点发过消息了，先做点别的。"),
        ));
    }
    Ok(())
}

fn note_delivery(collab: &CollabState, source: &str, target: &str) {
    let now = Utc::now();
    collab
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert((source.to_owned(), target.to_owned()), now);
    let mut turns = collab
        .turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let written = turns.entry(source.to_owned()).or_default();
    if !written.iter().any(|id| id == target) {
        written.push(target.to_owned());
    }
}

/// The pane gate: is the foreground of this PTY still the agent we think it is?
pub fn pane_runs_agent(info: &ForegroundInfo, expected: &[String]) -> bool {
    if expected.is_empty() {
        return false;
    }
    let mut haystacks: Vec<&str> = Vec::new();
    if let Some(command) = info.command.as_deref() {
        haystacks.push(command);
    }
    for child in &info.children {
        haystacks.push(child);
    }
    haystacks
        .iter()
        .any(|line| expected.iter().any(|name| line_names_program(line, name)))
}

/// `claude` matches `claude`, `/opt/bin/claude --resume` and
/// `node /usr/lib/claude/cli.js`, but not `claude-code-notifier`.
fn line_names_program(line: &str, name: &str) -> bool {
    line.split(|c: char| c.is_whitespace() || c == '/' || c == '\\')
        .any(|token| {
            let token = token.trim_end_matches(".exe");
            token == name || token.strip_suffix(".js").is_some_and(|stem| stem == name)
        })
}

async fn wait_for_reaction(
    events: &mut tokio::sync::broadcast::Receiver<WorkspaceEvent>,
    target_node_id: &str,
    window: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Ok(WorkspaceEvent::AgentStatus { status }))
                if status.node_id == target_node_id
                    && status.state.as_deref() == Some("working") =>
            {
                return true;
            }
            Ok(Ok(_)) => continue,
            // Lagged: we may have missed the reaction, so keep listening.
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) | Err(_) => return false,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn queue(
    state: &AppState,
    collab: &CollabState,
    caller: &Caller,
    target: &NodeRef,
    verb: &str,
    body: &str,
    trace_id: &str,
    target_state: &str,
) -> Report {
    let pushed = delivery_queue::push(
        collab,
        Queued {
            trace_id: trace_id.to_owned(),
            workspace_id: caller.node.workspace_id.clone(),
            source_node_id: caller.node.id.clone(),
            target_node_id: target.id.clone(),
            verb: verb.to_owned(),
            body: body.to_owned(),
            queued_at: Utc::now(),
        },
    );
    if !pushed {
        return finish(
            state,
            collab,
            caller,
            target,
            trace_id,
            body,
            Outcome::QueueFull,
            Some("queueFull"),
            None,
            format!(
                "「{}」的待投递队列已满（{} 条），这条没有入队。",
                target.title,
                delivery_queue::CAPACITY
            ),
        )
        .await;
    }
    note_delivery(collab, &caller.node.id, &target.id);
    finish(
        state,
        collab,
        caller,
        target,
        trace_id,
        body,
        Outcome::Queued,
        Some("targetBusy"),
        None,
        format!(
            "「{}」正在忙（{target_state}），消息已入队，它空下来后会自动投递（{} 分钟内有效）。",
            target.title,
            delivery_queue::TTL_MINUTES
        ),
    )
    .await
}

/// Records the outcome everywhere it belongs: the board log, `agent_deliveries`
/// and the workspace event stream.
#[allow(clippy::too_many_arguments)]
async fn finish(
    state: &AppState,
    collab: &CollabState,
    caller: &Caller,
    target: &NodeRef,
    trace_id: &str,
    body: &str,
    outcome: Outcome,
    reason: Option<&'static str>,
    receipt: Option<&'static str>,
    message: String,
) -> Report {
    let root = super::workspace_root(&state.pool, &caller.node.workspace_id)
        .await
        .ok()
        .flatten();
    let traced = board_log::record(
        collab,
        root.as_deref(),
        board_log::Trace {
            trace_id,
            source: &caller.node.id,
            target: &target.id,
            outcome: outcome.as_str(),
            receipt,
            body_chars: body.chars().count(),
        },
    );
    if let Err(error) = db::insert_delivery(
        &state.pool,
        db::DeliveryRecord {
            trace_id,
            workspace_id: &caller.node.workspace_id,
            source_node_id: &caller.node.id,
            target_node_id: &target.id,
            outcome: outcome.as_str(),
            receipt,
            body_chars: body.chars().count() as i64,
        },
    )
    .await
    {
        tracing::warn!(%error, "could not record the delivery");
    }
    state.events.publish(
        &caller.node.workspace_id,
        WorkspaceEvent::AgentDelivery {
            trace_id: trace_id.to_owned(),
            source_node_id: caller.node.id.clone(),
            target_node_id: target.id.clone(),
            outcome: outcome.as_str().to_owned(),
        },
    );
    Report {
        outcome,
        message,
        trace_id: Some(trace_id.to_owned()),
        receipt: receipt.map(str::to_owned),
        reason,
        traced: Some(traced),
    }
}

/* ------------------------------- queue flush ------------------------------ */

/// Called from the hook ingest path when a node reaches `done`: everything
/// waiting for it re-runs the whole gate chain and is delivered or dropped.
pub async fn flush_for(state: &AppState, target_node_id: &str) {
    let collab = collab(state);
    let (live, expired) = delivery_queue::drain(&collab, target_node_id);
    if live.is_empty() && expired.is_empty() {
        return;
    }
    let Ok(Some(target)) = load_node(&state.pool, target_node_id).await else {
        return;
    };
    for message in expired {
        let Ok(Some(source)) = load_node(&state.pool, &message.source_node_id).await else {
            continue;
        };
        let caller = Caller {
            node: source,
            verdict: crate::hook::auth::Verdict::Verified,
        };
        finish(
            state,
            &collab,
            &caller,
            &target,
            &message.trace_id,
            &message.body,
            Outcome::Expired,
            Some("ttl"),
            None,
            "排队超时，未投递。".to_owned(),
        )
        .await;
    }
    for message in live {
        let Ok(Some(source)) = load_node(&state.pool, &message.source_node_id).await else {
            continue;
        };
        let caller = Caller {
            node: source,
            verdict: crate::hook::auth::Verdict::Verified,
        };
        // The pair interval does not apply to a flush: the message was accepted
        // when it was queued, and re-charging it here would strand the queue.
        clear_pair(&collab, &caller.node.id, target_node_id);
        let report = deliver(
            state,
            &caller,
            &target,
            &message.verb,
            &message.body,
            RECEIPT_WINDOW,
        )
        .await;
        if report.outcome == Outcome::TargetBusy || report.outcome == Outcome::Queued {
            // Still busy: it went back on the queue, stop draining.
            break;
        }
    }
}

fn clear_pair(collab: &CollabState, source: &str, target: &str) {
    collab
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(source.to_owned(), target.to_owned()));
}

/// The flow-control gate on its own, so the two limits can be tested without a
/// board, a status row and a PTY behind them.
#[cfg(test)]
pub fn check_flow_for_test(collab: &CollabState, source: &str, target: &str) -> Result<(), Report> {
    check_flow(collab, source, target)
}

#[cfg(test)]
pub fn note_delivery_for_test(collab: &CollabState, source: &str, target: &str) {
    note_delivery(collab, source, target);
}

fn internal(error: crate::error::AppError) -> Refusal {
    Refusal {
        status: axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        message: format!("消息投递失败：{error}"),
    }
}
