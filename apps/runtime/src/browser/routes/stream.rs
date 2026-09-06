//! `WS /api/workspaces/{id}/browser/sessions/{sid}/stream` — one session's
//! own picture (design §2.9).
//!
//! Frames left the workspace event channel for two reasons. They are binary,
//! so base64 on a channel every client reads costs a third more bytes and a
//! decode per viewer; and they need a per-viewer acknowledgement, which a
//! fan-out channel cannot express. This socket carries `BrowserStreamFrame`
//! down and `BrowserStreamClient` up, both Protobuf, and the Host's existing
//! `proxyStream` carries it to a phone unchanged — it never looks inside.
//!
//! The socket is the subscription: connecting subscribes, disconnecting
//! unsubscribes. There is no way to hold a subscription open without a
//! connection to spend it on.

use std::{sync::Arc, time::Duration};

use armadra_protocol::{
    Message,
    v1::{
        BrowserBandwidthClass, BrowserStreamClient, BrowserStreamFrame, BrowserSubscribeRequest,
        BrowserVisibility, browser_stream_client,
    },
};
use axum::{
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};

use crate::{
    AppState,
    browser::{
        BandwidthClass, Visibility,
        session::{self, Live, StreamFrame, SubscribeRequest},
    },
    error::AppResult,
};

/// Long enough that a viewer which stopped drawing stops being sent frames,
/// short enough that it starts again as soon as it catches up. Without it, a
/// client that never acknowledges would be stuck forever behind its own
/// backpressure rather than merely being served at a lower rate.
const ACK_PATIENCE: Duration = Duration::from_secs(2);

/// `WS …/sessions/{sessionId}/stream`
pub async fn stream(
    State(state): State<AppState>,
    Path((workspace_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    crate::api::support::validate_websocket_origin(&headers)?;
    super::readable_workspace(&state, &workspace_id).await?;
    let live = super::live_in(&state, &workspace_id, &session_id).await?;
    Ok(ws.on_upgrade(move |socket| pump(live, socket)))
}

/// One connection: it owns the pacing, the acknowledgement bookkeeping and
/// the encoding, because it is the only place with both a timer and a socket.
///
/// The session hands it the *newest* frame through a watch. Everything this
/// loop skips is a frame that has already been superseded, which is why a
/// viewer that falls behind never ends up looking at a stale page.
async fn pump(live: Arc<Live>, socket: WebSocket) {
    let (mut sender, mut incoming) = socket.split();
    let (frames_tx, mut frames_rx) = tokio::sync::watch::channel::<Option<Arc<StreamFrame>>>(None);
    // Set by the first `hello`. Until then the client is connected but not
    // subscribed, which is what lets it state its budget before any frame is
    // encoded for it.
    let mut subscription: Option<String> = None;
    // The frame ceiling this viewer is being served at, as a minimum gap.
    let mut interval = Duration::ZERO;
    let mut next_slot = tokio::time::Instant::now();
    let mut sent_seq = 0_u64;
    // How many frames this viewer has been sent and not yet acknowledged.
    // Counted rather than derived from the sequence numbers: `frame_seq` is
    // the session's counter and skips every frame this viewer's own budget
    // thinned away, so `sent_seq - acked_seq` grows without the viewer being
    // behind at all. Measured on a real phone-sized stream, that mistake cost
    // one click in twenty a full `ACK_PATIENCE` of delay.
    let mut in_flight = 0_u64;
    let mut sent_at = tokio::time::Instant::now();

    loop {
        // Is there a frame this viewer has not been given yet? The watch only
        // ever holds the newest one, so "pending" is at most one frame, never
        // a backlog.
        let pending = interval > Duration::ZERO
            && frames_rx
                .borrow()
                .as_ref()
                .is_some_and(|frame| frame.frame_seq > sent_seq);
        // More than `MAX_UNACKED_FRAMES` behind means the viewer is not
        // drawing what it already has. It is served again once it catches up,
        // or after `ACK_PATIENCE` — served slowly beats served never, and a
        // client that never acknowledges must not wedge its own picture.
        let wake = if in_flight > crate::browser::MAX_UNACKED_FRAMES {
            next_slot.max(sent_at + ACK_PATIENCE)
        } else {
            next_slot
        };
        tokio::select! {
            // `sleep_until` on a slot that has already passed fires at once,
            // so this arm is both "the rate limit elapsed" and "send it now".
            () = tokio::time::sleep_until(wake), if pending => {
                let frame = frames_rx.borrow_and_update().clone();
                let Some(frame) = frame else { continue };
                let payload = encode(&live.session_id, &frame);
                if sender.send(WsMessage::Binary(payload.into())).await.is_err() {
                    break;
                }
                sent_seq = frame.frame_seq;
                in_flight += 1;
                sent_at = tokio::time::Instant::now();
                next_slot = sent_at + interval;
                // The socket is the subscription; holding it open is what
                // keeps it alive, not a renewal the client has to remember.
                if let Some(id) = subscription.as_deref() {
                    session::renew(&live, id);
                }
            }
            changed = frames_rx.changed(), if !pending => {
                if changed.is_err() {
                    break;
                }
            }
            message = incoming.next() => {
                let Some(Ok(message)) = message else { break };
                let bytes = match message {
                    WsMessage::Binary(bytes) => bytes,
                    WsMessage::Close(_) => break,
                    // Nothing on this socket is text. A client that sends any
                    // is ignored rather than guessed at.
                    _ => continue,
                };
                let Ok(client) = BrowserStreamClient::decode(bytes.as_ref()) else { continue };
                match client.message {
                    Some(browser_stream_client::Message::Hello(hello))
                    | Some(browser_stream_client::Message::Visibility(hello)) => {
                        let request = subscribe_request(&hello, subscription.as_deref());
                        let Ok(id) = session::insert_subscriber(
                            &live,
                            &request,
                            Some(frames_tx.clone()),
                        ) else {
                            break;
                        };
                        session::reconcile_stream(&live).await;
                        let receipt = session::describe(&live, &id);
                        subscription = Some(id);
                        interval = match receipt.max_fps {
                            0 => Duration::ZERO,
                            fps => Duration::from_millis(1_000 / u64::from(fps)),
                        };
                        next_slot = tokio::time::Instant::now();
                        // The client shows the budget it was actually given
                        // rather than assuming it got what it asked for.
                        let Ok(payload) = serde_json::to_string(&receipt) else { continue };
                        if sender.send(WsMessage::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(browser_stream_client::Message::Ack(frame_seq)) => {
                        // An acknowledgement of the newest frame clears the
                        // whole window; one for an older frame clears itself.
                        in_flight = if frame_seq >= sent_seq {
                            0
                        } else {
                            in_flight.saturating_sub(1)
                        };
                    }
                    Some(browser_stream_client::Message::Input(input)) => {
                        // Input on this socket saves a round trip; the HTTP
                        // route stays as the fallback and does the same work.
                        let request = session::InputRequest {
                            navigation_epoch: input.navigation_epoch,
                            frame_seq: Some(input.frame_seq),
                            events: input.events.iter().map(input_event).collect(),
                            lease_generation: (input.lease_generation != 0)
                                .then_some(input.lease_generation),
                            device_id: input.device_id,
                            display_name: String::new(),
                        };
                        // A refusal is not fatal to the stream: the client
                        // drops that batch and waits for the next frame. It
                        // is told which, though — silently swallowing input
                        // is how "my clicks do nothing" becomes unanswerable.
                        if let Err(error) = session::input(&live, &request).await {
                            // The same `{ code, message }` body the HTTP route
                            // would have answered with, so a client has one
                            // shape of error to handle rather than two.
                            let (_, body) = error.parts();
                            let payload = String::from_utf8_lossy(&body).into_owned();
                            if sender.send(WsMessage::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    None => {}
                }
            }
        }
    }

    if let Some(id) = subscription {
        session::unsubscribe(&live, &id).await;
    }
}

/// Turns the subscriber's `hello` into what the session registry expects.
fn subscribe_request(hello: &BrowserSubscribeRequest, held: Option<&str>) -> SubscribeRequest {
    SubscribeRequest {
        // The socket owns the subscription, so a client cannot claim
        // somebody else's by naming it: only the id this socket was given.
        subscription_id: held.map(str::to_owned),
        visibility: match BrowserVisibility::try_from(hello.visibility) {
            Ok(BrowserVisibility::Focused) => Visibility::Focused,
            Ok(BrowserVisibility::Hidden) => Visibility::Hidden,
            // Unspecified means "on screen but not the one being used", which
            // is the cheaper of the two things that can be meant.
            _ => Visibility::Visible,
        },
        bandwidth_class: match BrowserBandwidthClass::try_from(hello.bandwidth_class) {
            Ok(BrowserBandwidthClass::Wan) => BandwidthClass::Wan,
            Ok(BrowserBandwidthClass::Metered) => BandwidthClass::Metered,
            _ => BandwidthClass::Lan,
        },
        max_width: hello.max_width,
        device_id: hello.device_id.clone(),
    }
}

fn input_event(event: &armadra_protocol::v1::BrowserInputEvent) -> session::InputEvent {
    use armadra_protocol::v1::BrowserInputKind;
    session::InputEvent {
        kind: match BrowserInputKind::try_from(event.kind) {
            Ok(BrowserInputKind::MouseMoved) => "mouseMoved",
            Ok(BrowserInputKind::MousePressed) => "mousePressed",
            Ok(BrowserInputKind::MouseReleased) => "mouseReleased",
            Ok(BrowserInputKind::Wheel) => "wheel",
            Ok(BrowserInputKind::KeyDown) => "keyDown",
            Ok(BrowserInputKind::KeyUp) => "keyUp",
            Ok(BrowserInputKind::Text) => "text",
            Ok(BrowserInputKind::TouchStart) => "touchStart",
            Ok(BrowserInputKind::TouchMove) => "touchMove",
            Ok(BrowserInputKind::TouchEnd) => "touchEnd",
            // An unknown kind is refused by the encoder rather than mapped to
            // whatever is closest.
            _ => "unspecified",
        }
        .to_owned(),
        x: event.x,
        y: event.y,
        delta_x: event.delta_x,
        delta_y: event.delta_y,
        button: event.button.clone(),
        click_count: event.click_count,
        modifiers: event.modifiers,
        key: event.key.clone(),
        code: event.code.clone(),
        text: event.text.clone(),
    }
}

fn encode(session_id: &str, frame: &StreamFrame) -> Vec<u8> {
    BrowserStreamFrame {
        session_id: session_id.to_owned(),
        generation: frame.generation,
        frame_seq: frame.frame_seq,
        navigation_epoch: frame.navigation_epoch,
        tab_id: String::new(),
        viewport_width: frame.width,
        viewport_height: frame.height,
        device_scale_factor: frame.device_scale_factor,
        encoding: "jpeg".into(),
        data: frame.data.clone(),
        captured_at_unix_ms: frame.captured_at_unix_ms,
    }
    .encode_to_vec()
}
