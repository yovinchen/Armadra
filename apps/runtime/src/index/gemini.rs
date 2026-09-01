//! Gemini CLI chats — `~/.gemini/tmp/<project-hash>/chats/*.json`.
//!
//! Best effort, and the thinnest of the three. Each file is one JSON document
//! (`{sessionId, projectHash, startTime, lastUpdated, messages: [...]}`), the
//! files are small — every one on this machine is under 14 KB — and the CLI
//! records only a hash of the project directory, never the directory itself.
//! So `cwd` comes back empty for gemini rows and the palette shows the title
//! alone. Nothing here is fatal: an absent `~/.gemini` yields no candidates.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::scan::{self, Candidate, Parsed};

/// The whole document has to parse, so the budget is a size limit rather than a
/// window: a chat larger than this is skipped rather than truncated into
/// invalid JSON.
const MAX_BYTES: u64 = 1024 * 1024;

pub fn root() -> PathBuf {
    crate::collab::transcript::gemini_home().join("tmp")
}

pub fn candidates(root: &Path) -> Vec<Candidate> {
    scan::collect(root, &|path| {
        path.extension()
            .is_some_and(|extension| extension == "json")
            && path
                .parent()
                .and_then(|parent| parent.file_name())
                .is_some_and(|name| name == "chats")
    })
}

pub fn parse(path: &Path) -> Option<Parsed> {
    let text = scan::read_head(path, MAX_BYTES).ok()?;
    let document = serde_json::from_str::<Value>(&text).ok()?;
    let session_id = document
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| path.file_stem()?.to_str().map(str::to_owned))?;
    Some(parse_document(session_id, &document))
}

pub fn parse_document(session_id: String, document: &Value) -> Parsed {
    let title = document
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.get("type").and_then(Value::as_str) == Some("user"))
        .find_map(|message| {
            let text = match message.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| scan::title(trimmed))
        })
        // A chat that opened and was abandoned has no user turn; the CLI's own
        // summary is the next best label.
        .or_else(|| {
            document
                .get("summary")
                .and_then(Value::as_str)
                .map(scan::title)
        })
        .unwrap_or_default();
    Parsed {
        session_id,
        title,
        // The CLI stores `projectHash`, not the path it hashes, and we have no
        // table to reverse it with.
        cwd: String::new(),
    }
}
