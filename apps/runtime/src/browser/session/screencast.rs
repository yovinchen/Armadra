//! Frame delivery: subscriptions, visibility and the screencast stream.

use super::*;

pub(super) async fn on_frame(live: &Live, params: &Value) {
    // Acknowledge first and unconditionally: an unacknowledged frame stops the
    // browser sending the next one, so dropping a frame for the budget must
    // not also stall the stream.
    if let Some(session) = params.get("sessionId") {
        live.client
            .notify("Page.screencastFrameAck", json!({ "sessionId": session }));
    }
    let Some(data) = params.get("data").and_then(Value::as_str) else {
        return;
    };
    let publish = {
        let mut stream = live
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let max_fps = stream.max_fps;
        if max_fps == 0 {
            false
        } else {
            let minimum = Duration::from_millis(1_000 / u64::from(max_fps).max(1));
            let now = Instant::now();
            let due = stream
                .last_frame
                .is_none_or(|last| now.duration_since(last) >= minimum);
            if due {
                stream.last_frame = Some(now);
            }
            due
        }
    };
    if !publish {
        return;
    }
    let metadata = params.get("metadata");
    let record = live.snapshot();
    let width = metadata
        .and_then(|metadata| metadata.get("deviceWidth"))
        .and_then(Value::as_f64)
        .map(|value| value.round().max(1.0) as u32)
        .unwrap_or(record.viewport.width);
    let height = metadata
        .and_then(|metadata| metadata.get("deviceHeight"))
        .and_then(Value::as_f64)
        .map(|value| value.round().max(1.0) as u32)
        .unwrap_or(record.viewport.height);
    publish_frame(live, data, width, height);
}

pub(super) fn publish_frame(live: &Live, data: &str, width: u32, height: u32) {
    let record = live.snapshot();
    let frame_seq = live.frame_seq.fetch_add(1, Ordering::SeqCst) + 1;
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserFrame {
            frame: Box::new(crate::events::BrowserFramePayload {
                session_id: live.session_id.clone(),
                generation: record.generation,
                frame_seq,
                navigation_epoch: record.navigation_epoch,
                viewport_width: width,
                viewport_height: height,
                device_scale_factor: record.viewport.device_scale_factor,
                encoding: "jpeg",
                data: data.to_owned(),
                captured_at: Utc::now().to_rfc3339(),
            }),
        },
    );
}

/// One frame right now, without waiting for the page to repaint.
///
/// `Page.startScreencast` only produces frames when the compositor has
/// something new to show, so a subscriber that arrives at a finished, static
/// page would otherwise stare at an empty node until something moved. A single
/// screenshot published through the same channel is the first picture; the
/// stream takes over from there.
pub(super) async fn prime_frame(live: &Live, quality: u32) {
    let viewport = live.snapshot().viewport;
    let Ok(result) = live
        .call(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": quality, "optimizeForSpeed": true }),
        )
        .await
    else {
        return;
    };
    let Some(data) = result.get("data").and_then(Value::as_str) else {
        return;
    };
    publish_frame(live, data, viewport.width, viewport.height);
    live.stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last_frame = Some(Instant::now());
}

/* ------------------------------- subscriptions ----------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    #[serde(default)]
    pub subscription_id: Option<String>,
    pub visibility: Visibility,
}

pub async fn subscribe(live: &Live, request: &SubscribeRequest) -> AppResult<Subscription> {
    let expires_at =
        Utc::now() + chrono::Duration::seconds(crate::browser::SUBSCRIPTION_TTL_SECONDS);
    let id = {
        let mut subscriptions = live
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Utc::now();
        subscriptions.retain(|_, (_, expiry)| *expiry > now);
        let id = match request
            .subscription_id
            .as_ref()
            .filter(|id| subscriptions.contains_key(*id))
        {
            Some(id) => id.clone(),
            None => {
                if subscriptions.len() >= crate::browser::MAX_SUBSCRIPTIONS {
                    return Err(AppError::Conflict(
                        "That browser session already has as many viewers as it can stream to"
                            .into(),
                    ));
                }
                Uuid::new_v4().to_string()
            }
        };
        subscriptions.insert(id.clone(), (request.visibility, expires_at));
        id
    };
    reconcile_stream(live).await;
    let (quality, _, max_fps) = effective_visibility(live)
        .unwrap_or(Visibility::Hidden)
        .budget();
    Ok(Subscription {
        subscription_id: id,
        expires_at: expires_at.to_rfc3339(),
        quality,
        max_fps,
    })
}

pub async fn unsubscribe(live: &Live, subscription_id: &str) {
    live.subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(subscription_id);
    reconcile_stream(live).await;
}

pub(super) fn effective_visibility(live: &Live) -> Option<Visibility> {
    let now = Utc::now();
    live.subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .filter(|(_, expiry)| *expiry > now)
        .map(|(visibility, _)| *visibility)
        .max()
}

/// Brings the screencast in line with what subscribers are actually asking
/// for. No subscribers means no picture — and the page keeps running.
pub async fn reconcile_stream(live: &Live) {
    let wanted = effective_visibility(live).filter(|visibility| *visibility != Visibility::Hidden);
    let current = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .mode;
    if wanted == current {
        return;
    }
    match wanted {
        Some(visibility) => {
            if current.is_some() {
                let _ = stop_stream(live).await;
            }
            let _ = start_stream(live, visibility).await;
        }
        None => {
            let _ = stop_stream(live).await;
        }
    }
}

pub(super) async fn start_stream(live: &Live, visibility: Visibility) -> AppResult<()> {
    let (quality, every_nth, max_fps) = visibility.budget();
    let viewport = live.snapshot().viewport;
    live.call(
        "Page.startScreencast",
        json!({
            "format": "jpeg",
            "quality": quality,
            "maxWidth": viewport.width,
            "maxHeight": viewport.height,
            "everyNthFrame": every_nth.max(1),
        }),
    )
    .await?;
    {
        let mut stream = live
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        stream.mode = Some(visibility);
        stream.max_fps = max_fps;
        stream.last_frame = None;
    }
    prime_frame(live, quality).await;
    Ok(())
}

pub(super) async fn stop_stream(live: &Live) -> AppResult<()> {
    live.call("Page.stopScreencast", json!({})).await?;
    let mut stream = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    stream.mode = None;
    stream.max_fps = 0;
    Ok(())
}

/// One task per data directory: expires lapsed subscriptions so an unsubscribed
/// or crashed viewer stops costing frames.
pub fn start_sweep(state: &AppState) {
    let service = service(state);
    {
        let mut sweeping = service
            .sweeping
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *sweeping {
            return;
        }
        *sweeping = true;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_INTERVAL).await;
            for live in service.all() {
                if live.client.is_closed() {
                    continue;
                }
                reconcile_stream(&live).await;
            }
        }
    });
}
