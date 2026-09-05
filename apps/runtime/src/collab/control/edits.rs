//! Verbs that change what is already on the board: links, titles and colour.

use super::*;

/* ---------------------------------- edits --------------------------------- */

pub(super) async fn link(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
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

pub(super) async fn add_link(
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

pub(super) async fn rename(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
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

pub(super) async fn color(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
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
