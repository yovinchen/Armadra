//! Navigation, viewport changes and the bounded wait.

use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateRequest {
    pub action: String,
    #[serde(default)]
    pub url: Option<String>,
}

pub async fn navigate(live: &Live, request: &NavigateRequest) -> AppResult<BrowserSession> {
    match request.action.as_str() {
        "goto" => {
            let url = crate::browser::admit_url(request.url.as_deref().unwrap_or_default())?;
            navigate_to(live, &url).await?;
        }
        "reload" => {
            live.call("Page.reload", json!({ "ignoreCache": false }))
                .await?;
        }
        "stop" => {
            live.call("Page.stopLoading", json!({})).await?;
        }
        "back" | "forward" => {
            let history = live.call("Page.getNavigationHistory", json!({})).await?;
            let index = history
                .get("currentIndex")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let entries = history
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let wanted = if request.action == "back" {
                index - 1
            } else {
                index + 1
            };
            let Some(entry) = usize::try_from(wanted).ok().and_then(|at| entries.get(at)) else {
                return Err(AppError::Conflict(
                    "There is nothing in that direction of the history".into(),
                ));
            };
            let id = entry.get("id").cloned().unwrap_or(Value::Null);
            live.call("Page.navigateToHistoryEntry", json!({ "entryId": id }))
                .await?;
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "Unknown navigation action `{other}`"
            )));
        }
    }
    // The epoch and the URL land through `Page.frameNavigated`; give it a
    // moment so the caller's answer already reflects the new page rather than
    // making it poll.
    settle(live).await;
    live.publish().await;
    Ok(live.snapshot())
}

pub(super) async fn navigate_to(live: &Live, url: &str) -> AppResult<()> {
    let result = live.call("Page.navigate", json!({ "url": url })).await?;
    if let Some(error) = result.get("errorText").and_then(Value::as_str) {
        return Err(AppError::BadRequest(format!(
            "The page could not be loaded: {error}"
        )));
    }
    live.edit(|record| record.url = url.to_owned());
    Ok(())
}

/// Waits briefly for the pump to catch up with a navigation we just triggered.
pub(super) async fn settle(live: &Live) {
    let before = live.navigation_epoch();
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if live.navigation_epoch() != before {
            // One more tick so the title refresh lands too.
            tokio::time::sleep(Duration::from_millis(50)).await;
            return;
        }
    }
}

pub async fn set_viewport(live: &Live, viewport: Viewport) -> AppResult<BrowserSession> {
    set_viewport_inner(live, viewport.clamped()).await?;
    Ok(live.snapshot())
}

pub(super) async fn set_viewport_inner(live: &Live, viewport: Viewport) -> AppResult<()> {
    if live.snapshot().viewport == viewport {
        return Ok(());
    }
    apply_viewport(live, viewport).await?;
    live.edit(|record| record.viewport = viewport);
    // A resize changes the screencast bounds, so the stream is restarted with
    // the new maximums rather than left scaling an old size.
    let budget = live.running_budget();
    if let Some(budget) = budget {
        let encoding = live.running_encoding();
        let _ = stop_stream(live).await;
        let _ = start_stream(live, budget, encoding).await;
    }
    live.publish().await;
    Ok(())
}

pub(super) async fn wait_for_epoch_change(live: &Live, before: u64, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if live.navigation_epoch() != before {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    false
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WaitRequest {
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub url_contains: Option<String>,
    #[serde(default)]
    pub title_contains: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u32>,
}

/// Waits for one bounded condition. There is no "network idle": it cannot be
/// answered honestly, so it is not offered (design §7).
pub async fn wait(live: &Live, request: &WaitRequest) -> AppResult<WaitOutcome> {
    let conditions = [
        request.selector.as_deref(),
        request.url_contains.as_deref(),
        request.title_contains.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.trim().is_empty())
    .count();
    if conditions != 1 {
        return Err(AppError::BadRequest(
            "Give exactly one of --selector, --url-contains or --title-contains".into(),
        ));
    }
    let budget = request.timeout_ms.unwrap_or(5_000).min(MAX_WAIT_MS);
    let started = Instant::now();
    let deadline = started + Duration::from_millis(u64::from(budget));
    loop {
        let matched = if let Some(selector) = request.selector.as_deref() {
            live.evaluate(&dom::exists(selector)).await? == Value::Bool(true)
        } else if let Some(needle) = request.url_contains.as_deref() {
            live.evaluate(dom::LOCATION)
                .await?
                .as_str()
                .is_some_and(|url| url.contains(needle))
        } else {
            live.evaluate(dom::TITLE)
                .await?
                .as_str()
                .is_some_and(|title| {
                    title.contains(request.title_contains.as_deref().unwrap_or(""))
                })
        };
        if matched {
            return Ok(WaitOutcome {
                matched: true,
                reason_code: String::new(),
                navigation_epoch: live.navigation_epoch(),
                waited_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
            });
        }
        if Instant::now() >= deadline {
            return Ok(WaitOutcome {
                matched: false,
                reason_code: "timeout".into(),
                navigation_epoch: live.navigation_epoch(),
                waited_ms: budget,
            });
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}
