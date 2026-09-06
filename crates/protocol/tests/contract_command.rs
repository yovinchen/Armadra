//! The command executor surface (`command.proto`): binary input, an unknown
//! phase, and the optional exit evidence a receipt may or may not carry.

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
fn command_binary_input_unknown_phase_and_optional_exit_evidence() {
    check(
        "command_run",
        CommandRequest {
            action: Some(command_request::Action::Run(RunCommandRequest {
                operation_id: "operation-1".into(),
                session_id: "会话-1".into(),
                request_sha256: vec![8; 32],
                expected_generation: u64::MAX,
                stdin: vec![0, 255, 27, 10],
                expected_not_dispatched_sequence: 0,
            })),
        },
    );
    check(
        "command_receipt",
        CommandReceipt {
            operation_id: "operation-1".into(),
            session_id: "会话-1".into(),
            generation: 9_007_199_254_740_993,
            phase: 999,
            sequence: u64::MAX,
            exit_code: Some(0),
            stdout: vec![0, 255, 10],
            stdout_total_bytes: 9_007_199_254_740_993,
            stdout_truncated: true,
            ..Default::default()
        },
    );
    check(
        "command_absent_exit",
        CommandReceipt {
            operation_id: "operation-2".into(),
            phase: CommandPhase::NotDispatched as i32,
            no_effect_proven: true,
            cleanup_confirmed: true,
            ..Default::default()
        },
    );
}
