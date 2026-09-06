//! Reading the page: text, elements and screenshots.

use super::*;

/* ---------------------------------- reads ---------------------------------- */

pub async fn read(
    live: &Live,
    mode: ReadMode,
    limit: usize,
    max_bytes: usize,
) -> AppResult<ReadResponse> {
    read_in(live, &TargetRef::default(), mode, limit, max_bytes).await
}

/// The same, in one tab and one frame. A read never needs a lease and is
/// never refused by a pending dialog: an agent that has just been told
/// `DIALOG_PENDING` has to be able to look at the page to decide (§2.4).
pub async fn read_in(
    live: &Live,
    address: &TargetRef,
    mode: ReadMode,
    limit: usize,
    max_bytes: usize,
) -> AppResult<ReadResponse> {
    let place = live.place(address)?;
    // The title lands through `Page.loadEventFired`, which can still be in
    // flight when a read arrives right after opening a session. Asking the page
    // is cheap and makes every read self-consistent.
    if place.active
        && place.frame_id.is_empty()
        && live.snapshot().title.is_empty()
        && let Ok(Value::String(title)) = live.evaluate_in(&place, dom::TITLE).await
        && !title.is_empty()
    {
        live.edit(|record| record.title = title);
    }
    let record = live.snapshot();
    let mut response = ReadResponse {
        session_id: live.session_id.clone(),
        navigation_epoch: place.epoch,
        url: record.url.clone(),
        title: record.title.clone(),
        text: String::new(),
        elements: Vec::new(),
        console: Vec::new(),
        network: Vec::new(),
        truncated: false,
    };
    if !place.active || !place.frame_id.is_empty() {
        // A read of another tab or of a frame reports that document's own
        // address, not the one in the session's header.
        if let Ok(Value::String(url)) = live.evaluate_in(&place, dom::LOCATION).await {
            response.url = url;
        }
        if let Ok(Value::String(title)) = live.evaluate_in(&place, dom::TITLE).await {
            response.title = title;
        }
    }
    match mode {
        ReadMode::Title => {
            if let Value::String(title) = live.evaluate_in(&place, dom::TITLE).await? {
                response.title = title.clone();
                if place.active && place.frame_id.is_empty() {
                    live.edit(|record| record.title = title);
                }
            }
            if let Value::String(url) = live.evaluate_in(&place, dom::LOCATION).await? {
                response.url = url;
            }
        }
        ReadMode::Text => {
            let value = live.evaluate_in(&place, dom::PAGE_TEXT).await?;
            let text = value.as_str().unwrap_or_default();
            let budget = max_bytes.clamp(1_024, MAX_TEXT_BYTES);
            let (text, truncated) = cut(text, budget);
            response.text = text;
            response.truncated = truncated;
        }
        ReadMode::Elements => {
            let limit = limit.clamp(1, MAX_ELEMENTS);
            let value = live.evaluate_in(&place, &dom::elements(limit)).await?;
            let raw = value.as_array().cloned().unwrap_or_default();
            response.truncated = raw.len() >= limit;
            live.remember_elements(&place, raw.len());
            response.elements = raw
                .iter()
                .map(|item| element_from(item, &place, true))
                .collect();
            // Reading the page means reading what is on it, iframes included.
            // Each frame's elements come back with their own address in the
            // reference, so clicking one needs nothing else (§2.2).
            if place.frame_id.is_empty() {
                let spent = response.elements.len();
                let (nested, cut) = read_frames(live, &place, limit.saturating_sub(spent)).await;
                response.elements.extend(nested);
                response.truncated = response.truncated || cut;
            }
        }
        ReadMode::Links => {
            let limit = limit.clamp(1, MAX_ELEMENTS);
            let value = live.evaluate_in(&place, &dom::links(limit)).await?;
            let raw = value.as_array().cloned().unwrap_or_default();
            response.truncated = raw.len() >= limit;
            // Links get no element reference: a link is clicked either through
            // an `elements` read (anchors are in it) or by navigating to the
            // href this read already reports. Handing out a reference that
            // `click` would reject would be worse than handing out none.
            response.elements = raw
                .iter()
                .map(|item| element_from(item, &place, false))
                .collect();
        }
        ReadMode::Console => {
            let rings = live
                .rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let limit = limit.clamp(1, RING_CAPACITY);
            response.truncated = rings.console.len() > limit;
            response.console = rings
                .console
                .iter()
                .rev()
                .take(limit)
                .rev()
                .cloned()
                .collect();
        }
        ReadMode::Network => {
            let rings = live
                .rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let limit = limit.clamp(1, RING_CAPACITY);
            response.truncated = rings.network.len() > limit;
            response.network = rings
                .network
                .iter()
                .rev()
                .take(limit)
                .rev()
                .map(|(_, entry)| entry.clone())
                .collect();
        }
    }
    Ok(response)
}

/// Every child frame of one tab, read in turn. A frame that will not answer
/// is skipped rather than failing the whole read: one broken advert must not
/// make the page unreadable.
async fn read_frames(live: &Live, main: &Place, mut budget: usize) -> (Vec<Element>, bool) {
    if budget == 0 {
        return (Vec::new(), true);
    }
    let mut out = Vec::new();
    let mut truncated = false;
    for frame_id in live.frame_ids(&main.tab_id) {
        let address = TargetRef {
            tab_id: main.tab_id.clone(),
            frame_id: frame_id.clone(),
        };
        let Ok(place) = live.place(&address) else {
            continue;
        };
        let Ok(value) = live.evaluate_in(&place, &dom::elements(budget)).await else {
            continue;
        };
        let raw = value.as_array().cloned().unwrap_or_default();
        live.remember_elements(&place, raw.len());
        // The coordinates a caller sees are the tab's, so a frame's elements
        // are reported where they actually are on the picture.
        let (dx, dy) = live.frame_offset(&place).await.unwrap_or((0.0, 0.0));
        for item in &raw {
            let mut element = element_from(item, &place, true);
            element.x += dx;
            element.y += dy;
            out.push(element);
        }
        budget = budget.saturating_sub(raw.len());
        if budget == 0 {
            truncated = true;
            break;
        }
    }
    (out, truncated)
}

pub(super) fn element_from(item: &Value, place: &Place, referenceable: bool) -> Element {
    let index = item.get("index").and_then(Value::as_u64).unwrap_or(0);
    let number = |key: &str| item.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Element {
        element_ref: if referenceable {
            targets::format_ref(place, place.epoch, index)
        } else {
            String::new()
        },
        role: text("role"),
        name: text("name"),
        value: text("value"),
        selector: String::new(),
        visible: item
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
        tab_id: if place.active && place.frame_id.is_empty() {
            String::new()
        } else {
            place.tab_id.clone()
        },
        frame_id: place.frame_id.clone(),
    }
}

/// Cuts at a character boundary and reports whether anything was lost.
pub(super) fn cut(value: &str, budget: usize) -> (String, bool) {
    if value.len() <= budget {
        return (value.to_owned(), false);
    }
    let mut end = budget;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

/* --------------------------------- capture --------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default)]
    pub full_page: bool,
    #[serde(default)]
    pub format: Option<String>,
}

pub async fn capture(
    live: &Live,
    workspace: &Workspace,
    request: &CaptureRequest,
) -> AppResult<Capture> {
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only, so a screenshot cannot be saved".into(),
        ));
    }
    let format = match request.format.as_deref() {
        Some("jpeg") => "jpeg",
        _ => "png",
    };
    let result = live
        .call(
            "Page.captureScreenshot",
            json!({
                "format": format,
                "captureBeyondViewport": request.full_page,
                "optimizeForSpeed": false,
            }),
        )
        .await?;
    let encoded = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Conflict("The browser returned no image".into()))?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| AppError::Conflict("The browser returned an unreadable image".into()))?;
    let root = Path::new(&workspace.root_path);
    let directory = crate::browser::capture_dir(root);
    std::fs::create_dir_all(&directory)?;
    let name = format!(
        "{}-{}.{format}",
        live.session_id,
        Utc::now().format("%Y%m%dT%H%M%S%3fZ")
    );
    std::fs::write(directory.join(&name), &bytes)?;
    let record = live.snapshot();
    Ok(Capture {
        path: format!(".armadra/browser/{name}"),
        width: record.viewport.width,
        height: record.viewport.height,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        navigation_epoch: record.navigation_epoch,
    })
}
