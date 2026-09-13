//! Sleep-inhibition leases (T02, design §9).
//!
//! A lease is a *claim*, not a guarantee. Three things decide whether the
//! machine is actually held awake:
//!
//! 1. the lease has not expired — every lease carries a TTL and has to be
//!    renewed, so a crashed caller cannot keep a laptop awake all night;
//! 2. `power.policy` allows that lease's source;
//! 3. the platform has a mechanism at all (see [`super::inhibit`]).
//!
//! A lease that fails 2 or 3 is still recorded and still listed — with
//! `active: false` and a `blockedBy` reason — because "why is my machine asleep
//! during a long run" is exactly the question the panel exists to answer.
//!
//! The inhibitor is released the moment the last *active* lease goes away, and
//! on runtime shutdown ([`PowerService::release_all`]).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    settings::{PowerPolicy, SettingsStore},
};

use super::inhibit::{self, Inhibitor, InhibitorInfo};

/// Default lease TTL when the caller does not say. Long enough that a session
/// heartbeat every minute keeps it alive, short enough that a lost caller stops
/// mattering within minutes.
pub const DEFAULT_TTL: Duration = Duration::from_secs(300);
pub const MIN_TTL: Duration = Duration::from_secs(10);
/// Nothing may claim the machine for longer than this without renewing. The
/// design is explicit that "waiting for tomorrow's schedule" must not keep a
/// machine awake overnight by default.
pub const MAX_TTL: Duration = Duration::from_secs(6 * 3600);
/// How often expiry is checked in the background.
pub const TICK_INTERVAL: Duration = Duration::from_secs(1);

const MAX_LEASES: usize = 128;
const MAX_REASON: usize = 200;

/// Who is asking. The policy is expressed in these terms, so the source is not
/// cosmetic — it decides whether the lease can hold anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LeaseSource {
    /// An agent or terminal session that is doing work.
    Session,
    /// A platform automation run.
    Automation,
    /// The user flipped the switch in the resource panel.
    Manual,
}

impl LeaseSource {
    fn allowed_by(self, policy: PowerPolicy) -> bool {
        match policy {
            // The user's own switch is still refused: "never" means never.
            PowerPolicy::Never => false,
            PowerPolicy::AgentSessions => matches!(self, Self::Session | Self::Manual),
            PowerPolicy::Automation => matches!(self, Self::Automation | Self::Manual),
            PowerPolicy::Manual => matches!(self, Self::Manual),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerLease {
    pub id: String,
    pub source: LeaseSource,
    pub reason: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub created_at: String,
    pub renewed_at: String,
    pub expires_at: String,
    /// This lease is currently holding the machine awake.
    pub active: bool,
    /// `policy` or `unavailable` when it is not.
    pub blocked_by: Option<&'static str>,
}

/// `GET /api/power` and the `power` half of a resource sample.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    pub policy: PowerPolicy,
    /// The machine is being held awake right now.
    pub holding: bool,
    /// Which mechanism is holding it, when one is.
    pub mechanism: Option<&'static str>,
    pub inhibitor: InhibitorInfo,
    pub leases: Vec<PowerLease>,
}

#[derive(Debug, Clone)]
struct Lease {
    id: String,
    source: LeaseSource,
    reason: String,
    session_id: Option<String>,
    workspace_id: Option<String>,
    created_at: DateTime<Utc>,
    renewed_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

/// What a caller asks for. `ttlSeconds` is clamped, never rejected: a caller
/// asking for a week gets [`MAX_TTL`] and a lease it has to renew.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRequest {
    pub source: LeaseSource,
    pub reason: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewRequest {
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

struct Inner {
    settings: SettingsStore,
    leases: Mutex<HashMap<String, Lease>>,
    /// `None` = nothing held. Guarded separately from `leases` so that spawning
    /// or killing the helper never happens while the lease map is locked.
    held: Mutex<Option<Inhibitor>>,
}

/// Cloning shares the leases and the inhibitor.
#[derive(Clone)]
pub struct PowerService {
    inner: Arc<Inner>,
}

impl PowerService {
    pub fn new(settings: SettingsStore) -> Self {
        Self {
            inner: Arc::new(Inner {
                settings,
                leases: Mutex::new(HashMap::new()),
                held: Mutex::new(None),
            }),
        }
    }

    fn policy(&self) -> PowerPolicy {
        self.inner.settings.power_policy()
    }

    fn leases(&self) -> std::sync::MutexGuard<'_, HashMap<String, Lease>> {
        self.inner
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Request a lease. Always succeeds if the request is well formed — whether
    /// it *holds* anything is reported in the returned lease.
    pub fn acquire(&self, request: LeaseRequest) -> AppResult<PowerLease> {
        let reason = request.reason.trim();
        if reason.is_empty() {
            return Err(AppError::BadRequest(
                "A wake lease needs a reason".to_owned(),
            ));
        }
        let reason: String = reason.chars().take(MAX_REASON).collect();
        let now = Utc::now();
        let ttl = clamp_ttl(request.ttl_seconds);
        let lease = Lease {
            id: Uuid::now_v7().to_string(),
            source: request.source,
            reason,
            session_id: request.session_id,
            workspace_id: request.workspace_id,
            created_at: now,
            renewed_at: now,
            expires_at: now + chrono::Duration::from_std(ttl).unwrap_or_default(),
        };
        {
            let mut leases = self.leases();
            prune(&mut leases, now);
            if leases.len() >= MAX_LEASES {
                return Err(AppError::Conflict(
                    "Too many wake leases are already held".to_owned(),
                ));
            }
            leases.insert(lease.id.clone(), lease.clone());
        }
        let state = self.reconcile();
        state
            .leases
            .into_iter()
            .find(|entry| entry.id == lease.id)
            .ok_or_else(|| AppError::Internal("The wake lease disappeared".to_owned()))
    }

    /// Push a lease's expiry out. A lease that already expired is gone and
    /// cannot be renewed — the caller has to ask for a new one, so a silent
    /// gap in coverage is visible as a new lease rather than hidden.
    pub fn renew(&self, id: &str, request: RenewRequest) -> AppResult<PowerLease> {
        let now = Utc::now();
        let ttl = clamp_ttl(request.ttl_seconds);
        {
            let mut leases = self.leases();
            prune(&mut leases, now);
            let lease = leases
                .get_mut(id)
                .ok_or_else(|| AppError::NotFound("This wake lease is not held".to_owned()))?;
            lease.renewed_at = now;
            lease.expires_at = now + chrono::Duration::from_std(ttl).unwrap_or_default();
        }
        let state = self.reconcile();
        state
            .leases
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| AppError::NotFound("This wake lease is not held".to_owned()))
    }

    /// Release one lease. Releasing an unknown id is a 404 rather than a silent
    /// success: a caller that thinks it released something should be told when
    /// it did not.
    pub fn release(&self, id: &str) -> AppResult<PowerState> {
        {
            let mut leases = self.leases();
            if leases.remove(id).is_none() {
                return Err(AppError::NotFound("This wake lease is not held".to_owned()));
            }
        }
        Ok(self.reconcile())
    }

    /// Drop every lease and the inhibitor with it. Called on shutdown.
    pub fn release_all(&self) {
        self.leases().clear();
        self.reconcile();
    }

    /// Current state, with expiry applied. This is also the tick the background
    /// loop calls, and what tests drive directly.
    pub fn state(&self) -> PowerState {
        self.reconcile()
    }

    /// Everything the panel needs, plus the side effect of matching the
    /// platform inhibitor to the current set of active leases.
    fn reconcile(&self) -> PowerState {
        let policy = self.policy();
        let info = inhibit::describe();
        let now = Utc::now();

        let mut leases: Vec<Lease> = {
            let mut map = self.leases();
            prune(&mut map, now);
            map.values().cloned().collect()
        };
        leases.sort_by_key(|lease| lease.created_at);

        let mut wanted = false;
        let mut reported = Vec::with_capacity(leases.len());
        for lease in leases {
            let blocked_by = if !lease.source.allowed_by(policy) {
                Some("policy")
            } else if !info.available {
                Some("unavailable")
            } else {
                None
            };
            wanted |= blocked_by.is_none();
            reported.push(PowerLease {
                id: lease.id,
                source: lease.source,
                reason: lease.reason,
                session_id: lease.session_id,
                workspace_id: lease.workspace_id,
                created_at: lease.created_at.to_rfc3339(),
                renewed_at: lease.renewed_at.to_rfc3339(),
                expires_at: lease.expires_at.to_rfc3339(),
                active: blocked_by.is_none(),
                blocked_by,
            });
        }

        let mut held = self
            .inner
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if wanted && held.is_none() {
            let reason = reported
                .iter()
                .find(|lease| lease.active)
                .map(|lease| lease.reason.as_str())
                .unwrap_or("Armadra is working");
            match inhibit::acquire(reason) {
                Ok(inhibitor) => {
                    tracing::info!(mechanism = inhibitor.kind(), "holding off idle sleep");
                    *held = Some(inhibitor);
                }
                Err(error) => {
                    tracing::warn!(%error, "could not hold off idle sleep");
                    // The claim stays listed, but it is not holding anything.
                    for lease in &mut reported {
                        if lease.active {
                            lease.active = false;
                            lease.blocked_by = Some("unavailable");
                        }
                    }
                }
            }
        } else if !wanted && held.is_some() {
            tracing::info!("releasing the idle-sleep hold");
            *held = None;
        }
        let mechanism = held.as_ref().map(|inhibitor| inhibitor.kind());

        PowerState {
            policy,
            holding: mechanism.is_some(),
            mechanism,
            inhibitor: info,
            leases: reported,
        }
    }

    /// Expire leases in the background so that releasing does not wait for the
    /// next reader. The task holds a weak reference: dropping the last service
    /// clone stops it.
    pub fn start(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(TICK_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { return };
                let service = PowerService { inner };
                // Only reconcile when something could have expired; the common
                // case is an empty map and no work at all.
                let expired = {
                    let leases = service.leases();
                    !leases.is_empty()
                };
                if expired || service.holding() {
                    service.reconcile();
                }
            }
        });
    }

    fn holding(&self) -> bool {
        self.inner
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// Move a lease's expiry into the past so the expiry path can be exercised
    /// without a test waiting out [`MIN_TTL`].
    // Only the macOS lease cases reach this; elsewhere the inhibitor has no
    // helper to count and the whole `resources::tests::power` module is empty.
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn expire_for_test(&self, id: &str) {
        if let Some(lease) = self.leases().get_mut(id) {
            lease.expires_at = Utc::now() - chrono::Duration::seconds(1);
        }
    }
}

fn clamp_ttl(seconds: Option<u64>) -> Duration {
    match seconds {
        None => DEFAULT_TTL,
        Some(seconds) => Duration::from_secs(seconds).clamp(MIN_TTL, MAX_TTL),
    }
}

fn prune(leases: &mut HashMap<String, Lease>, now: DateTime<Utc>) {
    leases.retain(|_, lease| lease.expires_at > now);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(policy: &str) -> PowerService {
        PowerService::new(SettingsStore::in_memory(
            serde_json::json!({ "power": { "policy": policy } }),
        ))
    }

    fn request(source: LeaseSource, ttl: Option<u64>) -> LeaseRequest {
        LeaseRequest {
            source,
            reason: "running a long build".into(),
            session_id: None,
            workspace_id: None,
            ttl_seconds: ttl,
        }
    }

    #[test]
    fn the_policy_decides_which_sources_may_hold_the_machine() {
        for (policy, source, expected) in [
            ("never", LeaseSource::Manual, false),
            ("never", LeaseSource::Session, false),
            ("agentSessions", LeaseSource::Session, true),
            ("agentSessions", LeaseSource::Automation, false),
            ("agentSessions", LeaseSource::Manual, true),
            ("automation", LeaseSource::Automation, true),
            ("automation", LeaseSource::Session, false),
            ("manual", LeaseSource::Manual, true),
            ("manual", LeaseSource::Session, false),
        ] {
            let service = service(policy);
            let lease = service.acquire(request(source, None)).unwrap();
            // On a platform with no mechanism nothing can be active; the
            // policy decision is still visible in `blockedBy`.
            let blocked_by_platform = lease.blocked_by == Some("unavailable");
            assert_eq!(
                lease.active || blocked_by_platform,
                expected || blocked_by_platform,
                "{policy}/{source:?}"
            );
            if !expected {
                assert_eq!(lease.blocked_by, Some("policy"), "{policy}/{source:?}");
            }
            service.release_all();
        }
    }

    #[test]
    fn a_blocked_lease_is_still_reported_rather_than_refused() {
        let service = service("never");
        let lease = service
            .acquire(request(LeaseSource::Session, None))
            .unwrap();
        let state = service.state();
        assert!(!state.holding);
        assert_eq!(state.leases.len(), 1);
        assert_eq!(state.leases[0].id, lease.id);
        assert_eq!(state.leases[0].blocked_by, Some("policy"));
    }

    #[test]
    fn a_lease_needs_a_reason() {
        let service = service("manual");
        let mut bad = request(LeaseSource::Manual, None);
        bad.reason = "   ".into();
        assert!(service.acquire(bad).is_err());
    }

    #[test]
    fn ttls_are_clamped_not_rejected() {
        assert_eq!(clamp_ttl(None), DEFAULT_TTL);
        assert_eq!(clamp_ttl(Some(1)), MIN_TTL);
        assert_eq!(clamp_ttl(Some(9_999_999)), MAX_TTL);
        assert_eq!(clamp_ttl(Some(60)), Duration::from_secs(60));
    }

    #[test]
    fn expiry_removes_a_lease_without_anybody_releasing_it() {
        let service = service("manual");
        let lease = service
            .acquire(request(LeaseSource::Manual, Some(10)))
            .unwrap();
        // Reach past the clamp: the point is the expiry path, not the clock.
        service.leases().get_mut(&lease.id).unwrap().expires_at =
            Utc::now() - chrono::Duration::seconds(1);
        let state = service.state();
        assert!(state.leases.is_empty());
        assert!(!state.holding);
    }

    #[test]
    fn releasing_an_unknown_lease_is_an_error() {
        let service = service("manual");
        assert!(service.release("no-such-lease").is_err());
        assert!(
            service
                .renew("no-such-lease", RenewRequest::default())
                .is_err()
        );
    }

    #[test]
    fn renewing_moves_the_expiry_out() {
        let service = service("manual");
        let lease = service
            .acquire(request(LeaseSource::Manual, Some(10)))
            .unwrap();
        let renewed = service
            .renew(
                &lease.id,
                RenewRequest {
                    ttl_seconds: Some(600),
                },
            )
            .unwrap();
        assert!(renewed.expires_at > lease.expires_at);
        assert_eq!(renewed.created_at, lease.created_at);
    }
}
