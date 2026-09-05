//! Reading the page: text, elements and screenshots.

use super::*;

/* ---------------------------------- reads ---------------------------------- */

pub async fn read(
    live: &Live,
    mode: ReadMode,
    limit: usize,
    max_bytes: usize,
) -> AppResult<ReadResponse> {
    // The title lands through `Page.loadEventFired`, which can still be in
    // flight when a read arrives right after opening a session. Asking the page
    // is cheap and makes every read self-consistent.
    if live.snapshot().title.is_empty()
        && let Ok(Value::String(title)) = live.evaluate(dom::TITLE).await
        && !title.is_empty()
    {
        live.edit(|record| record.title = title);
    }
    let record = live.snapshot();
    let mut response = ReadResponse {
        session_id: live.session_id.clone(),
        navigation_epoch: record.navigation_epoch,
        url: record.url.clone(),
        title: record.title.clone(),
        text: String::new(),
        elements: Vec::new(),
        console: Vec::new(),
        network: Vec::new(),
        truncated: false,
    };
    match mode {
        ReadMode::Title => {
            if let Value::String(title) = live.evaluate(dom::TITLE).await? {
                response.title = title.clone();
                live.edit(|record| record.title = title);
            }
            if let Value::String(url) = live.evaluate(dom::LOCATION).await? {
                response.url = url;
            }
        }
        ReadMode::Text => {
            let value = live.evaluate(dom::PAGE_TEXT).await?;
            let text = value.as_str().unwrap_or_default();
            let budget = max_bytes.clamp(1_024, MAX_TEXT_BYTES);
            let (text, truncated) = cut(text, budget);
            response.text = text;
            response.truncated = truncated;
        }
        ReadMode::Elements => {
            let limit = limit.clamp(1, MAX_ELEMENTS);
            let value = live.evaluate(&dom::elements(limit)).await?;
            let raw = value.as_array().cloned().unwrap_or_default();
            response.truncated = raw.len() >= limit;
            *live
                .elements
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                (record.navigation_epoch, raw.len());
            response.elements = raw
                .iter()
                .map(|item| element_from(item, record.navigation_epoch, "e"))
                .collect();
        }
        ReadMode::Links => {
            let limit = limit.clamp(1, MAX_ELEMENTS);
            let value = live.evaluate(&dom::links(limit)).await?;
            let raw = value.as_array().cloned().unwrap_or_default();
            response.truncated = raw.len() >= limit;
            // Links get no element reference: a link is clicked either through
            // an `elements` read (anchors are in it) or by navigating to the
            // href this read already reports. Handing out a reference that
            // `click` would reject would be worse than handing out none.
            response.elements = raw
                .iter()
                .map(|item| element_from(item, record.navigation_epoch, ""))
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

pub(super) fn element_from(item: &Value, epoch: u64, prefix: &str) -> Element {
    let index = item.get("index").and_then(Value::as_u64).unwrap_or(0);
    let number = |key: &str| item.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Element {
        element_ref: if prefix.is_empty() {
            String::new()
        } else {
            format!("{prefix}{epoch}-{index}")
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
