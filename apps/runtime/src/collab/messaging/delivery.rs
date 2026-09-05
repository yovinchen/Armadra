//! Delivering one message into a live pane: the gate chain, the paste and
//! the receipt window.

use super::*;

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
    if [&caller.node.agent_id, &target.agent_id]
        .into_iter()
        .flatten()
        .any(|agent| !crate::context_usage::has_capability(&state.settings, agent, "contextLink"))
    {
        return Report::refused(
            Outcome::NotPermitted,
            "capabilityDisabled",
            "Context links are disabled for one of these Agents.",
        );
    }
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

pub(super) fn check_flow(collab: &CollabState, source: &str, target: &str) -> Result<(), Report> {
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

pub(super) fn note_delivery(collab: &CollabState, source: &str, target: &str) {
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
pub(super) fn line_names_program(line: &str, name: &str) -> bool {
    line.split(|c: char| c.is_whitespace() || c == '/' || c == '\\')
        .any(|token| {
            let token = token.trim_end_matches(".exe");
            token == name || token.strip_suffix(".js").is_some_and(|stem| stem == name)
        })
}

pub(super) async fn wait_for_reaction(
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
pub(super) async fn queue(
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
pub(super) async fn finish(
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
    let root = crate::collab::workspace_root(&state.pool, &caller.node.workspace_id)
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
