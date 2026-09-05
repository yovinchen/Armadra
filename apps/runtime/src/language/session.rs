//! One browser connection's view of a server (design §2.2 `session`, §2.5).
//!
//! A session is not a server. It has its own `initialize` answer (replayed
//! from the one the host already got), its own id space, its own in-flight
//! budget, and its own grants. Everything a session sends passes four gates
//! before a byte reaches the process:
//!
//!  1. **Lifecycle methods are answered here.** `initialize`, `initialized`,
//!     `shutdown` and `exit` never reach a shared server — one tab closing
//!     must not shut down another tab's language support.
//!  2. **The method allowlist** ([`super::policy`]), including the write gate.
//!  3. **Document bookkeeping**: only the owner of a uri produces `didChange`.
//!  4. **Rewriting**: `armadra:///<rel>` becomes `file://…`, and the id is
//!     renamed into this session's namespace.

use serde_json::Value;

use super::{
    MAX_IN_FLIGHT, documents::CloseOutcome, documents::ContentChange, documents::OpenOutcome,
    jsonrpc, mux::Hub, policy, uri,
};
use std::sync::Arc;

/// What a session sent, after this module is done with it.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Forwarded to the server.
    Forwarded,
    /// Answered here without touching the server.
    Answered,
    /// Deliberately dropped: a follower's edit, or a notification the server
    /// already knows about.
    Dropped,
    /// Refused; the session was told why.
    Refused,
}

/// Handles one raw JSON-RPC message from a session's socket.
pub fn handle(hub: &Arc<Hub>, session_id: &str, raw: &[u8]) -> Outcome {
    let Ok(mut message) = jsonrpc::Message::parse(raw) else {
        return Outcome::Refused;
    };
    if !super::mux::within_message_ceiling(raw) {
        refuse(
            hub,
            session_id,
            &message,
            jsonrpc::REQUEST_FAILED,
            "The request is larger than the language service accepts",
        );
        return Outcome::Refused;
    }
    match message.method.as_str() {
        "initialize" => return answer_initialize(hub, session_id, &message),
        // The host already sent `initialized`; a second one would re-announce
        // a client the server has had since it started.
        "initialized" | "exit" => return Outcome::Dropped,
        "shutdown" => {
            hub.deliver(
                session_id,
                &jsonrpc::result_response(message.id.as_ref(), Value::Null),
            );
            return Outcome::Answered;
        }
        "$/cancelRequest" => return cancel(hub, session_id, &message),
        _ => {}
    }

    let allow_write = hub
        .lock()
        .sessions
        .get(session_id)
        .is_some_and(|sink| sink.allow_write);
    if let Err(denial) = policy::check(&message.method, allow_write) {
        tracing::debug!(
            server = %hub.server_id,
            method = %message.method,
            "language method refused",
        );
        if message.kind == jsonrpc::Kind::Request {
            refuse(hub, session_id, &message, denial.code(), denial.message());
        }
        return Outcome::Refused;
    }

    match message.method.as_str() {
        "textDocument/didOpen" => return did_open(hub, session_id, &mut message),
        "textDocument/didChange" => return did_change(hub, session_id, &mut message),
        "textDocument/didClose" => return did_close(hub, session_id, &mut message),
        "textDocument/didSave" => fill_saved_text(hub, &mut message),
        _ => {}
    }

    hub.rewriter
        .rewrite(&mut message.value, uri::Direction::ToHost);
    if message.kind != jsonrpc::Kind::Request {
        hub.write(&message.value);
        return Outcome::Forwarded;
    }
    forward_request(hub, session_id, message)
}

/// The session's own `initialize` answer.
///
/// It is the server's capabilities, not a negotiation: the host already did
/// the negotiating, and a second client cannot change what the server can do.
/// Answering from cache is what makes a restart invisible to the browser.
fn answer_initialize(hub: &Arc<Hub>, session_id: &str, message: &jsonrpc::Message) -> Outcome {
    let capabilities = hub.lock().capabilities.clone();
    hub.deliver(
        session_id,
        &jsonrpc::result_response(
            message.id.as_ref(),
            serde_json::json!({
                "capabilities": capabilities,
                "serverInfo": { "name": hub.server_id, "version": "" },
            }),
        ),
    );
    Outcome::Answered
}

/// `$/cancelRequest` may only cancel this session's own request.
///
/// Ids are namespaced per session precisely so this check is possible: without
/// it, one browser tab could cancel another tab's completion by guessing a
/// number, and both tabs count from 1.
fn cancel(hub: &Arc<Hub>, session_id: &str, message: &jsonrpc::Message) -> Outcome {
    let Some(target) = message
        .value
        .get("params")
        .and_then(|params| params.get("id"))
    else {
        return Outcome::Dropped;
    };
    let wanted = match target {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let namespaced = {
        let state = hub.lock();
        state
            .pending
            .iter()
            .find(|(_, pending)| {
                pending.session_id == session_id && id_text(&pending.client_id) == wanted
            })
            .map(|(id, _)| id.clone())
    };
    let Some(namespaced) = namespaced else {
        // Not this session's request — or already answered. Either way there
        // is nothing to cancel, and forwarding it would cancel somebody else's.
        return Outcome::Dropped;
    };
    hub.lock().pending.remove(&namespaced);
    hub.write(&jsonrpc::notification(
        "$/cancelRequest",
        serde_json::json!({ "id": namespaced }),
    ));
    Outcome::Forwarded
}

fn id_text(id: &Value) -> String {
    match id {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn did_open(hub: &Arc<Hub>, session_id: &str, message: &mut jsonrpc::Message) -> Outcome {
    let Some(document) = message
        .value
        .get("params")
        .and_then(|params| params.get("textDocument"))
        .cloned()
    else {
        return Outcome::Refused;
    };
    let uri_text = document
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let language_id = document
        .get("languageId")
        .and_then(Value::as_str)
        .unwrap_or(&hub.language_id)
        .to_owned();
    let text = document
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let outcome = {
        let mut state = hub.lock();
        state.idle_since = None;
        state
            .documents
            .open(session_id, &uri_text, &language_id, text.clone())
    };
    match outcome {
        OpenOutcome::Followed { owner } => {
            tracing::debug!(server = %hub.server_id, owner = %owner, "language document followed");
            // The server already has this buffer. The follower still gets
            // diagnostics, because those are broadcast to every session.
            Outcome::Dropped
        }
        OpenOutcome::Opened { version } => {
            let host_uri = hub
                .rewriter
                .relative_of(&uri_text)
                .map(|relative| hub.rewriter.file_uri(&relative))
                .unwrap_or(uri_text);
            hub.write(&jsonrpc::notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": host_uri,
                        "languageId": language_id,
                        "version": version,
                        "text": text,
                    }
                }),
            ));
            Outcome::Forwarded
        }
    }
}

fn did_change(hub: &Arc<Hub>, session_id: &str, message: &mut jsonrpc::Message) -> Outcome {
    let Some(params) = message.value.get("params").cloned() else {
        return Outcome::Refused;
    };
    let uri_text = params
        .get("textDocument")
        .and_then(|document| document.get("uri"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let changes = ContentChange::parse(&params);
    let Some(version) = hub.lock().documents.change(session_id, &uri_text, &changes) else {
        // A follower's edit, or a range the shadow text does not have. Either
        // way this session is not the document, and forwarding it would make
        // the server's copy disagree with the owner's (design §2.5).
        return Outcome::Dropped;
    };
    hub.rewriter
        .rewrite(&mut message.value, uri::Direction::ToHost);
    if let Some(document) = message
        .value
        .get_mut("params")
        .and_then(|params| params.get_mut("textDocument"))
        .and_then(Value::as_object_mut)
    {
        // The host's version, never the client's: two tabs both count from 1.
        document.insert("version".into(), Value::from(version));
    }
    hub.write(&message.value);
    Outcome::Forwarded
}

fn did_close(hub: &Arc<Hub>, session_id: &str, message: &mut jsonrpc::Message) -> Outcome {
    let uri_text = message
        .value
        .get("params")
        .and_then(|params| params.get("textDocument"))
        .and_then(|document| document.get("uri"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let outcome = {
        let mut state = hub.lock();
        let outcome = state.documents.close(session_id, &uri_text);
        if state.documents.is_empty() {
            state.idle_since = Some(std::time::Instant::now());
        }
        outcome
    };
    let host_uri = hub
        .rewriter
        .relative_of(&uri_text)
        .map(|relative| hub.rewriter.file_uri(&relative))
        .unwrap_or(uri_text);
    match outcome {
        CloseOutcome::Closed => {
            hub.write(&jsonrpc::notification(
                "textDocument/didClose",
                serde_json::json!({ "textDocument": { "uri": host_uri } }),
            ));
            Outcome::Forwarded
        }
        // Ownership moved. The new owner's next incremental change is computed
        // against its own buffer, so the server is given that buffer in full
        // rather than being left with the departed owner's.
        CloseOutcome::OwnerMoved { version, text, .. } => {
            hub.write(&jsonrpc::notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": { "uri": host_uri, "version": version },
                    "contentChanges": [{ "text": text }],
                }),
            ));
            Outcome::Forwarded
        }
        CloseOutcome::StillOpen | CloseOutcome::Unknown => Outcome::Dropped,
    }
}

/// `didSave` with `includeText`: the text comes from the shadow document, not
/// from the client, so what the server is told matches what the host believes.
fn fill_saved_text(hub: &Arc<Hub>, message: &mut jsonrpc::Message) {
    let uri_text = message
        .value
        .get("params")
        .and_then(|params| params.get("textDocument"))
        .and_then(|document| document.get("uri"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let text = hub
        .lock()
        .documents
        .get(&uri_text)
        .map(|document| document.text.clone());
    if let (Some(text), Some(params)) = (
        text,
        message
            .value
            .get_mut("params")
            .and_then(Value::as_object_mut),
    ) && !params.contains_key("text")
    {
        params.insert("text".into(), Value::String(text));
    }
}

/// Renames the id into this session's namespace, records who is waiting, and
/// writes. The in-flight ceiling is checked here because this is the only
/// place a request is admitted.
fn forward_request(hub: &Arc<Hub>, session_id: &str, message: jsonrpc::Message) -> Outcome {
    let Some(client_id) = message.id.clone() else {
        return Outcome::Refused;
    };
    let namespaced = {
        let mut state = hub.lock();
        let Some(sink) = state.sessions.get(session_id) else {
            return Outcome::Refused;
        };
        if sink.in_flight >= MAX_IN_FLIGHT {
            drop(state);
            refuse(
                hub,
                session_id,
                &message,
                jsonrpc::REQUEST_FAILED,
                "Too many language requests are already in flight",
            );
            return Outcome::Refused;
        }
        state.sequence += 1;
        let namespaced = jsonrpc::namespaced(state.sequence, session_id);
        if let Some(sink) = state.sessions.get_mut(session_id) {
            sink.in_flight += 1;
        }
        state.pending.insert(
            namespaced.clone(),
            super::mux::Pending {
                session_id: session_id.to_owned(),
                client_id: client_id.clone(),
                method: message.method.clone(),
                sent_at: std::time::Instant::now(),
            },
        );
        namespaced
    };
    let mut value = message.value;
    if let Some(object) = value.as_object_mut() {
        object.insert("id".into(), Value::String(namespaced));
    }
    hub.write(&value);
    Outcome::Forwarded
}

fn refuse(hub: &Arc<Hub>, session_id: &str, message: &jsonrpc::Message, code: i64, text: &str) {
    if message.kind == jsonrpc::Kind::Notification {
        return;
    }
    hub.deliver(
        session_id,
        &jsonrpc::error_response(message.id.as_ref(), code, text),
    );
}
