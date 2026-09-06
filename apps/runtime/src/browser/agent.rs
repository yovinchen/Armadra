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
//!   * **A closed verb list.** `navigate` / `read` / `click` / `type` / `wait`
//!     / `capture`. No `eval`, no CDP method name, no selector that becomes
//!     code.
//!
//! Replies are `text/plain` prose because the reader is a model reading its own
//! stdout, exactly like the context-link surface.

use axum::http::StatusCode;

use crate::{
    AppState,
    collab::{Args, Caller, Refusal, load_node},
    error::AppError,
    model::ContextLink,
};

use super::{
    Download, DownloadState, ReadMode, ReadResponse,
    session::{self, CaptureRequest, NavigateRequest, Target, WaitRequest},
};

pub const VERBS: &[&str] = &["navigate", "read", "click", "type", "wait", "capture"];

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
    if LEASE_VERBS.contains(&verb)
        && let Err(error) = session::lease::acquire(&live, &actor, None).await
    {
        let reason = error.to_string();
        live.record_activity(activity(
            &opened.session_id,
            &caller.node.id,
            verb,
            "refused",
            &reason,
        ));
        return Err(refuse(error));
    }

    let outcome = match verb {
        "navigate" => navigate(&live, args).await,
        "read" => read(&live, args).await,
        "click" => click(&live, args).await,
        "type" => type_text(&live, args).await,
        "wait" => wait(&live, args).await,
        "capture" => capture(&live, &workspace, args).await,
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
            "ok",
            "",
        )),
        Err(refusal) => live.record_activity(activity(
            &opened.session_id,
            &caller.node.id,
            verb,
            "refused",
            &refusal.message,
        )),
    }
    outcome
}

/// Verbs that drive the page rather than read it. `read`, `wait` and
/// `capture` are reads and never take the lease (§2.6).
const LEASE_VERBS: &[&str] = &["navigate", "click", "type"];

fn activity(
    session_id: &str,
    node_id: &str,
    verb: &str,
    outcome: &'static str,
    reason: &str,
) -> super::Activity {
    super::Activity {
        session_id: session_id.to_owned(),
        actor: "agent",
        actor_id: node_id.to_owned(),
        verb: verb.to_owned(),
        target: String::new(),
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

async fn navigate(live: &session::Live, args: &Args<'_>) -> Result<String, Refusal> {
    let action = args
        .text("action")
        .or_else(|| args.text("url").map(|_| "goto"))
        .unwrap_or("goto")
        .to_owned();
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
    let response = session::read(live, mode, limit, bytes)
        .await
        .map_err(refuse)?;
    Ok(render_read(mode, &response))
}

fn render_read(mode: ReadMode, response: &ReadResponse) -> String {
    let mut out = format!(
        "{}\n{}\n\n",
        if response.title.is_empty() {
            "（无标题）"
        } else {
            &response.title
        },
        response.url
    );
    match mode {
        ReadMode::Title => {}
        ReadMode::Text => out.push_str(&response.text),
        ReadMode::Elements | ReadMode::Links => {
            for element in &response.elements {
                let reference = if element.element_ref.is_empty() {
                    String::new()
                } else {
                    format!("[{}] ", element.element_ref)
                };
                out.push_str(&format!(
                    "{reference}{} {}{}\n",
                    element.role,
                    element.name,
                    if element.value.is_empty() {
                        String::new()
                    } else {
                        format!("  ({})", element.value)
                    }
                ));
            }
            if response.elements.is_empty() {
                out.push_str("（这一页没有可操作的元素）\n");
            }
        }
        ReadMode::Console => {
            for entry in &response.console {
                out.push_str(&format!("{} {} {}\n", entry.at, entry.level, entry.text));
            }
            if response.console.is_empty() {
                out.push_str("（没有 console 记录）\n");
            }
        }
        ReadMode::Network => {
            for entry in &response.network {
                out.push_str(&format!(
                    "{} {} {} {}{}\n",
                    entry.method,
                    entry.status,
                    entry.url,
                    entry.mime_type,
                    if entry.failure_code.is_empty() {
                        String::new()
                    } else {
                        format!("  失败：{}", entry.failure_code)
                    }
                ));
            }
            if response.network.is_empty() {
                out.push_str("（没有网络记录）\n");
            }
        }
    }
    if response.truncated {
        out.push_str("\n（内容已按上限截断）\n");
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
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
    let session = session::click(live, target, 0, 1).await.map_err(refuse)?;
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

/// A short line for the downloads queue, used by the CLI's `read` of a session
/// that has one pending. Kept here so the wording lives with the other prose.
pub fn describe_download(download: &Download) -> String {
    let state = match download.state {
        DownloadState::Pending => "待确认",
        DownloadState::InProgress => "下载中",
        DownloadState::Completed => "已保存",
        DownloadState::Cancelled => "已取消",
        DownloadState::Failed => "失败",
    };
    format!("{state} {} {}\n", download.suggested_filename, download.url)
}
