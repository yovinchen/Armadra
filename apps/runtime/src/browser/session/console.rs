//! Turning CDP console, log and exception payloads into ring entries.

use super::*;

pub(super) fn push_console(live: &Live, entry: Option<ConsoleEntry>) {
    let Some(entry) = entry else { return };
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if rings.console.len() >= RING_CAPACITY {
        rings.console.pop_front();
    }
    rings.console.push_back(entry);
}

/// Console arguments, flattened to text. Only previews and primitives: the
/// object graph behind a logged value is not carried anywhere.
pub(super) fn console_from_api(params: &Value) -> Option<ConsoleEntry> {
    let level = params
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("log")
        .to_owned();
    let text = params
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .take(8)
                .map(describe_remote_object)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let frame = params
        .get("stackTrace")
        .and_then(|trace| trace.get("callFrames"))
        .and_then(Value::as_array)
        .and_then(|frames| frames.first());
    Some(ConsoleEntry {
        at: Utc::now().to_rfc3339(),
        level,
        text: truncate(&text, 2_000),
        url: frame
            .and_then(|frame| frame.get("url"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line: frame
            .and_then(|frame| frame.get("lineNumber"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
    })
}

pub(super) fn describe_remote_object(value: &Value) -> String {
    if let Some(description) = value.get("description").and_then(Value::as_str) {
        return description.to_owned();
    }
    match value.get("value") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("undefined")
            .to_owned(),
    }
}

pub(super) fn console_from_exception(params: &Value) -> Option<ConsoleEntry> {
    let details = params.get("exceptionDetails")?;
    let text = details
        .get("exception")
        .and_then(|exception| exception.get("description"))
        .and_then(Value::as_str)
        .or_else(|| details.get("text").and_then(Value::as_str))
        .unwrap_or("uncaught exception");
    Some(ConsoleEntry {
        at: Utc::now().to_rfc3339(),
        level: "pageerror".into(),
        text: truncate(text, 2_000),
        url: details
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line: details
            .get("lineNumber")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
    })
}

pub(super) fn console_from_log(params: &Value) -> Option<ConsoleEntry> {
    let entry = params.get("entry")?;
    Some(ConsoleEntry {
        at: Utc::now().to_rfc3339(),
        level: entry
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("info")
            .to_owned(),
        text: truncate(
            entry
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        url: entry
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line: entry.get("lineNumber").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}
