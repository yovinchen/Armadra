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

use self::render::{describe_download, render_lease, render_read, render_tabs};
use super::{
    ReadMode, TargetRef,
    session::{
        self, CaptureRequest, DialogRequest, NavigateRequest, PressRequest, ScrollRequest,
        SelectRequest, Target, UploadRequest, WaitRequest,
    },
};

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

    // The three rules above are the whole of the authorization, and they are
    // the same on both routes. What differs below is only WHERE the page is:
    // in a guest of the desktop window, or in a Chromium this Runtime started.
    //
    // A shell-started Runtime takes the shell route unconditionally, including
    // when the shell has not dialled back yet — in which case the verb answers
    // `browser_unavailable`. Falling back to launching a second browser nobody
    // can see would be worse than saying so (§4.2).
    if super::shell::configured() {
        return via_shell(state, caller, verb, args, &target, &workspace).await;
    }

    let availability = super::availability(state);
    if !availability.available {
        return Err(Refusal {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: format!(
                "这台执行主机上没有可用的 Chromium 浏览器（{}），受控浏览器不可用。",
                availability.reason_code
            ),
        });
    }
    // Opening the session if it is not running is deliberate: an agent that was
    // told to check a page should not fail because the human closed the node.
    let opened = session::ensure(
        state,
        &workspace,
        session::CreateRequest {
            node_id: target.id.clone(),
            url: target
                .data
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .filter(|url| !url.is_empty()),
            viewport: None,
            headful: None,
        },
    )
    .await
    .map_err(refuse)?;
    let live = session::require_live(state, &opened.session_id)
        .await
        .map_err(refuse)?;

    // Input-shaped verbs take the control lease; reads never do (§2.6). A
    // person who is mid-input makes this wait, briefly, and then refuses; a
    // person who pressed "take over" makes it fail at once with
    // `LEASE_REVOKED`, and the action is not retried.
    let actor = session::Actor::agent(&caller.node.id, &opened.session_id, &caller.node.title);
    if needs_lease(verb, args)
        && let Err(error) = session::lease::acquire(&live, &actor, None).await
    {
        let reason = error.to_string();
        live.record_activity(activity(
            &opened.session_id,
            &caller.node.id,
            verb,
            describe_target(args),
            "refused",
            &reason,
        ));
        return Err(refuse(error));
    }

    let outcome = match verb {
        "navigate" | "back" | "forward" => navigate(&live, verb, args).await,
        "read" => read(&live, args).await,
        "click" => click(&live, args).await,
        "type" => type_text(&live, args).await,
        "wait" => wait(&live, args).await,
        "capture" => capture(&live, &workspace, args).await,
        "select" => select(&live, args).await,
        "press" => press(&live, args).await,
        "scroll" => scroll(&live, args).await,
        "upload" => upload(&live, &workspace, args).await,
        "download" => download(&live, &workspace, args).await,
        "close" => close_tab(&live, args).await,
        "tabs" => tabs(&live, args).await,
        "dialog" => dialog(&live, args).await,
        "lease" => lease(&live, &actor, args).await,
        _ => unreachable!("verb was checked above"),
    };
    // The node's activity trace records what happened either way: a refused
    // action is exactly what somebody looking for "why did nothing change?"
    // needs to see.
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
    // The header badge shows the same thing the trace records, one line of it,
    // so somebody watching the canvas can see the agent working (§2.8).
    match outcome.as_ref() {
        Ok(_) => live.record_activity(activity(
            &opened.session_id,
            &caller.node.id,
            verb,
            describe_target(args),
            "ok",
            "",
        )),
        Err(refusal) => live.record_activity(activity(
            &opened.session_id,
            &caller.node.id,
            verb,
            describe_target(args),
            "refused",
            &refusal.message,
        )),
    }
    outcome
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
        let payload =
            super::shell::with_workspace(shell_args(verb, args), &workspace.root_path);
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
pub(crate) fn shell_args(verb: &str, args: &Args<'_>) -> serde_json::Map<String, serde_json::Value> {
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
            put("urlContains", opt(args.text("url-contains").or_else(|| args.text("urlContains"))));
            put(
                "titleContains",
                opt(args.text("title-contains").or_else(|| args.text("titleContains"))),
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
                    format!(".armadra/browser/{}.png", chrono::Utc::now().timestamp_millis())
                })),
            );
            put("fullPage", json!(args.flag("full-page") || args.flag("fullPage")));
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

/* --------------------------------- verbs ---------------------------------- */

/// `--tab` / `--frame`, which every verb accepts and almost nobody passes.
/// Absent means the active tab's main frame (§2.2).
fn address_of(args: &Args<'_>) -> TargetRef {
    TargetRef {
        tab_id: args.text("tab").unwrap_or_default().to_owned(),
        frame_id: args.text("frame").unwrap_or_default().to_owned(),
    }
}

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

async fn navigate(live: &session::Live, verb: &str, args: &Args<'_>) -> Result<String, Refusal> {
    // `back` and `forward` are verbs of their own as well as actions of
    // `navigate`; both spellings reach the same history walk (§2.7).
    let action = match verb {
        "back" | "forward" => verb.to_owned(),
        _ => args
            .text("action")
            .or_else(|| args.text("url").map(|_| "goto"))
            .unwrap_or("goto")
            .to_owned(),
    };
    let request = NavigateRequest {
        url: args.text("url").map(str::to_owned),
        action,
    };
    let session = session::navigate(live, &request).await.map_err(refuse)?;
    Ok(format!(
        "已导航。\n当前地址：{}\n标题：{}\n导航序号：{}\n",
        session.url,
        if session.title.is_empty() {
            "（未知）"
        } else {
            &session.title
        },
        session.navigation_epoch
    ))
}

async fn read(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let raw = args.text("mode").unwrap_or("text");
    let mode = ReadMode::parse(raw).ok_or_else(|| {
        Refusal::bad_request(format!(
            "未知的读取模式 `{raw}`，可用：{}。",
            ReadMode::NAMES.join(" / ")
        ))
    })?;
    let limit = args
        .count(&["n", "limit"])
        .unwrap_or(DEFAULT_ELEMENT_LIMIT as i64)
        .clamp(1, super::MAX_ELEMENTS as i64) as usize;
    let bytes = args
        .count(&["max-bytes", "maxBytes"])
        .unwrap_or(DEFAULT_READ_BYTES as i64)
        .clamp(1_024, super::MAX_TEXT_BYTES as i64) as usize;
    let response = session::read_in(live, &address_of(args), mode, limit, bytes)
        .await
        .map_err(refuse)?;
    Ok(render_read(mode, &response))
}

fn target_of<'a>(args: &'a Args<'_>) -> Result<Target<'a>, Refusal> {
    let point = match (args.count(&["x"]), args.count(&["y"])) {
        (Some(x), Some(y)) => Some((x as f64, y as f64)),
        (None, None) => None,
        _ => {
            return Err(Refusal::bad_request("按坐标点击需要同时给出 --x 和 --y。"));
        }
    };
    Target::parse(args.text("selector"), args.text("ref"), point).map_err(refuse)
}

async fn click(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let target = target_of(args)?;
    let session = session::click(live, target, &address_of(args), 0, 1)
        .await
        .map_err(refuse)?;
    Ok(format!(
        "已点击。\n当前地址：{}\n导航序号：{}\n",
        session.url, session.navigation_epoch
    ))
}

async fn type_text(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let text = args.text("text").unwrap_or_default().to_owned();
    let target = target_of(args)?;
    let session = session::type_text(
        live,
        target,
        &address_of(args),
        &text,
        args.flag("replace"),
        args.flag("submit") || args.flag("enter"),
    )
    .await
    .map_err(refuse)?;
    Ok(format!(
        "已输入 {} 个字符。\n当前地址：{}\n导航序号：{}\n",
        text.chars().count(),
        session.url,
        session.navigation_epoch
    ))
}

async fn wait(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let request = WaitRequest {
        selector: args.text("selector").map(str::to_owned),
        url_contains: args
            .text("url-contains")
            .or_else(|| args.text("urlContains"))
            .map(str::to_owned),
        title_contains: args
            .text("title-contains")
            .or_else(|| args.text("titleContains"))
            .map(str::to_owned),
        timeout_ms: args
            .count(&["timeout", "timeout-ms", "timeoutMs"])
            .map(|value| value.clamp(0, i64::from(session::MAX_WAIT_MS)) as u32),
    };
    let outcome = session::wait(live, &request).await.map_err(refuse)?;
    Ok(if outcome.matched {
        format!("条件在 {} ms 内满足。\n", outcome.waited_ms)
    } else {
        format!(
            "等待超时（{} ms），条件没有满足。页面没有被改动。\n",
            outcome.waited_ms
        )
    })
}

async fn capture(
    live: &session::Live,
    workspace: &crate::model::Workspace,
    args: &Args<'_>,
) -> Result<String, Refusal> {
    let request = CaptureRequest {
        full_page: args.flag("full-page") || args.flag("fullPage"),
        format: args.text("format").map(str::to_owned),
    };
    let capture = session::capture(live, workspace, &request)
        .await
        .map_err(refuse)?;
    Ok(format!(
        "截图已保存到工作区：{}\n{}×{}，{} 字节，sha256 {}\n",
        capture.path, capture.width, capture.height, capture.bytes, capture.sha256
    ))
}

async fn select(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let request = SelectRequest {
        selector: args.text("selector").map(str::to_owned),
        element_ref: args.text("ref").map(str::to_owned),
        values: repeated(args, "value"),
        labels: repeated(args, "label"),
        target: address_of(args),
    };
    let chosen = session::select(live, &request).await.map_err(refuse)?;
    Ok(format!("已选中：{}\n", chosen.join("、")))
}

async fn press(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let request = PressRequest {
        key: args.text("key").unwrap_or_default().to_owned(),
        modifiers: modifiers_of(args),
        repeat: args.count(&["repeat"]).unwrap_or(1).clamp(1, 32) as u32,
        target: address_of(args),
    };
    let times = session::press(live, &request).await.map_err(refuse)?;
    Ok(format!("已按下 {} {} 次。\n", request.key, times))
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

async fn scroll(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let request = ScrollRequest {
        direction: args.text("direction").map(str::to_owned),
        amount: args.count(&["amount"]).map(|value| value as f64),
        element_ref: args
            .text("to-ref")
            .or_else(|| args.text("toRef"))
            .or_else(|| args.text("ref"))
            .map(str::to_owned),
        selector: args.text("selector").map(str::to_owned),
        target: address_of(args),
    };
    let outcome = session::scroll(live, &request).await.map_err(refuse)?;
    Ok(match outcome.as_str() {
        "into-view" => "已滚动到该元素。\n".to_owned(),
        direction => format!("已向 {direction} 滚动。\n"),
    })
}

async fn upload(
    live: &session::Live,
    workspace: &crate::model::Workspace,
    args: &Args<'_>,
) -> Result<String, Refusal> {
    let request = UploadRequest {
        chooser_id: args.text("chooser").map(str::to_owned),
        selector: args.text("selector").map(str::to_owned),
        element_ref: args.text("ref").map(str::to_owned),
        paths: repeated(args, "path"),
        target: address_of(args),
    };
    let uploaded = session::upload(live, workspace, &request)
        .await
        .map_err(refuse)?;
    Ok(format!(
        "已{}：{}\n",
        if uploaded.answered_chooser {
            "回填页面打开的文件选择器"
        } else {
            "填入文件输入框"
        },
        uploaded.paths.join("、")
    ))
}

async fn download(
    live: &session::Live,
    workspace: &crate::model::Workspace,
    args: &Args<'_>,
) -> Result<String, Refusal> {
    let Some(id) = args.text("id") else {
        let queue = session::downloads(live);
        if queue.is_empty() {
            return Ok("下载队列是空的。\n".to_owned());
        }
        return Ok(queue.iter().map(describe_download).collect());
    };
    // Accepting is the only thing that writes bytes into the project, so it
    // has to be asked for explicitly (§2.3).
    let accept = if args.flag("accept") {
        true
    } else if args.flag("reject") || args.flag("decline") {
        false
    } else {
        return Err(Refusal::bad_request(
            "要处理一个下载，请给出 --accept 或 --reject。",
        ));
    };
    let decided = session::decide_download(live, workspace, id, accept)
        .await
        .map_err(refuse)?;
    Ok(if accept {
        format!(
            "已保存到工作区：{}\nsha256 {}\n",
            decided.path,
            if decided.sha256.is_empty() {
                "（未知）"
            } else {
                &decided.sha256
            }
        )
    } else {
        format!("已丢弃暂存文件：{}\n", decided.suggested_filename)
    })
}

async fn tabs(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let list = if let Some(tab_id) = args.text("switch") {
        session::switch_tab(live, tab_id).await.map_err(refuse)?
    } else if let Some(url) = args.text("new") {
        session::new_tab(live, url).await.map_err(refuse)?
    } else {
        session::tab_list(live)
    };
    Ok(render_tabs(&list))
}

/// `lease --status | --release`.
///
/// It never takes the lease — that is the point of it. `--status` is how an
/// agent that has just been refused finds out whether a person took over or
/// is merely typing, and `--release` is how it hands its own back early
/// rather than making the next person wait out the idle timer (§2.7).
///
/// There is deliberately no way for an agent to take the lease *away* from
/// somebody: taking over is a person's decision, made at a client.
async fn lease(
    live: &session::Live,
    actor: &session::Actor,
    args: &Args<'_>,
) -> Result<String, Refusal> {
    if args.flag("release") {
        let lease = session::lease::release(live, actor).await.map_err(refuse)?;
        return Ok(format!("已交还租约。{}", render_lease(&lease)));
    }
    Ok(render_lease(&session::lease::status(live)))
}

async fn close_tab(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let tab_id = args.text("tab").ok_or_else(|| {
        Refusal::bad_request("`close` 只能关标签：请给出 --tab。结束整个会话不是动词。")
    })?;
    let list = session::close_tab(live, tab_id).await.map_err(refuse)?;
    Ok(format!("已关闭标签 {tab_id}。\n{}", render_tabs(&list)))
}

async fn dialog(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let accept = if args.flag("accept") {
        true
    } else if args.flag("dismiss") || args.flag("reject") {
        false
    } else {
        return Err(Refusal::bad_request(
            "请给出 --accept 或 --dismiss；对话框不会自己消失。",
        ));
    };
    let request = DialogRequest {
        tab_id: args.text("tab").map(str::to_owned),
        dialog_id: args.text("id").map(str::to_owned),
        accept,
        prompt_text: args.text("text").map(str::to_owned),
    };
    let tab_id = match &request.tab_id {
        Some(tab_id) => tab_id.clone(),
        None => live.snapshot().active_tab_id,
    };
    let answered = session::handle_dialog(
        live,
        &tab_id,
        request.dialog_id.as_deref(),
        accept,
        request.prompt_text.as_deref(),
    )
    .await
    .map_err(refuse)?;
    Ok(format!(
        "已{}对话框（{}）：{}\n",
        if accept { "接受" } else { "取消" },
        answered.kind.as_str(),
        answered.message
    ))
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
