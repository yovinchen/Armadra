//! One browser node, as the Runtime sees it when the page lives in the shell.
//!
//! What stays here is everything the research said stays here: the lease state
//! machine (unchanged — it is a pure function of `now` and never knew about
//! Chrome), the `active_tab_url` column, and the activity ring the node header
//! shows. What is gone is the process, the CDP client, the frame stream and the
//! profile directory: the page is a guest in the window, and the only thing
//! this side holds is the right to drive it.
//!
//! The lease machine is imported from [`super::super::session::lease`] rather
//! than copied. The wait loop below IS copied, in the narrow sense that it is
//! the same six lines against a different owner — [`lease::acquire`] takes a
//! `Live`, which is the managed-Chromium session, and W3.5 removes that type.
//! Two short loops for the duration of the overlap beats a trait that exists
//! only to be deleted.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use chrono::Utc;
use sqlx::SqlitePool;

use crate::{
    browser::{
        ACTIVITY_CAPACITY, Activity, Lease, LeaseState, SessionState, StoredSession, Viewport,
        session::lease::{self, Actor, Grant},
    },
    error::{AppError, AppResult},
    events::{EventHub, WorkspaceEvent},
};

pub struct ShellSession {
    pub node_id: String,
    pub session_id: String,
    pub workspace_id: String,
    /// Who may drive (§2.6). In memory only: after a restart nobody does, and
    /// the generation continues from the stored counter.
    lease: Mutex<lease::Machine>,
    /// Woken when the lease is released, so an agent action waiting out a
    /// person's typing starts again the moment it can.
    lease_wake: tokio::sync::Notify,
    /// The single fact about the page this side still stores. Written from the
    /// shell's navigation events, so the Runtime is the source of truth for it
    /// and the canvas node's own `url` is a read-through copy.
    active_tab_url: Mutex<String>,
    activity: Mutex<VecDeque<Activity>>,
    pool: SqlitePool,
    events: EventHub,
}

impl ShellSession {
    fn new(stored: &StoredSession, pool: SqlitePool, events: EventHub) -> Self {
        Self {
            node_id: stored.node_id.clone(),
            session_id: stored.id.clone(),
            workspace_id: stored.workspace_id.clone(),
            lease: Mutex::new(lease::Machine::resuming(stored.lease_generation)),
            lease_wake: tokio::sync::Notify::new(),
            active_tab_url: Mutex::new(stored.active_tab_url.clone()),
            activity: Mutex::new(VecDeque::new()),
            pool,
            events,
        }
    }

    pub fn active_tab_url(&self) -> String {
        self.active_tab_url
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Records where the guest is now, and stores it.
    ///
    /// The canvas node also knows a URL, and the two must not disagree: this
    /// one wins. The node's `data.url` is what the page draws in its address
    /// bar; the column is what a restart re-navigates to.
    pub async fn remember_url(&self, url: &str) {
        {
            let mut current = self
                .active_tab_url
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *current == url {
                return;
            }
            *current = url.to_owned();
        }
        if let Err(error) =
            crate::browser::persist_active_tab_url(&self.pool, &self.session_id, url).await
        {
            tracing::warn!(%error, session = %self.session_id, "could not store the active tab url");
        }
    }

    pub fn lease_snapshot(&self) -> Lease {
        let mut machine = self.machine();
        machine.expire(Utc::now());
        machine.snapshot()
    }

    fn machine(&self) -> std::sync::MutexGuard<'_, lease::Machine> {
        self.lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Takes the lease for one action, waiting out a person's ordinary input
    /// for at most [`lease::AGENT_QUEUE`].
    pub async fn acquire(&self, actor: &Actor) -> AppResult<u64> {
        let deadline = tokio::time::Instant::now() + lease::AGENT_QUEUE;
        loop {
            let (grant, snapshot) = {
                let mut machine = self.machine();
                let grant = machine.request(actor, Utc::now(), None);
                (grant, machine.snapshot())
            };
            match grant {
                Grant::Granted => {
                    let generation = snapshot.generation;
                    self.publish_lease(snapshot).await;
                    return Ok(generation);
                }
                Grant::Refused(code) => return Err(lease::refusal(code)),
                Grant::Queue => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(lease::refusal(lease::LEASE_HELD_BY_HUMAN));
                    }
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(100),
                        self.lease_wake.notified(),
                    )
                    .await;
                }
            }
        }
    }

    /// A person touched the page. Their ordinary input preempts an agent
    /// outright; the agent's next action is told why.
    ///
    /// This is what replaced the frame stream's upstream input as the source of
    /// "a human did something here": the shell reports the guest's own
    /// `before-input-event`, which never travels through this process at all.
    pub async fn human_activity(&self, device_id: &str) -> Option<Lease> {
        let actor = Actor::human(device_id, "");
        let (changed, snapshot) = {
            let mut machine = self.machine();
            let before = machine.snapshot();
            // A takeover is deliberate and is not walked over by a click.
            if before.state == LeaseState::HumanTakeover {
                return None;
            }
            machine.request(&actor, Utc::now(), None);
            let after = machine.snapshot();
            (after != before, after)
        };
        if !changed {
            return None;
        }
        self.publish_lease(snapshot.clone()).await;
        Some(snapshot)
    }

    /// A person pressed Stop. The agent's lease is revoked and does not come
    /// back on its own.
    ///
    /// The answer says whether one actually was revoked, so the caller can
    /// record the in-flight action as `unknown` rather than guessing: an action
    /// already dispatched cannot be taken back, and calling it a success or a
    /// failure would both be inventions.
    pub async fn takeover(&self, device_id: &str, display_name: &str) -> Lease {
        let actor = Actor::human(
            lease::device_or_local(device_id),
            lease::truncate_name(display_name),
        );
        let (snapshot, revoked) = {
            let mut machine = self.machine();
            let revoked = machine.takeover(&actor, Utc::now());
            (machine.snapshot(), revoked)
        };
        if let Some(holder) = revoked {
            self.record_activity(Activity {
                session_id: self.session_id.clone(),
                actor: "agent",
                actor_id: holder.id,
                verb: "lease".into(),
                target: String::new(),
                outcome: "unknown",
                reason_code: lease::LEASE_REVOKED.into(),
                at: Utc::now().to_rfc3339(),
            });
        }
        self.publish_lease(snapshot.clone()).await;
        snapshot
    }

    pub async fn release(&self, actor: &Actor) -> AppResult<Lease> {
        let snapshot = {
            let mut machine = self.machine();
            machine.release(actor)?;
            machine.snapshot()
        };
        self.publish_lease(snapshot.clone()).await;
        Ok(snapshot)
    }

    async fn publish_lease(&self, lease: Lease) {
        if let Err(error) =
            crate::browser::persist_lease_generation(&self.pool, &self.session_id, lease.generation)
                .await
        {
            tracing::warn!(%error, session = %self.session_id, "could not store the lease generation");
        }
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::BrowserLease {
                session_id: self.session_id.clone(),
                lease: Box::new(lease),
            },
        );
        self.lease_wake.notify_waiters();
    }

    pub fn record_activity(&self, activity: Activity) {
        {
            let mut ring = self
                .activity
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if ring.len() >= ACTIVITY_CAPACITY {
                ring.pop_front();
            }
            ring.push_back(activity.clone());
        }
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::BrowserActivity {
                activity: Box::new(activity),
            },
        );
    }

    pub fn activity(&self) -> Vec<Activity> {
        self.activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }
}

/* -------------------------------- the table ------------------------------- */

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Arc<ShellSession>>>);

impl Sessions {
    pub fn get(&self, node_id: &str) -> Option<Arc<ShellSession>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(node_id)
            .cloned()
    }

    pub fn all(&self) -> Vec<Arc<ShellSession>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }

    fn put(&self, session: Arc<ShellSession>) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session.node_id.clone(), session);
    }
}

/// The session for one node, loading or creating its row.
///
/// The row is created with the process columns empty and stays that way: under
/// the shell there is no Chromium of ours to identify, so `pid`, `pid_started_at`
/// and `cdp_port` are the dead columns the design said they would be. The table
/// itself is unchanged — a published migration is not edited.
pub async fn ensure(
    sessions: &Sessions,
    pool: &SqlitePool,
    events: &EventHub,
    node_id: &str,
    workspace_id: &str,
    url: &str,
) -> AppResult<Arc<ShellSession>> {
    if let Some(found) = sessions.get(node_id) {
        return Ok(found);
    }
    let stored = match crate::browser::stored_for_node(pool, node_id).await? {
        Some(stored) => stored,
        None => {
            let now = Utc::now().to_rfc3339();
            let fresh = StoredSession {
                id: uuid::Uuid::new_v4().to_string(),
                workspace_id: workspace_id.to_owned(),
                node_id: node_id.to_owned(),
                url: url.to_owned(),
                title: String::new(),
                viewport: Viewport::default(),
                // No profile of ours: the guest's jar is the shell's partition,
                // named by the page and created by Electron.
                profile_dir: String::new(),
                headful: true,
                keep_alive: true,
                generation: 0,
                state: SessionState::Ready,
                reason_code: String::new(),
                created_at: now.clone(),
                updated_at: now,
                process: crate::browser::ProcessIdentity::default(),
                lease_generation: 0,
                active_tab_url: url.to_owned(),
            };
            crate::browser::insert_stored(pool, &fresh).await?;
            fresh
        }
    };
    if stored.workspace_id != workspace_id {
        return Err(AppError::Forbidden(
            "That browser node belongs to another workspace".into(),
        ));
    }
    let session = Arc::new(ShellSession::new(&stored, pool.clone(), events.clone()));
    sessions.put(Arc::clone(&session));
    Ok(session)
}
