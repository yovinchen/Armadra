//! What a desktop update may stop, and how a restart proves itself
//! (docs/design/updates-and-service-install.md §2.3, §3.4; acceptance R5, R6).

use std::path::Path;

use armadra_desktop::updates::coordinate::{
    self, Component, HealthReadings, PendingRestart, RestartOutcome,
};

fn pending() -> PendingRestart {
    PendingRestart {
        expected_version: "0.2.0".into(),
        previous_version: "0.1.0".into(),
        previous_package_url: "https://releases.invalid/download/v0.1.0/Armadra_0.1.0.dmg".into(),
        notes_url: "https://releases.invalid/v0.2.0".into(),
        started_at_ms: 1_700_000_000_000,
    }
}

fn write_launcher(dir: &Path, body: &str) {
    std::fs::write(coordinate::launcher_path(dir), body).expect("write launcher record");
}

/// R5: only the Host this shell started is stopped. A service-mode Host and its
/// sessions belong to whoever installed it.
#[test]
fn only_a_host_this_shell_launched_is_ours_to_stop() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let dir = temporary.path();
    let binary = dir.join("armadra-host");
    std::fs::write(&binary, b"#!/bin/sh\n").expect("write host binary");

    // No record at all: a Host may be running that never said who started it.
    assert!(!coordinate::host_is_ours(dir, &binary));

    for launcher in ["service", "cli", "", "Desktop", "tmux"] {
        write_launcher(dir, &format!(r#"{{"launcher":"{launcher}"}}"#));
        assert!(
            !coordinate::host_is_ours(dir, &binary),
            "launcher {launcher:?} was treated as ours"
        );
    }

    // Unreadable records are refused rather than assumed: the whole point of
    // the file is to stop an update acting on a Host it does not own.
    write_launcher(dir, "not json");
    assert!(!coordinate::host_is_ours(dir, &binary));

    // "desktop" naming another program is a stale record from a crashed Host.
    write_launcher(
        dir,
        &format!(
            r#"{{"launcher":"desktop","executable":"{}"}}"#,
            dir.join("some-other-host").display()
        ),
    );
    assert!(!coordinate::host_is_ours(dir, &binary));

    write_launcher(
        dir,
        &format!(
            r#"{{"launcher":"desktop","executable":"{}"}}"#,
            binary.display()
        ),
    );
    assert!(coordinate::host_is_ours(dir, &binary));

    // An older Host recorded only the launcher; "desktop" is still its own
    // statement about itself.
    write_launcher(dir, r#"{"launcher":" desktop "}"#);
    assert!(coordinate::host_is_ours(dir, &binary));
}

#[test]
fn the_pending_record_survives_a_round_trip_and_clears_once() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let dir = temporary.path();
    assert!(coordinate::read_pending(dir).is_none());
    coordinate::write_pending(dir, &pending()).expect("write pending restart");
    assert_eq!(coordinate::read_pending(dir), Some(pending()));
    assert!(coordinate::pending_path(dir).ends_with("updates/pending-restart.json"));
    coordinate::clear_pending(dir).expect("clear pending restart");
    assert!(coordinate::read_pending(dir).is_none());
    // Clearing a record that is already gone is success: what matters is that
    // none remains.
    coordinate::clear_pending(dir).expect("clearing twice is not an error");
}

/// R6: the shell, the Host and the Runtime all have to report the new version.
#[test]
fn a_restart_is_complete_only_when_all_three_report_the_new_version() {
    let all = HealthReadings {
        shell: Some("0.2.0".into()),
        host: Some("0.2.0".into()),
        runtime: Some("0.2.0".into()),
    };
    assert_eq!(
        coordinate::verify_restart(&pending(), &all),
        RestartOutcome::Completed {
            version: "0.2.0".into()
        }
    );
}

/// A reading that could not be taken is not agreement. "I could not ask" and
/// "it answered with the new version" are different answers.
#[test]
fn a_missing_or_stale_reading_reports_the_update_as_unfinished() {
    let cases = [
        (
            HealthReadings {
                shell: Some("0.2.0".into()),
                host: Some("0.1.0".into()),
                runtime: Some("0.2.0".into()),
            },
            vec![Component::Host],
        ),
        (
            HealthReadings {
                shell: Some("0.2.0".into()),
                host: None,
                runtime: None,
            },
            vec![Component::Host, Component::Runtime],
        ),
        (
            HealthReadings::default(),
            vec![Component::Shell, Component::Host, Component::Runtime],
        ),
    ];
    for (readings, expected) in cases {
        assert_eq!(
            coordinate::verify_restart(&pending(), &readings),
            RestartOutcome::Incomplete {
                mismatched: expected,
                expected_version: "0.2.0".into(),
                previous_version: "0.1.0".into(),
                previous_package_url: "https://releases.invalid/download/v0.1.0/Armadra_0.1.0.dmg"
                    .into(),
            }
        );
    }
}

/// A record with no expected version cannot be satisfied by anything, so it
/// reports "unfinished" rather than agreeing with three empty readings.
#[test]
fn an_empty_expected_version_never_counts_as_agreement() {
    let mut pending = pending();
    pending.expected_version = "  ".into();
    let outcome = coordinate::verify_restart(
        &pending,
        &HealthReadings {
            shell: Some(String::new()),
            host: Some(String::new()),
            runtime: Some(String::new()),
        },
    );
    assert!(matches!(outcome, RestartOutcome::Incomplete { .. }));
}

/// The Host's data directory has to be found even when the shell passes no
/// `--data-dir`, or every Host would look like somebody else's.
#[test]
fn the_host_data_directory_falls_back_to_the_hosts_own_default() {
    let configured = std::env::temp_dir().join("armadra-host-data");
    assert_eq!(
        coordinate::host_data_dir(Some(configured.as_path())),
        configured
    );
    let fallback = coordinate::host_data_dir(None);
    assert!(fallback.is_absolute() || fallback.starts_with(std::env::temp_dir()));
    assert!(fallback.ends_with("Armadra/host"));
}

/// The version probe is a read that must not hang or trust unbounded output.
#[tokio::test]
#[cfg(unix)]
async fn the_host_version_probe_refuses_anything_but_a_short_successful_json_answer() {
    use std::os::unix::fs::PermissionsExt;
    let temporary = tempfile::tempdir().expect("temporary directory");
    let binary = temporary.path().join("armadra-host");
    for (script, expected) in [
        (
            "test \"$1 $2 $3\" = 'version --output json' || exit 8\nprintf '{\"version\":\"v0.2.0\",\"channel\":\"stable\"}'",
            Some("0.2.0".to_owned()),
        ),
        ("printf '{\"version\":\"0.2.0\"}'; exit 3", None),
        ("printf 'not json'", None),
        ("printf '{\"version\":\"\"}'", None),
        ("head -c 9000 /dev/zero", None),
    ] {
        std::fs::write(&binary, format!("#!/bin/sh\n{script}\n")).expect("write probe script");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make probe executable");
        assert_eq!(
            coordinate::probe_host_version(&binary, None).await,
            expected,
            "script {script:?}"
        );
    }
}
