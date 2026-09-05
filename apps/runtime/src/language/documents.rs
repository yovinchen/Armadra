//! Shadow documents — one copy of every open file, on the execution host
//! (design §2.2 `documents`, §2.5).
//!
//! ## Why the host keeps the text at all
//!
//! Because the server has to be restartable without the editor noticing. When
//! a server is idle-stopped or crashes, the Manager replays `didOpen` for
//! every shadow document; if the text lived only in the browser, a restart
//! would need a round trip per open file and would lose anything typed in
//! between.
//!
//! ## Versions are the host's, not the client's
//!
//! Two browser tabs on the same file both count from 1. The server must see
//! one monotonic sequence, so the host assigns the version it forwards and
//! never passes the client's through.
//!
//! ## One owner per uri
//!
//! `open-editor.ts` already reuses an editor for a path, so a second view is
//! something the user asked for. The first session to open a uri owns it, and
//! only the owner's edits become `didChange` — two independent drafts of the
//! same buffer cannot both be the truth. When the owner closes, ownership
//! moves to the earliest remaining session and the text is re-sent in full.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

/// One open file as the execution host sees it.
#[derive(Debug, Clone)]
pub struct Document {
    pub uri: String,
    pub language_id: String,
    pub text: String,
    /// The version last sent to the server. Starts at 1 and only grows.
    pub version: i64,
    /// Sessions that have this uri open, in the order they opened it.
    pub readers: Vec<String>,
    /// The digest of the text as it was last read from or written to disk.
    /// `None` once the buffer has diverged from the file.
    pub disk_sha256: Option<String>,
}

impl Document {
    pub fn owner(&self) -> Option<&str> {
        self.readers.first().map(String::as_str)
    }

    pub fn sha256(&self) -> String {
        format!("{:x}", Sha256::digest(self.text.as_bytes()))
    }

    /// Whether the buffer still matches what is on disk. A `WorkspaceEdit`
    /// only applies to files that do.
    pub fn is_clean(&self) -> bool {
        self.disk_sha256
            .as_ref()
            .is_some_and(|disk| *disk == self.sha256())
    }
}

/// What opening a document means for the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenOutcome {
    /// First reader: the server must be told `didOpen`.
    Opened { version: i64 },
    /// Another session already has it open; only the reference count moved.
    Followed { owner: String },
}

#[derive(Debug, Default)]
pub struct Documents {
    open: HashMap<String, Document>,
}

impl Documents {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, uri: &str) -> Option<&Document> {
        self.open.get(uri)
    }

    pub fn len(&self) -> usize {
        self.open.len()
    }

    pub fn is_empty(&self) -> bool {
        self.open.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Document> {
        self.open.values()
    }

    /// Registers one session's view of a uri.
    pub fn open(
        &mut self,
        session_id: &str,
        uri: &str,
        language_id: &str,
        text: String,
    ) -> OpenOutcome {
        if let Some(document) = self.open.get_mut(uri) {
            if !document.readers.iter().any(|reader| reader == session_id) {
                document.readers.push(session_id.to_owned());
            }
            let owner = document.owner().unwrap_or_default().to_owned();
            if owner != session_id {
                return OpenOutcome::Followed { owner };
            }
            return OpenOutcome::Opened {
                version: document.version,
            };
        }
        let disk = format!("{:x}", Sha256::digest(text.as_bytes()));
        self.open.insert(
            uri.to_owned(),
            Document {
                uri: uri.to_owned(),
                language_id: language_id.to_owned(),
                text,
                version: 1,
                readers: vec![session_id.to_owned()],
                disk_sha256: Some(disk),
            },
        );
        OpenOutcome::Opened { version: 1 }
    }

    /// Applies a `didChange` from `session_id`.
    ///
    /// Returns the new host version, or `None` when the session is not the
    /// owner — a follower's edits are simply not the document, and saying so
    /// with `None` keeps that decision in one place.
    pub fn change(
        &mut self,
        session_id: &str,
        uri: &str,
        changes: &[ContentChange],
    ) -> Option<i64> {
        let document = self.open.get_mut(uri)?;
        if document.owner() != Some(session_id) {
            return None;
        }
        for change in changes {
            match change {
                ContentChange::Full(text) => document.text = text.clone(),
                ContentChange::Range {
                    start,
                    end,
                    text,
                    range_length: _,
                } => {
                    let Some((from, to)) = offsets(&document.text, *start, *end) else {
                        // An unusable range means the shadow text and the
                        // client's have diverged; taking the change anyway
                        // would corrupt both. Refusing keeps the shadow equal
                        // to *some* real state until the next full sync.
                        return None;
                    };
                    document.text.replace_range(from..to, text);
                }
            }
        }
        document.version += 1;
        Some(document.version)
    }

    /// Replaces the whole text — used after an external change is reloaded and
    /// after ownership moves.
    pub fn replace(&mut self, uri: &str, text: String, disk_sha256: Option<String>) -> Option<i64> {
        let document = self.open.get_mut(uri)?;
        document.text = text;
        document.version += 1;
        if disk_sha256.is_some() {
            document.disk_sha256 = disk_sha256;
        }
        Some(document.version)
    }

    /// Drops one session's view.
    ///
    /// The three outcomes are different instructions for the caller, which is
    /// why they are not collapsed into a boolean.
    pub fn close(&mut self, session_id: &str, uri: &str) -> CloseOutcome {
        let Some(document) = self.open.get_mut(uri) else {
            return CloseOutcome::Unknown;
        };
        let was_owner = document.owner() == Some(session_id);
        document.readers.retain(|reader| reader != session_id);
        if document.readers.is_empty() {
            self.open.remove(uri);
            return CloseOutcome::Closed;
        }
        if was_owner {
            document.version += 1;
            return CloseOutcome::OwnerMoved {
                owner: document.readers[0].clone(),
                version: document.version,
                text: document.text.clone(),
            };
        }
        CloseOutcome::StillOpen
    }

    /// Everything one session had open, for a disconnect.
    pub fn uris_for(&self, session_id: &str) -> Vec<String> {
        self.open
            .values()
            .filter(|document| document.readers.iter().any(|reader| reader == session_id))
            .map(|document| document.uri.clone())
            .collect()
    }

    /// Records that the file on disk now matches the buffer (a save landed).
    pub fn note_saved(&mut self, uri: &str, sha256: String) {
        if let Some(document) = self.open.get_mut(uri) {
            document.disk_sha256 = Some(sha256);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseOutcome {
    /// Nothing was open under that uri. A duplicate `didClose`, or one for a
    /// document this session never opened.
    Unknown,
    /// Last reader: the server is told `didClose`.
    Closed,
    /// Somebody else still has it; the server is told nothing.
    StillOpen,
    /// The owner left and the earliest remaining session took over. The caller
    /// re-sends the whole text so the new owner's next incremental change has
    /// a base the server agrees with.
    OwnerMoved {
        owner: String,
        version: i64,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentChange {
    Full(String),
    Range {
        start: Position,
        end: Position,
        range_length: Option<u32>,
        text: String,
    },
}

/// An LSP position: zero-based line, and a character offset in UTF-16 code
/// units, which is what the protocol means by "character" unless a client and
/// server agreed otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

impl ContentChange {
    /// Reads the `contentChanges` array of a `didChange` notification.
    pub fn parse(params: &serde_json::Value) -> Vec<Self> {
        params
            .get("contentChanges")
            .and_then(serde_json::Value::as_array)
            .map(|changes| changes.iter().filter_map(Self::one).collect())
            .unwrap_or_default()
    }

    fn one(change: &serde_json::Value) -> Option<Self> {
        let text = change.get("text")?.as_str()?.to_owned();
        let Some(range) = change.get("range") else {
            return Some(Self::Full(text));
        };
        Some(Self::Range {
            start: position(range.get("start")?)?,
            end: position(range.get("end")?)?,
            range_length: change
                .get("rangeLength")
                .and_then(serde_json::Value::as_u64)
                .map(|length| length as u32),
            text,
        })
    }
}

fn position(value: &serde_json::Value) -> Option<Position> {
    Some(Position {
        line: value.get("line")?.as_u64()? as u32,
        character: value.get("character")?.as_u64()? as u32,
    })
}

/// The byte offset of an LSP position in some text. Shared with [`super::edits`],
/// which has to resolve the same positions against a file on disk.
pub fn byte_offset_of(text: &str, position: Position) -> Option<usize> {
    byte_offset(text, position)
}

/// Byte offsets for an LSP range, or `None` when the range names something the
/// text does not have.
fn offsets(text: &str, start: Position, end: Position) -> Option<(usize, usize)> {
    let from = byte_offset(text, start)?;
    let to = byte_offset(text, end)?;
    (from <= to && to <= text.len()).then_some((from, to))
}

/// Byte offset of an LSP position.
///
/// Lines are split on `\n`, and a `\r` is part of the line it ends, which is
/// how the protocol counts. Characters are UTF-16 code units, so a position
/// past the end of a line clamps to the line end rather than failing: clients
/// legitimately name "end of line" that way.
fn byte_offset(text: &str, position: Position) -> Option<usize> {
    let mut offset = 0usize;
    let mut line = 0u32;
    let mut remaining = text;
    while line < position.line {
        let index = remaining.find('\n')?;
        offset += index + 1;
        remaining = &remaining[index + 1..];
        line += 1;
    }
    let line_text = remaining.split('\n').next().unwrap_or(remaining);
    let mut units = 0u32;
    for (index, character) in line_text.char_indices() {
        if units >= position.character {
            return Some(offset + index);
        }
        units += character.len_utf16() as u32;
    }
    Some(offset + line_text.len())
}
