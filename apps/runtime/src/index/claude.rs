//! Claude Code transcripts — `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/*.jsonl`.
//!
//! One file per session, named after the session id, inside a directory named
//! after the flattened project path. Sub-agent transcripts live one level
//! deeper (`<session>/subagents/*.jsonl`) and are deliberately *not* indexed:
//! they are not sessions a human resumes.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::scan::{self, Candidate, Parsed};

/// Sessions are short JSONL lines and the first user message is at the top, so
/// a small window finds it. 64 KB / 200 lines covers every local transcript.
const HEAD_BYTES: u64 = 64 * 1024;
const HEAD_LINES: usize = 200;

/// Text the CLI injects on the user's behalf. A slash command, a hook's
/// stdout or a caveat banner is not what the session is *about*, so these are
/// skipped and the next user message is tried instead.
const SYNTHETIC_PREFIXES: &[&str] = &[
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<command-name>",
    "<command-message>",
    "<task-notification>",
];

pub fn home() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| super::home().join(".claude"))
}

pub fn root() -> PathBuf {
    home().join("projects")
}

/// `<projects>/<project>/<session>.jsonl` and nothing deeper.
pub fn candidates(root: &Path) -> Vec<Candidate> {
    scan::collect(root, &|path| {
        path.extension()
            .is_some_and(|extension| extension == "jsonl")
            && path
                .parent()
                .and_then(Path::parent)
                .is_some_and(|grandparent| grandparent == root)
    })
}

pub fn parse(path: &Path) -> Option<Parsed> {
    let session_id = path.file_stem()?.to_str()?.to_owned();
    let lines = scan::read_lines(path, HEAD_BYTES, HEAD_LINES).ok()?;
    Some(parse_lines(session_id, &lines))
}

/// Split out from [`parse`] so the tests can feed it literal transcript lines.
pub fn parse_lines(session_id: String, lines: &[String]) -> Parsed {
    let mut cwd = String::new();
    let mut title = String::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Every record carries the same `cwd`; the first one that has it wins.
        if cwd.is_empty()
            && let Some(found) = record.get("cwd").and_then(Value::as_str)
        {
            cwd = found.to_owned();
        }
        if title.is_empty() && record.get("type").and_then(Value::as_str) == Some("user") {
            let text = record
                .get("message")
                .and_then(|message| message.get("content"))
                .map(user_text)
                .unwrap_or_default();
            if let Some(candidate) = usable(&text) {
                title = scan::title(candidate);
            }
        }
        if !cwd.is_empty() && !title.is_empty() {
            break;
        }
    }
    // No fallback here: an empty title is a fact the caller may need (the
    // ✦ suggest-title endpoint must not answer with a directory name), and the
    // indexer fills it in itself.
    Parsed {
        session_id,
        title,
        cwd,
    }
}

/// `content` is a plain string for a typed prompt and a block array once
/// attachments or tool results are involved. Only the text blocks matter: a
/// user turn that is nothing but a `tool_result` renders empty and is skipped.
fn user_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// `Some` when the text is a real user message rather than CLI machinery.
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

/// A session whose first message we could not read still deserves a row: it is
/// resumable, and the directory name is what the user recognises it by.
pub fn fallback_title(cwd: &str) -> String {
    scan::basename(cwd).map(scan::title).unwrap_or_default()
}
