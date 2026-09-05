//! `list`, and the verbs that add a node to the board.

use super::*;

/* ---------------------------------- list ---------------------------------- */

pub(super) async fn list(state: &AppState, caller: &Caller) -> Result<Outcome, Refusal> {
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

pub(super) async fn open_terminal(
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

pub(super) async fn open_agent(
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

pub(super) async fn sticky(
    state: &AppState,
    caller: &Caller,
    args: &Args<'_>,
) -> Result<Outcome, Refusal> {
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
