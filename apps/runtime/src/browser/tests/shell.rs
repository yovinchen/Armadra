//! The shell route (W3.4): the half of a verb that stays in the Runtime.
//!
//! None of this needs a browser, and that is the point of the split. What is
//! tested here is what did NOT move to the shell — the argument surface, the
//! lease, the prose — plus the two refusals whose exact wording is part of the
//! design rather than incidental.

use serde_json::{Map, Value, json};

use super::support::*;
use crate::{
    browser::{
        LeaseState,
        agent::shell_args,
        session::lease::Actor,
        shell::{self, client, render},
    },
    collab::Args,
};

fn args(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

/* ------------------------------ the argument face ------------------------- */

/// The drive channel carries a closed set of named arguments per verb, not
/// whatever a caller typed. A pass-through would make the shell's verbs take
/// arbitrary input, which is the thing a verb interface exists to prevent.
#[test]
fn each_verb_sends_only_the_arguments_that_verb_has() {
    let raw = args(&[
        ("url", json!("https://example.com")),
        ("selector", json!("#go")),
        ("text", json!("hello")),
        // Not an argument of any verb. It must not reach the wire.
        ("method", json!("Runtime.evaluate")),
        ("expression", json!("document.cookie")),
    ]);
    for verb in crate::browser::agent::VERBS {
        let sent = shell_args(verb, &Args(&raw));
        assert!(
            !sent.contains_key("method") && !sent.contains_key("expression"),
            "`{verb}` forwarded something that is not one of its arguments: {sent:?}"
        );
    }
}

#[test]
fn navigate_carries_the_url_and_the_action() {
    let sent = shell_args(
        "navigate",
        &Args(&args(&[("url", json!("https://example.com/a"))])),
    );
    assert_eq!(sent["url"], json!("https://example.com/a"));
    assert_eq!(sent["action"], json!("goto"));

    // `back` and `forward` are verbs of their own as well as actions of
    // `navigate`; both spellings reach the same history walk.
    for verb in ["back", "forward"] {
        let sent = shell_args(verb, &Args(&Map::new()));
        assert_eq!(sent["action"], json!(verb));
    }
    // No url and no action is a reload, not a navigation to nowhere.
    let sent = shell_args("navigate", &Args(&Map::new()));
    assert_eq!(sent["action"], json!("reload"));
}

#[test]
fn capture_defaults_to_a_path_inside_the_workspace() {
    let sent = shell_args("capture", &Args(&Map::new()));
    let path = sent["path"].as_str().unwrap();
    assert!(
        path.starts_with(".armadra/browser/") && path.ends_with(".png"),
        "a capture with no --path still writes inside the workspace: {path}"
    );
    // The root is added separately, and it is what the shell's jail resolves
    // against. Neither half is sufficient alone.
    let payload = shell::with_workspace(sent, "/tmp/project");
    assert_eq!(payload["workspaceRoot"], json!("/tmp/project"));
}

#[test]
fn press_and_scroll_clamp_what_they_are_given() {
    let sent = shell_args(
        "press",
        &Args(&args(&[
            ("key", json!("Enter")),
            ("repeat", json!(4)),
            ("modifiers", json!(["shift", "meta"])),
        ])),
    );
    assert_eq!(sent["key"], json!("Enter"));
    assert_eq!(sent["repeat"], json!(4));
    // shift = 8, meta = 4.
    assert_eq!(sent["modifiers"], json!(12));
}

#[test]
fn read_carries_its_own_ceilings_rather_than_trusting_the_shell_to_have_some() {
    let sent = shell_args("read", &Args(&args(&[("mode", json!("map"))])));
    assert_eq!(sent["mode"], json!("map"));
    assert_eq!(sent["limit"], json!(40));
    assert_eq!(sent["maxBytes"], json!(24 * 1024));
}

/* ----------------------------- the answers -------------------------------- */

#[test]
fn a_scroll_reports_what_the_page_did_and_not_what_was_asked() {
    let line = render(
        "scroll",
        &Args(&args(&[("amount", json!(600))])),
        &json!({ "moved": 0, "position": 4_400, "extent": 4_400 }),
    );
    // The page was already at the bottom, so it moved nothing. The requested
    // 600 appears nowhere: an answer that echoes the request cannot tell the
    // reader that the page ignored them.
    assert!(line.contains("已滚动 0 px"), "{line}");
    assert!(!line.contains("600"), "{line}");
}

#[test]
fn a_map_read_reports_whether_a_field_is_filled_and_never_what_is_in_it() {
    // The shape the shell's six-element fixture produces: the password,
    // hidden, aria-hidden and display:none elements never arrive here at all
    // (the frozen reader drops them), and the two that do carry only a state.
    let line = render(
        "read",
        &Args(&Map::new()),
        &json!({
            "mode": "map",
            "url": "https://example.com/in",
            "title": "Sign in",
            "elements": [
                { "ref": "@1", "role": "input", "name": "", "detail": "password, filled" },
                { "ref": "@2", "role": "input", "name": "Email", "detail": "email, filled" },
                { "ref": "@3", "role": "input", "name": "Note", "detail": "text, empty" },
            ]
        }),
    );
    assert!(line.contains("@1 input 「」（password, filled）"), "{line}");
    assert!(line.contains("@3 input 「Note」（text, empty）"), "{line}");
    assert_eq!(line.lines().filter(|line| line.starts_with('@')).count(), 3);
}

#[test]
fn a_type_reports_a_count_and_not_the_text() {
    let line = render(
        "type",
        &Args(&args(&[("text", json!("hunter2"))])),
        &json!({ "chars": 7, "url": "https://example.com", "generation": 3 }),
    );
    assert!(line.contains("已输入 7 个字符"), "{line}");
    assert!(!line.contains("hunter2"), "{line}");
}

#[test]
fn a_capture_reports_a_path_and_a_digest_and_no_bytes() {
    let line = render(
        "capture",
        &Args(&Map::new()),
        &json!({
            "path": "/p/.armadra/browser/1.png",
            "width": 520, "height": 332, "bytes": 8_192,
            "sha256": "abc123"
        }),
    );
    assert!(line.contains("/p/.armadra/browser/1.png"), "{line}");
    assert!(line.contains("sha256 abc123"), "{line}");
    assert!(!line.contains("base64"), "{line}");
}

#[test]
fn a_click_reports_the_address_afterwards() {
    let line = render(
        "click",
        &Args(&Map::new()),
        &json!({
            "url": "https://example.com/next", "title": "Next", "generation": 4,
            "role": "button", "name": "Sign in"
        }),
    );
    assert!(line.contains("button「Sign in」"), "{line}");
    assert!(line.contains("https://example.com/next"), "{line}");
    // Never where it was on the screen.
    assert!(!line.contains("px") && !line.contains(','), "{line}");
}

/* --------------------------- codes off the wire --------------------------- */

#[test]
fn a_refusal_keeps_its_code_at_the_front_of_the_line() {
    for (code, expected_not_found) in [
        ("browser_not_drivable", true),
        ("browser_not_found", true),
        ("browser_stale_ref", false),
        ("browser_refused", false),
    ] {
        let error = client::interpret(json!({
            "id": "r1", "ok": false,
            "error": { "code": code, "message": "no" }
        }))
        .unwrap_err();
        let text = error.to_string();
        assert!(text.contains(code), "{text}");
        assert_eq!(
            matches!(error, crate::error::AppError::NotFound(_)),
            expected_not_found,
            "{code} mapped to the wrong status"
        );
    }
}

#[test]
fn an_ok_answer_is_its_result_and_nothing_else() {
    let value = client::interpret(json!({ "id": "r1", "ok": true, "result": { "a": 1 } })).unwrap();
    assert_eq!(value, json!({ "a": 1 }));
}

#[test]
fn no_shell_is_a_named_absence() {
    let text = shell::unavailable().to_string();
    assert!(text.starts_with(client::UNAVAILABLE), "{text}");
}

/* -------------------------------- the lease ------------------------------- */

/// The lease is a fact about people and agents, so it stayed in the Runtime
/// when execution moved. The table in §2.6 is the same table; only the owner
/// of the machine changed.
#[tokio::test]
async fn a_person_taking_over_revokes_the_agent_and_records_the_action_as_unknown() {
    let fixture = fixture("shell-lease").await;
    let service = shell::service(&fixture.state);
    let session = shell::ensure_session(
        &service.sessions,
        &fixture.state.pool,
        &fixture.state.events,
        &fixture.node_id,
        &fixture.workspace_id,
        "https://example.com",
    )
    .await
    .unwrap();

    let agent = Actor::agent(&fixture.agent_id, &session.session_id, "Claude");
    session.acquire(&agent).await.unwrap();
    assert_eq!(session.lease_snapshot().state, LeaseState::Agent);

    session.takeover("device-1", "我").await;
    assert_eq!(session.lease_snapshot().state, LeaseState::HumanTakeover);

    // The agent's next action is refused with LEASE_REVOKED and is not queued
    // behind the takeover: taking over is a decision, not a turn in a line.
    let refusal = session.acquire(&agent).await.unwrap_err();
    assert!(refusal.to_string().contains("LEASE_REVOKED"), "{refusal}");

    // An action already dispatched cannot be taken back, so it is recorded as
    // `unknown` rather than as something that succeeded or failed.
    let unknown = session
        .activity()
        .into_iter()
        .find(|entry| entry.outcome == "unknown")
        .expect("the revoked agent's in-flight action is recorded");
    assert_eq!(unknown.reason_code, "LEASE_REVOKED");
    assert_eq!(unknown.actor_id, fixture.agent_id);
}

#[tokio::test]
async fn a_person_clicking_into_the_page_preempts_an_agent_outright() {
    let fixture = fixture("shell-human").await;
    let service = shell::service(&fixture.state);
    let session = shell::ensure_session(
        &service.sessions,
        &fixture.state.pool,
        &fixture.state.events,
        &fixture.node_id,
        &fixture.workspace_id,
        "",
    )
    .await
    .unwrap();

    let agent = Actor::agent(&fixture.agent_id, &session.session_id, "Claude");
    session.acquire(&agent).await.unwrap();
    // This is what the shell reports from the guest's own `before-input-event`.
    // Nothing about it travels through the Runtime except the fact that it
    // happened.
    assert!(session.human_activity("local").await.is_some());
    assert_eq!(session.lease_snapshot().state, LeaseState::Human);

    // A deliberate takeover is not walked over by a later click.
    session.takeover("device-1", "我").await;
    assert!(session.human_activity("local").await.is_none());
    assert_eq!(session.lease_snapshot().state, LeaseState::HumanTakeover);
}

#[tokio::test]
async fn the_active_tab_url_has_exactly_one_writer() {
    let fixture = fixture("shell-url").await;
    let service = shell::service(&fixture.state);
    let session = shell::ensure_session(
        &service.sessions,
        &fixture.state.pool,
        &fixture.state.events,
        &fixture.node_id,
        &fixture.workspace_id,
        "https://example.com/one",
    )
    .await
    .unwrap();
    assert_eq!(session.active_tab_url(), "https://example.com/one");

    // The shell's navigation event is the writer. The canvas node's own `url`
    // is what the page draws; this column is what a restart re-navigates to,
    // and the two must not be two truths.
    session.remember_url("https://example.com/two").await;
    let stored = crate::browser::stored(&fixture.state.pool, &session.session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.active_tab_url, "https://example.com/two");
    // The process columns stay empty: under the shell there is no Chromium of
    // ours to identify, and a published migration is not edited to drop them.
    assert!(!stored.process.is_recorded());
}

/* ------------------------------ the refusals ------------------------------ */

/// A node that is not linked and a node that does not exist get the SAME
/// sentence. A refusal that told them apart would turn the verb into a probe
/// for what is on somebody else's canvas.
#[tokio::test]
async fn an_unlinked_node_and_a_missing_node_are_refused_in_the_same_words() {
    let fixture = fixture("shell-refusal").await;
    let agent = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    let caller = crate::collab::Caller {
        node: agent,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let ask = async |node: &str| {
        let args = args(&[("node", json!(node))]);
        crate::browser::agent::run(&fixture.state, &caller, "read", &Args(&args))
            .await
            .unwrap_err()
    };

    // Both of these are "not one of the browser nodes you are linked to": one
    // is a name nothing on the board has ever had, the other is a well-formed
    // node id. The answer is the SAME sentence with only the name the caller
    // gave substituted — so the reply carries back nothing the caller did not
    // already know, and cannot be used to ask whether a node exists.
    let template = |name: &str| format!("连接的浏览器节点里没有叫「{name}」的。");
    for name in [
        "no-such-node-at-all",
        "00000000-0000-0000-0000-000000000000",
        &fixture.agent_id,
    ] {
        let refusal = ask(name).await;
        assert_eq!(refusal.message, template(name));
        assert_eq!(refusal.status, axum::http::StatusCode::NOT_FOUND);
    }
}
