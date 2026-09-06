//! The agent state machine — plan §5.4.
//!
//! Hook events do not arrive in the order they happened. Claude runs its hooks
//! in parallel, a `PostToolUse` can land after the `Stop` that ended the turn,
//! and an idle notification can arrive minutes late. A reducer that simply took
//! the newest event would flip a finished node back to `working` several times a
//! session, which is exactly the flicker the plan's invariants exist to prevent.
//!
//! Five rules, each defending against one real failure:
//!
//! 1. **done holdoff (3s)** — a late `working` that is not a new turn cannot
//!    revive a turn that just ended.
//! 2. **idle rescue** — the "waiting for your input" notification may only turn
//!    `working` into `done`. It never touches `blocked` or `waiting`, because a
//!    node that is asking something *is* idle by that definition.
//! 3. **awaitingInput hold** — while an unanswered question is open, the `done`
//!    that ends its turn is rewritten to `waiting`. Otherwise the node looks
//!    finished while the CLI sits at a prompt.
//! 4. **session reset** — `SessionStart` / `SessionEnd` clear the state rather
//!    than set one; a fresh CLI is idle, not done. Its exceptions live in
//!    [`SESSION_KEEP_RULES`]: not every session event describes a *different*
//!    session from the turn already on the row.
//! 5. **subagent isolation** — subagent events describe a child, never the
//!    parent's state.
//!
//! `restored` is the sixth: a row read back from SQLite after a restart is not
//! live knowledge, so it never gets the benefit of the holdoff and its `done`
//! is not a fresh one.

use chrono::{DateTime, Duration, Utc};

use super::normalize::{AgentEvent, DONE, EventKind, WAITING, WORKING};

/// A `working` that lands within this window after a `done` is discarded unless
/// it opens a new turn.
pub const DONE_HOLDOFF_SECONDS: i64 = 3;
/// A `working` node that has not reported for this long is swept to `done`.
pub const STALE_WORKING_MINUTES: i64 = 20;
/// How long a session event may still be talking about the turn next to it.
///
/// Copilot CLI 1.0.83 measured on 2026-09-06: `sessionStart` lands ~20 ms after
/// the `userPromptSubmitted` that created the session, and in `-p` mode
/// `sessionEnd` lands ~10 ms after `agentStop`. Three seconds is the same slack
/// rule 1 already gives a fresh `done`, and orders of magnitude below the gap
/// between two real sessions in one terminal.
pub const SESSION_ECHO_SECONDS: i64 = 3;

/// The row as it stands before the event is applied.
#[derive(Debug, Clone, Default)]
pub struct Current {
    pub state: Option<String>,
    pub state_source: Option<String>,
    pub unread: bool,
    pub session_id: Option<String>,
    pub pending_id: Option<String>,
    pub transcript_path: Option<String>,
    pub session_phase: Option<String>,
    pub errored: Option<bool>,
    pub interrupted: Option<bool>,
    pub restored: bool,
}

/// The part of the state machine that does not survive a restart: when the last
/// turn ended, and whether a question is still open. Keyed by node.
#[derive(Debug, Clone, Default)]
pub struct Memory {
    pub done_at: Option<DateTime<Utc>>,
    /// When the turn currently on the row opened. Only a session event reads
    /// it, to tell "the start that created this very turn" from "a start that
    /// found a turn left over from a CLI that is already gone".
    pub turn_started_at: Option<DateTime<Utc>>,
    pub awaiting_input: bool,
}

/// Everything a rule 4 exception is allowed to look at. Passing it as one value
/// keeps every rule below a pure predicate the tests can drive directly.
pub struct SessionFacts<'a> {
    pub now: DateTime<Utc>,
    pub current: &'a Current,
    pub memory: &'a Memory,
    pub event: &'a AgentEvent,
}

/// Why a session event leaves the turn on the row standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKeep {
    /// A start the prompt in flight created. Copilot opens its session *from*
    /// the first prompt, so `sessionStart` arrives after that turn's `working`;
    /// resetting on it blanks the state the prompt just set.
    OpenedByThisPrompt,
    /// A start naming the session the row is already tracking. Nothing to
    /// forget: it is the same session, however it got re-announced.
    SameSession,
    /// The end that closes the turn that just reported `done`. In Copilot's
    /// non-interactive `-p` mode it follows `agentStop` by ~10 ms, and clearing
    /// there leaves a finished run with no state at all.
    AfterTheFinalDone,
}

type SessionKeepRule = (SessionKeep, fn(&SessionFacts<'_>) -> bool);

/// Rule 4's exceptions, tried in order. Every session event that matches none
/// of them resets the machine, which is rule 4 unchanged.
pub const SESSION_KEEP_RULES: &[SessionKeepRule] = &[
    (SessionKeep::OpenedByThisPrompt, |facts| {
        facts.event.session_phase == Some("start")
            && facts.event.session_opened_by_prompt
            && facts.current.state.as_deref() == Some(WORKING)
            && within(facts.now, facts.memory.turn_started_at)
            // A start that names a session the row is not running is a real
            // new session, however it was opened, and rule 4 applies to it.
            && (facts.current.session_id.is_none()
                || facts.event.session_id == facts.current.session_id)
    }),
    (SessionKeep::SameSession, |facts| {
        facts.event.session_phase == Some("start")
            && facts.current.state.is_some()
            && facts.event.session_id.is_some()
            && facts.event.session_id == facts.current.session_id
    }),
    (SessionKeep::AfterTheFinalDone, |facts| {
        facts.event.session_phase == Some("end")
            && facts.current.state.as_deref() == Some(DONE)
            && within(facts.now, facts.memory.done_at)
    }),
];

/// The first exception that matches, or `None` for a plain rule 4 reset.
pub fn session_keep(facts: &SessionFacts<'_>) -> Option<SessionKeep> {
    SESSION_KEEP_RULES
        .iter()
        .find(|(_, matches)| matches(facts))
        .map(|(keep, _)| *keep)
}

fn within(now: DateTime<Utc>, mark: Option<DateTime<Utc>>) -> bool {
    mark.is_some_and(|mark| now - mark < Duration::seconds(SESSION_ECHO_SECONDS))
}

/// What to write and publish. `None` from [`reduce`] means "nothing changed" —
/// the report is still accepted, it simply says nothing new.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Next {
    pub state: Option<String>,
    /// Which channel produced this state. It follows the state rather than the
    /// row: a report that changes nothing changes no source either, and a
    /// report the reducer drops (a late `working` inside the holdoff) leaves
    /// the previous channel standing, because the state it described is the one
    /// still on screen.
    pub state_source: Option<String>,
    pub unread: bool,
    pub session_id: Option<String>,
    pub pending_id: Option<String>,
    pub transcript_path: Option<String>,
    pub session_phase: Option<String>,
    pub last_message: Option<String>,
    /// How the turn that just reached `done` ended. `None` while a turn is
    /// open, so the UI can tell "still running" from "finished cleanly".
    pub errored: Option<bool>,
    pub interrupted: Option<bool>,
}

pub fn reduce(
    now: DateTime<Utc>,
    current: &Current,
    memory: &mut Memory,
    event: &AgentEvent,
) -> Option<Next> {
    // Rule 5: a subagent card is not the parent's state.
    if event.kind.is_subagent() {
        return None;
    }

    // Carrying facts forward is the default; only what the event speaks about
    // is replaced.
    let mut next = Next {
        state: current.state.clone(),
        state_source: event
            .state_source
            .map(str::to_owned)
            .or_else(|| current.state_source.clone()),
        unread: current.unread,
        session_id: event
            .session_id
            .clone()
            .or_else(|| current.session_id.clone()),
        pending_id: current.pending_id.clone(),
        transcript_path: event
            .transcript_path
            .clone()
            .or_else(|| current.transcript_path.clone()),
        session_phase: current.session_phase.clone(),
        last_message: event.last_message.clone(),
        errored: current.errored,
        interrupted: current.interrupted,
    };

    if event.kind == EventKind::Session {
        next.session_phase = event.session_phase.map(str::to_owned);
        // The exceptions first: a session event that is talking about the turn
        // already on the row moves the phase and nothing else.
        if session_keep(&SessionFacts {
            now,
            current,
            memory,
            event,
        })
        .is_some()
        {
            return Some(next);
        }
        // Rule 4. A new session forgets the old turn entirely: no pending
        // approval, no open question, no just-finished holdoff.
        *memory = Memory::default();
        next.state = None;
        next.pending_id = None;
        next.errored = None;
        next.interrupted = None;
        return Some(next);
    }

    // Nothing to say about the state: a report that only carries identity.
    let target = event.state?;

    // Rule 2: the idle notification is a rescue, not a report.
    if event.idle == Some(true) && current.state.as_deref() != Some("working") {
        return None;
    }

    // Rule 1: a stale row was never live, so it gets no holdoff.
    if event.new_turn != Some(true)
        && target == "working"
        && current.state.as_deref() == Some(DONE)
        && !current.restored
        && memory
            .done_at
            .is_some_and(|done_at| now - done_at < Duration::seconds(DONE_HOLDOFF_SECONDS))
    {
        return None;
    }

    if event.new_turn == Some(true) {
        // A new turn answers whatever the last one was waiting on.
        memory.awaiting_input = false;
        memory.done_at = None;
        memory.turn_started_at = Some(now);
        next.pending_id = None;
    }
    if event.awaiting_input == Some(true) {
        memory.awaiting_input = true;
    }

    // Rule 3: an unanswered question outranks the end of its own turn.
    let target = if target == DONE && memory.awaiting_input {
        WAITING
    } else {
        target
    };

    match target {
        DONE => {
            memory.done_at = Some(now);
            // The badge is what makes a finished node findable on a big canvas;
            // only the client's read receipt clears it.
            // A synthetic close for a dead terminal raises no badge: there is
            // nothing to read that the terminal's own exit does not already
            // show. It does not *clear* an existing one either — output from an
            // earlier turn is still unread, and only the receipt says otherwise.
            if !event.silent {
                next.unread = true;
            }
            next.pending_id = None;
            // A `done` always carries a verdict, even when the event says
            // nothing: silence from `Stop` means the turn ended cleanly.
            next.errored = Some(event.errored.unwrap_or(false));
            next.interrupted = Some(event.interrupted.unwrap_or(false));
        }
        "blocked" => {
            next.pending_id = event
                .pending_id
                .clone()
                .or_else(|| current.pending_id.clone());
        }
        WAITING => {
            next.pending_id = event.pending_id.clone().or(next.pending_id);
            // A question is part of a turn that has not ended yet — including
            // the `done` that rule 3 just rewrote.
            next.errored = None;
            next.interrupted = None;
        }
        _ => {
            // Working again: whatever was blocking is resolved, and the last
            // turn's verdict no longer describes what the node is doing.
            next.pending_id = None;
            next.errored = None;
            next.interrupted = None;
        }
    }
    next.state = Some(target.to_owned());
    Some(next)
}

/// The synthetic event the 60s sweep applies to a node that stopped reporting.
/// It goes through [`reduce`] like any other event so the invariants (an open
/// question still wins) hold for it too.
pub fn stale_event(node_id: &str, agent_id: &str) -> AgentEvent {
    let mut event = AgentEvent::state(node_id, agent_id, DONE);
    event.errored = Some(false);
    event.interrupted = Some(false);
    event.last_message = Some(format!(
        "stale=true no hook report for {STALE_WORKING_MINUTES} minutes"
    ));
    event
}

/// The synthetic event for a node whose terminal died mid-turn.
///
/// A plain clean end. `interrupted` is deliberately *not* reused for it: that
/// flag means the user stopped the agent (Esc, `Interrupt`), and overloading it
/// with "the terminal went away" would make the PAUSED pill mean two different
/// things. The cause is carried by the `terminated=true` marker instead, which
/// a client can match on if it wants distinct wording.
pub fn terminal_gone_event(node_id: &str, agent_id: &str) -> AgentEvent {
    let mut event = AgentEvent::state(node_id, agent_id, DONE);
    event.errored = Some(false);
    event.interrupted = Some(false);
    event.silent = true;
    event.last_message = Some("terminated=true the terminal exited before the turn ended".into());
    event
}
