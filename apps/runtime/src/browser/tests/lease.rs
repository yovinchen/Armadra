//! The control lease's state machine, line by line against design §2.6.
//!
//! No Chrome and no clock: `Machine::request` takes `now`, so "the human went
//! idle for eleven seconds" is a value rather than a `sleep`.

use chrono::{DateTime, Duration, Utc};

use crate::browser::{
    LeaseState,
    session::lease::{
        AGENT_IDLE_SECONDS, Actor, Grant, HUMAN_IDLE_SECONDS, LEASE_GENERATION,
        LEASE_HELD_BY_AGENT, LEASE_HELD_BY_HUMAN, LEASE_REVOKED, Machine,
    },
};

fn t0() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-09-06T09:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn human() -> Actor {
    Actor::human("device-a", "Laptop")
}

fn other_human() -> Actor {
    Actor::human("device-b", "Phone")
}

fn agent() -> Actor {
    Actor::agent("node-7", "sess-7", "Claude")
}

#[test]
fn a_free_lease_goes_to_whoever_asks_first() {
    let mut machine = Machine::resuming(4);
    assert_eq!(machine.request(&agent(), t0(), None), Grant::Granted);
    assert_eq!(machine.state(), LeaseState::Agent);
    // The generation continues from the stored counter rather than from zero,
    // so a client that slept through a restart cannot present a live number.
    assert_eq!(machine.generation(), 5);
}

#[test]
fn the_holder_renewing_does_not_change_hands() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    let generation = machine.generation();
    assert_eq!(
        machine.request(&agent(), t0() + Duration::seconds(1), None),
        Grant::Granted
    );
    assert_eq!(
        machine.generation(),
        generation,
        "a renewal is not a change"
    );
}

#[test]
fn an_agent_waits_behind_a_person_who_is_typing() {
    let mut machine = Machine::resuming(0);
    machine.request(&human(), t0(), None);
    assert_eq!(machine.request(&agent(), t0(), None), Grant::Queue);
}

#[test]
fn an_idle_person_releases_the_lease_without_being_asked() {
    let mut machine = Machine::resuming(0);
    machine.request(&human(), t0(), None);
    let later = t0() + Duration::seconds(HUMAN_IDLE_SECONDS + 1);
    assert_eq!(machine.request(&agent(), later, None), Grant::Granted);
    assert_eq!(machine.state(), LeaseState::Agent);
}

#[test]
fn an_idle_agent_holds_on_longer_than_a_person() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    let between = t0() + Duration::seconds(HUMAN_IDLE_SECONDS + 1);
    assert!(between < t0() + Duration::seconds(AGENT_IDLE_SECONDS));
    // Still the agent's — a person's window does not apply to it.
    assert_eq!(machine.request(&agent(), between, None), Grant::Granted);
    assert_eq!(machine.state(), LeaseState::Agent);
}

#[test]
fn a_persons_ordinary_input_preempts_an_agent() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    let generation = machine.generation();
    assert_eq!(machine.request(&human(), t0(), None), Grant::Granted);
    assert_eq!(machine.state(), LeaseState::Human);
    assert_eq!(machine.generation(), generation + 1);
    // The agent's next action is told, rather than landing one more click.
    assert_eq!(machine.request(&agent(), t0(), None), Grant::Queue);
}

#[test]
fn a_takeover_revokes_the_agents_lease_outright() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    let revoked = machine.takeover(&human(), t0()).expect("an agent held it");
    assert_eq!(revoked.kind, "agent");
    assert_eq!(revoked.id, "node-7");
    assert_eq!(machine.state(), LeaseState::HumanTakeover);
    assert_eq!(
        machine.request(&agent(), t0(), None),
        Grant::Refused(LEASE_REVOKED),
        "a takeover is not something an agent queues behind"
    );
}

#[test]
fn a_takeover_does_not_lapse_on_its_own() {
    let mut machine = Machine::resuming(0);
    machine.takeover(&human(), t0());
    let much_later = t0() + Duration::seconds(HUMAN_IDLE_SECONDS * 100);
    assert_eq!(
        machine.request(&agent(), much_later, None),
        Grant::Refused(LEASE_REVOKED),
        "it is held until somebody hands it back"
    );
    assert_eq!(machine.snapshot().expires_at, "");
}

#[test]
fn handing_back_a_takeover_frees_the_lease() {
    let mut machine = Machine::resuming(0);
    machine.takeover(&human(), t0());
    machine.release(&human()).unwrap();
    assert_eq!(machine.state(), LeaseState::Free);
    assert_eq!(machine.request(&agent(), t0(), None), Grant::Granted);
}

#[test]
fn only_the_holder_may_release_it() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    assert!(machine.release(&human()).is_err());
    assert_eq!(machine.state(), LeaseState::Agent);
}

#[test]
fn another_device_cannot_click_over_a_deliberate_takeover() {
    let mut machine = Machine::resuming(0);
    machine.takeover(&human(), t0());
    assert_eq!(
        machine.request(&other_human(), t0(), None),
        Grant::Refused(LEASE_HELD_BY_HUMAN)
    );
    // Ordinary input between two people is last-touch-wins, though.
    let mut machine = Machine::resuming(0);
    machine.request(&human(), t0(), None);
    assert_eq!(machine.request(&other_human(), t0(), None), Grant::Granted);
}

#[test]
fn agents_do_not_queue_behind_each_other() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    let second = Actor::agent("node-9", "sess-9", "Codex");
    assert_eq!(
        machine.request(&second, t0(), None),
        Grant::Refused(LEASE_HELD_BY_AGENT)
    );
}

#[test]
fn a_stale_generation_is_refused_before_anything_else() {
    let mut machine = Machine::resuming(0);
    machine.request(&human(), t0(), None);
    let current = machine.generation();
    assert_eq!(
        machine.request(&human(), t0(), Some(current - 1)),
        Grant::Refused(LEASE_GENERATION)
    );
    assert_eq!(
        machine.request(&human(), t0(), Some(current)),
        Grant::Granted
    );
}

#[test]
fn the_snapshot_names_the_holder_for_the_badge() {
    let mut machine = Machine::resuming(0);
    machine.request(&agent(), t0(), None);
    let snapshot = machine.snapshot();
    assert_eq!(snapshot.state, LeaseState::Agent);
    let holder = snapshot.holder.expect("an agent holds it");
    assert_eq!(holder.kind, "agent");
    assert_eq!(holder.id, "node-7");
    assert_eq!(holder.display_name, "Claude");
    assert!(!snapshot.expires_at.is_empty(), "an agent lease lapses");
    let json = serde_json::to_value(machine.snapshot()).unwrap();
    assert_eq!(json["state"], "agent");
    assert_eq!(json["holder"]["kind"], "agent");
}
