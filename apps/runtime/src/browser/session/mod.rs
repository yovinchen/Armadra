//! One live browser session: its process, its CDP connection, its event pump
//! and every operation the API and the agent verb are allowed to perform.
//!
//! Locking rule for this file: a `std::sync::Mutex` guard is never held across
//! an `.await`. Every operation reads what it needs, drops the guard, then
//! talks to the browser.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::process::Child;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    model::Workspace,
};

use super::{
    BrowserSession, Capture, ConsoleEntry, Download, DownloadState, Element, MAX_ELEMENTS,
    MAX_TEXT_BYTES, NetworkEntry, RING_CAPACITY, ReadMode, ReadResponse, SessionState,
    StoredSession, Subscription, Viewport, Visibility, WaitOutcome, cdp,
    cdp::{CdpClient, CdpError, CdpEvent},
    dom, launch, service,
};

mod console;
mod downloads;
mod events;
mod input;
mod lifecycle;
mod navigate;
mod read;
mod screencast;
mod startup;

use self::console::*;
pub use self::downloads::*;
use self::events::*;
pub use self::input::*;
pub use self::lifecycle::*;
pub use self::navigate::*;
pub use self::read::*;
pub use self::screencast::*;
pub use self::startup::*;

/// Longest a `wait` may block. An agent that asks for more gets this, and is
/// told; nothing here waits forever (design §7).
pub const MAX_WAIT_MS: u32 = 30_000;
const WAIT_POLL: Duration = Duration::from_millis(100);
/// How often lapsed subscriptions are swept and the screencast reconciled.
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);
/// Cap on one input batch, so a single request cannot occupy the browser.
pub const MAX_INPUT_EVENTS: usize = 64;

/* -------------------------------- the session ------------------------------ */

pub struct Live {
    pub session_id: String,
    pub workspace_id: String,
    pub node_id: String,
    pub profile: PathBuf,
    pub staging: PathBuf,
    client: Arc<CdpClient>,
    child: tokio::sync::Mutex<Option<Child>>,
    /// The browser's process id, kept next to the child so a synchronous
    /// cleanup path (a `Drop`, a panicking process) can still reach the whole
    /// process group. Zero once the child has been terminated.
    pid: AtomicU32,
    record: Mutex<BrowserSession>,
    rings: Mutex<Rings>,
    subscriptions: Mutex<HashMap<String, (Visibility, DateTime<Utc>)>>,
    /// `(epoch, count)` of the last `elements` read. A reference minted before
    /// the current epoch is refused rather than resolved (design §7).
    elements: Mutex<(u64, usize)>,
    stream: Mutex<StreamState>,
    frame_seq: AtomicU64,
    pool: sqlx::SqlitePool,
    events: crate::events::EventHub,
}

#[derive(Default)]
struct Rings {
    console: VecDeque<ConsoleEntry>,
    network: VecDeque<(String, NetworkEntry)>,
    downloads: Vec<Download>,
}

#[derive(Default)]
struct StreamState {
    mode: Option<Visibility>,
    last_frame: Option<Instant>,
    max_fps: u32,
}

impl Live {
    pub fn snapshot(&self) -> BrowserSession {
        self.record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn navigation_epoch(&self) -> u64 {
        self.record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .navigation_epoch
    }

    fn edit<R>(&self, apply: impl FnOnce(&mut BrowserSession) -> R) -> R {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record.updated_at = Utc::now().to_rfc3339();
        apply(&mut record)
    }

    /// Persists the current record and tells the canvas about it. Both halves
    /// are best effort: a browser that is working must not be taken down by a
    /// database hiccup.
    async fn publish(&self) {
        let snapshot = self.snapshot();
        if let Err(error) = super::persist(&self.pool, &snapshot).await {
            tracing::warn!(%error, session = %self.session_id, "could not persist browser session");
        }
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::BrowserSession {
                session: Box::new(snapshot),
            },
        );
    }

    fn call_error(&self, error: CdpError) -> AppError {
        if matches!(error, CdpError::Closed) {
            self.edit(|record| {
                record.state = SessionState::Disconnected;
                record.reason_code = "cdp_closed".into();
            });
        }
        match error {
            CdpError::Protocol(message) => AppError::BadRequest(message),
            other => AppError::Conflict(other.to_string()),
        }
    }

    async fn call(&self, method: &str, params: Value) -> AppResult<Value> {
        self.client
            .call(method, params)
            .await
            .map_err(|error| self.call_error(error))
    }

    /// Runs one of the fixed helpers in [`dom`] and returns its value.
    async fn evaluate(&self, expression: &str) -> AppResult<Value> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": false,
                    // A helper must never trigger a page dialog or a user
                    // gesture requirement; it only reads and focuses.
                    "userGesture": false,
                }),
            )
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err(AppError::BadRequest(
                "The page rejected that request".into(),
            ));
        }
        Ok(result
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }
}

fn truncate(value: &str, limit: usize) -> String {
    match value.char_indices().nth(limit) {
        Some((index, _)) => value[..index].to_owned(),
        None => value.to_owned(),
    }
}

/* -------------------------------- operations ------------------------------- */

pub async fn require_live(state: &AppState, session_id: &str) -> AppResult<Arc<Live>> {
    service(state).live(session_id).ok_or_else(|| {
        AppError::NotFound("That browser session is not running on this host".into())
    })
}

/// Only used by tests: the CDP call timeout, re-exported so a test can assert
/// it is bounded rather than re-declaring the number.
pub const fn call_timeout() -> Duration {
    cdp::CALL_TIMEOUT
}
