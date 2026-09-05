//! The proxy against a real child process (`tools/probes/mock-lsp.mjs`).
//!
//! These are not unit tests of a fake: a Node process is started, framed
//! JSON-RPC crosses a pipe, and the assertions are about what a browser
//! session would actually receive. The mock exists because the branches worth
//! testing — a crash, a hang, an answer past the ceiling — are ones a real
//! server reaches only by accident.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{
    events::EventHub,
    language::{
        ServerState, jsonrpc,
        mux::{Hub, Sink},
        server::Launch,
        session,
    },
};

pub struct Harness {
    pub hub: Arc<Hub>,
    /// Held, not read: the server's working directory must outlive it, and
    /// dropping the handle would delete the directory out from under a running
    /// process.
    #[allow(dead_code)]
    pub root: tempfile::TempDir,
    inboxes: std::collections::HashMap<String, mpsc::UnboundedReceiver<Vec<u8>>>,
}

impl Harness {
    pub async fn start(extra: &[&str]) -> Option<Self> {
        let node = crate::agent::resolve_command("node")?;
        let root = tempfile::tempdir().ok()?;
        let mut args = vec![
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tools/probes/mock-lsp.mjs")
                .to_string_lossy()
                .into_owned(),
        ];
        args.extend(extra.iter().map(|value| (*value).to_owned()));
        let hub = Hub::new(
            "ws-1",
            "markdown",
            root.path().to_path_buf(),
            Launch {
                server_id: "mock-lsp".into(),
                executable: node,
                args,
                root: root.path().to_path_buf(),
                initialization_options: None,
            },
            EventHub::new(),
        );
        Some(Self {
            hub,
            root,
            inboxes: std::collections::HashMap::new(),
        })
    }

    pub fn join(&mut self, session_id: &str, allow_write: bool) {
        let (outbox, inbox) = mpsc::unbounded_channel();
        self.hub.lock().sessions.insert(
            session_id.to_owned(),
            Sink {
                client_id: session_id.to_owned(),
                allow_write,
                outbox,
                in_flight: 0,
            },
        );
        self.inboxes.insert(session_id.to_owned(), inbox);
    }

    pub fn send(&self, session_id: &str, message: &Value) {
        let body = serde_json::to_vec(message).unwrap();
        session::handle(&self.hub, session_id, &body);
    }

    /// The next message this session receives that matches, within a deadline.
    pub async fn expect(
        &mut self,
        session_id: &str,
        matches: impl Fn(&Value) -> bool,
    ) -> Option<Value> {
        let inbox = self.inboxes.get_mut(session_id)?;
        let deadline = std::time::Duration::from_secs(15);
        tokio::time::timeout(deadline, async {
            while let Some(body) = inbox.recv().await {
                let Ok(value) = serde_json::from_slice::<Value>(&body) else {
                    continue;
                };
                if matches(&value) {
                    return Some(value);
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    }

    pub fn quiet(&mut self, session_id: &str) -> bool {
        self.inboxes
            .get_mut(session_id)
            .is_some_and(|inbox| inbox.try_recv().is_err())
    }
}

fn is_response(id: &str) -> impl Fn(&Value) -> bool + '_ {
    move |value| value.get("id").map(id_text).as_deref() == Some(id)
}

fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn diagnostics_for(uri: &str) -> impl Fn(&Value) -> bool + '_ {
    move |value| {
        value.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
            && value
                .get("params")
                .and_then(|params| params.get("uri"))
                .and_then(Value::as_str)
                == Some(uri)
    }
}

fn did_open(uri: &str, text: &str) -> Value {
    jsonrpc::notification(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": uri, "languageId": "markdown", "version": 1, "text": text } }),
    )
}

#[tokio::test]
async fn diagnostics_reach_every_session_with_relative_uris() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("a", true);
    harness.join("b", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    assert_eq!(harness.hub.lock().state, ServerState::Running);

    harness.send("a", &did_open("armadra:///notes.md", "line\nTODO here\n"));
    // Both sessions get the diagnostics, because they belong to the document
    // and not to whoever opened it.
    for who in ["a", "b"] {
        let published = harness
            .expect(who, diagnostics_for("armadra:///notes.md"))
            .await
            .unwrap_or_else(|| panic!("{who} received diagnostics"));
        let diagnostics = published["params"]["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1);
        // Nothing absolute reaches a session, ever.
        assert!(!published.to_string().contains("file://"));
    }

    // The second session opening the same file must not open it twice: the
    // server holds one buffer, and a second didOpen would be a protocol error.
    harness.send("b", &did_open("armadra:///notes.md", "line\nTODO here\n"));
    assert_eq!(harness.hub.lock().documents.len(), 1);
}

#[tokio::test]
async fn two_sessions_using_the_same_request_id_get_their_own_answers() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("a", true);
    harness.join("b", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("armadra:///notes.md", "alpha beta\n"));
    let _ = harness
        .expect("a", diagnostics_for("armadra:///notes.md"))
        .await;

    // Both sessions send id 1. Without a per-session namespace the second
    // answer would be delivered to the first session.
    for who in ["a", "b"] {
        harness.send(
            who,
            &jsonrpc::request(
                &json!(1),
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": "armadra:///notes.md" },
                    "position": { "line": 0, "character": 1 }
                }),
            ),
        );
    }
    for who in ["a", "b"] {
        let answer = harness
            .expect(who, is_response("1"))
            .await
            .unwrap_or_else(|| panic!("{who} received its own answer"));
        // The id the client used comes back, not the namespaced one.
        assert_eq!(answer["id"], json!(1));
        assert_eq!(answer["result"]["contents"], "alpha");
    }
}

#[tokio::test]
async fn a_session_cannot_cancel_another_sessions_request() {
    let Some(mut harness) = Harness::start(&["--hang"]).await else {
        return;
    };
    harness.join("a", true);
    harness.join("b", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("armadra:///notes.md", "alpha\n"));
    let _ = harness
        .expect("a", diagnostics_for("armadra:///notes.md"))
        .await;
    harness.send(
        "a",
        &jsonrpc::request(
            &json!(1),
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "position": { "line": 0, "character": 1 }
            }),
        ),
    );
    // Session `b` guesses the id — both sessions count from 1, so guessing is
    // trivial — and asks for it to be cancelled.
    harness.send(
        "b",
        &jsonrpc::notification("$/cancelRequest", json!({ "id": 1 })),
    );
    // `a`'s request is still outstanding: the cancel named an id that is not
    // `b`'s, and ids are namespaced precisely so that is checkable.
    assert_eq!(harness.hub.lock().pending.len(), 1);
    let pending = harness
        .hub
        .lock()
        .pending
        .values()
        .next()
        .unwrap()
        .session_id
        .clone();
    assert_eq!(pending, "a");

    // The owner's own cancel does take effect.
    harness.send(
        "a",
        &jsonrpc::notification("$/cancelRequest", json!({ "id": 1 })),
    );
    assert!(harness.hub.lock().pending.is_empty());
}

#[tokio::test]
async fn an_answer_past_the_ceiling_becomes_an_error_for_the_session_that_asked() {
    let Some(mut harness) = Harness::start(&["--big-response"]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("armadra:///notes.md", "alpha\n"));
    let _ = harness
        .expect("a", diagnostics_for("armadra:///notes.md"))
        .await;
    harness.send(
        "a",
        &jsonrpc::request(
            &json!(4),
            "textDocument/hover",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "position": { "line": 0, "character": 1 }
            }),
        ),
    );
    let answer = harness
        .expect("a", is_response("4"))
        .await
        .expect("the session is told, rather than left waiting");
    assert_eq!(answer["error"]["code"], jsonrpc::REQUEST_FAILED);
    assert!(answer.get("result").is_none());
}

#[tokio::test]
async fn a_read_only_workspace_cannot_rename() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("reader", false);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("reader", &did_open("armadra:///notes.md", "old text\n"));
    let _ = harness
        .expect("reader", diagnostics_for("armadra:///notes.md"))
        .await;
    harness.send(
        "reader",
        &jsonrpc::request(
            &json!(9),
            "textDocument/rename",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "position": { "line": 0, "character": 0 },
                "newName": "new"
            }),
        ),
    );
    let answer = harness.expect("reader", is_response("9")).await.unwrap();
    assert_eq!(answer["error"]["code"], jsonrpc::METHOD_NOT_FOUND);
    // Nothing was sent to the server, so nothing is outstanding.
    assert!(harness.hub.lock().pending.is_empty());
}

#[tokio::test]
async fn locations_outside_the_workspace_are_opaque_and_commands_are_dropped() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send("a", &did_open("armadra:///notes.md", "alpha\n"));
    let _ = harness
        .expect("a", diagnostics_for("armadra:///notes.md"))
        .await;

    harness.send(
        "a",
        &jsonrpc::request(
            &json!(2),
            "textDocument/definition",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "position": { "line": 0, "character": 0 }
            }),
        ),
    );
    let answer = harness.expect("a", is_response("2")).await.unwrap();
    let text = answer.to_string();
    assert!(text.contains("armadra:///notes.md"));
    // The second location is `/usr/lib/elsewhere.txt`. The session may learn
    // that it is outside the workspace; it may not learn where it is.
    assert!(text.contains("armadra-external:///"), "{text}");
    assert!(!text.contains("usr"), "{text}");
    assert!(!text.contains("elsewhere"), "{text}");

    harness.send(
        "a",
        &jsonrpc::request(
            &json!(3),
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": "armadra:///notes.md" },
                "range": {
                    "start": { "line": 0, "character": 0 },
                    "end": { "line": 0, "character": 1 }
                },
                "context": { "diagnostics": [] }
            }),
        ),
    );
    let answer = harness.expect("a", is_response("3")).await.unwrap();
    let actions = answer["result"].as_array().unwrap();
    // A command-only action would need `workspace/executeCommand` to apply, so
    // it is removed here rather than offered and then refused on click.
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["title"], "with edit");
}

#[tokio::test]
async fn a_server_initiated_request_is_answered_by_the_host_not_the_browser() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    // The mock sends `workspace/configuration` right after `initialize`. It
    // must never appear on a session's socket: the browser is not the client
    // and cannot answer for a server it does not own.
    harness.send("a", &did_open("armadra:///notes.md", "alpha\n"));
    let _ = harness
        .expect("a", diagnostics_for("armadra:///notes.md"))
        .await;
    assert!(
        harness.quiet("a"),
        "a server-initiated request reached the browser"
    );
}

#[tokio::test]
async fn a_session_gets_its_initialize_answered_from_cache() {
    let Some(mut harness) = Harness::start(&[]).await else {
        return;
    };
    harness.join("a", true);
    harness.hub.ensure_started().await.expect("mock-lsp starts");
    harness.send(
        "a",
        &jsonrpc::request(&json!(0), "initialize", json!({ "capabilities": {} })),
    );
    let answer = harness.expect("a", is_response("0")).await.unwrap();
    assert_eq!(answer["result"]["capabilities"]["hoverProvider"], true);
    // A session shutting down does not shut down a server other sessions are
    // still using.
    harness.send("a", &jsonrpc::request(&json!(99), "shutdown", Value::Null));
    let _ = harness.expect("a", is_response("99")).await.unwrap();
    assert_eq!(harness.hub.lock().state, ServerState::Running);
}
