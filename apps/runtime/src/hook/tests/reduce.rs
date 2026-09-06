//! The state machine in `hook::reduce`, driven directly.
//!
//! These are unit tests rather than route tests: the reducer's invariants are
//! about *ordering and timing*, and expressing "this event landed 20 ms after
//! that one" is only honest with the clock in hand.

use chrono::{DateTime, Utc};

use crate::hook::normalize::{AgentEvent, BLOCKED, DONE, EventKind, WAITING, WORKING};
use crate::hook::reduce::*;

fn at(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
}

/// The same clock in milliseconds. Copilot's session events sit 10-20 ms from
/// the state event they belong to, and a second-resolution helper cannot say
/// that at all.
fn at_ms(millis: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(1_800_000_000_000 + millis).unwrap()
}

/// A Copilot `sessionStart`, optionally the kind its first prompt creates.
fn session_start(session_id: &str, opened_by_prompt: bool) -> AgentEvent {
    let mut event = AgentEvent::new("n", "copilot", EventKind::Session);
    event.session_phase = Some("start");
    event.session_id = Some(session_id.to_owned());
    event.session_opened_by_prompt = opened_by_prompt;
    event
}

fn session_end(session_id: &str) -> AgentEvent {
    let mut event = AgentEvent::new("n", "copilot", EventKind::Session);
    event.session_phase = Some("end");
    event.session_id = Some(session_id.to_owned());
    event
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
        ..Memory::default()
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

/// The source travels with the state it describes, which is what makes the
/// pair readable: a node drawn as `done` and a node drawn as `done
/// (observed)` are two different claims, and the second must not silently
/// become the first because a later report forgot to say.
#[test]
fn the_state_source_follows_the_state_it_describes() {
    let mut memory = Memory::default();
    let mut event = working("n");
    event.new_turn = Some(true);
    event.state_source = Some(crate::agent::STATE_SOURCE_HOOK);
    let next = reduce(at(0), &Current::default(), &mut memory, &event).unwrap();
    assert_eq!(next.state_source.as_deref(), Some("hook"));

    // A synthetic close — the sweep, a dead terminal — names no channel, so
    // the row keeps the one that last reported. Blanking it here would make
    // every swept node look like one that never had an adapter.
    let reported = Current {
        state: Some(WORKING.into()),
        state_source: Some("hook".into()),
        ..Current::default()
    };
    let next = reduce(at(1), &reported, &mut memory, &stale_event("n", "claude")).unwrap();
    assert_eq!(next.state.as_deref(), Some(DONE));
    assert_eq!(next.state_source.as_deref(), Some("hook"));

    // A CLI that changed channel says so, and the newer answer wins.
    let mut settled = AgentEvent::state("n", "claude", DONE);
    settled.state_source = Some(crate::agent::STATE_SOURCE_EXTENSION);
    let next = reduce(at(2), &reported, &mut memory, &settled).unwrap();
    assert_eq!(next.state_source.as_deref(), Some("extension"));

    // A session reset is still a report from the channel that sent it.
    let mut session = AgentEvent::new("n", "claude", EventKind::Session);
    session.session_phase = Some("start");
    session.state_source = Some(crate::agent::STATE_SOURCE_HOOK);
    let next = reduce(at(3), &reported, &mut memory, &session).unwrap();
    assert!(next.state.is_none());
    assert_eq!(next.state_source.as_deref(), Some("hook"));
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

/// Copilot CLI 1.0.83 creates the session *from* the first prompt, so its
/// `sessionStart` lands ~20 ms **after** that turn's `userPromptSubmitted` and
/// echoes the prompt back as `initialPrompt`. Rule 4 read that as a new session
/// and blanked the `working` the prompt had just written, which is why a
/// Copilot node showed no state at all through its first turn.
#[test]
fn a_session_started_by_the_prompt_in_flight_keeps_that_turn() {
    let mut memory = Memory::default();

    let mut prompt = AgentEvent::state("n", "copilot", WORKING);
    prompt.new_turn = Some(true);
    prompt.session_id = Some("s-1".into());
    let next = reduce(at_ms(0), &Current::default(), &mut memory, &prompt).unwrap();
    assert_eq!(next.state.as_deref(), Some(WORKING));

    let started = Current {
        state: next.state.clone(),
        session_id: next.session_id.clone(),
        ..Current::default()
    };
    let next = reduce(
        at_ms(20),
        &started,
        &mut memory,
        &session_start("s-1", true),
    )
    .unwrap();
    assert_eq!(
        next.state.as_deref(),
        Some(WORKING),
        "the start that opened this very turn must not reset it"
    );
    assert_eq!(next.session_phase.as_deref(), Some("start"));
    assert_eq!(next.session_id.as_deref(), Some("s-1"));
    assert!(
        memory.turn_started_at.is_some(),
        "the turn is still open, so its clock still runs"
    );
}

/// The non-interactive `-p` shape: `sessionEnd` follows `agentStop` by ~10 ms.
/// Resetting on it left a finished run with no state at all — neither the
/// `done` pill nor the unread badge survived.
#[test]
fn the_end_that_follows_the_final_stop_keeps_the_done() {
    let mut memory = Memory::default();

    let mut prompt = AgentEvent::state("n", "copilot", WORKING);
    prompt.new_turn = Some(true);
    prompt.session_id = Some("s-1".into());
    reduce(at_ms(0), &Current::default(), &mut memory, &prompt).unwrap();

    let working_now = Current {
        state: Some(WORKING.into()),
        session_id: Some("s-1".into()),
        ..Current::default()
    };
    let mut stop = AgentEvent::state("n", "copilot", DONE);
    stop.session_id = Some("s-1".into());
    let next = reduce(at_ms(4_000), &working_now, &mut memory, &stop).unwrap();
    assert_eq!(next.state.as_deref(), Some(DONE));
    assert!(next.unread);

    let finished = Current {
        state: next.state.clone(),
        unread: next.unread,
        session_id: next.session_id.clone(),
        errored: next.errored,
        interrupted: next.interrupted,
        ..Current::default()
    };
    let next = reduce(at_ms(4_010), &finished, &mut memory, &session_end("s-1")).unwrap();
    assert_eq!(
        next.state.as_deref(),
        Some(DONE),
        "the end of the session is not the unwinding of the turn it just ran"
    );
    assert_eq!(next.session_phase.as_deref(), Some("end"));
    assert_eq!(next.errored, Some(false));
    assert!(next.unread, "and the finished turn is still unread");
}

/// One row of rule 4's exception table.
struct SessionCase<'a> {
    /// What the row is, in the words the failure message should use.
    name: &'a str,
    now: DateTime<Utc>,
    current: &'a Current,
    memory: &'a Memory,
    event: AgentEvent,
    keep: Option<SessionKeep>,
}

/// The exceptions as a table. The `None` rows are the majority on purpose — an
/// exception that fired more often than these would be the old bug wearing the
/// opposite sign.
#[test]
fn the_session_exceptions_match_only_what_they_name() {
    let live = Current {
        state: Some(WORKING.into()),
        session_id: Some("s-1".into()),
        ..Current::default()
    };
    let nameless = Current {
        state: Some(WORKING.into()),
        ..Current::default()
    };
    let finished = Current {
        state: Some(DONE.into()),
        session_id: Some("s-1".into()),
        ..Current::default()
    };
    let idle = Current::default();
    let fresh = Memory {
        turn_started_at: Some(at_ms(0)),
        ..Memory::default()
    };
    let just_done = Memory {
        done_at: Some(at_ms(0)),
        ..Memory::default()
    };
    let stale_turn = Memory {
        turn_started_at: Some(at_ms(-60_000)),
        ..Memory::default()
    };

    let cases = [
        SessionCase {
            name: "the start the prompt in flight created",
            now: at_ms(20),
            current: &live,
            memory: &fresh,
            event: session_start("s-1", true),
            keep: Some(SessionKeep::OpenedByThisPrompt),
        },
        SessionCase {
            name: "that same start before the row has learned any session id",
            now: at_ms(20),
            current: &nameless,
            memory: &fresh,
            event: session_start("s-1", true),
            keep: Some(SessionKeep::OpenedByThisPrompt),
        },
        SessionCase {
            name: "a start naming the session the row already tracks",
            now: at_ms(20),
            current: &live,
            memory: &fresh,
            event: session_start("s-1", false),
            keep: Some(SessionKeep::SameSession),
        },
        SessionCase {
            name: "the end that follows the turn's own stop",
            now: at_ms(10),
            current: &finished,
            memory: &just_done,
            event: session_end("s-1"),
            keep: Some(SessionKeep::AfterTheFinalDone),
        },
        SessionCase {
            name: "a genuinely new session, even one its own prompt opened",
            now: at_ms(20),
            current: &live,
            memory: &fresh,
            event: session_start("s-2", true),
            keep: None,
        },
        SessionCase {
            name: "a start that found a turn left over from a CLI already gone",
            now: at_ms(20),
            current: &live,
            memory: &stale_turn,
            event: session_start("s-2", true),
            keep: None,
        },
        SessionCase {
            name: "an end long after the turn it is closing",
            now: at_ms(10_000),
            current: &finished,
            memory: &just_done,
            event: session_end("s-1"),
            keep: None,
        },
        SessionCase {
            name: "an end while the turn is still running",
            now: at_ms(10),
            current: &live,
            memory: &just_done,
            event: session_end("s-1"),
            keep: None,
        },
        SessionCase {
            name: "a start on an idle row, which is rule 4 with nothing to keep",
            now: at_ms(20),
            current: &idle,
            memory: &fresh,
            event: session_start("s-1", true),
            keep: None,
        },
    ];

    for case in &cases {
        assert_eq!(
            session_keep(&SessionFacts {
                now: case.now,
                current: case.current,
                memory: case.memory,
                event: &case.event,
            }),
            case.keep,
            "{}",
            case.name
        );
    }
}
/// The other providers announce their session before any work, so none of the
/// exceptions can fire for them: a start that names a session the row does not
/// know still resets, which is what every existing provider case asserts.
#[test]
fn a_start_that_names_an_unknown_session_still_resets() {
    let mut memory = Memory {
        done_at: Some(at(0)),
        turn_started_at: Some(at(0)),
        awaiting_input: true,
    };
    let live = Current {
        state: Some(WORKING.into()),
        session_id: Some("s-1".into()),
        ..Current::default()
    };
    let mut session = AgentEvent::new("n", "claude", EventKind::Session);
    session.session_phase = Some("start");
    session.session_id = Some("s-2".into());
    let next = reduce(at(1), &live, &mut memory, &session).unwrap();
    assert!(next.state.is_none());
    assert!(memory.turn_started_at.is_none());

    // And a start that names nothing at all is not "the same session" as a row
    // that names nothing either.
    let mut anonymous = AgentEvent::new("n", "claude", EventKind::Session);
    anonymous.session_phase = Some("start");
    let mut memory = Memory {
        turn_started_at: Some(at(0)),
        ..Memory::default()
    };
    let next = reduce(at(1), &current(WORKING), &mut memory, &anonymous).unwrap();
    assert!(next.state.is_none());
}
