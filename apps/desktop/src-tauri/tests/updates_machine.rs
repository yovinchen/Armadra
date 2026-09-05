//! The transition table of docs/design/updates-and-service-install.md §2.1.
//!
//! Two properties are asserted over the *whole* table rather than case by case,
//! because they are the ones a future edit is most likely to break: nothing
//! reaches "up to date" except a check that said so, and a state never moves on
//! an event it does not accept.

use armadra_desktop::updates::machine::{
    Event, Machine, MissingUpdaterConfig, Offer, Reason, RestartPhase, Unsupported, UpdateState,
};

fn offer() -> Offer {
    Offer {
        version: "0.2.0".into(),
        target: "darwin-aarch64".into(),
        manifest_url: "https://releases.invalid/download/v0.2.0/latest.json".into(),
        package_url:
            "https://releases.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz"
                .into(),
        sha256: "a".repeat(64),
        size_bytes: 4096,
        signed: true,
        notes_url: "https://releases.invalid/v0.2.0".into(),
    }
}

/// One machine in each state, so a property can be checked against all of them.
fn every_state() -> Vec<Machine> {
    let mut states = vec![
        Machine::not_configured(MissingUpdaterConfig {
            pubkey: true,
            endpoints: true,
        }),
        Machine::local_build(),
        Machine::unsupported(Unsupported::NotDesktop),
        Machine::idle(),
    ];

    let mut checking = Machine::idle();
    checking.apply(Event::CheckStarted);
    states.push(checking.clone());

    let mut up_to_date = checking.clone();
    up_to_date.apply(Event::CheckedUpToDate { at_ms: 10 });
    states.push(up_to_date);

    let mut unavailable = checking.clone();
    unavailable.apply(Event::CheckRefused {
        reason: Reason::SourceUnreachable,
        retry_after_ms: 900_000,
        at_ms: 10,
    });
    states.push(unavailable);

    let mut available = checking;
    available.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    states.push(available.clone());

    let mut downloading = available.clone();
    downloading.apply(Event::DownloadStarted);
    states.push(downloading.clone());

    let mut downloaded = downloading.clone();
    downloaded.apply(Event::DownloadFinished);
    states.push(downloaded.clone());

    let mut preparing = downloaded.clone();
    preparing.apply(Event::RestartRequested);
    states.push(preparing.clone());

    let mut installing = preparing;
    installing.apply(Event::BackgroundStopped);
    states.push(installing);

    let mut failed = downloading;
    failed.apply(Event::DownloadFailed {
        reason: Reason::DigestMismatch,
    });
    states.push(failed);

    states
}

fn every_event() -> Vec<Event> {
    vec![
        Event::CheckStarted,
        Event::CheckCancelled,
        Event::CheckedUpToDate { at_ms: 1 },
        Event::CheckedAvailable {
            offer: Box::new(offer()),
        },
        Event::CheckRefused {
            reason: Reason::SourceMalformed,
            retry_after_ms: 0,
            at_ms: 1,
        },
        Event::OfferDismissed,
        Event::DownloadStarted,
        Event::DownloadProgressed {
            received_bytes: 10,
            total_bytes: 20,
        },
        Event::DownloadFinished,
        Event::DownloadFailed {
            reason: Reason::DownloadInterrupted,
        },
        Event::RestartRequested,
        Event::BackgroundStopped,
        Event::RestartAbandoned {
            reason: Some(Reason::HostStopFailed),
        },
        Event::InstallFailed {
            reason: Reason::InstallFailed,
        },
        Event::Retry,
    ]
}

/// The contract's first rule. Not looking, failing to look, and looking and
/// finding nothing are three answers, and only the third one is "up to date".
#[test]
fn only_a_check_that_answered_can_produce_up_to_date() {
    for machine in every_state() {
        for event in every_event() {
            let mut machine = machine.clone();
            let before = machine.state().clone();
            machine.apply(event.clone());
            if matches!(machine.state(), UpdateState::UpToDate { .. })
                && !matches!(before, UpdateState::UpToDate { .. })
            {
                assert!(
                    matches!(before, UpdateState::Checking)
                        && matches!(event, Event::CheckedUpToDate { .. }),
                    "{before:?} + {event:?} claimed the build was up to date"
                );
            }
        }
    }
}

/// The three states that describe the build rather than a check never move.
#[test]
fn a_build_that_cannot_update_stays_where_it_is() {
    for machine in [
        Machine::not_configured(MissingUpdaterConfig {
            pubkey: true,
            endpoints: false,
        }),
        Machine::local_build(),
        Machine::unsupported(Unsupported::RemoteHost),
        Machine::unsupported(Unsupported::ManagedPackage),
    ] {
        assert!(machine.is_terminal());
        assert!(!machine.may_check());
        for event in every_event() {
            let mut machine = machine.clone();
            let before = machine.state().clone();
            assert!(
                !machine.apply(event.clone()),
                "{before:?} moved on {event:?}"
            );
            assert_eq!(machine.state(), &before);
        }
    }
}

#[test]
fn a_check_walks_to_each_of_its_three_answers() {
    let mut machine = Machine::idle();
    assert!(machine.apply(Event::CheckStarted));
    assert!(matches!(machine.state(), UpdateState::Checking));
    // A second start while one is in flight changes nothing.
    assert!(!machine.apply(Event::CheckStarted));

    machine.apply(Event::CheckedUpToDate { at_ms: 42 });
    assert_eq!(
        machine.state(),
        &UpdateState::UpToDate { checked_at_ms: 42 }
    );

    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckRefused {
        reason: Reason::SourceUnreachable,
        // A negative hint is a broken hint, not a request to retry in the past.
        retry_after_ms: -5,
        at_ms: 43,
    });
    assert_eq!(
        machine.state(),
        &UpdateState::Unavailable {
            reason: Reason::SourceUnreachable,
            retry_after_ms: 0,
            checked_at_ms: 43,
        }
    );

    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    assert_eq!(machine.offer(), Some(&offer()));
}

#[test]
fn a_cancelled_check_returns_to_never_having_checked() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckCancelled);
    assert_eq!(machine.state(), &UpdateState::Idle);
}

/// A download in flight is not interrupted by the periodic check: the offer in
/// hand is the one the person acted on.
#[test]
fn a_transfer_or_a_pending_restart_is_not_interrupted_by_a_check() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    machine.apply(Event::DownloadStarted);
    assert!(!machine.may_check());
    assert!(!machine.apply(Event::CheckStarted));
    machine.apply(Event::DownloadFinished);
    assert!(!machine.may_check());
    assert!(!machine.apply(Event::CheckStarted));
}

#[test]
fn progress_reports_a_total_even_when_the_server_gives_none() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    machine.apply(Event::DownloadStarted);
    machine.apply(Event::DownloadProgressed {
        received_bytes: 512,
        total_bytes: 0,
    });
    assert_eq!(
        machine.state(),
        &UpdateState::Downloading {
            offer: offer(),
            received_bytes: 512,
            // The offer's own size, never zero: a zero total renders as a full
            // bar the moment one byte arrives.
            total_bytes: 4096,
        }
    );
}

/// A cancelled or failed transfer discards the bytes and keeps the offer.
/// Tauri cannot resume, so a partial file is not something to continue from.
#[test]
fn a_failed_transfer_keeps_the_offer_and_nothing_else() {
    for (event, expected) in [
        (
            Event::DownloadFailed {
                reason: Reason::DigestMismatch,
            },
            Some(Reason::DigestMismatch),
        ),
        (
            Event::DownloadFailed {
                reason: Reason::SignatureMismatch,
            },
            Some(Reason::SignatureMismatch),
        ),
    ] {
        let mut machine = Machine::idle();
        machine.apply(Event::CheckStarted);
        machine.apply(Event::CheckedAvailable {
            offer: Box::new(offer()),
        });
        machine.apply(Event::DownloadStarted);
        machine.apply(event);
        assert_eq!(
            machine.state(),
            &UpdateState::Failed {
                reason: expected.unwrap(),
                offer: Some(offer()),
            }
        );
        // "Try again" goes back to the offer, and a second download may start
        // straight from the failure.
        machine.apply(Event::Retry);
        assert_eq!(machine.state(), &UpdateState::Available { offer: offer() });
    }

    let mut cancelled = Machine::idle();
    cancelled.apply(Event::CheckStarted);
    cancelled.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    cancelled.apply(Event::DownloadStarted);
    cancelled.apply(Event::CheckCancelled);
    assert_eq!(
        cancelled.state(),
        &UpdateState::Available { offer: offer() }
    );
}

/// Skipping a version drops the offer without claiming anything about whether
/// a newer one exists.
#[test]
fn skipping_a_version_does_not_become_up_to_date() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    machine.apply(Event::OfferDismissed);
    assert_eq!(machine.state(), &UpdateState::Idle);
}

/// Design §2.3: stopping the background failing means the install never starts,
/// and the update goes back to waiting rather than to a failure with no bytes.
#[test]
fn a_restart_that_could_not_stop_the_background_returns_to_waiting() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    machine.apply(Event::DownloadStarted);
    machine.apply(Event::DownloadFinished);
    machine.apply(Event::RestartRequested);
    assert!(matches!(
        machine.state(),
        UpdateState::Downloaded {
            phase: RestartPhase::Preparing,
            ..
        }
    ));
    machine.apply(Event::RestartAbandoned {
        reason: Some(Reason::HostStopFailed),
    });
    assert_eq!(
        machine.state(),
        &UpdateState::Downloaded {
            offer: offer(),
            phase: RestartPhase::Ready,
            problem: Some(Reason::HostStopFailed),
        }
    );
    // A person cancelling at the confirmation leaves no problem behind.
    machine.apply(Event::RestartRequested);
    machine.apply(Event::RestartAbandoned { reason: None });
    assert_eq!(
        machine.state(),
        &UpdateState::Downloaded {
            offer: offer(),
            phase: RestartPhase::Ready,
            problem: None,
        }
    );
}

/// An installer that failed leaves the old version running, and the offer is
/// kept so the failure can point at "try again" or the release page.
#[test]
fn a_failed_install_keeps_the_offer_and_reports_the_reason() {
    let mut machine = Machine::idle();
    machine.apply(Event::CheckStarted);
    machine.apply(Event::CheckedAvailable {
        offer: Box::new(offer()),
    });
    machine.apply(Event::DownloadStarted);
    machine.apply(Event::DownloadFinished);
    machine.apply(Event::RestartRequested);
    machine.apply(Event::BackgroundStopped);
    assert!(matches!(
        machine.state(),
        UpdateState::Downloaded {
            phase: RestartPhase::Installing,
            ..
        }
    ));
    // Installing is past the point of no return for stopping: a stop failure
    // reported now is a race, and it must not undo the install.
    assert!(!machine.apply(Event::RestartAbandoned {
        reason: Some(Reason::HostStopFailed)
    }));
    machine.apply(Event::InstallFailed {
        reason: Reason::InstallFailed,
    });
    assert_eq!(
        machine.state(),
        &UpdateState::Failed {
            reason: Reason::InstallFailed,
            offer: Some(offer()),
        }
    );
}

/// The eleven reported states of design §4.1, spelled the way the front end
/// reads them. A rename here is a silently broken settings page, so the tags
/// are asserted rather than inferred.
#[test]
fn every_reported_state_serializes_to_its_documented_tag() {
    let tag = |state: &UpdateState| {
        serde_json::to_value(state).unwrap()["state"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let mut seen: Vec<String> = every_state().iter().map(|m| tag(m.state())).collect();
    seen.sort();
    seen.dedup();
    assert_eq!(
        seen,
        [
            "available",
            "checking",
            "downloaded",
            "downloading",
            "failed",
            "idle",
            "localBuild",
            "notConfigured",
            "unavailable",
            "unsupported",
            "upToDate",
        ]
    );
}

/// A reason reaches the front end as a stable token and nothing else: no URL,
/// no response body, no transport message (design §2.1).
#[test]
fn reasons_are_stable_tokens_and_carry_no_transport_detail() {
    for (reason, token) in [
        (Reason::SourceUnreachable, "sourceUnreachable"),
        (Reason::SourceMalformed, "sourceMalformed"),
        (Reason::CompatibilityRefused, "compatibilityRefused"),
        (Reason::NoArtifactForTarget, "noArtifactForTarget"),
        (Reason::SignatureMismatch, "signatureMismatch"),
        (Reason::DigestMismatch, "digestMismatch"),
        (Reason::DownloadInterrupted, "downloadInterrupted"),
        (Reason::DiskFull, "diskFull"),
        (Reason::HostStopFailed, "hostStopFailed"),
        (Reason::InstallFailed, "installFailed"),
        (Reason::UpdaterUnavailable, "updaterUnavailable"),
    ] {
        let encoded = serde_json::to_string(&reason).unwrap();
        assert_eq!(encoded, format!("\"{token}\""));
        assert!(!encoded.contains("://"));
    }
}
