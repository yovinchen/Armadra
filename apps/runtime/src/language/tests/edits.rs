//! `WorkspaceEdit` parsing, validation and application.

use std::collections::HashMap;

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    events::{EventHub, WorkspaceEvent},
    language::{documents::Documents, edits, uri::Rewriter},
};

fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

struct Project {
    root: tempfile::TempDir,
    rewriter: Rewriter,
}

impl Project {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("a temporary project");
        // The rewriter has to hold the canonical path: on macOS a temporary
        // directory is a symlink, and a server answers with the resolved one.
        let canonical = std::fs::canonicalize(root.path()).expect("canonical root");
        let rewriter = Rewriter::new(&canonical);
        Self { root, rewriter }
    }

    fn path(&self) -> std::path::PathBuf {
        std::fs::canonicalize(self.root.path()).expect("canonical root")
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.path().join(name), text).expect("write fixture");
    }

    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.path().join(name)).expect("read fixture")
    }

    fn uri(&self, name: &str) -> String {
        self.rewriter.workspace_uri(name)
    }
}

fn replace_first_line(new_text: &str) -> serde_json::Value {
    json!([{
        "range": {
            "start": { "line": 0, "character": 0 },
            "end": { "line": 0, "character": 3 }
        },
        "newText": new_text
    }])
}

#[test]
fn an_edit_outside_the_workspace_blocks_the_whole_thing() {
    let project = Project::new();
    let edit = json!({
        "changes": {
            project.uri("a.txt"): replace_first_line("new"),
            "armadra-external:///deadbeefdeadbeef": replace_first_line("new"),
        }
    });
    // Not "skip the external file": an edit that silently does less than the
    // preview showed is worse than one that does nothing.
    let error = edits::parse(&edit, &project.rewriter).expect_err("refused");
    assert!(
        error.to_string().contains("outside the workspace"),
        "{error}"
    );
}

#[test]
fn a_file_operation_is_refused_rather_than_half_applied() {
    let project = Project::new();
    let edit = json!({
        "documentChanges": [
            { "kind": "rename", "oldUri": project.uri("a.txt"), "newUri": project.uri("b.txt") }
        ]
    });
    let error = edits::parse(&edit, &project.rewriter).expect_err("refused");
    assert!(
        error.to_string().contains("creates, renames or deletes"),
        "{error}"
    );
}

#[test]
fn edits_within_one_file_apply_against_the_original_offsets() {
    // Two edits on the same line. Applied first-to-last, the second one lands
    // in the wrong place; applied last-to-first, both are right.
    let edits = vec![
        edits::TextEdit {
            start: crate::language::documents::Position {
                line: 0,
                character: 0,
            },
            end: crate::language::documents::Position {
                line: 0,
                character: 3,
            },
            text: "AAAA".into(),
        },
        edits::TextEdit {
            start: crate::language::documents::Position {
                line: 0,
                character: 4,
            },
            end: crate::language::documents::Position {
                line: 0,
                character: 7,
            },
            text: "BBBB".into(),
        },
    ];
    assert_eq!(
        edits::apply_to_text("one two\n", &edits).as_deref(),
        Some("AAAA BBBB\n")
    );
    // A range the file does not have is refused, not clamped.
    let bad = vec![edits::TextEdit {
        start: crate::language::documents::Position {
            line: 9,
            character: 0,
        },
        end: crate::language::documents::Position {
            line: 9,
            character: 1,
        },
        text: "x".into(),
    }];
    assert_eq!(edits::apply_to_text("one\n", &bad), None);
}

#[test]
fn a_cross_file_rename_writes_both_files_and_announces_them() {
    let project = Project::new();
    project.write("a.txt", "old text\n");
    project.write("b.txt", "old other\n");
    let edit = json!({
        "changes": {
            project.uri("a.txt"): replace_first_line("new"),
            project.uri("b.txt"): replace_first_line("new"),
        }
    });
    let files = edits::parse(&edit, &project.rewriter).expect("parsed");
    assert_eq!(files.len(), 2);
    let expected = HashMap::from([
        ("a.txt".to_owned(), sha("old text\n")),
        ("b.txt".to_owned(), sha("old other\n")),
    ]);
    let events = EventHub::new();
    let mut stream = events.subscribe("ws-1");
    let result = edits::apply(&project.path(), "ws-1", &files, &expected, &events).unwrap();
    assert_eq!(result.applied.len(), 2);
    assert!(result.failed.is_empty());
    assert_eq!(project.read("a.txt"), "new text\n");
    assert_eq!(project.read("b.txt"), "new other\n");
    // Each write announces itself, which is how an open and clean editor
    // reloads — the same path an external change already takes.
    let mut changed = Vec::new();
    while let Ok(WorkspaceEvent::FileChanged { path, sha256, .. }) = stream.try_recv() {
        assert!(sha256.is_some());
        changed.push(path);
    }
    changed.sort();
    assert_eq!(changed, vec!["a.txt".to_owned(), "b.txt".to_owned()]);
}

#[test]
fn a_stale_version_stops_the_write_and_reports_how_far_it_got() {
    let project = Project::new();
    project.write("a.txt", "old text\n");
    project.write("b.txt", "old other\n");
    let edit = json!({
        "changes": {
            project.uri("a.txt"): replace_first_line("new"),
            project.uri("b.txt"): replace_first_line("new"),
        }
    });
    let files = edits::parse(&edit, &project.rewriter).expect("parsed");
    // `b.txt` changed on disk since the preview was computed.
    let expected = HashMap::from([
        ("a.txt".to_owned(), sha("old text\n")),
        ("b.txt".to_owned(), sha("something else\n")),
    ]);
    let result =
        edits::apply(&project.path(), "ws-1", &files, &expected, &EventHub::new()).unwrap();
    // Partial application is a real outcome, and the caller is told exactly
    // which half happened rather than getting a bare failure.
    assert_eq!(result.applied.len(), 1);
    assert_eq!(result.applied[0].path, "a.txt");
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].path, "b.txt");
    assert_eq!(result.failed[0].code, "conflict");
    assert_eq!(project.read("b.txt"), "old other\n");
}

#[test]
fn a_file_with_unsaved_changes_blocks_the_edit() {
    let project = Project::new();
    project.write("a.txt", "old text\n");
    let edit = json!({ "changes": { project.uri("a.txt"): replace_first_line("new") } });
    let files = edits::parse(&edit, &project.rewriter).expect("parsed");

    let mut documents = Documents::new();
    documents.open(
        "session-1",
        &project.uri("a.txt"),
        "plaintext",
        "old text\n".into(),
    );
    assert!(edits::dirty_files(&files, &documents, &project.rewriter).is_empty());

    // Once the editor has an unsaved draft, applying over it would destroy
    // work the editor is still holding.
    documents.change(
        "session-1",
        &project.uri("a.txt"),
        &[crate::language::documents::ContentChange::Full(
            "a draft\n".into(),
        )],
    );
    assert_eq!(
        edits::dirty_files(&files, &documents, &project.rewriter),
        vec!["a.txt".to_owned()]
    );
}

#[test]
fn an_edit_that_changes_nothing_or_too_much_is_refused() {
    let project = Project::new();
    assert!(edits::parse(&json!({}), &project.rewriter).is_err());
    assert!(edits::parse(&json!({ "changes": {} }), &project.rewriter).is_err());
    let many: serde_json::Map<String, serde_json::Value> = (0..edits::MAX_FILES + 1)
        .map(|index| (project.uri(&format!("f{index}.txt")), json!([])))
        .collect();
    let error =
        edits::parse(&json!({ "changes": many }), &project.rewriter).expect_err("too many files");
    assert!(error.to_string().contains("more than"), "{error}");
}
