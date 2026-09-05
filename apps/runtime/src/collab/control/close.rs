//! `close`, and the human confirmation it waits for.

use super::*;

/* ---------------------------------- close --------------------------------- */

/// How long a `close` waits for a human (plan §5.8). The hook client's own
/// wait is longer, so a refusal always reaches the agent as a sentence rather
/// than as a dropped connection.
pub const CONFIRM_TIMEOUT_SECS: u64 = 130;

/// Answers a pending confirmation. `false` means nothing was waiting any more:
/// the verb already timed out, or the id was never minted.
pub fn answer_confirm(state: &AppState, request_id: &str, approve: bool) -> bool {
    let collab = crate::collab::collab(state);
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
pub(super) async fn close(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
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

    let request_id = crate::collab::nonce(16);
    let (sender, receiver) = tokio::sync::oneshot::channel::<bool>();
    let collab = crate::collab::collab(state);
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
    if let Ok(Some(session)) = crate::collab::load_session(&state.pool, &target_id).await
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

pub(super) fn forget_confirm(state: &AppState, request_id: &str) {
    crate::collab::collab(state)
        .confirms
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(request_id);
}
