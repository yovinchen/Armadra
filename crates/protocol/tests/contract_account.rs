//! The reserved account (`account.proto`) and presence (`presence.proto`)
//! envelopes, which Prost must agree with Go and TypeScript on byte for byte.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .chunks_exact(2)
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

/// Reserved account (S02) and presence (H04) envelopes. Prost must agree with
/// Go and TypeScript byte for byte before anything is built on them.
#[test]
fn reserved_account_and_presence_envelopes() {
    check(
        "account_bind_request",
        BindNodeAccountRequest {
            meta: Some(CommandMeta {
                request_id: "绑定-1".into(),
                scope: Some(Scope {
                    host_id: "host-1".into(),
                    workspace_id: "workspace-1".into(),
                    execution_host_id: String::new(),
                }),
                expected_revision: Some(0),
                ..Default::default()
            }),
            node_id: "node-1".into(),
            account: Some(AccountRef {
                account_id: "default".into(),
                provider_id: "claude".into(),
                label: "工作账号📇".into(),
            }),
            // Only a reference: the schema cannot carry the secret itself.
            credential: Some(CredentialBinding {
                credential_ref: "keychain://armadra/claude/default".into(),
                scope: CredentialScope::ExecutionHost as i32,
                authorization_id: "grant-1".into(),
            }),
        },
    );
    check(
        "account_binding",
        NodeAccountBinding {
            node_id: "node-1".into(),
            account: Some(AccountRef {
                account_id: "default".into(),
                ..Default::default()
            }),
            credential: Some(CredentialBinding {
                credential_ref: "keychain://armadra/claude/default".into(),
                // An unknown scope stays unknown instead of decoding to 0.
                scope: 999,
                ..Default::default()
            }),
            revision: u64::MAX,
            bound_at_unix_ms: 9_007_199_254_740_993,
        },
    );
    check(
        "presence_snapshot",
        SubscribePresenceResponse {
            participants: vec![
                Presence {
                    participant_id: "principal-1".into(),
                    device_id: "device-1".into(),
                    display_name: "手机📱".into(),
                    canvas_id: "canvas-1".into(),
                    focus_node_id: "node-1".into(),
                    state: PresenceState::Active as i32,
                    observed_at_unix_ms: 1_788_557_900_000,
                    last_seen_unix_ms: None,
                },
                Presence {
                    participant_id: "principal-2".into(),
                    state: PresenceState::Disconnected as i32,
                    // Present and zero, not absent.
                    last_seen_unix_ms: Some(0),
                    ..Default::default()
                },
            ],
            lease: Some(WriterLease {
                lease_id: "lease-1".into(),
                canvas_id: "canvas-1".into(),
                holder_participant_id: "principal-1".into(),
                revision: 9_007_199_254_740_993,
                expires_at_unix_ms: 1_788_557_900_000,
            }),
            revision: u64::MAX,
        },
    );
    check(
        "presence_mutation",
        Mutation {
            mutation_id: "mutation-1".into(),
            canvas_id: "canvas-1".into(),
            actor_id: "principal-1".into(),
            lease_id: "lease-1".into(),
            expected_revision: Some(0),
            revision: 9_007_199_254_740_993,
            kind: MutationKind::WhiteboardBlob as i32,
            payload_type: "tldraw/snapshot".into(),
            payload: vec![0, 255, 27, 10],
            observed_at_unix_ms: i64::MIN,
        },
    );
    check(
        "presence_acquire",
        AcquireWriterLeaseRequest {
            meta: Some(CommandMeta {
                request_id: "租约-1".into(),
                ..Default::default()
            }),
            canvas_id: "canvas-1".into(),
            expected_revision: None,
            requested_ttl_ms: 300_000,
        },
    );
}
