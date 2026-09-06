//! `interrupt` — the one thing an agent may still write into a peer's terminal.
//!
//! It carries no text. The whole payload is `ESC`, which is what a person
//! reaches for when a CLI has gone down the wrong path: it stops the turn and
//! leaves the session exactly where it was. Nothing about the peer's work is
//! replaced, nothing is submitted, and there is no way to smuggle a sentence
//! through it — the byte is a constant in this file.
//!
//! That is why it survives the removal of `send` / `reply` / `notify` while
//! they do not. Those wrote a *message* somebody else's agent would read as
//! input; this writes a keystroke whose only meaning is "stop".
//!
//! The authorization is the same one the mailbox uses, and for the same
//! reason: the canvas the user drew is the whole story about who may reach
//! whom. The caller must hold a node token this runtime minted, the target
//! must be in the caller's own link document, and it must be in the caller's
//! workspace. A link that survived a workspace move does not carry over.
//!
//! There is no idle gate. Interrupting a *busy* agent is the entire point, and
//! an agent that is not busy loses nothing: `ESC` at an idle prompt is a
//! no-op. The pane gate stays, though — the foreground has to still be the
//! agent we think it is, or the keystroke lands in whatever replaced it.

use super::*;

/// The keystroke. A constant rather than an argument: the moment this takes
/// text from the caller it stops being an interrupt and becomes the delivery
/// primitive this refactor removed.
const ESCAPE: &str = "\x1b";

/// `canvas interrupt --to <node id, handle or title>`.
pub(super) async fn interrupt(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refused> {
    let wanted = args
        .text("to")
        .or_else(|| args.text("node"))
        .ok_or_else(|| {
            Refusal::bad_request("interrupt 需要 --to <已连线节点的 id、短名或标题>。")
        })?;

    // The caller's own link document, exactly as the mailbox reads it: a node
    // that exists on the board but has no edge to the caller is refused as a
    // permission answer, not as "not found".
    let links = db::get_context_links(&state.pool, &caller.node.id)
        .await
        .map_err(internal)?
        .links;
    let handles = addressing::load_handles(&state.pool, &links)
        .await
        .map_err(internal)?;
    let link = addressing::resolve_link(&links, &handles, Some(wanted)).map_err(|error| {
        Refused::new(error.status(), error.code(), error.refusal("--to").message)
    })?;

    let target = crate::collab::load_node(&state.pool, &link.id)
        .await
        .map_err(internal)?
        .filter(|target| target.workspace_id == caller.node.workspace_id)
        .ok_or_else(|| {
            Refused::new(
                StatusCode::FORBIDDEN,
                "target_not_linked",
                "这个链接指向的节点不在当前工作空间，已拒绝。",
            )
        })?;
    if target.id == caller.node.id {
        return Err(Refused::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "不能打断你自己。",
        ));
    }
    if target.node_type != "terminal" {
        return Err(Refused::new(
            StatusCode::BAD_REQUEST,
            "target_not_terminal",
            format!("「{}」不是终端节点，没有可以打断的东西。", target.title),
        ));
    }

    let session = crate::collab::load_session(&state.pool, &target.id)
        .await
        .map_err(internal)?
        .filter(|session| session.status == "running")
        .ok_or_else(|| {
            Refused::new(
                StatusCode::NOT_FOUND,
                "target_gone",
                format!("「{}」没有在运行的终端会话。", target.title),
            )
        })?;

    // The pane gate. Not an idle gate: a busy agent is exactly who this is for.
    // What it checks is that the foreground is still the agent this node claims
    // to run, so an `ESC` cannot land in whatever the user started instead.
    if let Some(agent_id) = target.agent_id.as_deref() {
        let expected = crate::collab::expected_processes(&state.settings.base_agent(agent_id));
        let foreground = state.terminals.foreground(&session.session_id).await.ok();
        if !foreground.is_some_and(|info| crate::collab::pane_runs_agent(&info, &expected)) {
            return Err(Refused::new(
                StatusCode::CONFLICT,
                "target_not_agent_pane",
                format!(
                    "「{}」的终端当前没有在跑 {agent_id}，没有发送打断。",
                    target.title
                ),
            ));
        }
    }

    if args.flag("dry-run") {
        return Ok(Outcome::with_result(
            format!("（演练）会向「{}」发送一次打断。", target.title),
            json!({ "dryRun": true, "id": target.id, "title": target.title }),
        ));
    }

    state
        .terminals
        .write(&session.session_id, session.generation, ESCAPE)
        .await
        .map_err(|error| Refused::from(internal(error)))?;

    // Traced like every other reach into somebody else's node. `bodyChars` is
    // zero because there is no body — that is the claim worth recording.
    let root = crate::collab::workspace_root(&state.pool, &caller.node.workspace_id)
        .await
        .ok()
        .flatten();
    let traced = crate::collab::board_log::record(
        &crate::collab::collab(state),
        root.as_deref(),
        crate::collab::board_log::Trace {
            trace_id: &crate::collab::nonce(16),
            source: &caller.node.id,
            target: &target.id,
            outcome: "interrupted",
            receipt: Some("escape"),
            body_chars: 0,
        },
    );
    Ok(Outcome::with_result(
        format!("已向「{}」发送一次打断（Escape）。", target.title),
        json!({ "id": target.id, "title": target.title, "traced": traced }),
    ))
}
