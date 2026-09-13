//! The envelopes every surface is wrapped in (`common.proto`): the handshake,
//! the local control channel, `CommandMeta`'s optional presence, the stream
//! frame oneof, and what an unknown or malformed wire has to do.

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

#[test]
fn handshake_and_unicode() {
    check(
        "hello",
        HelloRequest {
            client_id: "客户端📡".into(),
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
        },
    );
    check(
        "hello_response",
        HelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            host_instance_id: "主机".into(),
            capabilities: vec!["protocol.hello".into()],
            max_frame_bytes: 1_048_576,
            host_id: String::new(),
            capability_status: Vec::new(),
        },
    );
    check(
        "hello_identity",
        HelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 1 }),
            host_instance_id: "新进程".into(),
            capabilities: vec!["protocol.hello.v1".into(), "host.identity.v1".into()],
            max_frame_bytes: 1_048_576,
            host_id: "0123456789abcdef0123456789abcdef".into(),
            capability_status: Vec::new(),
        },
    );
    check(
        "error",
        ErrorResponse {
            code: "UNSUPPORTED".into(),
            message: "尚未实现".into(),
        },
    );
}

#[test]
fn local_control_contracts() {
    check(
        "management_running",
        HostManagementResult {
            state: Some(host_management_result::State::Running(HostStatus {
                host_id: "host-1".into(),
                host_instance_id: "instance-1".into(),
                http_endpoint: "http://127.0.0.1:43121".into(),
                started_at_unix_ms: 1_788_556_300_000,
                process_id: 321,
            })),
        },
    );
    check(
        "management_stopped",
        HostManagementResult {
            state: Some(host_management_result::State::Stopped(HostStoppedState {})),
        },
    );
    check(
        "control_status",
        HostControlRequest {
            request_id: "控制请求".into(),
            action: Some(host_control_request::Action::Status(HostStatusRequest {})),
        },
    );
    check(
        "control_stop",
        HostControlRequest {
            request_id: "停止请求".into(),
            action: Some(host_control_request::Action::Stop(HostStopRequest {
                expected_instance_id: "instance-1".into(),
            })),
        },
    );
    check(
        "control_status_reply",
        HostControlResponse {
            request_id: "控制请求".into(),
            result: Some(host_control_response::Result::Status(HostStatus {
                host_id: "host-1".into(),
                host_instance_id: "instance-1".into(),
                http_endpoint: "http://127.0.0.1:43121".into(),
                started_at_unix_ms: 1_788_556_300_000,
                process_id: 321,
            })),
        },
    );
    check(
        "control_stop_reply",
        HostControlResponse {
            request_id: "停止请求".into(),
            result: Some(host_control_response::Result::Stopped(HostStopResponse {
                accepted: true,
            })),
        },
    );
}

#[test]
fn optional_presence_and_64_bit_extremes() {
    check(
        "meta_absent",
        CommandMeta {
            request_id: "请求".into(),
            ..Default::default()
        },
    );
    check(
        "meta_zero",
        CommandMeta {
            request_id: "请求".into(),
            expected_revision: Some(0),
            ..Default::default()
        },
    );
    check(
        "meta_large",
        CommandMeta {
            request_id: "请求".into(),
            scope: Some(Scope {
                host_id: "主机".into(),
                workspace_id: "工作区".into(),
                execution_host_id: "执行主机".into(),
            }),
            idempotency_key: "唯一".into(),
            expected_revision: Some(u64::MAX),
            deadline_unix_ms: i64::MIN,
        },
    );
}

#[test]
fn all_oneof_members_and_binary_payload() {
    check(
        "frame_input",
        StreamFrame {
            stream_id: "流".into(),
            sequence: u64::MAX,
            epoch: "纪元".into(),
            payload: Some(stream_frame::Payload::TerminalInput(TerminalInput {
                session: Some(SessionAddress {
                    session_id: "会话".into(),
                    generation: 9_007_199_254_740_993,
                }),
                input_id: "输入".into(),
                data: vec![0, 255, 27, 10],
                writer_lease_id: "租约".into(),
            })),
        },
    );
    check(
        "frame_output",
        StreamFrame {
            sequence: 9_007_199_254_740_993,
            payload: Some(stream_frame::Payload::TerminalOutput(vec![0, 255, 27, 10])),
            ..Default::default()
        },
    );
    check(
        "frame_ack",
        StreamFrame {
            payload: Some(stream_frame::Payload::Ack(StreamAck {
                received_through: u64::MAX,
                available_credit_bytes: 1_048_576,
            })),
            ..Default::default()
        },
    );
}

#[test]
fn oneof_last_member_wins() {
    let mut wire = fixture("frame_input");
    wire.extend(fixture("frame_ack"));
    let decoded = StreamFrame::decode(wire.as_slice()).unwrap();
    assert!(matches!(
        decoded.payload,
        Some(stream_frame::Payload::Ack(_))
    ));
}

#[test]
fn unknown_fields_are_accepted_but_prost_drops_them() {
    let future = fixture("hello_unknown");
    let decoded = HelloRequest::decode(future.as_slice()).unwrap();
    assert_eq!(decoded.client_id, "客户端📡");
    // This documents a real compatibility boundary: a Rust relay MUST forward
    // the original bytes, because decode/re-encode loses future fields.
    assert_eq!(decoded.encode_to_vec(), fixture("hello"));
    assert_ne!(decoded.encode_to_vec(), future);
}

#[test]
fn malformed_wire_is_rejected() {
    assert!(HelloRequest::decode(&[0x0a, 0xff][..]).is_err());
}

#[test]
fn desktop_shutdown_requires_an_explicit_action() {
    check(
        "desktop_shutdown",
        DesktopRuntimeControl {
            action: Some(desktop_runtime_control::Action::Shutdown(
                DesktopShutdownRequest {},
            )),
        },
    );
    assert_eq!(DesktopRuntimeControl::decode(&[][..]).unwrap().action, None);
}

/// An explicitly unsupported surface must survive decoding: losing it would
/// leave a client guessing that presence or account binding might work.
#[test]
fn hello_reports_unsupported_surfaces() {
    check(
        "hello_unsupported",
        HelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 1 }),
            host_instance_id: "新进程".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            capabilities: vec!["protocol.hello.v1".into(), "host.identity.v1".into()],
            max_frame_bytes: 1_048_576,
            capability_status: vec![
                CapabilityStatus {
                    name: "presence".into(),
                    state: CapabilityState::Unsupported as i32,
                    reason: "host.capability.reserved".into(),
                },
                CapabilityStatus {
                    name: "accountBinding".into(),
                    state: CapabilityState::Unsupported as i32,
                    reason: "host.capability.reserved".into(),
                },
            ],
        },
    );
}
