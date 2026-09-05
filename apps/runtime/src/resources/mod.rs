//! Host and session resources, and the leases that keep this machine awake
//! (T02 — [terminal host design](../../../docs/terminal-host-design.md) §8/§9).
//!
//! ## Sampling is a subscription, not a timer
//!
//! Nothing is measured unless somebody is looking. The panel takes a
//! subscription with a TTL and renews it while it is open; the sampling task
//! only exists while at least one live subscription does, and stops on its own
//! when the last one lapses. A closed panel therefore costs nothing — not a
//! process-table walk, not a `Disks` refresh, not a wake-up.
//!
//! The interval is `resources.intervalMs` (2s by default, design §8's "面板打
//! 开时每 2 秒"); samples reach the canvas as `resource.sample` on the
//! workspace event socket that is already open.
//!
//! ## Unknown is a value
//!
//! Every metric is an `Option`. A metric this platform cannot answer is `null`
//! on the wire and an em dash in the panel — never `0`, which would read as
//! "idle" (design §8: "不可测返回 unknown，不显示 0 B").
//!
//! ## What the service owns
//!
//! Only the state that has to be shared between requests: the subscriptions,
//! the `sysinfo` handle (whose CPU numbers are deltas between refreshes, so it
//! must be the same one every time) and the power leases. The pool, the
//! terminal manager and the event hub are handed in per call from [`AppState`],
//! which keeps the service out of the construction order of everything else.

pub mod inhibit;
pub mod orphans;
pub mod platform_power;
pub mod power;
pub mod routes;
pub mod sample;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, error::AppResult, events::WorkspaceEvent, settings::SettingsStore};

use orphans::OrphanSession;
use power::{PowerService, PowerState};
use sample::{HostResources, Sampler, SessionResources, SessionTarget};

/// A subscription lapses after this multiple of the sampling interval, floored
/// at [`MIN_SUBSCRIPTION_TTL`]. A panel that renews every interval therefore
/// has two missed renewals of slack before sampling stops.
const TTL_INTERVALS: u32 = 3;
const MIN_SUBSCRIPTION_TTL: Duration = Duration::from_secs(10);
const MAX_SUBSCRIPTIONS: usize = 32;

/// One resource sample, as `GET …/resources` answers it and as the
/// `resource.sample` event carries it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub workspace_id: String,
    pub host: HostResources,
    pub sessions: Vec<SessionResources>,
    pub orphans: Vec<OrphanSession>,
    pub power: PowerState,
    pub interval_ms: u64,
    pub sampled_at: String,
}

/// What `POST …/resources/subscription` answers. The client re-posts with the
/// same `subscriptionId` to renew.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub subscription_id: String,
    pub workspace_id: String,
    pub interval_ms: u64,
    pub expires_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    /// Renew this subscription instead of taking a new one. An id that has
    /// already lapsed is not an error: a new subscription is issued and the
    /// client learns the new id from the response.
    #[serde(default)]
    pub subscription_id: Option<String>,
}

#[derive(Debug, Clone)]
struct Watcher {
    workspace_id: String,
    expires_at: DateTime<Utc>,
}

struct Inner {
    settings: SettingsStore,
    power: PowerService,
    watchers: Mutex<HashMap<String, Watcher>>,
    /// One sample at a time, and a one-shot `GET` shares the same `sysinfo`
    /// state — and therefore the same CPU baseline — as the sampling loop. A
    /// plain mutex because the guard only ever lives inside a blocking task.
    sampler: Arc<Mutex<Sampler>>,
    /// A sampling loop is running. Reset when it exits so that the next
    /// subscription starts a new one.
    pumping: Mutex<bool>,
}

/// Cloning shares the subscriptions, the sampler and the power leases.
#[derive(Clone)]
pub struct ResourceService {
    inner: Arc<Inner>,
}

impl ResourceService {
    pub fn new(settings: SettingsStore) -> Self {
        Self {
            inner: Arc::new(Inner {
                power: PowerService::new(settings.clone()),
                settings,
                watchers: Mutex::new(HashMap::new()),
                sampler: Arc::new(Mutex::new(Sampler::new())),
                pumping: Mutex::new(false),
            }),
        }
    }

    pub fn power(&self) -> &PowerService {
        &self.inner.power
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.inner.settings.resource_interval_ms())
    }

    fn watchers(&self) -> std::sync::MutexGuard<'_, HashMap<String, Watcher>> {
        self.inner
            .watchers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Take or renew a subscription, and start the sampling loop if it is not
    /// already running.
    pub fn subscribe(
        &self,
        state: &AppState,
        workspace_id: &str,
        request: &SubscribeRequest,
    ) -> Subscription {
        let interval = self.interval();
        let ttl = (interval * TTL_INTERVALS).max(MIN_SUBSCRIPTION_TTL);
        let expires_at = Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default();

        let id = {
            let mut watchers = self.watchers();
            let now = Utc::now();
            watchers.retain(|_, watcher| watcher.expires_at > now);
            let renewing = request
                .subscription_id
                .as_ref()
                .filter(|id| watchers.contains_key(*id))
                .cloned();
            let id = match renewing {
                Some(id) => id,
                None if watchers.len() >= MAX_SUBSCRIPTIONS => {
                    // Every slot is already live; reuse the one closest to
                    // lapsing rather than growing without bound. The client
                    // learns the id it actually got from the response.
                    watchers
                        .iter()
                        .min_by_key(|(_, watcher)| watcher.expires_at)
                        .map(|(id, _)| id.clone())
                        .unwrap_or_else(|| Uuid::now_v7().to_string())
                }
                None => Uuid::now_v7().to_string(),
            };
            watchers.insert(
                id.clone(),
                Watcher {
                    workspace_id: workspace_id.to_owned(),
                    expires_at,
                },
            );
            id
        };
        self.ensure_pump(state);
        Subscription {
            subscription_id: id,
            workspace_id: workspace_id.to_owned(),
            interval_ms: interval.as_millis() as u64,
            expires_at: expires_at.to_rfc3339(),
        }
    }

    /// Drop a subscription. An unknown id is ignored: a panel closing twice, or
    /// closing after its subscription lapsed, is not an error.
    pub fn unsubscribe(&self, subscription_id: &str) {
        self.watchers().remove(subscription_id);
    }

    /// Workspaces with at least one live subscription right now.
    fn subscribed_workspaces(&self) -> Vec<String> {
        let now = Utc::now();
        let mut watchers = self.watchers();
        watchers.retain(|_, watcher| watcher.expires_at > now);
        let mut workspaces: Vec<String> = watchers
            .values()
            .map(|watcher| watcher.workspace_id.clone())
            .collect();
        workspaces.sort();
        workspaces.dedup();
        workspaces
    }

    /// One sample of one workspace.
    ///
    /// `prime` refreshes twice around the platform's minimum CPU window, which
    /// is what a one-shot `GET` needs so its first paint carries real CPU
    /// numbers rather than a first-refresh zero.
    pub async fn snapshot(
        &self,
        state: &AppState,
        workspace_id: &str,
        prime: bool,
    ) -> AppResult<ResourceSnapshot> {
        let orphans = orphans::list(&state.pool, &state.terminals, workspace_id).await?;
        let managed =
            orphans::for_workspace(state.terminals.managed_sessions().await, workspace_id);
        let targets: Vec<SessionTarget> = managed
            .into_iter()
            .map(|session| SessionTarget {
                remote: sample::is_remote_executable(&session.executable),
                session_id: session.session_id,
                session_key: session.session_key,
                workspace_id: session.workspace_id,
                node_id: session.owner_node_id,
                generation: session.generation,
                backend: session.backend.as_str(),
                cwd: session.cwd,
                pid: session.pid,
                exited: session.exited,
            })
            .collect();

        // `sysinfo` walks the whole process table and stats the mounted
        // filesystems, and priming sleeps for the platform's minimum CPU
        // window: blocking work that must not sit on an async worker.
        let sampler = self.inner.sampler.clone();
        let (host, sessions) = tokio::task::spawn_blocking(move || {
            let mut guard = sampler
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if prime {
                guard.prime();
            }
            guard.sample(&targets)
        })
        .await?;

        Ok(ResourceSnapshot {
            workspace_id: workspace_id.to_owned(),
            sampled_at: host.sampled_at.clone(),
            host,
            sessions,
            orphans,
            power: self.inner.power.state(),
            interval_ms: self.interval().as_millis() as u64,
        })
    }

    /// Start the sampling loop unless one is already running.
    ///
    /// The task holds a clone of [`AppState`] — the same handles every request
    /// holds — and returns as soon as the last subscription lapses, so nothing
    /// is kept alive by a panel nobody has open.
    fn ensure_pump(&self, state: &AppState) {
        {
            let mut pumping = self
                .inner
                .pumping
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *pumping {
                return;
            }
            *pumping = true;
        }
        let state = state.clone();
        tokio::spawn(async move {
            let service = state.resources.clone();
            loop {
                tokio::time::sleep(service.interval()).await;
                let workspaces = service.subscribed_workspaces();
                if workspaces.is_empty() {
                    *service
                        .inner
                        .pumping
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
                    // A subscription taken between the check and the reset
                    // would have found the flag set and not started a loop, so
                    // re-check once and hand the loop back if it did.
                    if service.subscribed_workspaces().is_empty() {
                        return;
                    }
                    service.ensure_pump(&state);
                    return;
                }
                for workspace_id in workspaces {
                    match service.snapshot(&state, &workspace_id, false).await {
                        Ok(snapshot) => {
                            state.events.publish(
                                &workspace_id,
                                WorkspaceEvent::ResourceSample {
                                    snapshot: Box::new(snapshot),
                                },
                            );
                        }
                        Err(error) => {
                            tracing::debug!(
                                %error,
                                workspace = %workspace_id,
                                "resource sample failed"
                            );
                        }
                    }
                }
            }
        });
    }
}
