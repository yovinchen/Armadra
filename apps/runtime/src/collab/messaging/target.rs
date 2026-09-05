//! The `send` verb and the target resolution behind it.

use super::*;

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
pub(super) async fn resolve_target(
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

pub(super) async fn last_sender(
    state: &AppState,
    caller: &Caller,
) -> Result<Option<String>, Refusal> {
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

pub(super) async fn workspace_nodes(
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

pub(super) fn ambiguous(wanted: &str, matches: &[&NodeRef]) -> Refusal {
    Refusal::bad_request(format!(
        "「{wanted}」同时匹配 {} 个节点，请改用节点 ID。",
        matches.len()
    ))
}
