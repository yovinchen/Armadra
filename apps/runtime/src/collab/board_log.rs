//! `<workspace>/.armadra/board-log.jsonl` — the delivery trace (plan §5.7 step 10).
//!
//! Every delivery *and* every refusal is traced, because the interesting
//! question after the fact is almost always "why did nothing arrive?". The
//! message body is never written: the log records that a message of N
//! characters went from A to B and what happened to it.
//!
//! A workspace root we cannot write is not an error. The entry goes into a
//! 200-item in-memory ring instead and the reply says `traced: "memory"` so the
//! agent knows the trace is not on disk.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::CollabState;

/// How many entries the fallback ring keeps.
pub const RING_CAPACITY: usize = 200;

pub struct Trace<'a> {
    pub trace_id: &'a str,
    pub source: &'a str,
    pub target: &'a str,
    pub outcome: &'a str,
    pub receipt: Option<&'a str>,
    pub body_chars: usize,
}

/// Appends one entry and reports where it landed: `"file"` or `"memory"`.
pub fn record(
    collab: &CollabState,
    workspace_root: Option<&str>,
    trace: Trace<'_>,
) -> &'static str {
    let mut entry = json!({
        "traceId": trace.trace_id,
        "ts": chrono::Utc::now().to_rfc3339(),
        "source": trace.source,
        "target": trace.target,
        "outcome": trace.outcome,
        "receipt": trace.receipt,
        "bodyChars": trace.body_chars,
    });

    if let Some(root) = workspace_root
        && let Some(path) = log_path(Path::new(root))
        && append(&path, &entry).is_ok()
    {
        entry["traced"] = json!("file");
        return "file";
    }

    entry["traced"] = json!("memory");
    let mut ring = collab
        .ring
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if ring.len() >= RING_CAPACITY {
        ring.pop_front();
    }
    ring.push_back(entry);
    "memory"
}

/// The most recent in-memory entries, newest last. Used by the tests and by
/// nothing else — the on-disk log is the real record.
pub fn ring_snapshot(collab: &CollabState) -> Vec<Value> {
    collab
        .ring
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .cloned()
        .collect()
}

fn log_path(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let directory = root.join(".armadra");
    std::fs::create_dir_all(&directory).ok()?;
    Some(directory.join("board-log.jsonl"))
}

fn append(path: &Path, entry: &Value) -> std::io::Result<()> {
    use std::io::Write;
    let mut line = serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_owned());
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(line.as_bytes())
}
