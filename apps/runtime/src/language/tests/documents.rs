//! Shadow documents: ownership, versions and incremental edits.

use crate::language::documents::{CloseOutcome, ContentChange, Documents, OpenOutcome, Position};

fn full(text: &str) -> Vec<ContentChange> {
    vec![ContentChange::Full(text.to_owned())]
}

fn range(start: (u32, u32), end: (u32, u32), text: &str) -> Vec<ContentChange> {
    vec![ContentChange::Range {
        start: Position {
            line: start.0,
            character: start.1,
        },
        end: Position {
            line: end.0,
            character: end.1,
        },
        range_length: None,
        text: text.to_owned(),
    }]
}

#[test]
fn the_first_session_to_open_a_uri_owns_it() {
    let mut documents = Documents::new();
    assert_eq!(
        documents.open("a", "armadra:///x.rs", "rust", "one".into()),
        OpenOutcome::Opened { version: 1 }
    );
    // The second session gets the document, not a second copy of it: the
    // server is told about one buffer, and both sessions read its diagnostics.
    assert_eq!(
        documents.open("b", "armadra:///x.rs", "rust", "one".into()),
        OpenOutcome::Followed {
            owner: "a".to_owned()
        }
    );
    assert_eq!(documents.len(), 1);
    assert_eq!(documents.get("armadra:///x.rs").unwrap().readers.len(), 2);
}

#[test]
fn only_the_owner_edits_the_document() {
    let mut documents = Documents::new();
    documents.open("a", "armadra:///x.rs", "rust", "one".into());
    documents.open("b", "armadra:///x.rs", "rust", "one".into());
    assert_eq!(
        documents.change("a", "armadra:///x.rs", &full("two")),
        Some(2)
    );
    // A follower's edit is not the document. Taking it would leave the server
    // holding text neither session actually has.
    assert_eq!(
        documents.change("b", "armadra:///x.rs", &full("three")),
        None
    );
    assert_eq!(documents.get("armadra:///x.rs").unwrap().text, "two");
}

#[test]
fn closing_the_owner_hands_the_document_to_the_next_session() {
    let mut documents = Documents::new();
    documents.open("a", "armadra:///x.rs", "rust", "one".into());
    documents.open("b", "armadra:///x.rs", "rust", "one".into());
    documents.change("a", "armadra:///x.rs", &full("edited"));
    let outcome = documents.close("a", "armadra:///x.rs");
    let CloseOutcome::OwnerMoved {
        owner,
        version,
        text,
    } = outcome
    else {
        panic!("expected ownership to move, got {outcome:?}");
    };
    assert_eq!(owner, "b");
    assert_eq!(text, "edited");
    // The version moves too, so the full re-send the caller makes is newer
    // than everything the server has already seen.
    assert_eq!(version, 3);
    assert_eq!(
        documents.change("b", "armadra:///x.rs", &full("now mine")),
        Some(4)
    );
    assert_eq!(
        documents.close("b", "armadra:///x.rs"),
        CloseOutcome::Closed
    );
    assert!(documents.is_empty());
}

#[test]
fn a_follower_leaving_changes_nothing() {
    let mut documents = Documents::new();
    documents.open("a", "armadra:///x.rs", "rust", "one".into());
    documents.open("b", "armadra:///x.rs", "rust", "one".into());
    assert_eq!(
        documents.close("b", "armadra:///x.rs"),
        CloseOutcome::StillOpen
    );
    assert_eq!(
        documents.close("a", "armadra:///nothing.rs"),
        CloseOutcome::Unknown
    );
}

#[test]
fn incremental_edits_are_applied_in_utf16_units() {
    let mut documents = Documents::new();
    // `注` and `释` are one UTF-16 unit each; `📘` is two. A byte-offset
    // implementation gets every one of these wrong.
    documents.open(
        "a",
        "armadra:///x.md",
        "markdown",
        "注释📘尾\nsecond".into(),
    );
    documents.change("a", "armadra:///x.md", &range((0, 2), (0, 4), "X"));
    assert_eq!(
        documents.get("armadra:///x.md").unwrap().text,
        "注释X尾\nsecond"
    );
    documents.change("a", "armadra:///x.md", &range((1, 0), (1, 6), "2nd"));
    assert_eq!(
        documents.get("armadra:///x.md").unwrap().text,
        "注释X尾\n2nd"
    );
}

#[test]
fn an_unusable_range_is_refused_rather_than_guessed() {
    let mut documents = Documents::new();
    documents.open("a", "armadra:///x.rs", "rust", "one".into());
    // Line 9 does not exist. Applying "as close as possible" would corrupt the
    // shadow text and make every later incremental edit wrong.
    assert_eq!(
        documents.change("a", "armadra:///x.rs", &range((9, 0), (9, 1), "z")),
        None
    );
    assert_eq!(documents.get("armadra:///x.rs").unwrap().text, "one");
}

#[test]
fn a_document_is_clean_until_it_diverges_from_disk() {
    let mut documents = Documents::new();
    documents.open("a", "armadra:///x.rs", "rust", "one".into());
    assert!(documents.get("armadra:///x.rs").unwrap().is_clean());
    documents.change("a", "armadra:///x.rs", &full("two"));
    // A dirty buffer blocks a `WorkspaceEdit`: applying over it would destroy
    // work the editor is still holding.
    assert!(!documents.get("armadra:///x.rs").unwrap().is_clean());
    let sha = documents.get("armadra:///x.rs").unwrap().sha256();
    documents.note_saved("armadra:///x.rs", sha);
    assert!(documents.get("armadra:///x.rs").unwrap().is_clean());
}

#[test]
fn a_content_change_array_is_read_as_the_protocol_writes_it() {
    let params = serde_json::json!({
        "contentChanges": [
            { "text": "whole file" },
            {
                "range": { "start": { "line": 0, "character": 1 }, "end": { "line": 0, "character": 2 } },
                "rangeLength": 1,
                "text": "x"
            }
        ]
    });
    let changes = ContentChange::parse(&params);
    assert_eq!(changes.len(), 2);
    assert!(matches!(changes[0], ContentChange::Full(_)));
    assert!(matches!(changes[1], ContentChange::Range { .. }));
}
