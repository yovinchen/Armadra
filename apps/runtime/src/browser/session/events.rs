//! The CDP event pump and the network bookkeeping it feeds.

use super::*;

pub(super) async fn handle_event(live: &Live, event: CdpEvent) {
    match event.method.as_str() {
        "Page.screencastFrame" => on_frame(live, &event.params).await,
        "Page.frameNavigated" => {
            let frame = event.params.get("frame");
            let is_main = frame
                .and_then(|frame| frame.get("parentId"))
                .and_then(Value::as_str)
                .is_none();
            if !is_main {
                return;
            }
            let url = frame
                .and_then(|frame| frame.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            live.edit(|record| {
                record.navigation_epoch += 1;
                record.url = url;
                record.title = String::new();
            });
            refresh_page_state(live).await;
            live.publish().await;
        }
        "Page.navigatedWithinDocument" => {
            if let Some(url) = event.params.get("url").and_then(Value::as_str) {
                live.edit(|record| record.url = url.to_owned());
                live.publish().await;
            }
        }
        "Page.loadEventFired" => {
            refresh_page_state(live).await;
            live.publish().await;
        }
        "Runtime.consoleAPICalled" => push_console(live, console_from_api(&event.params)),
        "Runtime.exceptionThrown" => push_console(live, console_from_exception(&event.params)),
        "Log.entryAdded" => push_console(live, console_from_log(&event.params)),
        "Network.requestWillBeSent" => on_request(live, &event.params),
        "Network.responseReceived" => on_response(live, &event.params),
        "Network.loadingFinished" => on_loading_finished(live, &event.params),
        "Network.loadingFailed" => on_loading_failed(live, &event.params),
        "Browser.downloadWillBegin" => on_download_begin(live, &event.params),
        "Browser.downloadProgress" => on_download_progress(live, &event.params),
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
pub(super) async fn refresh_page_state(live: &Live) {
    if let Ok(Value::String(title)) = live.evaluate(dom::TITLE).await {
        live.edit(|record| record.title = title);
    }
    if let Ok(history) = live.call("Page.getNavigationHistory", json!({})).await {
        let index = history
            .get("currentIndex")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let count = history
            .get("entries")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0) as i64;
        live.edit(|record| {
            record.can_go_back = index > 0;
            record.can_go_forward = index + 1 < count;
        });
    }
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
