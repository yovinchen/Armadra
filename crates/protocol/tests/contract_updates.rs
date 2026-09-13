//! The update contract as protocol minor 1 published it: "I did not look" must
//! stay distinguishable from "there is nothing new", and an unsigned release
//! from a device that holds no public key. The `component` field minor 2 added
//! is covered by contract_updates_v2.rs.

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

/// "I did not look" must stay distinguishable from "there is nothing new", and
/// an unsigned release from a device that holds no public key.
#[test]
fn update_contract_states() {
    check(
        "update_unsupported",
        CheckForUpdateResponse {
            state: UpdateCheckState::Unsupported as i32,
            channel: ReleaseChannel::Stable as i32,
            installed_version: Some(SemanticVersion {
                major: 0,
                minor: 1,
                patch: 0,
                prerelease: String::new(),
            }),
            reason_code: "UPDATES_NOT_CONFIGURED".into(),
            checked_at_unix_ms: 1788557000000,
            ..Default::default()
        },
    );
    check(
        "update_available",
        CheckForUpdateResponse {
            state: UpdateCheckState::Available as i32,
            channel: ReleaseChannel::Beta as i32,
            installed_version: Some(SemanticVersion {
                major: 0,
                minor: 1,
                patch: 0,
                prerelease: String::new(),
            }),
            release: Some(ReleaseInfo {
                version: Some(SemanticVersion {
                    major: 0,
                    minor: 2,
                    patch: 1,
                    prerelease: "beta.1".into(),
                }),
                channel: ReleaseChannel::Beta as i32,
                published_at_unix_ms: 1788557900000,
                notes_url: "https://example.invalid/发布说明".into(),
                compatibility: Some(UpdateCompatibility {
                    minimum_installed: Some(SemanticVersion {
                        minor: 1,
                        ..Default::default()
                    }),
                    maximum_installed: Some(SemanticVersion {
                        major: 1,
                        ..Default::default()
                    }),
                    protocol_major: 1,
                    minimum_protocol_minor: 1,
                }),
                artifacts: vec![UpdateArtifact {
                    target: "darwin-aarch64".into(),
                    url: "https://example.invalid/Armadra.tar.gz".into(),
                    size_bytes: 9_007_199_254_740_993,
                    sha256: vec![4; 32],
                    signature: Some(UpdateSignature {
                        state: UpdateSignatureState::Present as i32,
                        value: "dW50cnVzdGVkIGNvbW1lbnQ".into(),
                        key_id: "key-1".into(),
                    }),
                    component: String::new(),
                }],
            }),
            checked_at_unix_ms: 1788557900000,
            retry_after_ms: 3600000,
            ..Default::default()
        },
    );
    check(
        "update_unconfigured_signature",
        UpdateArtifact {
            target: "windows-x86_64".into(),
            url: "https://example.invalid/Armadra.msi".into(),
            size_bytes: 1,
            sha256: vec![2; 32],
            signature: Some(UpdateSignature {
                state: UpdateSignatureState::Unconfigured as i32,
                ..Default::default()
            }),
            component: String::new(),
        },
    );
}
