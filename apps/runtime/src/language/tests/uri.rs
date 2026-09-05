//! Uri rewriting in both directions, field by field.
//!
//! The failure this file exists to catch is a *missing field*. A rewrite that
//! covers `textDocument.uri` and forgets `LocationLink.targetUri` does not
//! fail loudly: navigation quietly stops working, or worse, an absolute path
//! reaches the browser.

use serde_json::json;

use crate::language::uri::{Direction, Rewriter};

fn rewriter() -> Rewriter {
    Rewriter::new(std::path::Path::new("/项目/仓库"))
}

#[test]
fn a_workspace_path_survives_a_round_trip() {
    let rewriter = rewriter();
    let web = rewriter.workspace_uri("src/主.py");
    assert_eq!(web, "armadra:///src/%E4%B8%BB.py");
    let mut value = json!({ "textDocument": { "uri": web } });
    rewriter.rewrite(&mut value, Direction::ToHost);
    assert_eq!(
        value["textDocument"]["uri"],
        "file:///%E9%A1%B9%E7%9B%AE/%E4%BB%93%E5%BA%93/src/%E4%B8%BB.py"
    );
    rewriter.rewrite(&mut value, Direction::ToWeb);
    assert_eq!(value["textDocument"]["uri"], web);
    assert_eq!(rewriter.relative_of(&web).as_deref(), Some("src/主.py"));
}

#[test]
fn every_known_field_is_rewritten_not_just_the_first() {
    let rewriter = rewriter();
    let mut value = json!({
        "result": [
            { "uri": "file:///项目/仓库/a.rs", "range": {} },
            { "targetUri": "file:///项目/仓库/b.rs", "targetRange": {} },
            { "location": { "uri": "file:///项目/仓库/c.rs" } },
        ],
        "params": {
            "diagnostics": [{
                "relatedInformation": [{ "location": { "uri": "file:///项目/仓库/d.rs" } }]
            }]
        }
    });
    rewriter.rewrite(&mut value, Direction::ToWeb);
    let text = value.to_string();
    // Not one `file://` may survive anywhere in the message.
    assert!(!text.contains("file://"), "{text}");
    assert!(text.contains("armadra:///a.rs"));
    assert!(text.contains("armadra:///b.rs"));
    assert!(text.contains("armadra:///c.rs"));
    assert!(text.contains("armadra:///d.rs"));
}

#[test]
fn a_workspace_edit_rewrites_its_keys_as_well_as_its_values() {
    let rewriter = rewriter();
    let mut value = json!({
        "result": {
            "changes": { "file:///项目/仓库/a.rs": [{ "newText": "x" }] },
            "documentChanges": [
                { "textDocument": { "uri": "file:///项目/仓库/b.rs", "version": 1 }, "edits": [] }
            ]
        }
    });
    rewriter.rewrite(&mut value, Direction::ToWeb);
    // A generic value walk never sees a uri that is a *key*, which is why
    // `changes` needs its own pass.
    assert!(
        value["result"]["changes"]
            .as_object()
            .unwrap()
            .contains_key("armadra:///a.rs")
    );
    assert_eq!(
        value["result"]["documentChanges"][0]["textDocument"]["uri"],
        "armadra:///b.rs"
    );
}

#[test]
fn a_path_outside_the_root_becomes_opaque() {
    let rewriter = rewriter();
    let mut value = json!({ "uri": "file:///usr/lib/other.rs" });
    rewriter.rewrite(&mut value, Direction::ToWeb);
    let external = value["uri"].as_str().unwrap().to_owned();
    assert!(Rewriter::is_external(&external));
    // Opaque means opaque: nothing of the path is recoverable from it.
    assert!(!external.contains("usr"));
    assert!(!external.contains("other"));
    // Stable across calls, so a list the user is reading does not reshuffle.
    let mut again = json!({ "uri": "file:///usr/lib/other.rs" });
    rewriter.rewrite(&mut again, Direction::ToWeb);
    assert_eq!(again["uri"], external);
    // And it cannot be handed back in to reach the file.
    assert_eq!(rewriter.relative_of(&external), None);
    let mut back = json!({ "uri": external });
    rewriter.rewrite(&mut back, Direction::ToHost);
    assert!(!back["uri"].as_str().unwrap().starts_with("file://"));
}

#[test]
fn a_sibling_directory_is_not_inside_the_root() {
    let rewriter = Rewriter::new(std::path::Path::new("/project"));
    let mut value = json!({ "uri": "file:///project-2/secret.rs" });
    rewriter.rewrite(&mut value, Direction::ToWeb);
    assert!(Rewriter::is_external(value["uri"].as_str().unwrap()));
}

#[test]
fn other_schemes_and_prose_are_left_alone() {
    let rewriter = rewriter();
    let mut value = json!({
        "uri": "untitled:Untitled-1",
        "result": {
            // Hover markdown legitimately contains uris. Rewriting text would
            // break documentation links and could rewrite words a user typed.
            "contents": "see file:///项目/仓库/README.md for details",
        }
    });
    rewriter.rewrite(&mut value, Direction::ToWeb);
    assert_eq!(value["uri"], "untitled:Untitled-1");
    assert!(
        value["result"]["contents"]
            .as_str()
            .unwrap()
            .contains("file:///项目/仓库/README.md")
    );
}

#[test]
fn a_traversal_is_not_a_workspace_path() {
    let rewriter = rewriter();
    assert_eq!(rewriter.relative_of("armadra:///../etc/passwd"), None);
    assert_eq!(rewriter.relative_of("armadra:///"), None);
    assert_eq!(rewriter.relative_of("file:///项目/仓库/a.rs"), None);
}
