//! Cancelling a transfer that is already running (design §2.1, §4.1 "下载中 →
//! 取消").
//!
//! The interesting cases are all races. Tauri gives no abort handle, so the
//! shell stops *awaiting* the transfer instead — which means a cancel and a
//! completion can both be true at nearly the same instant, and the rules for
//! who wins have to be stated rather than discovered.

use std::sync::Arc;

use armadra_desktop::updates::cancel::Cancellation;
use armadra_desktop::updates::machine::{Event, Machine, Offer, UpdateState};

fn offer() -> Offer {
    Offer {
        version: "0.2.0".into(),
        target: "darwin-aarch64".into(),
        manifest_url: "https://example.invalid/latest.json".into(),
        package_url: "https://example.invalid/Armadra.app.tar.gz".into(),
        sha256: "a".repeat(64),
        size_bytes: 4_096,
        signed: true,
        notes_url: "https://example.invalid/notes".into(),
    }
}

fn downloading() -> Machine {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    machine.apply(Event::DownloadStarted);
    machine
}

#[test]
fn nothing_is_cancelled_before_a_transfer_is_armed() {
    let cancellation = Cancellation::default();
    assert!(!cancellation.is_armed());
    // "There was nothing to cancel" is a different answer from "cancelled",
    // and the command needs to be able to tell them apart.
    assert!(!cancellation.cancel());
}

#[tokio::test]
async fn an_armed_transfer_is_woken_by_a_cancel() {
    let cancellation = Cancellation::default();
    let token = cancellation.arm();
    assert!(cancellation.is_armed());
    assert!(cancellation.cancel());
    // The permit is stored, so a cancel that lands before the transfer's first
    // poll still stops it. This await would hang if it were not.
    token.notified().await;
    assert!(!cancellation.is_armed());
}

#[tokio::test]
async fn arming_a_second_transfer_cancels_the_first() {
    let cancellation = Cancellation::default();
    let first = cancellation.arm();
    let second = cancellation.arm();
    // The first token is woken so its transfer stops; the state machine only
    // models one, and an orphan would keep reporting progress for an offer
    // nobody is waiting on.
    first.notified().await;
    assert!(cancellation.is_armed());
    assert!(cancellation.cancel());
    second.notified().await;
}

#[test]
fn a_late_finish_does_not_disarm_the_next_transfer() {
    let cancellation = Cancellation::default();
    let stale = cancellation.arm();
    assert!(cancellation.cancel());
    let current = cancellation.arm();
    // The cancelled transfer completes anyway and retires its own token. The
    // one armed afterwards must survive, or nothing could stop it.
    cancellation.finish(&stale);
    assert!(cancellation.is_armed());
    cancellation.finish(&current);
    assert!(!cancellation.is_armed());
}

#[test]
fn finishing_a_token_twice_is_harmless() {
    let cancellation = Cancellation::default();
    let token = cancellation.arm();
    cancellation.finish(&token);
    cancellation.finish(&token);
    assert!(!cancellation.is_armed());
    assert!(!cancellation.cancel());
}

#[test]
fn a_cancelled_transfer_keeps_the_offer_and_drops_the_bytes() {
    let mut machine = downloading();
    assert!(machine.apply(Event::CheckCancelled));
    // Back to the offer, not to "never checked": the release is still there,
    // and only the partial file was thrown away.
    assert_eq!(machine.state(), &UpdateState::Available { offer: offer() });
    // And it can be started again from exactly that state.
    assert!(machine.apply(Event::DownloadStarted));
    assert!(matches!(machine.state(), UpdateState::Downloading { .. }));
}

#[test]
fn a_transfer_that_finished_while_being_cancelled_stages_nothing() {
    let mut machine = downloading();
    machine.apply(Event::CheckCancelled);
    // The download command applies `DownloadFinished` after the select loses;
    // the machine refuses it, and `updates_download` reads that refusal as
    // "do not keep these bytes".
    assert!(!machine.apply(Event::DownloadFinished));
    assert_eq!(machine.state(), &UpdateState::Available { offer: offer() });
}

#[test]
fn cancelling_a_check_returns_to_idle_and_ignores_its_late_answer() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckCancelled);
    assert_eq!(machine.state(), &UpdateState::Idle);
    // The check's answer arrives after the cancel. It is not an answer to
    // anything anybody is waiting for, and "up to date" least of all.
    assert!(!machine.apply(Event::CheckedUpToDate { at_ms: 1 }));
    assert_eq!(machine.state(), &UpdateState::Idle);
}

#[test]
fn a_cancel_arriving_after_the_bytes_landed_changes_nothing() {
    let mut machine = downloading();
    machine.apply(Event::DownloadFinished);
    let staged = machine.state().clone();
    // A person pressing cancel as the transfer completes must not throw away a
    // verified package; `updates_cancel` only acts while `Downloading`.
    assert!(!machine.apply(Event::CheckCancelled));
    assert_eq!(machine.state(), &staged);
}

#[test]
fn cancel_tokens_are_distinct_across_transfers() {
    let cancellation = Cancellation::default();
    let first = cancellation.arm();
    let second = cancellation.arm();
    assert!(!Arc::ptr_eq(&first, &second));
}
