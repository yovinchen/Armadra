//! Raw pointer and keyboard input from a person watching the picture.
//!
//! Everything here is aimed at the active tab in its own coordinates: the
//! client that sent it was looking at that tab. Agent verbs resolve an
//! address first and live in [`super::actions`].

use super::*;

/* ---------------------------------- input ---------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    pub navigation_epoch: u64,
    #[serde(default)]
    pub frame_seq: Option<u64>,
    pub events: Vec<InputEvent>,
    /// The generation the caller last saw. Absent means it is not tracking
    /// one, which is allowed: a person clicking is not required to have read
    /// the lease first (§2.6).
    #[serde(default)]
    pub lease_generation: Option<u64>,
    /// The viewer this input came from, so the badge can say "you" on one
    /// device and "another device" on the others.
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputEvent {
    pub kind: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub delta_x: f64,
    #[serde(default)]
    pub delta_y: f64,
    #[serde(default)]
    pub button: String,
    #[serde(default)]
    pub click_count: u32,
    #[serde(default)]
    pub modifiers: u32,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub text: String,
}

/// Dispatches a batch of input events, refusing the whole batch when the page
/// it was aimed at is gone.
///
/// Design §8: "点击坐标从显示框映射回 CSS viewport，携带 frameSeq；过旧帧或导航
/// 变化时拒绝输入并请求新画面." Refusing the batch — rather than replaying it
/// against whatever is on screen now — is the point.
pub async fn input(live: &Live, request: &InputRequest) -> AppResult<u32> {
    if request.events.is_empty() {
        return Ok(0);
    }
    if request.events.len() > MAX_INPUT_EVENTS {
        return Err(AppError::BadRequest(format!(
            "At most {MAX_INPUT_EVENTS} input events per request"
        )));
    }
    let record = live.snapshot();
    if record.navigation_epoch != request.navigation_epoch {
        return Err(AppError::Conflict(
            "The page navigated; discard this input and wait for a new frame".into(),
        ));
    }
    if record.state != SessionState::Ready && record.state != SessionState::Starting {
        return Err(AppError::Conflict(
            "That browser session is not accepting input".into(),
        ));
    }
    // A tab blocked in a dialog does not process input at all; saying so is
    // better than dispatching events the renderer will never see (§2.4). It is
    // checked before the lease so a refused batch does not also change hands.
    dialog_guard(live, &live.active_tab_id())?;
    // A person's ordinary input takes the lease straight away — it never
    // queues, and it preempts an agent (§2.6). Taking it *before* dispatching
    // is what makes the agent's next action see a human holder.
    let actor = lease::Actor::human(
        lease::device_or_local(&request.device_id),
        lease::truncate_name(&request.display_name),
    );
    let before = live.lease_machine().generation();
    lease::acquire(live, &actor, request.lease_generation).await?;
    if live.lease_machine().generation() != before {
        live.record_activity(crate::browser::Activity {
            session_id: live.session_id.clone(),
            actor: "human",
            actor_id: actor.id().to_owned(),
            verb: "input".into(),
            target: String::new(),
            outcome: "ok",
            reason_code: String::new(),
            at: Utc::now().to_rfc3339(),
        });
    }
    let mut accepted = 0;
    for event in &request.events {
        let (method, params) = encode_input(event, record.viewport)?;
        live.call(&method, params).await?;
        accepted += 1;
        // A navigation mid-batch invalidates every later event in it.
        if live.navigation_epoch() != request.navigation_epoch {
            break;
        }
    }
    Ok(accepted)
}

pub(super) fn encode_input(event: &InputEvent, viewport: Viewport) -> AppResult<(String, Value)> {
    let x = event.x.clamp(0.0, f64::from(viewport.width));
    let y = event.y.clamp(0.0, f64::from(viewport.height));
    let button = match event.button.as_str() {
        "left" | "middle" | "right" | "back" | "forward" => event.button.as_str(),
        _ => "none",
    };
    let modifiers = event.modifiers & 0b1111;
    Ok(match event.kind.as_str() {
        "mouseMoved" | "mousePressed" | "mouseReleased" => (
            "Input.dispatchMouseEvent".to_owned(),
            json!({
                "type": event.kind,
                "x": x,
                "y": y,
                "button": button,
                "clickCount": event.click_count.min(3),
                "modifiers": modifiers,
            }),
        ),
        "wheel" => (
            "Input.dispatchMouseEvent".to_owned(),
            json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": clamp_delta(event.delta_x),
                "deltaY": clamp_delta(event.delta_y),
                "modifiers": modifiers,
            }),
        ),
        "keyDown" | "keyUp" => (
            "Input.dispatchKeyEvent".to_owned(),
            json!({
                "type": if event.kind == "keyDown" { "keyDown" } else { "keyUp" },
                "key": truncate(&event.key, 32),
                "code": truncate(&event.code, 32),
                "text": truncate(&event.text, 8),
                "modifiers": modifiers,
            }),
        ),
        // Committed composition text. IME never arrives as synthetic key
        // events, which is what design §8 asks for.
        "text" => (
            "Input.insertText".to_owned(),
            json!({ "text": truncate(&event.text, 4_096) }),
        ),
        "touchStart" | "touchMove" | "touchEnd" => (
            "Input.dispatchTouchEvent".to_owned(),
            json!({
                "type": match event.kind.as_str() {
                    "touchStart" => "touchStart",
                    "touchMove" => "touchMove",
                    _ => "touchEnd",
                },
                "touchPoints": if event.kind == "touchEnd" {
                    json!([])
                } else {
                    json!([{ "x": x, "y": y }])
                },
                "modifiers": modifiers,
            }),
        ),
        other => {
            return Err(AppError::BadRequest(format!(
                "Unknown input kind `{other}`"
            )));
        }
    })
}

pub(super) fn clamp_delta(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-10_000.0, 10_000.0)
    } else {
        0.0
    }
}
