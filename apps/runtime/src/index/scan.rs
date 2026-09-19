//! Shared plumbing for the three transcript scanners — plan §17.
//!
//! Every provider needs the same four things: a bounded list of candidate
//! files, each file's mtime and size, a bounded read of the file's head, and a
//! title that has been collapsed and cut. None of it is provider-specific, so
//! it lives here and `claude.rs` / `codex.rs` only describe the
//! shape of their own JSON.
//!
//! Everything is bounded, because these directories belong to other programs:
//! a scan walks a fixed depth, stops after [`MAX_FILES_PER_PROVIDER`] files,
//! and never reads more than the caller's head budget from any one file. A
//! surprising layout costs us a truncated index, never a hung runtime.

use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::{DateTime, Utc};

/// Per-provider ceiling on indexed files. ~1000 claude and ~1300 codex
/// transcripts on the machine this was written on; 5000 leaves room without
/// letting a pathological directory run away with the scan.
pub const MAX_FILES_PER_PROVIDER: usize = 5_000;
/// Directory depth the walk is allowed to descend from a provider's root.
const MAX_DEPTH: usize = 8;
/// Hard stop on directory entries examined, independent of how many match.
const MAX_ENTRIES: usize = 200_000;
/// Titles are one line in a palette row, not a summary.
pub const MAX_TITLE_CHARS: usize = 120;

/// A candidate transcript file: where it is, when it last changed, how big.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    /// RFC 3339, UTC — the same shape the `conversations.updated_at` column and
    /// every other timestamp in this runtime uses, so "is this row stale?" is a
    /// string comparison rather than a parse.
    pub updated_at: String,
    pub bytes: i64,
}

/// What a provider managed to read out of one file.
#[derive(Debug, Clone)]
pub struct Parsed {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
}

/// Depth-bounded walk collecting files that `matches` accepts.
///
/// `matches` receives the path so a provider can require a parent directory
/// (`chats/`) as well as a file name.
pub fn collect(root: &Path, matches: &dyn Fn(&Path) -> bool) -> Vec<Candidate> {
    let mut found = Vec::new();
    if !root.is_dir() {
        return found;
    }
    let mut frontier = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((directory, depth)) = frontier.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES || found.len() >= MAX_FILES_PER_PROVIDER {
                return found;
            }
            // `file_type` on the entry does not follow symlinks, which is what
            // keeps a link back up the tree from turning the walk into a loop.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    frontier.push((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() || !matches(&path) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            found.push(Candidate {
                path,
                updated_at: rfc3339(metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
                bytes: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
            });
        }
    }
    found
}

pub fn rfc3339(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

/// Reads the head of a JSONL file as whole lines.
///
/// Two budgets, because one is not enough. `max_bytes` is what stops a
/// multi-megabyte transcript from being read in full. `max_lines` is what makes
/// the read *useful*: codex writes its instruction preamble as two or three
/// lines that are tens of kilobytes each, so the first real user message can
/// sit 200 KB in while still being line 5. Reading by line and stopping at a
/// small line count costs the same as reading a byte window of the same size,
/// and finds four times as many titles (measured: 953 of 1280 local codex
/// sessions were untitled under a 64 KB byte window alone).
///
/// A trailing partial line is dropped rather than returned half-parsed.
pub fn read_lines(path: &Path, max_bytes: u64, max_lines: usize) -> std::io::Result<Vec<String>> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file.take(max_bytes));
    let mut lines = Vec::new();
    let mut buffer = Vec::new();
    while lines.len() < max_lines {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 {
            break;
        }
        if !buffer.ends_with(b"\n") {
            // Ran out of budget (or hit EOF) mid-line. A fragment of JSON is
            // not worth handing to the parser, so it is dropped; a file whose
            // last line has no newline loses that line, which is a transcript
            // the CLI is still writing.
            break;
        }
        lines.push(String::from_utf8_lossy(&buffer).trim().to_owned());
    }
    Ok(lines)
}

/// Reads at most `max_bytes` of a file as text — for the providers that write
/// one JSON document rather than JSONL.
pub fn read_head(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut buffer = Vec::new();
    File::open(path)?.take(max_bytes).read_to_end(&mut buffer)?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Collapses every run of whitespace to one space and trims.
pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Collapse, then cut to `max_chars` *characters* (not bytes — these titles are
/// mostly Chinese on the author's machine).
pub fn clamp(text: &str, max_chars: usize) -> String {
    let collapsed = collapse(text);
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    collapsed.chars().take(max_chars).collect()
}

/// Title as it is stored: collapsed and cut to [`MAX_TITLE_CHARS`].
pub fn title(text: &str) -> String {
    clamp(text, MAX_TITLE_CHARS)
}

/// The last path segment, used as a fallback label when a session has no
/// readable first message but does name its working directory.
pub fn basename(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\']).find(|part| !part.is_empty())
}
