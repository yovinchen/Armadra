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
//!    than set one; a fresh CLI is idle, not done.
//! 5. **subagent isolation** — subagent events describe a child, never the
//!    parent's state.
//!
//! `restored` is the sixth: a row read back from SQLite after a restart is not
//! live knowledge, so it never gets the benefit of the holdoff and its `done`
//! is not a fresh one.

use chrono::{DateTime, Duration, Utc};

use super::normalize::{AgentEvent, DONE, EventKind, WAITING};

/// A `working` that lands within this window after a `done` is discarded unless
/// it opens a new turn.
pub const DONE_HOLDOFF_SECONDS: i64 = 3;
/// A `working` node that has not reported for this long is swept to `done`.
pub const STALE_WORKING_MINUTES: i64 = 20;

/// The row as it stands before the event is applied.
#[derive(Debug, Clone, Default)]
pub struct Current {
    pub state: Option<String>,
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
    pub awaiting_input: bool,
}

/// What to write and publish. `None` from [`reduce`] means "nothing changed" —
/// the report is still accepted, it simply says nothing new.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Next {
    pub state: Option<String>,
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
        // Rule 4. A new session forgets the old turn entirely: no pending
        // approval, no open question, no just-finished holdoff.
        *memory = Memory::default();
        next.state = None;
        next.pending_id = None;
        next.errored = None;
        next.interrupted = None;
        next.session_phase = event.session_phase.map(str::to_owned);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::normalize::{BLOCKED, WORKING};

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    fn working(node: &str) -> AgentEvent {
        AgentEvent::state(node, "claude", WORKING)
    }

    fn current(state: &str) -> Current {
        Current {
            state: Some(state.to_owned()),
            ..Current::default()
        }
    }

    #[test]
    fn a_plain_turn_walks_working_to_done_and_marks_unread() {
        let mut memory = Memory::default();
        let mut event = working("n");
        event.new_turn = Some(true);
        let next = reduce(at(0), &Current::default(), &mut memory, &event).unwrap();
        assert_eq!(next.state.as_deref(), Some(WORKING));
        assert!(!next.unread);

        let done = AgentEvent::state("n", "claude", DONE);
        let next = reduce(at(1), &current(WORKING), &mut memory, &done).unwrap();
        assert_eq!(next.state.as_deref(), Some(DONE));
        assert!(
            next.unread,
            "a finished node is unread until a client says otherwise"
        );
        assert!(memory.done_at.is_some());
    }

    #[test]
    fn a_late_working_cannot_revive_a_just_finished_turn() {
        let mut memory = Memory {
            done_at: Some(at(0)),
            ..Memory::default()
        };
        let finished = Current {
            state: Some(DONE.into()),
            unread: true,
            ..Current::default()
        };
        // Inside the holdoff: dropped.
        assert!(reduce(at(2), &finished, &mut memory, &working("n")).is_none());
        // A new turn is always allowed through, however soon it arrives.
        let mut fresh = working("n");
        fresh.new_turn = Some(true);
        assert_eq!(
            reduce(at(2), &finished, &mut memory, &fresh)
                .unwrap()
                .state
                .as_deref(),
            Some(WORKING)
        );
        // Past the holdoff a plain working is real work again.
        let mut memory = Memory {
            done_at: Some(at(0)),
            ..Memory::default()
        };
        assert_eq!(
            reduce(at(4), &finished, &mut memory, &working("n"))
                .unwrap()
                .state
                .as_deref(),
            Some(WORKING)
        );
    }

    #[test]
    fn a_restored_done_gets_no_holdoff() {
        // After a restart the row is old news: the first live report wins.
        let mut memory = Memory {
            done_at: Some(at(0)),
            ..Memory::default()
        };
        let restored = Current {
            state: Some(DONE.into()),
            restored: true,
            ..Current::default()
        };
        assert_eq!(
            reduce(at(1), &restored, &mut memory, &working("n"))
                .unwrap()
                .state
                .as_deref(),
            Some(WORKING)
        );
    }

    #[test]
    fn the_idle_rescue_only_fires_from_working() {
        let mut idle = AgentEvent::state("n", "claude", DONE);
        idle.idle = Some(true);

        let mut memory = Memory::default();
        assert_eq!(
            reduce(at(0), &current(WORKING), &mut memory, &idle)
                .unwrap()
                .state
                .as_deref(),
            Some(DONE)
        );

        for state in [BLOCKED, WAITING, DONE] {
            let mut memory = Memory::default();
            assert!(
                reduce(at(0), &current(state), &mut memory, &idle).is_none(),
                "idle must not touch {state}"
            );
        }
        // A node that never reported has nothing to rescue either.
        let mut memory = Memory::default();
        assert!(reduce(at(0), &Current::default(), &mut memory, &idle).is_none());
    }

    #[test]
    fn an_open_question_rewrites_the_done_that_ends_its_turn() {
        let mut memory = Memory::default();
        let mut question = AgentEvent::state("n", "claude", WAITING);
        question.awaiting_input = Some(true);
        question.ask_kind = Some("AskUserQuestion".into());
        let next = reduce(at(0), &current(WORKING), &mut memory, &question).unwrap();
        assert_eq!(next.state.as_deref(), Some(WAITING));
        assert!(memory.awaiting_input);

        let done = AgentEvent::state("n", "claude", DONE);
        let next = reduce(at(1), &current(WAITING), &mut memory, &done).unwrap();
        assert_eq!(
            next.state.as_deref(),
            Some(WAITING),
            "the CLI is still sitting at a prompt"
        );
        assert!(!next.unread, "waiting is not a finished turn");

        // The answer arrives as the next turn, which releases the hold.
        let mut answered = working("n");
        answered.new_turn = Some(true);
        let next = reduce(at(2), &current(WAITING), &mut memory, &answered).unwrap();
        assert_eq!(next.state.as_deref(), Some(WORKING));
        assert!(!memory.awaiting_input);

        let next = reduce(at(3), &current(WORKING), &mut memory, &done).unwrap();
        assert_eq!(next.state.as_deref(), Some(DONE));
        assert!(next.unread);
    }

    #[test]
    fn blocking_stores_the_pending_id_and_working_clears_it() {
        let mut memory = Memory::default();
        let mut blocked = AgentEvent::state("n", "claude", BLOCKED);
        blocked.pending_id = Some("p-1".into());
        let next = reduce(at(0), &current(WORKING), &mut memory, &blocked).unwrap();
        assert_eq!(next.state.as_deref(), Some(BLOCKED));
        assert_eq!(next.pending_id.as_deref(), Some("p-1"));

        let blocked_now = Current {
            state: Some(BLOCKED.into()),
            pending_id: Some("p-1".into()),
            ..Current::default()
        };
        let next = reduce(at(1), &blocked_now, &mut memory, &working("n")).unwrap();
        assert_eq!(next.state.as_deref(), Some(WORKING));
        assert!(next.pending_id.is_none(), "the approval was resolved");
    }

    #[test]
    fn a_session_event_resets_the_machine() {
        let mut memory = Memory {
            done_at: Some(at(0)),
            awaiting_input: true,
        };
        let mut session = AgentEvent::new("n", "claude", EventKind::Session);
        session.session_phase = Some("start");
        session.session_id = Some("s-2".into());
        session.transcript_path = Some("/tmp/t.jsonl".into());
        let blocked_now = Current {
            state: Some(BLOCKED.into()),
            pending_id: Some("p-1".into()),
            unread: true,
            ..Current::default()
        };
        let next = reduce(at(1), &blocked_now, &mut memory, &session).unwrap();
        assert!(next.state.is_none(), "a fresh session is idle, not done");
        assert!(next.pending_id.is_none());
        assert_eq!(next.session_id.as_deref(), Some("s-2"));
        assert_eq!(next.transcript_path.as_deref(), Some("/tmp/t.jsonl"));
        assert_eq!(next.session_phase.as_deref(), Some("start"));
        assert!(
            next.unread,
            "the reset does not read the badge for the user"
        );
        assert!(!memory.awaiting_input);
        assert!(memory.done_at.is_none());
    }

    #[test]
    fn subagent_events_never_touch_the_main_state() {
        for kind in [EventKind::SubagentStart, EventKind::SubagentEnd] {
            let mut memory = Memory::default();
            let mut event = AgentEvent::new("n", "claude", kind);
            event.tool_use_id = Some("tu-1".into());
            assert!(reduce(at(0), &current(WORKING), &mut memory, &event).is_none());
            assert!(memory.done_at.is_none());
        }
    }

    #[test]
    fn facts_the_event_is_silent_about_are_carried_forward() {
        let mut memory = Memory::default();
        let established = Current {
            state: Some(WORKING.into()),
            session_id: Some("s-1".into()),
            transcript_path: Some("/tmp/a.jsonl".into()),
            ..Current::default()
        };
        let next = reduce(
            at(0),
            &established,
            &mut memory,
            &AgentEvent::state("n", "claude", DONE),
        )
        .unwrap();
        assert_eq!(next.session_id.as_deref(), Some("s-1"));
        assert_eq!(next.transcript_path.as_deref(), Some("/tmp/a.jsonl"));
    }

    /// Deliberate, and easy to "fix" by accident: a new turn does NOT clear the
    /// unread badge. The badge means "this node produced something you have not
    /// looked at", and starting another turn is not looking at it.
    ///
    /// The case that decides it is §5.7 delivery: an agent may only message a
    /// target that is `done`, and delivery writes into the target's PTY, which
    /// opens a new turn. Clearing here would silently drop the badge in exactly
    /// the situation where no human has seen the result. Same for a §5.8
    /// `--after` pending launch. Only `POST /api/agent-status/{nodeId}/read`
    /// clears it, because only a client knows the user actually looked.
    #[test]
    fn a_new_turn_does_not_clear_the_unread_badge() {
        let mut memory = Memory::default();
        let unseen = Current {
            state: Some(DONE.into()),
            unread: true,
            ..Current::default()
        };

        let mut fresh = working("n");
        fresh.new_turn = Some(true);
        let next = reduce(at(10), &unseen, &mut memory, &fresh).unwrap();
        assert_eq!(next.state.as_deref(), Some(WORKING));
        assert!(
            next.unread,
            "the previous turn's result is still unread while the next one runs"
        );

        // Still unread through a whole second turn, and a second `done` keeps it
        // raised rather than double-counting it.
        let running = Current {
            state: Some(WORKING.into()),
            unread: true,
            ..Current::default()
        };
        let next = reduce(
            at(11),
            &running,
            &mut memory,
            &AgentEvent::state("n", "claude", DONE),
        )
        .unwrap();
        assert!(next.unread);

        // A node the user already read stays read until something finishes.
        let seen = Current {
            state: Some(WORKING.into()),
            unread: false,
            ..Current::default()
        };
        let next = reduce(at(12), &seen, &mut memory, &working("n")).unwrap();
        assert!(!next.unread);
    }

    #[test]
    fn a_done_always_carries_a_verdict_and_the_next_turn_clears_it() {
        let mut memory = Memory::default();

        // A plain Stop says the turn ended cleanly — not that we do not know.
        let next = reduce(
            at(0),
            &current(WORKING),
            &mut memory,
            &AgentEvent::state("n", "claude", DONE),
        )
        .unwrap();
        assert_eq!(next.errored, Some(false));
        assert_eq!(next.interrupted, Some(false));

        // StopFailure and an Esc-interrupted turn are distinguishable.
        let mut failed = AgentEvent::state("n", "claude", DONE);
        failed.errored = Some(true);
        let next = reduce(at(1), &current(WORKING), &mut memory, &failed).unwrap();
        assert_eq!(next.errored, Some(true));
        assert_eq!(next.interrupted, Some(false));

        let mut stopped = AgentEvent::state("n", "claude", DONE);
        stopped.interrupted = Some(true);
        let next = reduce(at(2), &current(WORKING), &mut memory, &stopped).unwrap();
        assert_eq!(next.errored, Some(false));
        assert_eq!(next.interrupted, Some(true));

        // The verdict belongs to the turn that produced it: opening a new one
        // clears it, so the pill never shows TURN FAILED over live work.
        let failed_now = Current {
            state: Some(DONE.into()),
            errored: Some(true),
            interrupted: Some(true),
            ..Current::default()
        };
        let mut fresh = working("n");
        fresh.new_turn = Some(true);
        let next = reduce(at(6), &failed_now, &mut memory, &fresh).unwrap();
        assert_eq!(next.state.as_deref(), Some(WORKING));
        assert!(next.errored.is_none());
        assert!(next.interrupted.is_none());

        // So does a plain working, a block, and a session reset.
        let next = reduce(at(7), &failed_now, &mut memory, &working("n")).unwrap();
        assert!(next.errored.is_none());
        let mut session = AgentEvent::new("n", "claude", EventKind::Session);
        session.session_phase = Some("start");
        let next = reduce(at(8), &failed_now, &mut memory, &session).unwrap();
        assert!(next.errored.is_none());
        assert!(next.interrupted.is_none());
    }

    #[test]
    fn a_verdict_survives_a_report_that_says_nothing_about_it() {
        // A late PostToolUse inside the holdoff is dropped entirely, so the
        // finished turn keeps its verdict; a blocked report carries it forward
        // rather than inventing a clean end.
        let failed_now = Current {
            state: Some(DONE.into()),
            errored: Some(true),
            interrupted: Some(false),
            ..Current::default()
        };
        let mut memory = Memory {
            done_at: Some(at(0)),
            ..Memory::default()
        };
        assert!(reduce(at(1), &failed_now, &mut memory, &working("n")).is_none());

        let mut blocked = AgentEvent::state("n", "claude", BLOCKED);
        blocked.pending_id = Some("p-1".into());
        // `blocked` is a state the reducer reaches from a *live* turn, so the
        // stale verdict is carried, not cleared, and the next done overwrites it.
        let next = reduce(at(5), &failed_now, &mut memory, &blocked).unwrap();
        assert_eq!(next.errored, Some(true));
    }

    #[test]
    fn an_open_question_has_no_verdict_yet() {
        // Rule 3 rewrites the turn-ending `done` to `waiting`; that is not an
        // outcome, so the pill must not claim the turn finished cleanly.
        let mut memory = Memory {
            awaiting_input: true,
            ..Memory::default()
        };
        let next = reduce(
            at(0),
            &current(WORKING),
            &mut memory,
            &AgentEvent::state("n", "claude", DONE),
        )
        .unwrap();
        assert_eq!(next.state.as_deref(), Some(WAITING));
        assert!(next.errored.is_none());
        assert!(next.interrupted.is_none());
    }

    #[test]
    fn the_terminal_gone_event_is_a_clean_end_that_raises_no_badge() {
        let event = terminal_gone_event("n", "claude");
        assert_eq!(event.state, Some(DONE));
        assert_eq!(event.errored, Some(false));
        assert_eq!(
            event.interrupted,
            Some(false),
            "`interrupted` means the user stopped the agent, not that the PTY died"
        );
        assert!(event.silent);
        assert!(
            event
                .last_message
                .as_deref()
                .unwrap()
                .starts_with("terminated=true")
        );
        // The control flag is ours alone: it must never appear on the wire, and
        // no hook client can set it.
        let json = serde_json::to_value(&event).unwrap();
        assert!(json.get("silent").is_none());

        let mut memory = Memory::default();
        let next = reduce(at(0), &current(WORKING), &mut memory, &event).unwrap();
        assert_eq!(next.state.as_deref(), Some(DONE));
        assert!(!next.unread, "a dead terminal leaves nothing new to read");

        // But it does not clear a badge an earlier turn raised.
        let unseen = Current {
            state: Some(WORKING.into()),
            unread: true,
            ..Current::default()
        };
        let mut memory = Memory::default();
        assert!(reduce(at(1), &unseen, &mut memory, &event).unwrap().unread);

        // The 20-minute silence sweep is the opposite case: the agent may well
        // have produced output before it went quiet, so that one does badge.
        let mut memory = Memory::default();
        let stale = reduce(
            at(2),
            &current(WORKING),
            &mut memory,
            &stale_event("n", "claude"),
        )
        .unwrap();
        assert!(stale.unread);
    }

    #[test]
    fn the_sweep_event_closes_a_stuck_turn_but_still_yields_to_a_question() {
        let event = stale_event("n", "claude");
        assert_eq!(event.state, Some(DONE));
        assert_eq!(event.errored, Some(false));
        assert_eq!(event.interrupted, Some(false));
        assert!(
            event
                .last_message
                .as_deref()
                .unwrap()
                .contains("stale=true")
        );

        let mut memory = Memory::default();
        let next = reduce(at(0), &current(WORKING), &mut memory, &event).unwrap();
        assert_eq!(next.state.as_deref(), Some(DONE));
        assert!(next.unread);
        assert!(next.last_message.unwrap().contains("stale=true"));
        // A swept turn did not fail and was not interrupted; it just stopped
        // talking, and `lastMessage` is where that is said.
        assert_eq!(next.errored, Some(false));
        assert_eq!(next.interrupted, Some(false));

        let mut memory = Memory {
            awaiting_input: true,
            ..Memory::default()
        };
        assert_eq!(
            reduce(at(0), &current(WORKING), &mut memory, &event)
                .unwrap()
                .state
                .as_deref(),
            Some(WAITING)
        );
    }
}
