//! What the shipped `tauri.conf.json` is allowed to say about updates
//! (docs/design/updates-and-service-install.md §2.5).
//!
//! Two things are asserted about the file in this repository, and they pull in
//! opposite directions on purpose: it must not claim to be able to check when
//! it cannot, and it must not hard-code where to check. The endpoint is
//! supplied at run time from the release the Host described, so an address
//! committed here would send a beta build at the stable manifest.

use armadra_desktop::updates::{
    MissingUpdaterConfig, UpdateState, initial_state, missing_updater_config,
};

fn config(value: &str) -> serde_json::Value {
    serde_json::from_str(value).expect("test configuration is valid JSON")
}

fn shipped() -> serde_json::Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json")
}

#[test]
fn an_absent_or_empty_updater_block_is_not_configured() {
    for value in [
        r#"{}"#,
        r#"{"pubkey":"","endpoints":[]}"#,
        r#"{"pubkey":"   ","endpoints":["https://example.invalid/latest.json"]}"#,
        r#"{"pubkey":"dW50cnVzdGVk","endpoints":[]}"#,
        r#"{"pubkey":"dW50cnVzdGVk","endpoints":["  "]}"#,
        r#"{"pubkey":123,"endpoints":"https://example.invalid/latest.json"}"#,
    ] {
        assert!(
            missing_updater_config(Some(&config(value))).any(),
            "an unusable updater block was treated as configured: {value}"
        );
    }
    assert!(missing_updater_config(None).any());
}

#[test]
fn a_complete_updater_block_is_configured() {
    let complete = config(
        r#"{"pubkey":"dW50cnVzdGVkIGNvbW1lbnQ6","endpoints":["https://example.invalid/latest.json"],"windows":{"installMode":"passive"}}"#,
    );
    assert_eq!(
        missing_updater_config(Some(&complete)),
        MissingUpdaterConfig {
            pubkey: false,
            endpoints: false
        }
    );
}

/// The key is the half that makes a check mean anything, so its absence — and
/// only its absence — is what makes a build unable to update. A missing
/// endpoint is the intended shape, not a fault.
#[test]
fn the_missing_key_is_what_makes_a_build_unable_to_update() {
    let no_key = MissingUpdaterConfig {
        pubkey: true,
        endpoints: false,
    };
    assert!(matches!(
        initial_state(no_key, "stable", false),
        UpdateState::NotConfigured { .. }
    ));
    // Even on the development channel: the key is the thing a person can do
    // something about, so it is what they are told.
    assert!(matches!(
        initial_state(no_key, "development", false),
        UpdateState::NotConfigured { .. }
    ));

    let no_endpoint = MissingUpdaterConfig {
        pubkey: false,
        endpoints: true,
    };
    assert_eq!(
        initial_state(no_endpoint, "stable", false),
        UpdateState::Idle
    );
    assert_eq!(initial_state(no_endpoint, "beta", false), UpdateState::Idle);
    // A build that never went through CI never auto-updates (design §1.1)…
    assert_eq!(
        initial_state(no_endpoint, "development", false),
        UpdateState::LocalBuild
    );
    // …unless a developer explicitly asked for the loopback release server.
    assert_eq!(
        initial_state(no_endpoint, "development", true),
        UpdateState::Idle
    );
}

/// The bundled configuration is the one this build actually ships with. As long
/// as it carries no signing key, the shell must say "not configured" — never
/// "up to date", which would be a check nobody performed.
#[test]
fn the_shipped_configuration_still_reports_not_configured() {
    let shipped = shipped();
    let updater = shipped
        .get("plugins")
        .and_then(|plugins| plugins.get("updater"));
    let missing = missing_updater_config(updater);
    assert!(
        missing.pubkey,
        "tauri.conf.json gained a signing key; review the shell's update story, \
         the release pipeline's key handling and this test before shipping it"
    );
    let state = initial_state(missing, "stable", false);
    let encoded = serde_json::to_string(&state).expect("state serializes");
    assert!(encoded.contains("notConfigured"), "{encoded}");
    assert!(!encoded.contains("upToDate"), "{encoded}");
}

/// Design §2.5, step 3: the release address is never committed. It is injected
/// by CI as a fallback and, at run time, taken from the release the Host
/// described — so a beta build reads the beta release's manifest.
#[test]
fn the_source_configuration_never_hard_codes_a_release_address() {
    let shipped = shipped();
    let endpoints = shipped["plugins"]["updater"]["endpoints"]
        .as_array()
        .expect("endpoints is an array");
    assert!(
        endpoints.is_empty(),
        "an endpoint was committed to tauri.conf.json: {endpoints:?}"
    );
    // `active` stays false until there is a real key; with none, the plugin
    // would have nothing to verify against anyway.
    assert_eq!(
        shipped["plugins"]["updater"]["active"],
        serde_json::json!(false)
    );
}

/// Packaging has to produce the signed bundles the updater consumes; without
/// them a configured updater would point at a release that has nothing to
/// apply (design §1.2).
#[test]
fn packaging_produces_updater_artifacts() {
    assert_eq!(
        shipped()["bundle"]["createUpdaterArtifacts"],
        serde_json::json!(true)
    );
}
