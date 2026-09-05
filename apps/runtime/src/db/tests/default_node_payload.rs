//! The per-type node payload defaults: what each kind may and may not
//! carry.

use crate::db::{NODE_TYPES, valid_node_data};
use crate::model::{CanvasNode, DEFAULT_NODE_COLOR, Position};

fn node(node_type: &str, data: serde_json::Value) -> CanvasNode {
    CanvasNode {
        id: "n".into(),
        board_id: "b".into(),
        node_type: node_type.into(),
        title: "t".into(),
        color: DEFAULT_NODE_COLOR.into(),
        position: Position { x: 0.0, y: 0.0 },
        size: None,
        collapsed: None,
        expanded_height: None,
        parent_id: None,
        labels: Vec::new(),
        note: String::new(),
        data,
        created_at: "2026-09-02T00:00:00+00:00".into(),
        updated_at: "2026-09-02T00:00:00+00:00".into(),
    }
}

/// Mirrors the node defaults in apps/web: every palette entry must be
/// saveable before the user types anything.
#[test]
fn palette_defaults_are_valid() {
    let cases = [
        ("terminal", serde_json::json!({ "kind": "terminal" })),
        (
            "sticky",
            serde_json::json!({ "kind": "sticky", "content": "" }),
        ),
        ("group", serde_json::json!({ "kind": "group" })),
        (
            "editor",
            serde_json::json!({ "kind": "editor", "path": "src/App.tsx" }),
        ),
        (
            "diff",
            serde_json::json!({ "kind": "diff", "repoPath": ".", "scope": "worktree" }),
        ),
        ("files", serde_json::json!({ "kind": "files", "path": "." })),
        (
            "browser",
            serde_json::json!({ "kind": "browser", "url": "" }),
        ),
        (
            "automation",
            serde_json::json!({
                "kind": "automation",
                "planId": "plan-1",
                "planWorkspaceId": "workspace-1",
                "executionHostId": "0123456789abcdef0123456789abcdef",
                "scheduleKind": "cron",
                "timezone": "Asia/Shanghai"
            }),
        ),
        (
            "agentActivity",
            serde_json::json!({
                "kind": "agentActivity",
                "sourceNodeId": "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
                "source": "loop"
            }),
        ),
    ];
    assert_eq!(cases.len(), NODE_TYPES.len());
    for (node_type, data) in cases {
        assert!(
            valid_node_data(&node(node_type, data)),
            "{node_type} default rejected"
        );
    }
}

/// The two Host-owned cards keep separate shapes on purpose: neither may be
/// saved with the other's payload, so one can never drift into the other.
#[test]
fn automation_and_activity_payloads_do_not_substitute_for_each_other() {
    let automation = serde_json::json!({
        "kind": "automation",
        "planId": "plan-1",
        "planWorkspaceId": "workspace-1",
        "executionHostId": "0123456789abcdef0123456789abcdef"
    });
    let activity = serde_json::json!({
        "kind": "agentActivity",
        "sourceNodeId": "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21"
    });
    assert!(!valid_node_data(&node("automation", activity.clone())));
    assert!(!valid_node_data(&node("agentActivity", automation.clone())));
    // A plan reference with no Host binding is not a plan reference.
    let mut orphan = automation.clone();
    orphan["executionHostId"] = serde_json::json!("");
    assert!(!valid_node_data(&node("automation", orphan)));
    // An observation card must name a real node, never a free-text title.
    let mut untitled = activity.clone();
    untitled["sourceNodeId"] = serde_json::json!("nightly build");
    assert!(!valid_node_data(&node("agentActivity", untitled)));
    let mut unknown = automation;
    unknown["scheduleKind"] = serde_json::json!("whenever");
    assert!(!valid_node_data(&node("automation", unknown)));
}

/// The reserved account binding (S02) is optional and bounded. A node
/// without it stays valid, which is why nothing in the UI shows a binding
/// control today.
#[test]
fn reserved_account_binding_is_optional_and_bounded() {
    let with = |account: serde_json::Value| {
        node(
            "terminal",
            serde_json::json!({ "kind": "terminal", "agent": { "id": "claude", "account": account } }),
        )
    };
    assert!(valid_node_data(&node(
        "terminal",
        serde_json::json!({ "kind": "terminal", "agent": { "id": "claude" } })
    )));
    assert!(valid_node_data(&with(serde_json::json!({
        "accountId": "default",
        "providerId": "claude",
        "label": "工作账号",
        "credentialRef": "keychain://armadra/claude/default",
    }))));
    assert!(valid_node_data(&with(
        serde_json::json!({ "accountId": "default" })
    )));
    // An account without an id, or an oversized reference, is not storable.
    assert!(!valid_node_data(&with(serde_json::json!({}))));
    assert!(!valid_node_data(&with(
        serde_json::json!({ "accountId": "" })
    )));
    assert!(!valid_node_data(&with(
        serde_json::json!({ "accountId": "default", "credentialRef": "x".repeat(201) })
    )));
}
