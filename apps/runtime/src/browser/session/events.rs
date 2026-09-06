//! The CDP event pump and the network bookkeeping it feeds.

use super::*;

pub(super) async fn handle_event(live: &Live, event: CdpEvent) {
    let session = event.session_id.as_str();
    let active = live.active_session();
    match event.method.as_str() {
        // The picture only ever comes from the tab on screen; a background
        // tab's frames are acknowledged and dropped.
        "Page.screencastFrame" => on_frame(live, session, &event.params).await,
        "Target.attachedToTarget" => tabs::on_attached(live, session, &event.params).await,
        "Target.detachedFromTarget" => tabs::on_detached(live, &event.params).await,
        "Target.targetDestroyed" => tabs::on_target_destroyed(live, &event.params).await,
        "Target.targetInfoChanged" => tabs::on_target_info(live, &event.params).await,
        "Page.frameNavigated" => {
            tabs::on_frame_navigated(live, session, &event.params).await;
            if session == active {
                refresh_page_state(live).await;
                live.publish().await;
            }
        }
        "Page.frameAttached" => tabs::on_frame_attached(live, session, &event.params),
        "Page.frameDetached" => tabs::on_frame_detached(live, session, &event.params),
        "Runtime.executionContextCreated" => tabs::on_context_created(live, session, &event.params),
        "Runtime.executionContextDestroyed" => {
            tabs::on_context_destroyed(live, session, &event.params)
        }
        "Runtime.executionContextsCleared" => tabs::on_contexts_cleared(live, session),
        "Page.navigatedWithinDocument" => {
            if let Some(url) = event.params.get("url").and_then(Value::as_str)
                && session == active
            {
                live.edit(|record| record.url = url.to_owned());
                live.publish().await;
            }
        }
        "Page.loadEventFired" => {
            if session == active {
                refresh_page_state(live).await;
                live.publish().await;
            }
        }
        "Page.javascriptDialogOpening" => on_dialog_opening(live, session, &event.params).await,
        "Page.javascriptDialogClosed" => on_dialog_closed(live, session).await,
        "Page.fileChooserOpened" => on_file_chooser(live, session, &event.params).await,
        "Runtime.consoleAPICalled" => push_console(live, console_from_api(&event.params)),
        "Runtime.exceptionThrown" => push_console(live, console_from_exception(&event.params)),
        "Log.entryAdded" => push_console(live, console_from_log(&event.params)),
        "Network.requestWillBeSent" => on_request(live, &event.params),
        "Network.responseReceived" => on_response(live, &event.params),
        "Network.loadingFinished" => on_loading_finished(live, &event.params),
        "Network.loadingFailed" => on_loading_failed(live, &event.params),
        "Browser.downloadWillBegin" => on_download_begin(live, session, &event.params),
        "Browser.downloadProgress" => on_download_progress(live, &event.params).await,
        "Inspector.targetCrashed" => {
            live.edit(|record| {
                record.state = SessionState::Disconnected;
                record.reason_code = "page_crashed".into();
            });
            live.publish().await;
        }
        _ => {}
    }
}

/// Title and history buttons after a navigation settles.
///
/// Both come out of the navigation history rather than out of the page. The
/// pump must never wait on the renderer: a document that is mid-navigation
/// does not answer `Runtime.evaluate`, and every later command on the same CDP
/// session queues behind the one that is still outstanding — including the
/// navigation the page is waiting to make. Asking the browser instead of the
/// page keeps that from happening.
pub(super) async fn refresh_page_state(live: &Live) {
    let Ok(history) = live.call("Page.getNavigationHistory", json!({})).await else {
        return;
    };
    let index = history
        .get("currentIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let entries = history
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let title = usize::try_from(index)
        .ok()
        .and_then(|at| entries.get(at))
        .and_then(|entry| entry.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let count = entries.len() as i64;
    live.edit(|record| {
        // An entry with no title yet leaves the last one alone rather than
        // blanking the header while the next page parses.
        if !title.is_empty() {
            record.title = title;
        }
        record.can_go_back = index > 0;
        record.can_go_forward = index + 1 < count;
    });
}

pub(super) fn on_request(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let request = params.get("request");
    let entry = NetworkEntry {
        at: Utc::now().to_rfc3339(),
        method: request
            .and_then(|request| request.get("method"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        url: truncate(
            request
                .and_then(|request| request.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        status: 0,
        mime_type: String::new(),
        encoded_bytes: 0,
        failure_code: String::new(),
        from_cache: false,
    };
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if rings.network.len() >= RING_CAPACITY {
        rings.network.pop_front();
    }
    rings.network.push_back((request_id.to_owned(), entry));
}

pub(super) fn amend_network(live: &Live, request_id: &str, apply: impl FnOnce(&mut NetworkEntry)) {
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((_, entry)) = rings
        .network
        .iter_mut()
        .rev()
        .find(|(id, _)| id == request_id)
    {
        apply(entry);
    }
}

pub(super) fn on_response(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let response = params.get("response");
    let status = response
        .and_then(|response| response.get("status"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let mime = response
        .and_then(|response| response.get("mimeType"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let cached = response
        .and_then(|response| response.get("fromDiskCache"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    amend_network(live, request_id, |entry| {
        entry.status = status;
        entry.mime_type = mime;
        entry.from_cache = cached;
    });
}

pub(super) fn on_loading_finished(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let bytes = params
        .get("encodedDataLength")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0) as u64;
    amend_network(live, request_id, |entry| entry.encoded_bytes = bytes);
}

pub(super) fn on_loading_failed(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let failure = params
        .get("errorText")
        .and_then(Value::as_str)
        .unwrap_or("failed")
        .to_owned();
    amend_network(live, request_id, |entry| entry.failure_code = failure);
}

/* ----------------------------- document policy ---------------------------- */

/// One paused document request. `Fetch` is enabled for `Document` only, so
/// this runs for navigations, iframes, popups and — crucially — for every hop
/// of a redirect chain, each of which arrives as its own paused request.
///
/// The request is never left paused: a decision this code cannot make is a
/// page that hangs forever, so an internal failure continues the request
/// rather than stranding it.
pub(super) async fn on_document_request(live: &Live, session: &str, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let url = params
        .get("request")
        .and_then(|request| request.get("url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // A redirect is reported a second time once its response arrives, and a
    // paused response is continued with a different command. It carries the
    // URL that was already admitted at the request stage — the *next* hop
    // arrives as its own request-stage pause — so there is nothing to re-judge
    // here, only something to let through.
    if params.get("responseStatusCode").is_some() || params.get("responseErrorReason").is_some() {
        let _ = live
            .call_in(
                session,
                "Fetch.continueResponse",
                json!({ "requestId": request_id }),
            )
            .await;
        return;
    }
    let policy = live
        .policy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let admission = admit_document_now(&url, &policy).await;
    if admission.is_admitted() {
        let _ = live
            .call_in(
                session,
                "Fetch.continueRequest",
                json!({ "requestId": request_id }),
            )
            .await;
        return;
    }
    // `BlockedByClient` is what Chrome shows as ERR_BLOCKED_BY_CLIENT, which
    // is exactly what happened: this client blocked it.
    let _ = live
        .call_in(
            session,
            "Fetch.failRequest",
            json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
        )
        .await;
    push_console(
        live,
        Some(ConsoleEntry {
            at: Utc::now().to_rfc3339(),
            level: "error".into(),
            text: format!("navigation_blocked {}", admission.reason_code()),
            url: truncate(&url, 2_000),
            line: 0,
        }),
    );
    live.edit(|record| record.reason_code = "navigation_blocked".into());
    live.publish().await;
}

/// Resolves the host, then applies the policy. The lookup is bounded: a name
/// that will not resolve inside a second is treated as unresolvable, which is
/// a refusal — admitting an address nobody could resolve would mean admitting
/// whatever the browser resolves it to a moment later.
async fn admit_document_now(url: &str, policy: &crate::browser::NetworkPolicy) -> Admission {
    let Some(target) = crate::browser::parse_target(url) else {
        return Admission::Refuse("scheme_not_allowed");
    };
    let resolved = if target.host.parse::<std::net::IpAddr>().is_ok() {
        Vec::new()
    } else {
        let lookup = tokio::net::lookup_host((target.host.as_str(), target.effective_port()));
        match tokio::time::timeout(Duration::from_secs(1), lookup).await {
            Ok(Ok(addresses)) => addresses.map(|address| address.ip()).collect(),
            _ => Vec::new(),
        }
    };
    crate::browser::admit_document(url, &resolved, policy)
}
