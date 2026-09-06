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
use serde::{Deserialize, Serialize};
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
    ACTIVITY_CAPACITY, Activity, Admission, BandwidthClass, BrowserSession, Budget, Capture,
    ConsoleEntry, Dialog, DialogKind, Download, DownloadState, Element, FileChooser, FrameEncoding,
    Lease, MAX_ELEMENTS, MAX_TEXT_BYTES, NetworkEntry, ProcessIdentity, RING_CAPACITY, ReadMode,
    ReadResponse, SessionState, StoredSession, Subscription, Tab, TabList, TargetRef, Viewport,
    Visibility, WaitOutcome, cdp,
    cdp::{CdpClient, CdpError, CdpEvent},
    dom, launch, service,
};

mod actions;
mod console;
mod dialogs;
mod downloads;
mod events;
mod input;
pub mod lease;
mod lifecycle;
mod navigate;
mod read;
mod startup;
mod stream;
mod tabs;
mod targets;

pub use self::actions::*;
use self::console::*;
pub use self::dialogs::*;
pub use self::downloads::*;
use self::events::*;
pub use self::input::*;
pub use self::lease::{Actor, Grant, LeaseRequest, Machine as LeaseMachine};
pub use self::lifecycle::*;
pub use self::navigate::*;
pub use self::read::*;
pub use self::startup::*;
pub use self::stream::*;
pub use self::tabs::{close_tab, new_tab, switch_tab, tab_list};
use self::targets::{PendingChooser, Targets};
pub use self::targets::{Place, parse_ref};

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
    /// A handle back to this session, for the timers that outlive a call: a
    /// dialog or a chooser nobody answered has to be able to find the session
    /// again without keeping it alive on its own.
    me: std::sync::Weak<Live>,
    pub session_id: String,
    pub workspace_id: String,
    pub node_id: String,
    pub profile: PathBuf,
    pub staging: PathBuf,
    client: Arc<CdpClient>,
    /// Absent for a session that was re-attached after the Runtime was killed:
    /// the browser is ours, but this process never spawned it, so there is no
    /// child to wait on — only [`Live::pid`] and the identity behind it.
    child: tokio::sync::Mutex<Option<Child>>,
    /// The browser's process id, kept next to the child so a synchronous
    /// cleanup path (a `Drop`, a panicking process) can still reach the whole
    /// process group. Zero once the child has been terminated.
    pub(crate) pid: AtomicU32,
    /// Windows Job Object, held for the life of the session: dropping it ends
    /// every renderer and helper the browser spawned. A no-op elsewhere, where
    /// the process group does the same job.
    #[allow(dead_code)]
    containment: launch::Containment,
    /// What this session's document requests are judged against. Read on every
    /// `Fetch.requestPaused`, including each redirect hop (§2.5).
    policy: Mutex<crate::browser::NetworkPolicy>,
    record: Mutex<BrowserSession>,
    rings: Mutex<Rings>,
    /// One entry per viewer, each with its own budget and its own idea of how
    /// far behind it is: a phone on a metered link must not cost the desktop
    /// node its frame rate (§2.9).
    subscriptions: Mutex<HashMap<String, Subscriber>>,
    /// Tabs, frames and the element references bound to them. The only place
    /// that knows a CDP session id (§2.2).
    targets: Mutex<Targets>,
    stream: Mutex<StreamState>,
    frame_seq: AtomicU64,
    /// Who may drive the page (§2.6). In memory: after a restart nobody does,
    /// and the generation continues from the row.
    lease: Mutex<lease::Machine>,
    /// Woken when the lease is released, so an agent action that is waiting
    /// out a person's typing starts again the moment it can.
    lease_wake: tokio::sync::Notify,
    pool: sqlx::SqlitePool,
    events: crate::events::EventHub,
}

#[derive(Default)]
struct Rings {
    console: VecDeque<ConsoleEntry>,
    network: VecDeque<(String, NetworkEntry)>,
    downloads: Vec<Download>,
    /// The last few actions, for the node header. Not stored anywhere: the
    /// durable record is the board log (§2.8).
    activity: VecDeque<Activity>,
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

    /// The lease state machine. The guard is a `std::sync::Mutex` guard, so
    /// the rule at the top of this file applies: never hold it across an
    /// `.await`.
    pub(super) fn lease_machine(&self) -> std::sync::MutexGuard<'_, lease::Machine> {
        self.lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Copies the lease into the published record. Returns false when it did
    /// not actually change, so a renewal does not produce an event per click.
    pub(super) fn remember_lease(&self, lease: &Lease) -> bool {
        self.edit(|record| {
            if record.lease == *lease {
                return false;
            }
            record.lease = lease.clone();
            record.lease_generation = lease.generation;
            true
        })
    }

    /// Adds one line to the header's activity list and tells the canvas.
    pub(super) fn record_activity(&self, activity: Activity) {
        {
            let mut rings = self
                .rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if rings.activity.len() >= ACTIVITY_CAPACITY {
                rings.activity.pop_front();
            }
            rings.activity.push_back(activity.clone());
        }
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::BrowserActivity {
                activity: Box::new(activity),
            },
        );
    }

    /// The last few actions, newest last.
    pub fn activity(&self) -> Vec<Activity> {
        self.rings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .activity
            .iter()
            .cloned()
            .collect()
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

    /// A command aimed at the active tab. Everything written before tabs
    /// existed goes through here and keeps meaning "the page on screen".
    ///
    /// A page that is between documents has no frame host for a moment, and
    /// Chrome answers anything from the `Page` domain with "not attached to an
    /// active page" until it does. That is a moment, not a failure, so it is
    /// waited out once — the alternative is telling a caller that a page they
    /// can see does not exist.
    async fn call(&self, method: &str, params: Value) -> AppResult<Value> {
        let session = self.active_session();
        match self.client.call_on(&session, method, params.clone()).await {
            Err(CdpError::Protocol(message)) if message.contains("Not attached") => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let session = self.active_session();
                self.call_in(&session, method, params).await
            }
            other => other.map_err(|error| self.call_error(error)),
        }
    }

    /// A command aimed at one attached target.
    pub(super) async fn call_in(
        &self,
        session: &str,
        method: &str,
        params: Value,
    ) -> AppResult<Value> {
        self.client
            .call_on(session, method, params)
            .await
            .map_err(|error| self.call_error(error))
    }

    /// A command aimed at the browser itself: downloads, targets, shutdown.
    pub(super) async fn call_browser(&self, method: &str, params: Value) -> AppResult<Value> {
        self.client
            .call(method, params)
            .await
            .map_err(|error| self.call_error(error))
    }

    /// Runs one of the fixed helpers in [`dom`] in the active tab's main
    /// frame and returns its value.
    async fn evaluate(&self, expression: &str) -> AppResult<Value> {
        let place = self.place(&TargetRef::default())?;
        self.evaluate_in(&place, expression).await
    }

    /// What this session's document requests and popups are judged against.
    /// Set from the workspace's `browserPolicy`; the default admits private
    /// networks and every loopback port but Armadra's own (§2.5).
    pub fn set_policy(&self, policy: crate::browser::NetworkPolicy) {
        *self
            .policy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = policy;
    }

    pub fn policy(&self) -> crate::browser::NetworkPolicy {
        self.policy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(super) fn clone_handle(&self) -> std::sync::Weak<Live> {
        self.me.clone()
    }

    pub(super) fn publish_tabs(&self) {
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::BrowserTabs {
                session_id: self.session_id.clone(),
                tabs: Box::new(self.tab_list()),
            },
        );
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
