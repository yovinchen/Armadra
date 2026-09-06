//! Frame delivery: subscriptions, per-subscriber budgets and the screencast.
//!
//! Chrome gives one page one screencast, so the session runs it at the most
//! demanding subscriber's budget and thins every other subscriber down from
//! there, frame by frame (design §2.9). Two things are per-subscriber and
//! real: the frame ceiling, and how far behind that subscriber is. A phone on
//! a metered link therefore costs itself frames and nobody else.
//!
//! Two delivery paths exist on purpose. The dedicated stream
//! (`routes/stream.rs`) carries binary `BrowserStreamFrame`s and acknowledges
//! them; the workspace event channel carries base64 for a client that has not
//! moved yet. A session with no event-channel subscriber never encodes base64
//! at all, which is the point of moving the frames off that channel.

use super::*;

/* -------------------------------- subscribers ------------------------------ */

/// One viewer of one session.
pub(super) struct Subscriber {
    visibility: Visibility,
    bandwidth: BandwidthClass,
    /// The ceiling this client asked for, kept so a renewal that does not
    /// re-state it does not silently widen the picture.
    requested_width: u32,
    expires_at: DateTime<Utc>,
    /// Set for a viewer on the dedicated stream. `None` means it is reading
    /// the workspace event channel instead, which cannot acknowledge frames.
    ///
    /// A *watch* rather than a queue, and that is the whole per-subscriber
    /// backpressure design: a viewer that is behind loses the frames in
    /// between, never the newest one. A queue would hand a slow phone a
    /// backlog of pictures that are already wrong, and — worse — a plain
    /// rate-limiting drop would throw away the last frame of a burst and
    /// leave that viewer looking at a stale page forever.
    sender: Option<tokio::sync::watch::Sender<Option<Arc<StreamFrame>>>>,
    /// Only used by the event-channel path, which has no timer of its own.
    last_sent: Option<Instant>,
}

impl Subscriber {
    pub(crate) fn budget(&self) -> Budget {
        Budget::of(self.visibility, self.bandwidth).with_client_ceiling(self.requested_width)
    }

    /// Whether the event-channel path should encode this frame. The dedicated
    /// stream does its own pacing, in the connection that owns the timer.
    fn wants_event(&self, now: Instant) -> bool {
        let budget = self.budget();
        if budget.max_fps == 0 {
            return false;
        }
        let minimum = Duration::from_millis(1_000 / u64::from(budget.max_fps).max(1));
        self.last_sent
            .is_none_or(|last| now.duration_since(last) >= minimum)
    }
}

/// One frame, decoded once and shared by every subscriber on the dedicated
/// stream. The bytes are behind an `Arc` because the alternative is copying a
/// JPEG per viewer, per frame.
pub struct StreamFrame {
    pub generation: u64,
    pub frame_seq: u64,
    pub navigation_epoch: u64,
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub captured_at_unix_ms: i64,
    pub data: Vec<u8>,
}

/// What the session-wide screencast is currently running at.
#[derive(Default)]
pub(super) struct StreamState {
    /// The budget that was *asked for*, stored verbatim so it can be compared
    /// with the next one. Storing what Chrome was told instead would make the
    /// comparison fail every time the two differ — a ceiling wider than the
    /// page, say — and the sweep would tear the screencast down and build it
    /// up again every five seconds, which costs every frame in between.
    running: Option<Budget>,
    /// The width Chrome was actually told, which is what a subscriber is
    /// served and therefore what the receipt reports. Zero means the page's
    /// own width.
    applied_width: u32,
    last_frame: Option<Instant>,
}

impl Live {
    /// The budget the one screencast is running at, or `None` when nobody is
    /// watching and the page is producing no frames at all.
    pub(super) fn running_budget(&self) -> Option<Budget> {
        self.stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .running
    }
}

/* ---------------------------------- frames --------------------------------- */

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

/// Offers one frame to every live subscriber.
///
/// The two paths differ on purpose. A viewer on the dedicated stream is handed
/// the frame unconditionally — its connection owns a timer and paces itself,
/// and the watch it reads keeps only the newest frame, so nothing it skips can
/// leave it looking at a stale page. A viewer on the event channel has no
/// timer, so the frame rate is enforced here, the way it always was.
pub(super) fn publish_frame(live: &Live, data: &str, width: u32, height: u32) {
    let now = Instant::now();
    let record = live.snapshot();
    let (streamed, evented) = {
        let subscriptions = live
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let expiry = Utc::now();
        let mut streamed = Vec::new();
        let mut evented = false;
        for (id, subscriber) in subscriptions.iter() {
            if subscriber.expires_at <= expiry {
                continue;
            }
            match &subscriber.sender {
                Some(_) => streamed.push(id.clone()),
                None => evented |= subscriber.wants_event(now),
            }
        }
        (streamed, evented)
    };
    if streamed.is_empty() && !evented {
        return;
    }
    let frame_seq = live.frame_seq.fetch_add(1, Ordering::SeqCst) + 1;
    live.stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last_frame = Some(now);

    if !streamed.is_empty()
        && let Ok(bytes) = BASE64.decode(data)
    {
        let frame = Arc::new(StreamFrame {
            generation: record.generation,
            frame_seq,
            navigation_epoch: record.navigation_epoch,
            width,
            height,
            device_scale_factor: record.viewport.device_scale_factor,
            captured_at_unix_ms: Utc::now().timestamp_millis(),
            data: bytes,
        });
        let subscriptions = live
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in &streamed {
            if let Some(sender) = subscriptions.get(id).and_then(|s| s.sender.as_ref()) {
                sender.send_replace(Some(frame.clone()));
            }
        }
    }

    if evented {
        {
            let mut subscriptions = live
                .subscriptions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for subscriber in subscriptions.values_mut() {
                if subscriber.sender.is_none() {
                    subscriber.last_sent = Some(now);
                }
            }
        }
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
}

/// One frame right now, without waiting for the page to repaint.
///
/// `Page.startScreencast` only produces frames when the compositor has
/// something new to show, so a subscriber that arrives at a finished, static
/// page would otherwise stare at an empty node until something moved. A single
/// screenshot published through the same path is the first picture; the stream
/// takes over from there.
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
    // A primed frame goes out regardless of the per-subscriber cadence: it is
    // the picture somebody just subscribed for.
    {
        let mut subscriptions = live
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for subscriber in subscriptions.values_mut() {
            subscriber.last_sent = None;
        }
    }
    publish_frame(live, data, viewport.width, viewport.height);
}

/* ------------------------------- subscriptions ----------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    #[serde(default)]
    pub subscription_id: Option<String>,
    pub visibility: Visibility,
    /// What the subscriber says its link is. Absent means LAN, which is what
    /// a node on this machine has.
    #[serde(default)]
    pub bandwidth_class: BandwidthClass,
    /// The subscriber's own width ceiling; zero means it has none.
    #[serde(default)]
    pub max_width: u32,
    /// Opaque per-viewer id, used only to name the lease's human holder.
    #[serde(default)]
    pub device_id: String,
}

pub async fn subscribe(live: &Live, request: &SubscribeRequest) -> AppResult<Subscription> {
    let id = insert_subscriber(live, request, None)?;
    reconcile_stream(live).await;
    Ok(describe(live, &id))
}

/// Registers or renews one subscriber. `sender` is present for a viewer on
/// the dedicated stream, which is also the only kind that acknowledges.
pub(crate) fn insert_subscriber(
    live: &Live,
    request: &SubscribeRequest,
    sender: Option<tokio::sync::watch::Sender<Option<Arc<StreamFrame>>>>,
) -> AppResult<String> {
    let expires_at =
        Utc::now() + chrono::Duration::seconds(crate::browser::SUBSCRIPTION_TTL_SECONDS);
    let mut subscriptions = live
        .subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = Utc::now();
    subscriptions.retain(|_, subscriber| subscriber.expires_at > now);
    let id = match request
        .subscription_id
        .as_ref()
        .filter(|id| subscriptions.contains_key(*id))
    {
        Some(id) => id.clone(),
        None => {
            if subscriptions.len() >= crate::browser::MAX_SUBSCRIPTIONS {
                return Err(AppError::Conflict(
                    "That browser session already has as many viewers as it can stream to".into(),
                ));
            }
            Uuid::new_v4().to_string()
        }
    };
    match subscriptions.get_mut(&id) {
        Some(existing) => {
            existing.visibility = request.visibility;
            existing.bandwidth = request.bandwidth_class;
            existing.requested_width = request.max_width;
            existing.expires_at = expires_at;
            if sender.is_some() {
                existing.sender = sender;
            }
        }
        None => {
            subscriptions.insert(
                id.clone(),
                Subscriber {
                    visibility: request.visibility,
                    bandwidth: request.bandwidth_class,
                    requested_width: request.max_width,
                    expires_at,
                    sender,
                    last_sent: None,
                },
            );
        }
    }
    Ok(id)
}

/// What one subscriber is actually served, as opposed to what it asked for.
///
/// The quality and the width are the session's: there is one screencast, and
/// re-encoding per viewer is not something this module does. The frame
/// ceiling is this subscriber's own, and it is enforced.
pub(crate) fn describe(live: &Live, subscription_id: &str) -> Subscription {
    let (running, applied_width) = {
        let stream = live
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            stream.running.unwrap_or(Budget::NOTHING),
            stream.applied_width,
        )
    };
    let subscriptions = live
        .subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let subscriber = subscriptions.get(subscription_id);
    let mine = subscriber
        .map(Subscriber::budget)
        .unwrap_or(Budget::NOTHING);
    Subscription {
        subscription_id: subscription_id.to_owned(),
        expires_at: subscriber
            .map(|subscriber| subscriber.expires_at.to_rfc3339())
            .unwrap_or_default(),
        quality: running.quality,
        max_fps: mine.max_fps,
        max_width: applied_width,
    }
}

pub async fn unsubscribe(live: &Live, subscription_id: &str) {
    live.subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(subscription_id);
    reconcile_stream(live).await;
}

/// Keeps a subscription from lapsing while its stream is open. The socket is
/// the subscription, so the connection renews it rather than the client having
/// to send anything.
pub(crate) fn renew(live: &Live, subscription_id: &str) {
    let mut subscriptions = live
        .subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(subscriber) = subscriptions.get_mut(subscription_id) {
        subscriber.expires_at =
            Utc::now() + chrono::Duration::seconds(crate::browser::SUBSCRIPTION_TTL_SECONDS);
    }
}

/// The budget the one screencast has to run at: the widest any live
/// subscriber asked for.
pub(super) fn effective_budget(live: &Live) -> Budget {
    let now = Utc::now();
    live.subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .filter(|subscriber| subscriber.expires_at > now)
        .map(Subscriber::budget)
        .fold(Budget::NOTHING, Budget::widen)
}

/// Brings the screencast in line with what subscribers are actually asking
/// for. No subscribers means no picture — and the page keeps running.
pub async fn reconcile_stream(live: &Live) {
    let wanted = effective_budget(live);
    let current = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .running;
    if current == Some(wanted) || (current.is_none() && wanted == Budget::NOTHING) {
        return;
    }
    if wanted == Budget::NOTHING {
        let _ = stop_stream(live).await;
        return;
    }
    if current.is_some() {
        let _ = stop_stream(live).await;
    }
    let _ = start_stream(live, wanted).await;
}

pub(super) async fn start_stream(live: &Live, budget: Budget) -> AppResult<()> {
    let viewport = live.snapshot().viewport;
    let max_width = match budget.max_width {
        0 => viewport.width,
        ceiling => ceiling.min(viewport.width),
    };
    live.call(
        "Page.startScreencast",
        json!({
            "format": "jpeg",
            "quality": budget.quality,
            "maxWidth": max_width,
            "maxHeight": viewport.height,
            // Deliberately 1, not `budget.every_nth`. Chrome only produces a
            // screencast frame when the compositor has something new, so
            // "every Nth" counts repaints, not time: a click that repaints
            // once and then settles has its only frame swallowed whenever N is
            // above 1, and that viewer stares at a stale page until something
            // else moves. Measured on a real Chrome at 390×844: with N = 2 a
            // click produced a frame only when the five-second sweep happened
            // to restart the stream. The thinning is done per subscriber
            // instead, where the newest frame always survives (§2.9).
            "everyNthFrame": 1,
        }),
    )
    .await?;
    {
        let mut stream = live
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        stream.running = Some(budget);
        stream.applied_width = if max_width >= viewport.width {
            0
        } else {
            max_width
        };
        stream.last_frame = None;
    }
    prime_frame(live, budget.quality).await;
    Ok(())
}

pub(super) async fn stop_stream(live: &Live) -> AppResult<()> {
    live.call("Page.stopScreencast", json!({})).await?;
    let mut stream = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    stream.running = None;
    stream.applied_width = 0;
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
                // A lapsed lease is swept on the same beat: an agent waiting
                // on a person who closed their laptop should not wait for the
                // next click to find out the lease is free.
                let expired = {
                    let mut machine = live.lease_machine();
                    machine.expire(Utc::now()).then(|| machine.snapshot())
                };
                if let Some(lease) = expired {
                    lease::publish(&live, lease).await;
                }
                reconcile_stream(&live).await;
            }
        }
    });
}
