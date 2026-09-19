//! Driving a browser node that lives in the Electron shell (W3.3 / W3.4).
//!
//! The division of labour is design §4.2, and it is the whole reason this
//! module is thin:
//!
//! ```text
//! armadra-hook browser <verb>
//!   -> POST /browser/{verb}       the three rules + the lease, HERE
//!   -> browser:drive              one narrow loopback WebSocket
//!        -> the shell             guest registry -> CDP allowlist -> guest
//!   <- the result, re-measured
//! ```
//!
//! **Authorization stays in the Runtime; execution moved to the shell.** The
//! interface between them is a verb, not a CDP method name — so a Runtime that
//! has been talked into something still cannot name a protocol method, and a
//! shell that has been talked into something still cannot decide who may drive.
//!
//! When no shell is connected every verb answers `browser_unavailable`. That is
//! a named absence, not a fallback: there is no second browser to quietly use
//! instead, and pretending otherwise is how an agent ends up driving a page
//! nobody is looking at.

pub mod client;
mod render;
mod session;

use std::sync::{Arc, OnceLock};

use serde_json::{Map, Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

pub use client::{Client, UNAVAILABLE, unavailable};
pub use render::render;
pub use session::{ShellSession, ensure as ensure_session};

use self::session::Sessions;

/// Everything this process holds about shell-hosted browser nodes.
pub struct ShellService {
    pub client: Option<Arc<Client>>,
    pub sessions: Sessions,
}

static SERVICE: OnceLock<Arc<ShellService>> = OnceLock::new();

/// The shell service, started on first use.
///
/// Process-wide rather than in [`AppState`] for the same reason the browser
/// service is: the drive channel is a property of how this process was started,
/// not of any one request.
pub fn service(state: &AppState) -> Arc<ShellService> {
    Arc::clone(SERVICE.get_or_init(|| {
        let client = Client::from_environment();
        let service = Arc::new(ShellService {
            client: client.clone(),
            sessions: Sessions::default(),
        });
        // `connect` spawns. A caller that built a router outside a Tokio
        // runtime gets a service with no dialler rather than a panic: it has no
        // shell to reach either way.
        if let (Some(client), Ok(_)) = (client, tokio::runtime::Handle::try_current()) {
            let events = state.events.clone();
            let pool = state.pool.clone();
            let handle = Arc::clone(&service);
            client.connect(Arc::new(move |event: Value| {
                let handle = Arc::clone(&handle);
                let events = events.clone();
                let pool = pool.clone();
                tokio::spawn(async move { on_event(&handle, &pool, &events, event).await });
            }));
        }
        service
    }))
}

/// Whether this Runtime was started by a shell at all. Distinct from
/// "connected": a shell that has not dialled back yet is still the reason the
/// old managed-Chromium path must not be taken.
pub fn configured() -> bool {
    std::env::var(client::ADDRESS_ENV).is_ok_and(|value| !value.is_empty())
}

/// Sends one already-authorized verb to the shell.
pub async fn drive(
    service: &ShellService,
    node_id: &str,
    verb: &str,
    args: Value,
) -> AppResult<Value> {
    let Some(client) = service.client.as_ref() else {
        return Err(unavailable());
    };
    client.drive(node_id, verb, args).await
}

/* --------------------------------- events --------------------------------- */

/// What the shell tells this process about, and what each fact changes.
///
/// Only two of them change state. A navigation writes `active_tab_url`, which
/// is the one column a restart needs. Human input takes the lease, which is
/// what preempts an agent — and it arrives here because the guest's own
/// `before-input-event` fires in the main process, not because anything
/// re-routes a person's keystrokes through the Runtime.
async fn on_event(
    service: &ShellService,
    pool: &sqlx::SqlitePool,
    events: &crate::events::EventHub,
    event: Value,
) {
    let name = event.get("event").and_then(Value::as_str).unwrap_or("");
    let Some(node_id) = event.get("nodeId").and_then(Value::as_str) else {
        return;
    };
    let Some(session) = service.sessions.get(node_id) else {
        // A node nobody has driven yet has no session here, and creating one
        // from an event would mean a row per guest the user merely opened.
        return;
    };
    match name {
        "navigated" => {
            if let Some(url) = event.get("url").and_then(Value::as_str) {
                session.remember_url(url).await;
            }
        }
        "humanInput" | "humanFocus" => {
            if session.human_activity("local").await.is_some() {
                // The lease left the agent. Every debugger attached to this
                // node goes with it: a lease that ends without a detach is the
                // failure the whole ownership design is written against.
                detach(service, node_id, "the user took this browser back");
            }
        }
        "control" => {
            let action = event.get("action").and_then(Value::as_str).unwrap_or("");
            match action {
                "takeover" => {
                    session.takeover("local", "").await;
                    detach(
                        service,
                        node_id,
                        "the user stopped agent control of this node",
                    );
                }
                "release" => {
                    let actor = crate::browser::session::lease::Actor::human("local", "");
                    let _ = session.release(&actor).await;
                }
                _ => {}
            }
        }
        "guestLost" => {
            // A guest that went away takes the lease with it, and the badge
            // has to stop claiming somebody is driving a page that is gone.
            let actor = crate::browser::session::lease::Actor::human("local", "");
            let _ = session.release(&actor).await;
        }
        // Both prompts ride the events the canvas already draws. Nothing here
        // reads a page's text for meaning; it is carried, bounded, and shown to
        // a person.
        "dialog" => {
            events.publish(
                &session.workspace_id,
                crate::events::WorkspaceEvent::BrowserDialog {
                    session_id: session.session_id.clone(),
                    dialog: Some(Box::new(crate::browser::Dialog {
                        dialog_id: string_of(&event, "id"),
                        tab_id: string_of(&event, "tabId"),
                        kind: crate::browser::DialogKind::parse(&string_of(&event, "kind")),
                        message: string_of(&event, "message"),
                        default_prompt: string_of(&event, "defaultPrompt"),
                        url: session.active_tab_url(),
                        opened_at: chrono::Utc::now().to_rfc3339(),
                    })),
                },
            );
        }
        "dialogClosed" => {
            events.publish(
                &session.workspace_id,
                crate::events::WorkspaceEvent::BrowserDialog {
                    session_id: session.session_id.clone(),
                    dialog: None,
                },
            );
        }
        "fileChooser" => {
            events.publish(
                &session.workspace_id,
                crate::events::WorkspaceEvent::BrowserFileChooser {
                    session_id: session.session_id.clone(),
                    chooser: Some(Box::new(crate::browser::FileChooser {
                        chooser_id: string_of(&event, "id"),
                        tab_id: string_of(&event, "tabId"),
                        frame_id: String::new(),
                        multiple: string_of(&event, "mode") == "selectMultiple",
                        accept: String::new(),
                        opened_at: chrono::Utc::now().to_rfc3339(),
                    })),
                },
            );
        }
        _ => {}
    }
    let _ = pool;
}

fn string_of(event: &Value, field: &str) -> String {
    event
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn detach(service: &ShellService, node_id: &str, reason: &str) {
    if let Some(client) = service.client.as_ref() {
        client.notify(node_id, "revoke", json!({ "reason": reason }));
    }
}

/* ---------------------------------- args ---------------------------------- */

/// Adds what only this side knows to the arguments a verb carries.
///
/// The workspace root travels because the jail that uses it lives where the
/// write happens. The Runtime supplies the root; the shell enforces the
/// boundary with `realpath`, a separator-terminated prefix comparison and an
/// `lstat` on the final segment. Neither half is sufficient alone: the shell
/// does not know which workspace a node belongs to, and this side is not the
/// process that opens the file.
pub fn with_workspace(mut args: Map<String, Value>, root: &str) -> Value {
    args.insert("workspaceRoot".into(), json!(root));
    Value::Object(args)
}

/// Turns a refusal from the drive channel into one an agent reads.
pub fn describe(error: AppError) -> String {
    error.to_string()
}
