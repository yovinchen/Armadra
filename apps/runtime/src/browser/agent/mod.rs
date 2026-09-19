//! `POST /browser/{verb}` — an agent drives a browser node it is linked to.
//!
//! Three rules, all of them checks rather than conventions:
//!
//!   * **Only a linked node.** The target must appear in the caller's own
//!     context-link document — the picture the user is looking at — and it must
//!     be a `browser` node in the caller's workspace. Holding the app bearer is
//!     not enough, and neither is knowing a session id.
//!   * **The same session as the human.** There is no agent-only browser. The
//!     verb resolves the node's live session and drives that, so a person can
//!     watch what the agent did and take over by clicking (design §7).
//!   * **A closed verb list.** Seventeen of them, listed in [`VERBS`]. No
//!     `eval`, no CDP method name, no selector that becomes code, and no verb
//!     that ends the session — closing a node is not the same as closing a
//!     page (§2.7).
//!
//! Replies are `text/plain` prose because the reader is a model reading its own
//! stdout, exactly like the context-link surface.

mod render;

use axum::http::StatusCode;

use crate::{
    AppState,
    collab::{Args, Caller, Refusal, load_node},
    error::AppError,
    model::ContextLink,
};

use self::render::render_lease;
use super::session;

/// Every verb, and nothing else. `armadra-hook`'s `BROWSER_VERBS` is the same
/// list, checked there too so a typo costs a local error line rather than a
/// round trip and a refusal in the model's context.
pub const VERBS: &[&str] = &[
    "navigate", "read", "click", "type", "wait", "capture", "select", "press", "scroll", "upload",
    "download", "back", "forward", "close", "tabs", "dialog", "lease",
];

/// Default page-text budget for an agent read. Smaller than the API's ceiling
/// because this text goes straight into a model's context window.
const DEFAULT_READ_BYTES: usize = 24 * 1024;
const DEFAULT_ELEMENT_LIMIT: usize = 40;

pub async fn run(
    state: &AppState,
    caller: &Caller,
    verb: &str,
    args: &Args<'_>,
) -> Result<String, Refusal> {
    if !VERBS.contains(&verb) {
        return Err(Refusal::bad_request(format!(
            "未知的浏览器动词 `{verb}`，可用：{}。",
            VERBS.join(" / ")
        )));
    }
    // Every verb here changes or reads a real page, so a token this runtime did
    // not mint is never enough.
    caller.require_verified(verb)?;
    if !capability_allowed(state, caller.node.agent_id.as_deref()) {
        return Err(Refusal::forbidden(
            "这个 Agent 的 `browser` 能力已被禁用，浏览器动词不可用。",
        ));
    }

    let document = db_links(state, &caller.node.id).await?;
    let link = resolve_browser_link(&document, args.text("node"))?;
    let target = load_node(&state.pool, &link.id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            Refusal::not_found(format!(
                "链接的浏览器节点「{}」已经不在画布上了。",
                link.title
            ))
        })?;
    if target.workspace_id != caller.node.workspace_id {
        return Err(Refusal::forbidden(format!(
            "「{}」不在当前工作空间，已拒绝。",
            target.title
        )));
    }
    if target.node_type != "browser" {
        return Err(Refusal::bad_request(format!(
            "「{}」不是浏览器节点，`browser` 动词只能操作浏览器节点。",
            target.title
        )));
    }

    let workspace = super::readable_workspace(state, &target.workspace_id)
        .await
        .map_err(refuse)?;

    // The three rules above are the whole of the authorization. What is left
    // is WHERE the page is, and since W3.5 there is only one answer: a guest
    // of the desktop window. A Runtime with no shell answers
    // `browser_unavailable` rather than starting a browser nobody can see
    // (electron-migration §4.2).
    via_shell(state, caller, verb, args, &target, &workspace).await
}

/* ------------------------------ the shell route --------------------------- */

/// The same seventeen verbs, executed in the desktop shell (W3.4).
///
/// Everything that decides WHETHER this may happen already happened: the
/// caller is verified, the node is linked, in this workspace, and a browser.
/// What is left is the lease — which stays here, because it is a fact about
/// people and agents rather than about pages — and one narrow send.
async fn via_shell(
    state: &AppState,
    caller: &Caller,
    verb: &str,
    args: &Args<'_>,
    target: &crate::collab::NodeRef,
    workspace: &crate::model::Workspace,
) -> Result<String, Refusal> {
    let service = super::shell::service(state);
    let url = target
        .data
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let session = super::shell::ensure_session(
        &service.sessions,
        &state.pool,
        &state.events,
        service.client.clone(),
        &target.id,
        &target.workspace_id,
        url,
    )
    .await
    .map_err(refuse)?;

    // Two verbs whose whole meaning is in a flag. Refusing here rather than
    // defaulting: "dismiss" and "accept" are not the same thing to a person
    // whose page is holding a dialog open, and neither is a safe guess.
    if verb == "dialog" && !args.flag("accept") && !args.flag("dismiss") && !args.flag("reject") {
        return Err(Refusal::bad_request(
            "请给出 --accept 或 --dismiss；对话框不会自己消失。",
        ));
    }
    if verb == "download"
        && args.text("id").is_some()
        && !args.flag("accept")
        && !args.flag("reject")
        && !args.flag("decline")
    {
        return Err(Refusal::bad_request(
            "要处理一个下载，请给出 --accept 或 --reject。",
        ));
    }

    let actor = session::Actor::agent(&caller.node.id, &session.session_id, &caller.node.title);
    if needs_lease(verb, args)
        && let Err(error) = session.acquire(&actor).await
    {
        let reason = error.to_string();
        session.record_activity(activity(
            &session.session_id,
            &caller.node.id,
            verb,
            describe_target(args),
            "refused",
            &reason,
        ));
        return Err(refuse(error));
    }

    // `lease` never reaches the shell. There is nothing on a page for it to
    // do: it is a question about who may drive, answered here.
    let outcome = if verb == "lease" {
        if args.flag("release") {
            session
                .release(&actor)
                .await
                .map(|lease| format!("已交还租约。{}", render_lease(&lease)))
                .map_err(refuse)
        } else {
            Ok(render_lease(&session.lease_snapshot()))
        }
    } else {
        let payload = super::shell::with_workspace(shell_args(verb, args), &workspace.root_path);
        super::shell::drive(&service, &target.id, verb, payload)
            .await
            .map(|result| super::shell::render(verb, args, &result))
            .map_err(refuse)
    };

    trace(
        state,
        &workspace.root_path,
        &caller.node.id,
        &target.id,
        verb,
        outcome
            .as_ref()
            .err()
            .map(|refusal| refusal.message.as_str()),
    );
    match outcome.as_ref() {
        Ok(_) => session.record_activity(activity(
            &session.session_id,
            &caller.node.id,
            verb,
            describe_target(args),
            "ok",
            "",
        )),
        Err(refusal) => session.record_activity(activity(
            &session.session_id,
            &caller.node.id,
            verb,
            describe_target(args),
            "refused",
            &refusal.message,
        )),
    }
    outcome
}

/// The hook's flags, as the drive channel's camelCase arguments.
///
/// Written out per verb rather than forwarded wholesale. A pass-through would
/// mean the shell's verbs taking whatever a caller typed, and the point of a
/// verb interface is that the set of things one can say is closed.
pub(crate) fn shell_args(
    verb: &str,
    args: &Args<'_>,
) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::json;
    let mut map = serde_json::Map::new();
    let mut put = |name: &str, value: serde_json::Value| {
        if !value.is_null() {
            map.insert(name.to_owned(), value);
        }
    };
    let opt = |value: Option<&str>| match value {
        Some(text) => json!(text),
        None => serde_json::Value::Null,
    };
    // Targeting, which almost every verb accepts.
    put("ref", opt(args.text("ref")));
    put("selector", opt(args.text("selector")));
    if let (Some(x), Some(y)) = (args.count(&["x"]), args.count(&["y"])) {
        put("x", json!(x));
        put("y", json!(y));
    }
    match verb {
        "navigate" => {
            put("url", opt(args.text("url")));
            put(
                "action",
                json!(
                    args.text("action")
                        .unwrap_or(if args.text("url").is_some() {
                            "goto"
                        } else {
                            "reload"
                        })
                ),
            );
        }
        "back" | "forward" => put("action", json!(verb)),
        "read" => {
            put("mode", json!(args.text("mode").unwrap_or("text")));
            put(
                "limit",
                json!(
                    args.count(&["n", "limit"])
                        .unwrap_or(DEFAULT_ELEMENT_LIMIT as i64)
                ),
            );
            put(
                "maxBytes",
                json!(
                    args.count(&["max-bytes", "maxBytes"])
                        .unwrap_or(DEFAULT_READ_BYTES as i64)
                ),
            );
        }
        "type" => {
            put("text", json!(args.text("text").unwrap_or_default()));
            put("replace", json!(args.flag("replace")));
            put("submit", json!(args.flag("submit") || args.flag("enter")));
        }
        "press" => {
            put("key", opt(args.text("key")));
            put("repeat", json!(args.count(&["repeat"]).unwrap_or(1)));
            put("modifiers", json!(modifiers_of(args)));
        }
        "select" => {
            put("values", json!(repeated(args, "value")));
            put("labels", json!(repeated(args, "label")));
        }
        "scroll" => {
            put("direction", opt(args.text("direction")));
            if let Some(amount) = args.count(&["amount"]) {
                put("amount", json!(amount));
            }
        }
        "wait" => {
            put(
                "urlContains",
                opt(args
                    .text("url-contains")
                    .or_else(|| args.text("urlContains"))),
            );
            put(
                "titleContains",
                opt(args
                    .text("title-contains")
                    .or_else(|| args.text("titleContains"))),
            );
            put(
                "timeoutMs",
                json!(
                    args.count(&["timeout", "timeout-ms", "timeoutMs"])
                        .unwrap_or(15_000)
                ),
            );
        }
        "capture" => {
            // A default inside the workspace rather than a required flag: the
            // jail is what keeps the write safe, so there is nothing to gain
            // from making every caller name a directory.
            put(
                "path",
                json!(args.text("path").map(str::to_owned).unwrap_or_else(|| {
                    format!(
                        ".armadra/browser/{}.png",
                        chrono::Utc::now().timestamp_millis()
                    )
                })),
            );
            put(
                "fullPage",
                json!(args.flag("full-page") || args.flag("fullPage")),
            );
            put("format", opt(args.text("format")));
        }
        "upload" => put("paths", json!(repeated(args, "path"))),
        "download" => {
            put("id", opt(args.text("id")));
            put("accept", json!(args.flag("accept")));
        }
        "tabs" => {
            put("switch", opt(args.text("switch")));
            put("new", opt(args.text("new")));
        }
        "close" => put("tab", opt(args.text("tab"))),
        "dialog" => {
            put("id", opt(args.text("id")));
            put("accept", json!(args.flag("accept")));
            put("text", opt(args.text("text")));
        }
        _ => {}
    }
    map
}

/// Verbs that drive the page rather than read it. `read`, `wait` and
/// `capture` are reads and never take the lease (§2.6).
const LEASE_VERBS: &[&str] = &[
    "navigate", "click", "type", "select", "press", "scroll", "upload", "back", "forward", "close",
    "dialog",
];

/// Whether this call takes the control lease.
///
/// Two verbs are split by their arguments rather than by their name, which is
/// what §2.7's "partly" column means: listing tabs or staged downloads is a
/// read and must work while a person is driving, while switching a tab or
/// accepting a download changes what that person is looking at.
fn needs_lease(verb: &str, args: &Args<'_>) -> bool {
    match verb {
        "tabs" => args.text("switch").is_some() || args.text("new").is_some(),
        "download" => args.flag("accept") || args.flag("reject"),
        other => LEASE_VERBS.contains(&other),
    }
}

fn activity(
    session_id: &str,
    node_id: &str,
    verb: &str,
    target: String,
    outcome: &'static str,
    reason: &str,
) -> super::Activity {
    super::Activity {
        session_id: session_id.to_owned(),
        actor: "agent",
        actor_id: node_id.to_owned(),
        verb: verb.to_owned(),
        target,
        outcome,
        // The badge localizes a stable code; a whole refusal message would be
        // prose in one language sitting in a chip.
        reason_code: reason
            .split(':')
            .next()
            .filter(|code| code.starts_with("LEASE_"))
            .unwrap_or_default()
            .to_owned(),
        at: chrono::Utc::now().to_rfc3339(),
    }
}

/// A one-line "what was aimed at", for the activity badge.
fn describe_target(args: &Args<'_>) -> String {
    for name in ["ref", "selector", "url", "key", "tab", "id", "path"] {
        if let Some(value) = args.text(name) {
            return crate::collab::truncate(value, 120);
        }
    }
    String::new()
}

fn capability_allowed(state: &AppState, agent_id: Option<&str>) -> bool {
    match agent_id {
        // A plain terminal is a person at a shell, not an agent with a
        // capability list; the human half of "人与 Agent 共用会话".
        None => true,
        Some(agent) => crate::context_usage::has_capability(&state.settings, agent, "browser"),
    }
}

async fn db_links(state: &AppState, node_id: &str) -> Result<Vec<ContextLink>, Refusal> {
    Ok(crate::db::get_context_links(&state.pool, node_id)
        .await
        .map_err(internal)?
        .links)
}

/// The linked browser node this verb should act on.
fn resolve_browser_link<'a>(
    links: &'a [ContextLink],
    wanted: Option<&str>,
) -> Result<&'a ContextLink, Refusal> {
    let browsers: Vec<&ContextLink> = links.iter().filter(|link| link.kind == "browser").collect();
    if browsers.is_empty() {
        return Err(Refusal::forbidden(
            "这个节点没有连接任何浏览器节点。在画布上把它连到一个浏览器节点后再试。",
        ));
    }
    let Some(wanted) = wanted else {
        return match browsers.as_slice() {
            [only] => Ok(only),
            many => Err(Refusal::bad_request(format!(
                "这个节点连接了 {} 个浏览器节点，请用 --node 指明要操作哪一个。",
                many.len()
            ))),
        };
    };
    let wanted = wanted.trim();
    if let Some(link) = browsers.iter().find(|link| link.id == wanted) {
        return Ok(link);
    }
    let lowered = wanted.to_lowercase();
    let matches: Vec<&&ContextLink> = browsers
        .iter()
        .filter(|link| link.title.to_lowercase() == lowered)
        .collect();
    match matches.as_slice() {
        [only] => Ok(only),
        [] => Err(Refusal::not_found(format!(
            "连接的浏览器节点里没有叫「{wanted}」的。"
        ))),
        many => Err(Refusal::bad_request(format!(
            "有 {} 个连接的浏览器节点叫「{wanted}」，请用节点 ID。",
            many.len()
        ))),
    }
}

/* ------------------------------ argument shapes --------------------------- */

/// A repeatable flag, kept whole. Unlike `Args::list` this does not split on
/// commas: an option value or a file name is allowed to contain one.
fn repeated(args: &Args<'_>, name: &str) -> Vec<String> {
    match args.0.get(name) {
        Some(serde_json::Value::String(value)) => vec![value.trim().to_owned()],
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// `--modifiers` as a number, or as names a person would actually type.
fn modifiers_of(args: &Args<'_>) -> u32 {
    if let Some(value) = args.count(&["modifiers"]) {
        return (value.max(0) as u32) & 0b1111;
    }
    let mut bits = 0;
    for name in args.list("modifiers") {
        bits |= match name.to_ascii_lowercase().as_str() {
            "alt" | "option" => 1,
            "ctrl" | "control" => 2,
            "meta" | "cmd" | "command" => 4,
            "shift" => 8,
            _ => 0,
        };
    }
    bits
}

/* -------------------------------- plumbing -------------------------------- */

fn trace(
    state: &AppState,
    workspace_root: &str,
    source: &str,
    target: &str,
    verb: &str,
    failure: Option<&str>,
) {
    let collab = crate::collab::collab(state);
    crate::collab::board_log::record(
        &collab,
        Some(workspace_root),
        crate::collab::board_log::Trace {
            trace_id: &uuid::Uuid::new_v4().to_string(),
            source,
            target,
            outcome: &format!("browser.{verb}"),
            receipt: failure,
            body_chars: 0,
        },
    );
}

fn refuse(error: AppError) -> Refusal {
    match error {
        AppError::BadRequest(message) => Refusal::bad_request(message),
        AppError::NotFound(message) => Refusal::not_found(message),
        AppError::Forbidden(message) => Refusal::forbidden(message),
        AppError::Conflict(message) => Refusal {
            status: StatusCode::CONFLICT,
            message,
        },
        other => Refusal {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: other.to_string(),
        },
    }
}

fn internal(error: AppError) -> Refusal {
    Refusal {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: error.to_string(),
    }
}
