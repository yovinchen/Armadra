//! Opening, closing and switching tabs, and the CDP events that keep the
//! registry in [`super::targets`] true (§2.2).
//!
//! A tab is a page target this session attached to. Runtime names it `t1`,
//! `t2`, … and never hands out the CDP `targetId`, so a caller cannot address
//! a target this module does not model. The last tab cannot be closed —
//! ending a session is `terminate`, and nothing else.

use super::targets::{FrameContext, FrameState, TabState, no_such_tab};
use super::*;

/* --------------------------------- tab verbs ------------------------------- */

/// `tabs --list`.
pub fn tab_list(live: &Live) -> TabList {
    live.tab_list()
}

/// `tabs --switch`. Moves the picture, the viewport and every unaddressed
/// action to another tab.
pub async fn switch_tab(live: &Live, tab_id: &str) -> AppResult<TabList> {
    {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if targets.tab(tab_id).is_none() {
            return Err(no_such_tab(tab_id));
        }
        if targets.active == tab_id {
            return Ok(TabList {
                tabs: targets
                    .tabs
                    .iter()
                    .map(|tab| tab.describe(&targets.active))
                    .collect(),
                active_tab_id: targets.active.clone(),
                limit: crate::browser::MAX_TABS as u32,
            });
        }
        targets.active = tab_id.to_owned();
    }
    // The old tab's screencast belongs to the old tab's session, so it is
    // stopped where it was started and restarted on the new one. The budget is
    // the subscribers' — it does not change because the tab did — and every
    // subscriber gets a primed frame of the new page rather than waiting for
    // it to repaint (§2.9).
    let running = live.running_budget();
    let encoding = live.running_encoding();
    if running.is_some() {
        let _ = stop_stream(live).await;
    }
    let viewport = live.snapshot().viewport;
    let _ = apply_viewport(live, viewport).await;
    if let Some(budget) = running {
        let _ = start_stream(live, budget, encoding).await;
    }
    live.sync_active();
    live.publish().await;
    live.publish_tabs();
    Ok(live.tab_list())
}

/// `tabs --new`. The address goes through the same policy as any other
/// navigation before a target is even created.
pub async fn new_tab(live: &Live, url: &str) -> AppResult<TabList> {
    let url = crate::browser::admit_url(url)?;
    {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if targets.tabs.len() >= crate::browser::MAX_TABS {
            return Err(AppError::Conflict(format!(
                "tab_limit: this browser session already has {} tabs",
                crate::browser::MAX_TABS
            )));
        }
    }
    live.call_browser("Target.createTarget", json!({ "url": url }))
        .await?;
    // The tab arrives through `Target.attachedToTarget`, so wait for the pump
    // to have adopted it rather than reporting a list it is not in yet.
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let known = {
            let targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            targets.tabs.iter().any(|tab| tab.url == url)
        };
        if known {
            break;
        }
    }
    Ok(live.tab_list())
}

/// `close --tab`. Ending the session is `terminate`, and nothing else.
pub async fn close_tab(live: &Live, tab_id: &str) -> AppResult<TabList> {
    let target_id = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if targets.tabs.len() <= 1 {
            return Err(AppError::Conflict(
                "LAST_TAB: the last tab cannot be closed; end the session instead".into(),
            ));
        }
        targets
            .tab(tab_id)
            .ok_or_else(|| no_such_tab(tab_id))?
            .target_id
            .clone()
    };
    live.call_browser("Target.closeTarget", json!({ "targetId": target_id }))
        .await?;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let gone = {
            let targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            targets.tab(tab_id).is_none()
        };
        if gone {
            break;
        }
    }
    Ok(live.tab_list())
}

/* ------------------------------ pump handlers ------------------------------ */

/// A target attached itself to us.
///
/// `owner` is the session the event arrived on: empty for a page attaching at
/// browser level, and the parent page's session for an out-of-process iframe,
/// which is what says whose frame it is.
pub(super) async fn on_attached(live: &Live, owner: &str, params: &Value) {
    let Some(session) = params.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let info = params.get("targetInfo").cloned().unwrap_or(Value::Null);
    let kind = info
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let target_id = info
        .get("targetId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let url = info
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match kind.as_str() {
        // Chrome ≥ 111 hands out a `tab` wrapper first; the page inside it is
        // reached by asking that session to auto-attach in turn.
        "tab" => {
            let _ = live
                .call_in(
                    session,
                    "Target.setAutoAttach",
                    json!({ "autoAttach": true, "waitForDebuggerOnStart": false,
                            "flatten": true }),
                )
                .await;
        }
        "page" => adopt_tab(live, session, &target_id, &url, &info).await,
        "iframe" => adopt_oopif(live, owner, session, &target_id, &url).await,
        _ => {}
    }
}

async fn adopt_tab(live: &Live, session: &str, target_id: &str, url: &str, info: &Value) {
    let opener = info
        .get("openerId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let (tab_id, refused, opened_by) = {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if targets.tabs.iter().any(|tab| tab.target_id == target_id) {
            return;
        }
        let opened_by = targets
            .tabs
            .iter()
            .find(|tab| tab.target_id == opener)
            .map(|tab| tab.tab_id.clone())
            .unwrap_or_default();
        let refused = if targets.tabs.len() >= crate::browser::MAX_TABS {
            Some("tab_limit")
        } else {
            None
        };
        if refused.is_some() {
            (String::new(), refused, opened_by)
        } else {
            let tab_id = targets.next_tab_id();
            targets.tabs.push(TabState {
                tab_id: tab_id.clone(),
                target_id: target_id.to_owned(),
                session: session.to_owned(),
                url: url.to_owned(),
                title: String::new(),
                opener_tab_id: opened_by.clone(),
                loading: false,
                favicon: String::new(),
                ready: false,
                epoch: 0,
                main_frame: String::new(),
                dialog: None,
                chooser: None,
                frames: HashMap::new(),
                elements: HashMap::new(),
            });
            if targets.active.is_empty() {
                targets.active = tab_id.clone();
            }
            (tab_id, None, opened_by)
        }
    };
    // First, before anything else: a target that auto-attached may be held at
    // its very first instruction, and while it is, the *opener* is held too —
    // the click that called `window.open` does not come back until the new
    // window is let go.
    let _ = live
        .call_in(session, "Runtime.runIfWaitingForDebugger", json!({}))
        .await;
    // A popup the workspace policy does not allow, or one tab too many, is
    // closed and written to the console rather than silently ignored.
    let blocked = refused.or_else(|| {
        let policy = live
            .policy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .popups;
        if !opened_by.is_empty() && policy == crate::browser::PopupPolicy::Block {
            Some("popup_blocked")
        } else {
            None
        }
    });
    if let Some(reason) = blocked {
        if !tab_id.is_empty() {
            forget_tab(live, &tab_id);
        }
        push_console(
            live,
            Some(ConsoleEntry {
                at: Utc::now().to_rfc3339(),
                level: "warning".into(),
                text: format!("{reason} {url}"),
                url: truncate(url, 2_000),
                line: 0,
            }),
        );
        let _ = live
            .call_browser("Target.closeTarget", json!({ "targetId": target_id }))
            .await;
        return;
    }
    match prepare_tab(live, session).await {
        Ok(()) => {
            let mut targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(tab) = targets.tab_mut(&tab_id) {
                tab.ready = true;
            }
        }
        Err(error) => {
            // A target that will not answer is not a tab anybody can drive.
            // Chrome discards the one it starts with while it settles, and
            // keeping it would make every later command fail on a page that
            // is not there.
            tracing::info!(session = %live.session_id, %error, "a browser target did not attach");
            forget_tab(live, &tab_id);
        }
    }
    live.sync_active();
    live.publish().await;
    live.publish_tabs();
}

async fn adopt_oopif(live: &Live, owner: &str, session: &str, target_id: &str, url: &str) {
    // The iframe target's id *is* its frame id, which is what makes an OOPIF
    // addressable with the same `frame_id` a same-process iframe uses. The
    // frame may not be in the parent's tree yet, so the owning session — the
    // one this event arrived on — is what says which tab it belongs to.
    {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tab = match targets
            .tabs
            .iter_mut()
            .find(|tab| tab.frames.contains_key(target_id))
        {
            Some(tab) => Some(tab),
            None => targets.by_session_mut(owner),
        };
        let Some(tab) = tab else { return };
        let frame = tab
            .frames
            .entry(target_id.to_owned())
            .or_insert(FrameState {
                frame_id: target_id.to_owned(),
                parent_id: tab.main_frame.clone(),
                session: session.to_owned(),
                context: None,
                epoch: 0,
                url: url.to_owned(),
                out_of_process: true,
            });
        frame.session = session.to_owned();
        frame.context = None;
        frame.out_of_process = true;
        frame.url = url.to_owned();
    }
    let _ = live
        .call_in(session, "Runtime.runIfWaitingForDebugger", json!({}))
        .await;
    let _ = live
        .call_in(session, "Page.enable", json!({}))
        .await
        .map_err(|error| tracing::debug!(%error, "iframe target refused Page.enable"));
    let _ = live.call_in(session, "Runtime.enable", json!({})).await;
    let _ = live
        .call_in(
            session,
            "Fetch.enable",
            json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request",
                                   "resourceType": "Document" }] }),
        )
        .await;
}

/// Everything one page target needs enabled, and nothing else.
pub(super) async fn prepare_tab(live: &Live, session: &str) -> AppResult<()> {
    live.call_in(session, "Page.enable", json!({})).await?;
    live.call_in(session, "Runtime.enable", json!({})).await?;
    live.call_in(session, "Log.enable", json!({})).await?;
    live.call_in(session, "DOM.enable", json!({})).await?;
    // Small browser-side buffers: we never ask for a response body, so keeping
    // one would only cost memory and store material we promised not to hold.
    live.call_in(
        session,
        "Network.enable",
        json!({ "maxTotalBufferSize": 1024, "maxResourceBufferSize": 1024 }),
    )
    .await?;
    // Every document request pauses here first — the top-level navigation, an
    // iframe's document, a popup's first request, and each redirect hop, since
    // a hop arrives as its own paused request. That is what makes the URL
    // policy hold for a redirect the caller never saw (§2.5).
    live.call_in(
        session,
        "Fetch.enable",
        json!({
            "patterns": [{ "urlPattern": "*", "requestStage": "Request",
                           "resourceType": "Document" }],
        }),
    )
    .await?;
    // Out-of-process iframes of this page attach to us through its session.
    let _ = live
        .call_in(
            session,
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
        )
        .await;
    // A file chooser is answered by `upload`, never by a native dialog nobody
    // can see (§2.3).
    let _ = live
        .call_in(
            session,
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": true }),
        )
        .await;
    let tree = live
        .call_in(session, "Page.getFrameTree", json!({}))
        .await?;
    adopt_frame_tree(live, session, tree.get("frameTree"));
    Ok(())
}

fn adopt_frame_tree(live: &Live, session: &str, tree: Option<&Value>) {
    let Some(tree) = tree else { return };
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(tab) = targets.by_session_mut(session) else {
        return;
    };
    if let Some(id) = tree
        .get("frame")
        .and_then(|frame| frame.get("id"))
        .and_then(Value::as_str)
    {
        tab.main_frame = id.to_owned();
    }
    if let Some(url) = tree
        .get("frame")
        .and_then(|frame| frame.get("url"))
        .and_then(Value::as_str)
        && tab.url.is_empty()
    {
        tab.url = url.to_owned();
    }
    let parent = tab.main_frame.clone();
    let session = session.to_owned();
    let children = tree
        .get("childFrames")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    fn walk(tab: &mut TabState, session: &str, parent: &str, nodes: &[Value]) {
        for node in nodes {
            let Some(frame) = node.get("frame") else {
                continue;
            };
            let Some(id) = frame.get("id").and_then(Value::as_str) else {
                continue;
            };
            let url = frame
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let entry = tab.frames.entry(id.to_owned()).or_insert(FrameState {
                frame_id: id.to_owned(),
                parent_id: parent.to_owned(),
                session: session.to_owned(),
                context: None,
                epoch: 0,
                url: url.clone(),
                out_of_process: false,
            });
            entry.parent_id = parent.to_owned();
            entry.url = url;
            let children = node
                .get("childFrames")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            walk(tab, session, id, &children);
        }
    }
    walk(tab, &session, &parent, &children);
}

pub(super) async fn on_detached(live: &Live, params: &Value) {
    let Some(session) = params.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let tab_id = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        targets
            .tabs
            .iter()
            .find(|tab| tab.session == session)
            .map(|tab| tab.tab_id.clone())
    };
    match tab_id {
        Some(tab_id) => {
            forget_tab(live, &tab_id);
            live.sync_active();
            live.publish().await;
            live.publish_tabs();
        }
        None => {
            let mut targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for tab in &mut targets.tabs {
                tab.frames
                    .retain(|_, frame| !(frame.out_of_process && frame.session == session));
            }
        }
    }
}

/// A target the browser threw away. Not every one of them produces a detach
/// event first, so both are handled and the second is a no-op.
pub(super) async fn on_target_destroyed(live: &Live, params: &Value) {
    let Some(target_id) = params.get("targetId").and_then(Value::as_str) else {
        return;
    };
    let tab_id = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        targets
            .tabs
            .iter()
            .find(|tab| tab.target_id == target_id)
            .map(|tab| tab.tab_id.clone())
    };
    let Some(tab_id) = tab_id else { return };
    forget_tab(live, &tab_id);
    live.sync_active();
    live.publish().await;
    live.publish_tabs();
}

fn forget_tab(live: &Live, tab_id: &str) {
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    targets.tabs.retain(|tab| tab.tab_id != tab_id);
    if targets.active == tab_id {
        targets.active = targets
            .tabs
            .first()
            .map(|tab| tab.tab_id.clone())
            .unwrap_or_default();
    }
}

pub(super) async fn on_target_info(live: &Live, params: &Value) {
    let Some(info) = params.get("targetInfo") else {
        return;
    };
    let Some(target_id) = info.get("targetId").and_then(Value::as_str) else {
        return;
    };
    let changed = {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match targets
            .tabs
            .iter_mut()
            .find(|tab| tab.target_id == target_id)
        {
            Some(tab) => {
                if let Some(url) = info.get("url").and_then(Value::as_str) {
                    tab.url = url.to_owned();
                }
                if let Some(title) = info.get("title").and_then(Value::as_str)
                    && !title.is_empty()
                {
                    tab.title = title.to_owned();
                }
                true
            }
            None => false,
        }
    };
    if changed {
        live.sync_active();
        live.publish_tabs();
    }
}

/// A frame committed a new document: its epoch moves and every reference
/// minted against the old one stops resolving.
pub(super) async fn on_frame_navigated(live: &Live, session: &str, params: &Value) {
    let Some(frame) = params.get("frame") else {
        return;
    };
    let Some(frame_id) = frame.get("id").and_then(Value::as_str) else {
        return;
    };
    let url = frame
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let parent_id = frame
        .get("parentId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let main = {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(tab) = targets.by_session_mut(session) else {
            return;
        };
        let is_page_session = tab.session == session;
        if is_page_session && parent_id.is_empty() {
            tab.main_frame = frame_id.to_owned();
            tab.epoch += 1;
            tab.url = url.clone();
            tab.title = String::new();
            // The previous site's mark beside the new site's address is worse
            // than no mark at all; `Page.loadEventFired` asks for the new one.
            tab.favicon = String::new();
            // Every frame of the old document went with it. Keeping them
            // would let a reference resolve against a frame that no longer
            // exists, which is worse than `STALE_TARGET`.
            tab.frames.clear();
            tab.elements.clear();
            true
        } else {
            let entry = tab.frames.entry(frame_id.to_owned()).or_insert(FrameState {
                frame_id: frame_id.to_owned(),
                parent_id: parent_id.clone(),
                session: session.to_owned(),
                context: None,
                epoch: 0,
                url: url.clone(),
                out_of_process: !is_page_session,
            });
            if !parent_id.is_empty() {
                entry.parent_id = parent_id.clone();
            }
            entry.url = url.clone();
            entry.epoch += 1;
            tab.elements.remove(frame_id);
            false
        }
    };
    if main {
        live.sync_active();
    }
    live.publish_tabs();
}

pub(super) fn on_frame_attached(live: &Live, session: &str, params: &Value) {
    let Some(frame_id) = params.get("frameId").and_then(Value::as_str) else {
        return;
    };
    let parent_id = params
        .get("parentFrameId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(tab) = targets.by_session_mut(session) else {
        return;
    };
    let entry = tab.frames.entry(frame_id.to_owned()).or_insert(FrameState {
        frame_id: frame_id.to_owned(),
        parent_id: parent_id.clone(),
        session: session.to_owned(),
        context: None,
        epoch: 0,
        url: String::new(),
        out_of_process: false,
    });
    entry.parent_id = parent_id;
}

pub(super) fn on_frame_detached(live: &Live, session: &str, params: &Value) {
    let Some(frame_id) = params.get("frameId").and_then(Value::as_str) else {
        return;
    };
    // A frame that moved out of process is *not* gone: it is about to attach
    // as its own target, and forgetting it here would lose its parent.
    if params.get("reason").and_then(Value::as_str) == Some("swap") {
        return;
    }
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(tab) = targets.by_session_mut(session) {
        tab.frames.remove(frame_id);
        tab.elements.remove(frame_id);
    }
}

/// The default world of a frame, which is what a per-frame read evaluates in.
pub(super) fn on_context_created(live: &Live, session: &str, params: &Value) {
    let Some(context) = params.get("context") else {
        return;
    };
    let aux = context.get("auxData");
    if aux
        .and_then(|aux| aux.get("isDefault"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return;
    }
    let Some(frame_id) = aux
        .and_then(|aux| aux.get("frameId"))
        .and_then(Value::as_str)
    else {
        return;
    };
    let Some(unique) = context.get("uniqueId").and_then(Value::as_str) else {
        return;
    };
    let id = context
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(tab) = targets.by_session_mut(session) else {
        return;
    };
    if tab.main_frame == frame_id || tab.session != session {
        return;
    }
    if let Some(frame) = tab.frames.get_mut(frame_id) {
        frame.context = Some(FrameContext {
            id,
            unique: unique.to_owned(),
        });
        frame.session = session.to_owned();
        frame.out_of_process = false;
    }
}

/// The browser is the only thing that knows when a context is really gone.
/// Both spellings are accepted: newer builds report the unique id, older ones
/// only the number.
pub(super) fn on_context_destroyed(live: &Live, session: &str, params: &Value) {
    let unique = params
        .get("executionContextUniqueId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let id = params.get("executionContextId").and_then(Value::as_i64);
    if unique.is_empty() && id.is_none() {
        return;
    }
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(tab) = targets.by_session_mut(session) {
        for frame in tab.frames.values_mut() {
            let matches = frame.context.as_ref().is_some_and(|context| {
                (!unique.is_empty() && context.unique == unique) || Some(context.id) == id
            });
            if matches {
                frame.context = None;
            }
        }
    }
}

/// Every context of one target went at once: a page-wide navigation.
pub(super) fn on_contexts_cleared(live: &Live, session: &str) {
    let mut targets = live
        .targets
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(tab) = targets.by_session_mut(session) {
        for frame in tab.frames.values_mut() {
            if !frame.out_of_process && frame.session == session {
                frame.context = None;
            }
        }
    }
}
