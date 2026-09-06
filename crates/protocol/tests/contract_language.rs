//! `language.proto` decoded and re-encoded by prost against the shared
//! fixtures the Go runtime produced (language service design §2.8).
//!
//! The three things this file exists to catch are the ones a refactor loses
//! without failing anything else: a probe failure turning into "available", a
//! JSON-RPC payload being re-encoded on its way through the transport, and an
//! absent `expected_sha256` entry turning into an empty string, which would
//! change "this file must not exist" into "this file is empty".

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
fn discovery_separates_running_from_probe_failure() {
    check(
        "language_capabilities",
        LanguageCapabilities {
            execution_host_id: "local".into(),
            servers: vec![
                LanguageServerDescriptor {
                    server_id: "ruff".into(),
                    language_id: "python".into(),
                    file_extensions: vec!["py".into(), "pyi".into()],
                    executable: "/opt/homebrew/bin/ruff".into(),
                    version: "0.16.1".into(),
                    state: LanguageServerState::Running as i32,
                    reason: String::new(),
                    features: vec![
                        LanguageFeature::Diagnostics as i32,
                        LanguageFeature::Formatting as i32,
                        LanguageFeature::CodeAction as i32,
                    ],
                    restart_count: 2,
                    pid: Some(4242),
                    start_time_unix_ms: Some(1_788_556_300_000),
                    open_documents: 3,
                    probed_at_unix_ms: 1_788_557_000_000,
                },
                // A rustup proxy that exists on PATH but whose component is
                // not installed. It is UNSUPPORTED with a reason, and it
                // carries no pid at all — never a zero the panel could claim.
                LanguageServerDescriptor {
                    server_id: "rust-analyzer".into(),
                    language_id: "rust".into(),
                    file_extensions: vec!["rs".into()],
                    state: LanguageServerState::Unsupported as i32,
                    reason: "server_probe_failed".into(),
                    probed_at_unix_ms: 1_788_557_000_000,
                    ..Default::default()
                },
            ],
            max_document_bytes: 1_048_576,
            max_sessions: 32,
            max_message_bytes: 983_040,
        },
    );
    check(
        "language_session",
        LanguageSession {
            session_id: "会话-1".into(),
            server_id: "ruff".into(),
            generation: u64::MAX,
            state: LanguageServerState::Running as i32,
            reason: String::new(),
            server_capabilities_json: br#"{"hoverProvider":true}"#.to_vec(),
        },
    );
}

#[test]
fn a_json_rpc_payload_is_relayed_byte_for_byte() {
    let payload =
        r#"{"jsonrpc":"2.0","id":7,"result":{"contents":"注释 📘","uri":"armadra:///源码/主.py"}}"#;
    check(
        "language_frame_message",
        LanguageFrame {
            link_epoch: "epoch-1".into(),
            payload: Some(language_frame::Payload::Message(LanguageMessage {
                session_id: "会话-1".into(),
                sequence: 9_007_199_254_740_993,
                kind: LanguageMessageKind::Response as i32,
                method: "textDocument/hover".into(),
                request_id: "7:client-1".into(),
                payload_json: payload.as_bytes().to_vec(),
            })),
        },
    );
    check(
        "language_frame_ack",
        LanguageFrame {
            link_epoch: "epoch-1".into(),
            payload: Some(language_frame::Payload::Ack(LanguageAck {
                session_id: "会话-1".into(),
                received_through: u64::MAX,
                available_credit_bytes: 4 * 1_048_576,
            })),
        },
    );
}

#[test]
fn an_absent_expected_version_means_the_file_must_not_exist() {
    check(
        "language_apply_edit",
        LanguageApplyEditRequest {
            root_id: "root-1".into(),
            session_id: "会话-1".into(),
            workspace_edit_json: r#"{"changes":{"armadra:///src/主.py":[]}}"#.as_bytes().to_vec(),
            expected_sha256: std::collections::HashMap::from([(
                "src/主.py".to_owned(),
                "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_owned(),
            )]),
            allow_write: true,
        },
    );
    let decoded =
        LanguageApplyEditRequest::decode(fixture("language_apply_edit").as_slice()).unwrap();
    // A create-only path is one the map never mentions. An empty string would
    // be a version, and versions are checked; absence is not.
    assert!(!decoded.expected_sha256.contains_key("src/新.py"));
    assert_eq!(decoded.expected_sha256.len(), 1);
}

#[test]
fn stopping_and_restarting_are_separate_actions_and_neither_is_the_default() {
    check(
        "language_control",
        LanguageControlRequest {
            root_id: "root-1".into(),
            workspace_id: "ws-1".into(),
            server_id: "ruff".into(),
            action: LanguageControlAction::Restart as i32,
            allow_execute: true,
        },
    );
    // A frame that names no action must not read as "restart": an empty
    // request is a caller that never said what it wanted, and starting a
    // process on that basis is the one outcome nobody asked for.
    let empty = LanguageControlRequest {
        server_id: "ruff".into(),
        ..Default::default()
    };
    let decoded = LanguageControlRequest::decode(empty.encode_to_vec().as_slice()).unwrap();
    assert_eq!(decoded.action, LanguageControlAction::Unspecified as i32);
}

#[test]
fn the_worker_oneof_carries_language_branches_without_colliding() {
    let request = WorkerRequest {
        request_id: "language-1".into(),
        action: Some(worker_request::Action::LanguageCapabilities(
            LanguageCapabilitiesRequest {
                root_id: "root-1".into(),
                refresh: true,
            },
        )),
        ..Default::default()
    };
    let decoded = WorkerRequest::decode(request.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(
        decoded.action,
        Some(worker_request::Action::LanguageCapabilities(_))
    ));
    let response = WorkerResponse {
        request_id: "language-1".into(),
        result: Some(worker_response::Result::LanguageSession(LanguageSession {
            session_id: "会话-1".into(),
            state: LanguageServerState::Stopped as i32,
            ..Default::default()
        })),
        ..Default::default()
    };
    let decoded = WorkerResponse::decode(response.encode_to_vec().as_slice()).unwrap();
    let Some(worker_response::Result::LanguageSession(session)) = decoded.result else {
        panic!("a closed session lost its branch");
    };
    assert_eq!(session.state, LanguageServerState::Stopped as i32);
}

#[test]
fn a_language_server_is_its_own_platform_component() {
    // The resource panel tells Armadra's own processes apart by kind; a
    // language server must not be filed under the command worker it is not.
    assert_eq!(PlatformComponentKind::LanguageServer as i32, 6);
    assert_eq!(PlatformComponentKind::Unspecified as i32, 0);
}
