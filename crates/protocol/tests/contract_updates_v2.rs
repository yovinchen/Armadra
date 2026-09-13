//! Protocol minor 2: the update artifact and the check request carry a
//! `component` (design docs/design/updates-and-service-install.md §1.5).
//!
//! The samples are the same golden bytes the Go and TypeScript suites read, so
//! a field number or a wire type that drifts in one runtime fails in all three.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check<M: Message + Default + PartialEq + std::fmt::Debug>(name: &str, expected: M) {
    let wire = fixture(name);
    assert_eq!(M::decode(wire.as_slice()).unwrap(), expected);
    assert_eq!(
        expected.encode_to_vec(),
        wire,
        "{name} differs across runtimes"
    );
}

/// One release publishes several programs for the same target, so the target
/// alone no longer names a download.
#[test]
fn update_component_states() {
    check(
        "update_component_request",
        CheckForUpdateRequest {
            meta: Some(CommandMeta {
                request_id: "更新检查".into(),
                ..Default::default()
            }),
            channel: ReleaseChannel::Beta as i32,
            installed_version: Some(SemanticVersion {
                major: 0,
                minor: 2,
                patch: 0,
                prerelease: String::new(),
            }),
            target: "linux-x86_64".into(),
            component: "host".into(),
        },
    );
    check(
        "update_component_artifact",
        UpdateArtifact {
            target: "windows-aarch64".into(),
            url: "https://example.invalid/armadra-host_0.2.0_windows-aarch64.zip".into(),
            size_bytes: 9_007_199_254_740_993,
            sha256: vec![6; 32],
            signature: Some(UpdateSignature {
                state: UpdateSignatureState::Present as i32,
                value: "dW50cnVzdGVkIGNvbW1lbnQ".into(),
                key_id: "key-2".into(),
            }),
            component: "host".into(),
        },
    );
    // The updater manifest is one file for every platform: a component with no
    // target, which a target-only match would either miss or misattribute.
    check(
        "update_manifest_artifact",
        UpdateArtifact {
            target: String::new(),
            url: "https://example.invalid/latest.json".into(),
            size_bytes: 2048,
            sha256: vec![9; 32],
            signature: Some(UpdateSignature {
                state: UpdateSignatureState::Absent as i32,
                value: String::new(),
                key_id: String::new(),
            }),
            component: "manifest".into(),
        },
    );
}

/// An empty component is "the publisher did not say", not "desktop". Only the
/// Host turns an empty *request* component into the desktop bundle, and it does
/// so above the wire; the message itself must keep the two distinguishable.
#[test]
fn absent_component_stays_absent() {
    let older = UpdateArtifact {
        target: "darwin-aarch64".into(),
        url: "https://example.invalid/Armadra_0.2.0_darwin-aarch64.tar.gz".into(),
        size_bytes: 12,
        ..Default::default()
    };
    let wire = older.encode_to_vec();
    let decoded = UpdateArtifact::decode(wire.as_slice()).unwrap();
    assert!(decoded.component.is_empty());
    assert_eq!(decoded, older);
    let named = UpdateArtifact {
        component: "worker".into(),
        ..older
    };
    // Tag byte, length byte, six characters: an absent component costs nothing
    // on the wire, so a minor 1 encoder and a minor 2 encoder that was not told
    // a component produce identical bytes.
    assert_eq!(named.encode_to_vec().len(), wire.len() + 8);
}
