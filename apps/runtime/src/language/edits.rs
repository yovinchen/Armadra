//! Applying a `WorkspaceEdit` (design §2.6, §2.3).
//!
//! A rename that touches nine files is nine saves, and the editor's existing
//! protection — every save carries the SHA-256 of what the caller read — is
//! not weakened just because a language server proposed them. So:
//!
//!  * Every path must resolve **inside** the workspace root. An external uri
//!    blocks the whole edit rather than being skipped, because an edit that
//!    silently does less than it showed is worse than one that does nothing.
//!  * Every file carries an expected version. A path absent from the map must
//!    not already exist.
//!  * An open document must be **clean**. Applying over an unsaved draft would
//!    destroy work the editor is still holding.
//!  * Writing stops at the first failure and both lists come back, so the
//!    dialog can say exactly which files changed.
//!
//! Each successful write publishes `file.changed`, which is what makes the
//! open (and clean) editors reload themselves — the same path an external
//! change already takes.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::{documents::Documents, uri::Rewriter};
use crate::{
    error::{AppError, AppResult},
    events::{EventHub, FileChangeKind, WorkspaceEvent},
    files,
};

/// Bounds from design §2.2 `edits`. A "refactor" past these is not something
/// to apply without the user having seen it file by file.
pub const MAX_FILES: usize = 50;
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedFile {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: Vec<AppliedFile>,
    pub failed: Vec<FailedFile>,
}

impl ApplyResult {
    pub fn to_proto(&self) -> armadra_protocol::v1::LanguageApplyEditResult {
        armadra_protocol::v1::LanguageApplyEditResult {
            applied: self
                .applied
                .iter()
                .map(|file| armadra_protocol::v1::LanguageAppliedFile {
                    path: file.path.clone(),
                    sha256: file.sha256.clone(),
                    size: file.size,
                })
                .collect(),
            failed: self
                .failed
                .iter()
                .map(|file| armadra_protocol::v1::LanguageFailedFile {
                    path: file.path.clone(),
                    code: file.code.clone(),
                    message: file.message.clone(),
                })
                .collect(),
        }
    }
}

/// One file's edits, already resolved to a workspace-relative path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEdits {
    pub path: String,
    pub edits: Vec<TextEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub start: super::documents::Position,
    pub end: super::documents::Position,
    pub text: String,
}

/// Reads a `WorkspaceEdit` whose uris the browser already saw.
///
/// `documentChanges` wins over `changes` when both are present, which is what
/// the spec says; a create, rename or delete operation is refused outright —
/// the first version applies text edits and nothing else, and pretending
/// otherwise would silently drop half a refactor.
pub fn parse(edit: &Value, rewriter: &Rewriter) -> Result<Vec<FileEdits>, AppError> {
    let mut files: Vec<FileEdits> = Vec::new();
    if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
        for change in changes {
            if change.get("kind").is_some() {
                return Err(AppError::BadRequest(
                    "This edit creates, renames or deletes files, which is not applied".into(),
                ));
            }
            let uri = change
                .get("textDocument")
                .and_then(|document| document.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            files.push(FileEdits {
                path: relative(uri, rewriter)?,
                edits: text_edits(change.get("edits")),
            });
        }
    } else if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            files.push(FileEdits {
                path: relative(uri, rewriter)?,
                edits: text_edits(Some(edits)),
            });
        }
        // A map has no order of its own; sorting makes the applied list, and
        // therefore the failure point, reproducible.
        files.sort_by(|left, right| left.path.cmp(&right.path));
    }
    if files.is_empty() {
        return Err(AppError::BadRequest("This edit changes nothing".into()));
    }
    if files.len() > MAX_FILES {
        return Err(AppError::BadRequest(format!(
            "This edit touches more than {MAX_FILES} files"
        )));
    }
    Ok(files)
}

fn relative(uri: &str, rewriter: &Rewriter) -> Result<String, AppError> {
    if Rewriter::is_external(uri) {
        return Err(AppError::BadRequest(
            "This edit reaches a file outside the workspace".into(),
        ));
    }
    rewriter.relative_of(uri).ok_or_else(|| {
        AppError::BadRequest("This edit names a location the workspace does not contain".into())
    })
}

fn text_edits(value: Option<&Value>) -> Vec<TextEdit> {
    value
        .and_then(Value::as_array)
        .map(|edits| {
            edits
                .iter()
                .filter_map(|edit| {
                    let range = edit.get("range")?;
                    Some(TextEdit {
                        start: position(range.get("start")?)?,
                        end: position(range.get("end")?)?,
                        text: edit.get("newText")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn position(value: &Value) -> Option<super::documents::Position> {
    Some(super::documents::Position {
        line: value.get("line")?.as_u64()? as u32,
        character: value.get("character")?.as_u64()? as u32,
    })
}

/// Applies text edits to one file's text.
///
/// Edits are applied last-first so an earlier edit's offsets stay valid: the
/// LSP spec says edits in one file must not overlap and are computed against
/// the same original document, which is exactly what reverse order preserves.
pub fn apply_to_text(original: &str, edits: &[TextEdit]) -> Option<String> {
    let mut ordered: Vec<&TextEdit> = edits.iter().collect();
    ordered.sort_by(|left, right| {
        (right.start.line, right.start.character).cmp(&(left.start.line, left.start.character))
    });
    let mut text = original.to_owned();
    for edit in ordered {
        let from = super::documents::byte_offset_of(&text, edit.start)?;
        let to = super::documents::byte_offset_of(&text, edit.end)?;
        if from > to || to > text.len() {
            return None;
        }
        text.replace_range(from..to, &edit.text);
    }
    Some(text)
}

/// The files an edit touches that have unsaved changes in an open editor.
///
/// Returned rather than silently skipped: the dialog lists them and asks the
/// user to save first, which is a decision only the user can make.
pub fn dirty_files(files: &[FileEdits], documents: &Documents, rewriter: &Rewriter) -> Vec<String> {
    files
        .iter()
        .filter(|file| {
            documents
                .get(&rewriter.workspace_uri(&file.path))
                .is_some_and(|document| !document.is_clean())
        })
        .map(|file| file.path.clone())
        .collect()
}

/// Writes every file, in order, stopping at the first failure.
///
/// The read-modify-write is deliberately not atomic across files: no
/// filesystem offers that, and pretending otherwise by rolling back would mean
/// writing every file twice. Instead the caller is told exactly how far it got.
pub fn apply(
    root: &Path,
    workspace_id: &str,
    files: &[FileEdits],
    expected: &std::collections::HashMap<String, String>,
    events: &EventHub,
) -> AppResult<ApplyResult> {
    let mut result = ApplyResult::default();
    for file in files {
        let version = expected.get(&file.path).map(String::as_str);
        let current = match files::read_text_file(root, &file.path) {
            Ok(content) => content,
            Err(error) => {
                result.failed.push(FailedFile {
                    path: file.path.clone(),
                    code: "not_readable".into(),
                    message: error.to_string(),
                });
                break;
            }
        };
        // The version the caller previewed against, checked before the edit is
        // computed rather than only at the write: an edit applied to text that
        // has since changed produces garbage, not a conflict.
        if version.is_some_and(|expected| Some(expected) != current.sha256.as_deref()) {
            result.failed.push(FailedFile {
                path: file.path.clone(),
                code: "conflict".into(),
                message: "The file changed since the preview was computed".into(),
            });
            break;
        }
        let Some(text) = apply_to_text(&current.content, &file.edits) else {
            result.failed.push(FailedFile {
                path: file.path.clone(),
                code: "invalid_range".into(),
                message: "The edit names a range the file does not have".into(),
            });
            break;
        };
        if text.len() > MAX_FILE_BYTES {
            result.failed.push(FailedFile {
                path: file.path.clone(),
                code: "too_large".into(),
                message: "The edited file is larger than the write limit".into(),
            });
            break;
        }
        match files::write_text_file(root, &file.path, &text, version, current.bom) {
            Ok(written) => {
                events.publish(
                    workspace_id,
                    WorkspaceEvent::FileChanged {
                        workspace_id: workspace_id.to_owned(),
                        path: written.path.clone(),
                        kind: FileChangeKind::Modified,
                        sha256: Some(written.sha256.clone()),
                        size: Some(written.size),
                        mtime: Some(chrono::Utc::now().to_rfc3339()),
                    },
                );
                result.applied.push(AppliedFile {
                    path: written.path,
                    sha256: written.sha256,
                    size: written.size,
                });
            }
            Err(error) => {
                result.failed.push(FailedFile {
                    path: file.path.clone(),
                    code: match error {
                        AppError::Conflict(_) => "conflict",
                        AppError::Forbidden(_) => "forbidden",
                        _ => "write_failed",
                    }
                    .into(),
                    message: error.to_string(),
                });
                break;
            }
        }
    }
    Ok(result)
}
