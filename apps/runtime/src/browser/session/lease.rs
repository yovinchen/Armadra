//! The control lease: who is allowed to drive one session (design §2.6).
//!
//! Reads never take the lease. Anything input-shaped does, and there is
//! exactly one holder at a time. Two rules carry the whole design:
//!
//! * a person who just clicks something takes the lease away from an agent
//!   immediately, and the agent's *next* action waits for them to go idle —
//!   at most five seconds, then it is refused rather than queued forever;
//! * a person who presses "take over" revokes the agent's lease outright, and
//!   every agent action is refused until they hand it back.
//!
//! [`Machine`] is the whole of that, with no Chrome, no database and no clock
//! of its own — `now` is a parameter — so the table in §2.6 can be tested
//! line by line. [`acquire`] is the thin async wrapper that owns the waiting.

use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::{
    browser::{Lease, LeaseHolder, LeaseState},
    error::{AppError, AppResult},
};

/// A person's lease lapses this long after their last input, so an agent that
/// is waiting gets going again without anybody pressing anything.
pub const HUMAN_IDLE_SECONDS: i64 = 10;
/// An agent's lease lapses this long after its last action. Longer than a
/// person's because an agent thinks between clicks.
pub const AGENT_IDLE_SECONDS: i64 = 30;
/// How long an agent action waits for a person to go idle before it is
/// refused (§2.6). Refusing is the design: a queue that grows without bound
/// turns "the human is typing" into "the agent hung".
pub const AGENT_QUEUE: Duration = Duration::from_secs(5);

/* ------------------------------- reason codes ----------------------------- */

/// A person is driving right now; the agent waited and gave up.
pub const LEASE_HELD_BY_HUMAN: &str = "LEASE_HELD_BY_HUMAN";
/// A person took over. The agent's lease is gone and is not coming back on
/// its own — somebody has to hand it back.
pub const LEASE_REVOKED: &str = "LEASE_REVOKED";
/// Another agent holds it. Agents do not queue behind each other.
pub const LEASE_HELD_BY_AGENT: &str = "LEASE_HELD_BY_AGENT";
/// The caller's `leaseGeneration` is not the current one, so whatever it
/// believed about who was driving is out of date.
pub const LEASE_GENERATION: &str = "LEASE_GENERATION";

/// The message a refusal carries, which is what a person actually reads.
pub fn refusal(code: &str) -> AppError {
    let message = match code {
        LEASE_HELD_BY_HUMAN => "LEASE_HELD_BY_HUMAN: somebody is using this browser; try again",
        LEASE_REVOKED => "LEASE_REVOKED: a person took over this browser",
        LEASE_HELD_BY_AGENT => "LEASE_HELD_BY_AGENT: another agent is using this browser",
        _ => "LEASE_GENERATION: the browser changed hands since you last looked",
    };
    AppError::Conflict(message.into())
}

/* ---------------------------------- actors -------------------------------- */

/// Who is asking. A person is told apart by the opaque id their client sends;
/// an agent by the canvas node it runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    Human {
        device_id: String,
        display_name: String,
    },
    Agent {
        node_id: String,
        session_id: String,
        display_name: String,
    },
}

impl Actor {
    pub fn human(device_id: &str, display_name: &str) -> Self {
        Self::Human {
            device_id: device_id.to_owned(),
            display_name: display_name.to_owned(),
        }
    }

    pub fn agent(node_id: &str, session_id: &str, display_name: &str) -> Self {
        Self::Agent {
            node_id: node_id.to_owned(),
            session_id: session_id.to_owned(),
            display_name: display_name.to_owned(),
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Human { device_id, .. } => device_id,
            Self::Agent { node_id, .. } => node_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Human { .. } => "human",
            Self::Agent { .. } => "agent",
        }
    }

    fn display_name(&self) -> &str {
        match self {
            Self::Human { display_name, .. } | Self::Agent { display_name, .. } => display_name,
        }
    }

    fn holder(&self) -> LeaseHolder {
        LeaseHolder {
            kind: self.kind(),
            id: self.id().to_owned(),
            display_name: self.display_name().to_owned(),
        }
    }

    fn idle_seconds(&self) -> i64 {
        match self {
            Self::Human { .. } => HUMAN_IDLE_SECONDS,
            Self::Agent { .. } => AGENT_IDLE_SECONDS,
        }
    }
}

/// What the state machine says about one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grant {
    /// The caller holds the lease and may act.
    Granted,
    /// A person is mid-input. Wait for them to go idle, up to [`AGENT_QUEUE`].
    Queue,
    Refused(&'static str),
}

/* -------------------------------- the machine ------------------------------ */

/// The lease of one session. In memory only: after a Runtime restart nobody
/// holds it, and the generation continues from the stored counter so an old
/// client's number cannot come back around to being current (§2.6).
#[derive(Debug, Clone)]
pub struct Machine {
    state: LeaseState,
    holder: Option<LeaseHolder>,
    /// The agent's own CLI session, kept out of [`LeaseHolder`] because it is
    /// not something a badge shows.
    agent_session: String,
    expires_at: Option<DateTime<Utc>>,
    generation: u64,
}

impl Machine {
    /// A free lease continuing from the generation the row remembers.
    pub fn resuming(stored_generation: u64) -> Self {
        Self {
            state: LeaseState::Free,
            holder: None,
            agent_session: String::new(),
            expires_at: None,
            generation: stored_generation,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn state(&self) -> LeaseState {
        self.state
    }

    pub fn snapshot(&self) -> Lease {
        Lease {
            state: self.state,
            generation: self.generation,
            expires_at: self
                .expires_at
                .map(|at| at.to_rfc3339())
                .unwrap_or_default(),
            holder: self.holder.clone(),
        }
    }

    /// True when this actor is the current holder.
    fn held_by(&self, actor: &Actor) -> bool {
        match (&self.holder, actor) {
            (Some(holder), Actor::Human { device_id, .. }) => {
                holder.kind == "human" && holder.id == *device_id
            }
            (Some(holder), Actor::Agent { node_id, .. }) => {
                holder.kind == "agent" && holder.id == *node_id
            }
            (None, _) => false,
        }
    }

    /// Releases a lease whose idle window has passed. A takeover has no
    /// window: it is held until the person hands it back.
    pub fn expire(&mut self, now: DateTime<Utc>) -> bool {
        let Some(expires_at) = self.expires_at else {
            return false;
        };
        if now < expires_at {
            return false;
        }
        self.clear();
        true
    }

    fn clear(&mut self) {
        self.state = LeaseState::Free;
        self.holder = None;
        self.agent_session.clear();
        self.expires_at = None;
        self.generation += 1;
    }

    fn hold(&mut self, actor: &Actor, state: LeaseState, now: DateTime<Utc>, changed: bool) {
        self.state = state;
        self.holder = Some(actor.holder());
        self.agent_session = match actor {
            Actor::Agent { session_id, .. } => session_id.clone(),
            Actor::Human { .. } => String::new(),
        };
        self.expires_at = match state {
            // A takeover is deliberate and stays until it is handed back.
            LeaseState::HumanTakeover => None,
            _ => Some(now + chrono::Duration::seconds(actor.idle_seconds())),
        };
        if changed {
            self.generation += 1;
        }
    }

    /// One input-shaped action asking to proceed.
    ///
    /// `expected` is the generation the caller last saw; `None` means it is
    /// not tracking one. Expiry is applied first, so a request that arrives
    /// after the previous holder went idle sees a free lease rather than a
    /// stale one.
    pub fn request(&mut self, actor: &Actor, now: DateTime<Utc>, expected: Option<u64>) -> Grant {
        self.expire(now);
        if let Some(expected) = expected
            && expected != self.generation
        {
            return Grant::Refused(LEASE_GENERATION);
        }
        match (self.state, actor) {
            (LeaseState::Free, _) => {
                let state = match actor {
                    Actor::Human { .. } => LeaseState::Human,
                    Actor::Agent { .. } => LeaseState::Agent,
                };
                self.hold(actor, state, now, true);
                Grant::Granted
            }
            // The holder renewing: no change of hands, so no new generation.
            (LeaseState::Human | LeaseState::HumanTakeover | LeaseState::Agent, _)
                if self.held_by(actor) =>
            {
                self.hold(actor, self.state, now, false);
                Grant::Granted
            }
            // A person's ordinary input preempts an agent outright; the
            // agent's next action is told why (§2.6).
            (LeaseState::Agent, Actor::Human { .. }) => {
                self.hold(actor, LeaseState::Human, now, true);
                Grant::Granted
            }
            (LeaseState::Agent, Actor::Agent { .. }) => Grant::Refused(LEASE_HELD_BY_AGENT),
            // Somebody is typing. Wait for them, briefly.
            (LeaseState::Human, Actor::Agent { .. }) => Grant::Queue,
            // The takeover is the point: the agent does not queue behind it.
            (LeaseState::HumanTakeover, Actor::Agent { .. }) => Grant::Refused(LEASE_REVOKED),
            // A second person: whoever touched it last is driving.
            (LeaseState::Human, Actor::Human { .. }) => {
                self.hold(actor, LeaseState::Human, now, true);
                Grant::Granted
            }
            // …except against a deliberate takeover, which is not something
            // another device gets to walk over by clicking.
            (LeaseState::HumanTakeover, Actor::Human { .. }) => Grant::Refused(LEASE_HELD_BY_HUMAN),
        }
    }

    /// A person pressing "take over". Any agent lease is revoked; the answer
    /// says whether one actually was, so the caller can log it as `unknown`
    /// rather than guessing (§2.6).
    pub fn takeover(&mut self, actor: &Actor, now: DateTime<Utc>) -> Option<LeaseHolder> {
        let revoked = match (self.state, &self.holder) {
            (LeaseState::Agent, Some(holder)) => Some(holder.clone()),
            _ => None,
        };
        self.hold(actor, LeaseState::HumanTakeover, now, true);
        revoked
    }

    /// Giving the lease back, or an agent releasing its own. Only the holder
    /// may: releasing somebody else's lease is not a thing a client can ask
    /// for, and is refused rather than quietly ignored.
    pub fn release(&mut self, actor: &Actor) -> AppResult<()> {
        if !self.held_by(actor) {
            return Err(refusal(match self.state {
                LeaseState::Agent => LEASE_HELD_BY_AGENT,
                LeaseState::Free => LEASE_GENERATION,
                _ => LEASE_HELD_BY_HUMAN,
            }));
        }
        self.clear();
        Ok(())
    }
}

/* -------------------------------- the client ------------------------------ */

/// A client that sends no id is "the person at this machine". They are not
/// told apart from each other, which only matters when two of them drive the
/// same node at once.
pub fn device_or_local(device_id: &str) -> &str {
    let trimmed = device_id.trim();
    if trimmed.is_empty() { "local" } else { trimmed }
}

/// Free text from a client, kept short enough to sit in a badge.
pub fn truncate_name(name: &str) -> &str {
    let trimmed = name.trim();
    match trimmed.char_indices().nth(40) {
        Some((index, _)) => &trimmed[..index],
        None => trimmed,
    }
}
