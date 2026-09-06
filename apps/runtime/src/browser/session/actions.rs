//! What an action does to a page: click, type, select, press, scroll.
//!
//! Every one of them resolves an address first ([`targets`]), refuses a tab
//! that is blocked in a dialog ([`dialogs::dialog_guard`]), and then dispatches
//! real input events at real coordinates. Nothing here evaluates caller text:
//! a selector reaches the page only as a JSON string literal inside one of the
//! constants in [`dom`].

use super::*;

/// Where a click or a type should land inside a frame. Exactly one of three.
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

/// A resolved click point, in the coordinates the owning tab dispatches in.
pub(super) struct Aim {
    pub(super) place: Place,
    pub(super) session: String,
    pub(super) x: f64,
    pub(super) y: f64,
}

/// Resolves a target to a point in its tab's viewport, refusing a stale
/// element reference and a tab that is waiting on a dialog.
pub(super) async fn aim(live: &Live, target: &Target<'_>, address: &TargetRef) -> AppResult<Aim> {
    let (place, expression) = match target {
        Target::Point(x, y) => {
            let place = live.place(address)?;
            dialog_guard(live, &place.tab_id)?;
            let session = live.tab_session(&place.tab_id)?;
            let (dx, dy) = live.frame_offset(&place).await?;
            return Ok(Aim {
                place,
                session,
                x: x + dx,
                y: y + dy,
            });
        }
        Target::Selector(selector) => {
            let place = live.place(address)?;
            let expression = dom::rect_of(selector);
            (place, expression)
        }
        Target::ElementRef(reference) => {
            let (place, index) = live.resolve_ref(reference, address)?;
            let expression = dom::element_rect(index);
            (place, expression)
        }
    };
    dialog_guard(live, &place.tab_id)?;
    let session = live.tab_session(&place.tab_id)?;
    let value = live.evaluate_in(&place, &expression).await?;
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
    let (dx, dy) = live.frame_offset(&place).await?;
    Ok(Aim {
        place,
        session,
        x: value.get("x").and_then(Value::as_f64).unwrap_or(0.0) + dx,
        y: value.get("y").and_then(Value::as_f64).unwrap_or(0.0) + dy,
    })
}

/* ---------------------------------- click ---------------------------------- */

pub async fn click(
    live: &Live,
    target: Target<'_>,
    address: &TargetRef,
    modifiers: u32,
    click_count: u32,
) -> AppResult<BrowserSession> {
    let aim = aim(live, &target, address).await?;
    let epoch = live.navigation_epoch();
    for phase in ["mousePressed", "mouseReleased"] {
        live.call_in(
            &aim.session,
            "Input.dispatchMouseEvent",
            json!({
                "type": phase,
                "x": aim.x,
                "y": aim.y,
                "button": "left",
                "clickCount": click_count.clamp(1, 3),
                "modifiers": modifiers & 0b1111,
            }),
        )
        .await?;
    }
    // A click that navigates should answer with the page it produced.
    if aim.place.active && wait_for_epoch_change(live, epoch, Duration::from_millis(400)).await {
        settle(live).await;
        live.publish().await;
    }
    Ok(live.snapshot())
}

/* ----------------------------------- type ---------------------------------- */

pub async fn type_text(
    live: &Live,
    target: Target<'_>,
    address: &TargetRef,
    text: &str,
    replace: bool,
    submit: bool,
) -> AppResult<BrowserSession> {
    if text.chars().count() > 4_096 {
        return Err(AppError::BadRequest("That text is too long".into()));
    }
    let epoch = live.navigation_epoch();
    let (place, session, focused) = match &target {
        Target::Selector(selector) => {
            let place = live.place(address)?;
            dialog_guard(live, &place.tab_id)?;
            let session = live.tab_session(&place.tab_id)?;
            let focused = live
                .evaluate_in(&place, &dom::focus_field(selector, replace))
                .await?;
            (place, session, focused)
        }
        Target::ElementRef(reference) => {
            let (place, index) = live.resolve_ref(reference, address)?;
            dialog_guard(live, &place.tab_id)?;
            let session = live.tab_session(&place.tab_id)?;
            let focused = live
                .evaluate_in(&place, &dom::focus_element(index, replace))
                .await?;
            (place, session, focused)
        }
        Target::Point(_, _) => {
            let aim = aim(live, &target, address).await?;
            for phase in ["mousePressed", "mouseReleased"] {
                live.call_in(
                    &aim.session,
                    "Input.dispatchMouseEvent",
                    json!({ "type": phase, "x": aim.x, "y": aim.y,
                            "button": "left", "clickCount": 1 }),
                )
                .await?;
            }
            (aim.place, aim.session, Value::Bool(true))
        }
    };
    if focused != Value::Bool(true) {
        return Err(AppError::NotFound(
            "Nothing on the page matches that target".into(),
        ));
    }
    if !text.is_empty() {
        live.call_in(&session, "Input.insertText", json!({ "text": text }))
            .await?;
    }
    if submit {
        for phase in ["keyDown", "keyUp"] {
            live.call_in(
                &session,
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
        if place.active && wait_for_epoch_change(live, epoch, Duration::from_millis(600)).await {
            settle(live).await;
            live.publish().await;
        }
    }
    Ok(live.snapshot())
}

/* ---------------------------------- select --------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectRequest {
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub element_ref: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub target: TargetRef,
}

/// Chooses `<select>` options by value or by label.
///
/// Deliberately not a click on a rendered menu: a native select popup is drawn
/// by the operating system, is not in the page's own coordinates and does not
/// appear in a screencast at all. Setting the options and dispatching
/// `input` / `change` is what the page itself observes.
pub async fn select(live: &Live, request: &SelectRequest) -> AppResult<Vec<String>> {
    if request.values.is_empty() && request.labels.is_empty() {
        return Err(AppError::BadRequest(
            "Give at least one --value or --label to select".into(),
        ));
    }
    let (place, element) = match (&request.element_ref, &request.selector) {
        (Some(reference), _) => {
            let (place, index) = live.resolve_ref(reference, &request.target)?;
            (place, dom::by_index(index))
        }
        (None, Some(selector)) => {
            let place = live.place(&request.target)?;
            (place, dom::by_selector(selector))
        }
        (None, None) => {
            return Err(AppError::BadRequest(
                "Give a --selector or a --ref to select in".into(),
            ));
        }
    };
    dialog_guard(live, &place.tab_id)?;
    let outcome = live
        .evaluate_in(
            &place,
            &dom::select_options(&element, &request.values, &request.labels),
        )
        .await?;
    match outcome.as_str().unwrap_or("missing") {
        "ok" => {}
        "not_selectable" => {
            return Err(AppError::Conflict(
                "NOT_SELECTABLE: that element is not a `<select>`".into(),
            ));
        }
        "no_option" => {
            return Err(AppError::NotFound(
                "That `<select>` has no option with those values or labels".into(),
            ));
        }
        _ => {
            return Err(AppError::NotFound(
                "Nothing on the page matches that target".into(),
            ));
        }
    }
    let mut chosen = request.values.clone();
    chosen.extend(request.labels.clone());
    Ok(chosen)
}

/* ---------------------------------- press ---------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PressRequest {
    pub key: String,
    #[serde(default)]
    pub modifiers: u32,
    #[serde(default)]
    pub repeat: u32,
    #[serde(default)]
    pub target: TargetRef,
}

/// One key, dispatched as a `keyDown` / `keyUp` pair.
///
/// The whitelist is the point: a caller can press Enter or F5, and cannot
/// drive the browser's own shortcuts or synthesize a paste. Text goes through
/// `type`, which inserts it as committed composition rather than as a pretend
/// sequence of key events (§2.7).
pub async fn press(live: &Live, request: &PressRequest) -> AppResult<u32> {
    let key = named_key(request.key.trim()).ok_or_else(|| {
        AppError::BadRequest(format!(
            "Unknown key `{}`; expected one of {} or a single character",
            request.key,
            NAMED_KEYS
                .iter()
                .map(|(name, _, _)| *name)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;
    let place = live.place(&request.target)?;
    dialog_guard(live, &place.tab_id)?;
    let session = live.tab_session(&place.tab_id)?;
    let modifiers = request.modifiers & 0b1111;
    let times = request.repeat.clamp(1, 32);
    let epoch = live.navigation_epoch();
    for _ in 0..times {
        for phase in ["keyDown", "keyUp"] {
            let mut params = json!({
                "type": phase,
                "key": key.key,
                "code": key.code,
                "windowsVirtualKeyCode": key.code_point,
                "modifiers": modifiers,
            });
            // A modified key is a shortcut, not typed text: sending `text`
            // with Ctrl held is how a chord turns into a stray character.
            if phase == "keyDown" && modifiers & 0b0110 == 0 && !key.text.is_empty() {
                params["text"] = Value::String(key.text.clone());
            }
            live.call_in(&session, "Input.dispatchKeyEvent", params)
                .await?;
        }
    }
    if place.active && wait_for_epoch_change(live, epoch, Duration::from_millis(300)).await {
        settle(live).await;
        live.publish().await;
    }
    Ok(times)
}

struct KeyStroke {
    key: String,
    code: String,
    code_point: u32,
    text: String,
}

/// `(name, code, windowsVirtualKeyCode)` for everything that is not a plain
/// character. Arrow keys, editing keys, and the function row.
const NAMED_KEYS: &[(&str, &str, u32)] = &[
    ("Enter", "Enter", 13),
    ("Tab", "Tab", 9),
    ("Escape", "Escape", 27),
    ("Backspace", "Backspace", 8),
    ("Delete", "Delete", 46),
    ("ArrowUp", "ArrowUp", 38),
    ("ArrowDown", "ArrowDown", 40),
    ("ArrowLeft", "ArrowLeft", 37),
    ("ArrowRight", "ArrowRight", 39),
    ("Home", "Home", 36),
    ("End", "End", 35),
    ("PageUp", "PageUp", 33),
    ("PageDown", "PageDown", 34),
    ("F1", "F1", 112),
    ("F2", "F2", 113),
    ("F3", "F3", 114),
    ("F4", "F4", 115),
    ("F5", "F5", 116),
    ("F6", "F6", 117),
    ("F7", "F7", 118),
    ("F8", "F8", 119),
    ("F9", "F9", 120),
    ("F10", "F10", 121),
    ("F11", "F11", 122),
    ("F12", "F12", 123),
];

fn named_key(raw: &str) -> Option<KeyStroke> {
    if raw.is_empty() {
        return None;
    }
    if let Some((name, code, point)) = NAMED_KEYS
        .iter()
        .find(|(name, _, _)| name.eq_ignore_ascii_case(raw))
    {
        return Some(KeyStroke {
            key: (*name).to_owned(),
            code: (*code).to_owned(),
            code_point: *point,
            text: match *name {
                "Enter" => "\r".to_owned(),
                "Tab" => "\t".to_owned(),
                _ => String::new(),
            },
        });
    }
    let mut characters = raw.chars();
    let character = characters.next()?;
    if characters.next().is_some() {
        return None;
    }
    let code = if character.is_ascii_alphabetic() {
        format!("Key{}", character.to_ascii_uppercase())
    } else if character.is_ascii_digit() {
        format!("Digit{character}")
    } else {
        String::new()
    };
    Some(KeyStroke {
        key: character.to_string(),
        code,
        code_point: u32::from(character.to_ascii_uppercase()),
        text: character.to_string(),
    })
}

/* ---------------------------------- scroll --------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScrollRequest {
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub element_ref: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub target: TargetRef,
}

/// Scrolls by a distance, or brings one element into view.
pub async fn scroll(live: &Live, request: &ScrollRequest) -> AppResult<String> {
    if let Some(element) = match (&request.element_ref, &request.selector) {
        (Some(reference), _) => {
            let (place, index) = live.resolve_ref(reference, &request.target)?;
            Some((place, dom::by_index(index)))
        }
        (None, Some(selector)) => {
            let place = live.place(&request.target)?;
            Some((place, dom::by_selector(selector)))
        }
        (None, None) => None,
    } {
        let (place, expression) = element;
        dialog_guard(live, &place.tab_id)?;
        let value = live
            .evaluate_in(&place, &dom::scroll_into_view(&expression))
            .await?;
        if value.is_null() {
            return Err(AppError::NotFound(
                "Nothing on the page matches that target".into(),
            ));
        }
        return Ok("into-view".to_owned());
    }
    let direction = request.direction.as_deref().unwrap_or("down");
    let amount = request.amount.unwrap_or(400.0);
    let (delta_x, delta_y) = match direction {
        "down" => (0.0, amount),
        "up" => (0.0, -amount),
        "right" => (amount, 0.0),
        "left" => (-amount, 0.0),
        other => {
            return Err(AppError::BadRequest(format!(
                "Unknown scroll direction `{other}`; expected up, down, left or right"
            )));
        }
    };
    let place = live.place(&request.target)?;
    dialog_guard(live, &place.tab_id)?;
    let session = live.tab_session(&place.tab_id)?;
    // The wheel lands in the middle of the frame that was addressed, so
    // scrolling an iframe scrolls the iframe rather than the page behind it.
    let viewport = live.snapshot().viewport;
    let (dx, dy) = live.frame_offset(&place).await?;
    let (x, y) = if place.frame_id.is_empty() {
        (
            f64::from(viewport.width) / 2.0,
            f64::from(viewport.height) / 2.0,
        )
    } else {
        let size = live
            .evaluate_in(&place, dom::FRAME_VIEWPORT)
            .await
            .unwrap_or(Value::Null);
        (
            dx + size.get("width").and_then(Value::as_f64).unwrap_or(0.0) / 2.0,
            dy + size.get("height").and_then(Value::as_f64).unwrap_or(0.0) / 2.0,
        )
    };
    live.call_in(
        &session,
        "Input.dispatchMouseEvent",
        json!({
            "type": "mouseWheel",
            "x": x,
            "y": y,
            "deltaX": clamp_delta(delta_x),
            "deltaY": clamp_delta(delta_y),
            "modifiers": 0,
        }),
    )
    .await?;
    Ok(direction.to_owned())
}
