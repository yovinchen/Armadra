//! Pointer and keyboard input, plus the element targeting it resolves.

use super::*;

/* ---------------------------------- input ---------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    pub navigation_epoch: u64,
    #[serde(default)]
    pub frame_seq: Option<u64>,
    pub events: Vec<InputEvent>,
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

/* --------------------------------- targeting ------------------------------- */

/// Where a click or a type should land. Exactly one of the three.
pub enum Target<'a> {
    Selector(&'a str),
    ElementRef(&'a str),
    Point(f64, f64),
}

impl<'a> Target<'a> {
    pub fn parse(
        selector: Option<&'a str>,
        element_ref: Option<&'a str>,
        point: Option<(f64, f64)>,
    ) -> AppResult<Self> {
        match (selector, element_ref, point) {
            (Some(selector), None, None) if !selector.trim().is_empty() => {
                Ok(Self::Selector(selector.trim()))
            }
            (None, Some(reference), None) if !reference.trim().is_empty() => {
                Ok(Self::ElementRef(reference.trim()))
            }
            (None, None, Some((x, y))) => Ok(Self::Point(x, y)),
            _ => Err(AppError::BadRequest(
                "Give exactly one of a selector, an element reference, or coordinates".into(),
            )),
        }
    }
}

/// Resolves a target to a viewport point, refusing a stale element reference.
pub(super) async fn point_of(live: &Live, target: &Target<'_>) -> AppResult<(f64, f64)> {
    let epoch = live.navigation_epoch();
    let expression = match target {
        Target::Point(x, y) => return Ok((*x, *y)),
        Target::Selector(selector) => dom::rect_of(selector),
        Target::ElementRef(reference) => dom::element_rect(resolve_ref(live, reference, epoch)?),
    };
    let value = live.evaluate(&expression).await?;
    if value.is_null() {
        return Err(AppError::NotFound(
            "Nothing on the page matches that target".into(),
        ));
    }
    if !value
        .get("visible")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(AppError::Conflict(
            "That element is on the page but not visible".into(),
        ));
    }
    Ok((
        value.get("x").and_then(Value::as_f64).unwrap_or(0.0),
        value.get("y").and_then(Value::as_f64).unwrap_or(0.0),
    ))
}

/// `e<epoch>-<index>`, valid only for the epoch it was minted in.
pub(super) fn resolve_ref(live: &Live, reference: &str, epoch: u64) -> AppResult<usize> {
    let stale = || {
        AppError::Conflict(
            "STALE_TARGET: the page changed since that element was read; read it again".into(),
        )
    };
    let body = reference.strip_prefix('e').ok_or_else(stale)?;
    let (minted, index) = body.split_once('-').ok_or_else(stale)?;
    let minted: u64 = minted.parse().map_err(|_| stale())?;
    let index: usize = index.parse().map_err(|_| stale())?;
    if minted != epoch {
        return Err(stale());
    }
    let (read_epoch, count) = *live
        .elements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if read_epoch != epoch || index >= count {
        return Err(stale());
    }
    Ok(index)
}

pub async fn click(
    live: &Live,
    target: Target<'_>,
    modifiers: u32,
    click_count: u32,
) -> AppResult<BrowserSession> {
    let (x, y) = point_of(live, &target).await?;
    let epoch = live.navigation_epoch();
    for phase in ["mousePressed", "mouseReleased"] {
        live.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": phase,
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": click_count.clamp(1, 3),
                "modifiers": modifiers & 0b1111,
            }),
        )
        .await?;
    }
    // A click that navigates should answer with the page it produced.
    if wait_for_epoch_change(live, epoch, Duration::from_millis(400)).await {
        settle(live).await;
        live.publish().await;
    }
    Ok(live.snapshot())
}

pub async fn type_text(
    live: &Live,
    target: Target<'_>,
    text: &str,
    replace: bool,
    submit: bool,
) -> AppResult<BrowserSession> {
    if text.chars().count() > 4_096 {
        return Err(AppError::BadRequest("That text is too long".into()));
    }
    let epoch = live.navigation_epoch();
    let focused = match &target {
        Target::Selector(selector) => live.evaluate(&dom::focus_field(selector, replace)).await?,
        Target::ElementRef(reference) => {
            let index = resolve_ref(live, reference, epoch)?;
            live.evaluate(&dom::focus_element(index, replace)).await?
        }
        Target::Point(x, y) => {
            for phase in ["mousePressed", "mouseReleased"] {
                live.call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": phase, "x": x, "y": y, "button": "left", "clickCount": 1 }),
                )
                .await?;
            }
            Value::Bool(true)
        }
    };
    if focused != Value::Bool(true) {
        return Err(AppError::NotFound(
            "Nothing on the page matches that target".into(),
        ));
    }
    if !text.is_empty() {
        live.call("Input.insertText", json!({ "text": text }))
            .await?;
    }
    if submit {
        for phase in ["keyDown", "keyUp"] {
            live.call(
                "Input.dispatchKeyEvent",
                json!({
                    "type": phase,
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "text": "\r",
                }),
            )
            .await?;
        }
        if wait_for_epoch_change(live, epoch, Duration::from_millis(600)).await {
            settle(live).await;
            live.publish().await;
        }
    }
    Ok(live.snapshot())
}
