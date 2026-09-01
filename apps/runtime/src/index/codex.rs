//! Codex rollouts — `${CODEX_HOME:-~/.codex}/sessions/**/rollout-*.jsonl`.
//!
//! Files are filed under `sessions/YYYY/MM/DD/` and named
//! `rollout-<timestamp>-<uuid>.jsonl`. The first record is a `session_meta`
//! carrying the id and the cwd; the turns that follow are `response_item`
//! envelopes around OpenAI-shaped messages.
//!
//! The wrinkle is that codex replays a lot of machinery *as the user*: the
//! permissions block, `AGENTS.md`, the plugin catalogue. Those come first and
//! they are large — on this machine the median real first message starts
//! ~95 KB into the file and the 99th percentile ~205 KB, all within the first
//! ten lines. Hence the line-oriented budget in [`scan::read_lines`].

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::scan::{self, Candidate, Parsed};

/// Generous byte budget, tight line budget — see the module comment.
const HEAD_BYTES: u64 = 512 * 1024;
const HEAD_LINES: usize = 24;

/// Openings that mean "codex is talking to itself". Everything codex injects
/// on the user's behalf starts with one of these, and a human message that
/// happens to start with `<` does not survive being mistaken for one often
/// enough to matter — the next user turn is used instead.
const SYNTHETIC_PREFIXES: &[&str] = &[
    "<user_instructions>",
    "<environment_context>",
    "<recommended_plugins>",
    "<permissions instructions>",
    "<INSTRUCTIONS>",
    "# AGENTS.md instructions",
];

pub fn root() -> PathBuf {
    crate::collab::transcript::codex_home().join("sessions")
}

pub fn candidates(root: &Path) -> Vec<Candidate> {
    scan::collect(root, &|path| {
        path.extension()
            .is_some_and(|extension| extension == "jsonl")
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-"))
    })
}

pub fn parse(path: &Path) -> Option<Parsed> {
    let stem = path.file_stem()?.to_str()?.to_owned();
    let lines = scan::read_lines(path, HEAD_BYTES, HEAD_LINES).ok()?;
    Some(parse_lines(&stem, &lines))
}

pub fn parse_lines(stem: &str, lines: &[String]) -> Parsed {
    let mut session_id = session_id_from_stem(stem).unwrap_or_default();
    let mut cwd = String::new();
    let mut title = String::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = record.get("payload").unwrap_or(&Value::Null);
        match kind {
            "session_meta" => {
                if session_id.is_empty()
                    && let Some(id) = payload.get("id").and_then(Value::as_str)
                {
                    session_id = id.to_owned();
                }
                if cwd.is_empty()
                    && let Some(found) = payload.get("cwd").and_then(Value::as_str)
                {
                    cwd = found.to_owned();
                }
            }
            // `turn_context` repeats the cwd; useful when the meta record was
            // written by a version that did not carry one.
            "turn_context" => {
                if cwd.is_empty()
                    && let Some(found) = payload.get("cwd").and_then(Value::as_str)
                {
                    cwd = found.to_owned();
                }
            }
            _ => {}
        }
        if title.is_empty()
            && let Some(text) = user_text(kind, payload)
            && let Some(usable) = usable(&text)
        {
            title = scan::title(usable);
        }
        if !cwd.is_empty() && !title.is_empty() && !session_id.is_empty() {
            break;
        }
    }
    if session_id.is_empty() {
        session_id = stem.to_owned();
    }
    Parsed {
        session_id,
        title,
        cwd,
    }
}

/// The user's words in this record, if it holds any.
///
/// Two shapes: the persisted conversation item (`response_item` wrapping a
/// `message` with `role: "user"`) and the UI event stream (`event_msg` /
/// `user_message`), which newer builds also write.
fn user_text(kind: &str, payload: &Value) -> Option<String> {
    match kind {
        "response_item" => {
            if payload.get("type").and_then(Value::as_str) != Some("message")
                || payload.get("role").and_then(Value::as_str) != Some("user")
            {
                return None;
            }
            Some(
                payload
                    .get("content")?
                    .as_array()?
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        }
        "event_msg" => {
            if payload.get("type").and_then(Value::as_str) != Some("user_message") {
                return None;
            }
            payload
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        _ => None,
    }
}

pub fn usable(text: &str) -> Option<&str> {
    let text = text.trim();
    if text.is_empty()
        || SYNTHETIC_PREFIXES
            .iter()
            .any(|prefix| text.starts_with(prefix))
    {
        return None;
    }
    Some(text)
}

/// `rollout-2026-09-04T02-06-15-01a06873-346b-73e1-b3b6-2224a11ce547` → the
/// trailing UUID. The timestamp in the middle also contains dashes, so the id
/// is taken as the last 36 characters and only accepted if it is shaped like a
/// UUID; anything else falls back to the `session_meta` record.
pub fn session_id_from_stem(stem: &str) -> Option<String> {
    let characters: Vec<char> = stem.chars().collect();
    if characters.len() < 36 {
        return None;
    }
    let tail: String = characters[characters.len() - 36..].iter().collect();
    uuid::Uuid::parse_str(&tail).ok().map(|_| tail)
}
