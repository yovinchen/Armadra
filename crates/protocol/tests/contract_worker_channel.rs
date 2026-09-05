//! The resident Worker channel's upward half (Go Host business migration
//! §2.9). The Worker is the only end that produces these frames, so the Rust
//! encoding is the one a Host will actually see: it has to match the shared
//! fixtures byte for byte, not merely round-trip against itself.

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

#[test]
fn an_agent_upcall_keeps_its_opaque_payload_and_digest() {
    check(
        "worker_upcall_agent",
        WorkerUpcall {
            request_id: "w-0123456789abcdef".into(),
            worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
            sequence: 9_007_199_254_740_993,
            attempt: 1,
            emitted_at_unix_ms: 1_788_557_900_000,
            event: Some(worker_upcall::Event::Agent(WorkerAgentUpcall {
                workspace_id: "workspace-1".into(),
                node_id: "节点-1".into(),
                session_id: "会话-1".into(),
                payload: vec![0, 255, 27, 10],
                payload_sha256: vec![5; 32],
                schema_version: 1,
                kind: WorkerAgentUpcallKind::HookTurn as i32,
                reason_code: String::new(),
                observed_at_unix_ms: 1_788_557_899_000,
            })),
        },
    );
}

/// A replay differs from the first send only in `attempt`. An operator reading
/// the Host's record has to be able to tell a redelivered event from a second
/// observation of the same thing, so the field cannot be dropped as noise.
#[test]
fn a_replayed_upcall_keeps_its_attempt_and_sequence_extremes() {
    check(
        "worker_upcall_replay",
        WorkerUpcall {
            request_id: "w-replay-1".into(),
            worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
            sequence: u64::MAX,
            attempt: u32::MAX,
            emitted_at_unix_ms: i64::MIN,
            event: Some(worker_upcall::Event::Agent(WorkerAgentUpcall {
                node_id: "节点-2".into(),
                kind: WorkerAgentUpcallKind::ApprovalRequested as i32,
                reason_code: "agent.approval.pending".into(),
                ..Default::default()
            })),
        },
    );
}

/// Prost keeps an unrecognized enum as its number. A Worker built after a Host
/// must not have its report read as UNSPECIFIED, which is a different claim.
#[test]
fn an_unknown_upcall_kind_stays_the_number_it_was() {
    check(
        "worker_upcall_unknown_kind",
        WorkerUpcall {
            request_id: "w-unknown-1".into(),
            worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
            sequence: 1,
            attempt: 1,
            emitted_at_unix_ms: 0,
            event: Some(worker_upcall::Event::Agent(WorkerAgentUpcall {
                kind: 999,
                ..Default::default()
            })),
        },
    );
    let decoded = WorkerUpcall::decode(fixture("worker_upcall_unknown_kind").as_slice()).unwrap();
    let agent = match decoded.event {
        Some(worker_upcall::Event::Agent(agent)) => agent,
        _ => panic!("agent member lost"),
    };
    assert!(WorkerAgentUpcallKind::try_from(agent.kind).is_err());
}

#[test]
fn receipts_distinguish_acceptance_duplication_and_rejection() {
    check(
        "worker_upcall_accepted",
        WorkerUpcallReply {
            request_id: "w-0123456789abcdef".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
            ack_sequence: 9_007_199_254_740_993,
            disposition: WorkerUpcallDisposition::Accepted as i32,
            reason_code: String::new(),
            received_at_unix_ms: 1_788_557_900_001,
        },
    );
    check(
        "worker_upcall_duplicate",
        WorkerUpcallReply {
            request_id: "w-replay-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
            ack_sequence: u64::MAX,
            disposition: WorkerUpcallDisposition::Duplicate as i32,
            reason_code: "worker.upcall.duplicate".into(),
            received_at_unix_ms: 0,
        },
    );
    // A rejection carries no acknowledgement. The sequence it names must not
    // read as accepted by a Worker that only inspects `ack_sequence`.
    check(
        "worker_upcall_rejected",
        WorkerUpcallReply {
            request_id: "w-bad-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
            ack_sequence: 0,
            disposition: WorkerUpcallDisposition::Rejected as i32,
            reason_code: "worker.upcall.malformed".into(),
            received_at_unix_ms: 0,
        },
    );
}

/// Three states a Host reacts to differently: no channel, an idle channel and
/// one that owes a replay. Only an absent message can mean the first.
#[test]
fn the_handshake_reports_the_channel_and_its_absence() {
    check(
        "worker_hello_channel",
        WorkerHelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            platform: "macos".into(),
            architecture: "aarch64".into(),
            capabilities: vec!["worker.roots.v1".into(), "worker.upcall.v1".into()],
            max_frame_bytes: 1 << 20,
            max_file_chunk_bytes: 256 << 10,
            max_text_file_bytes: 1 << 20,
            runtime_version: "0.1.0".into(),
            commands: None,
            channel: Some(WorkerChannelCapability {
                worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
                socket: "/tmp/状态/worker-upcall.sock".into(),
                pipe: String::new(),
                highest_sequence: 9_007_199_254_740_993,
                unacknowledged: 3,
                max_unacknowledged: 1024,
                state: WorkerChannelState::Replaying as i32,
                reason_code: "worker.upcall.replaying".into(),
            }),
        },
    );
    // The first-phase handshake fixture predates the field: adding it must not
    // have turned "this Worker never speaks upward" into a default record.
    let legacy = WorkerHelloResponse::decode(
        WorkerHelloResponse {
            instance_id: "no-channel".into(),
            ..Default::default()
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert!(legacy.channel.is_none());
}
