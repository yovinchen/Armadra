//! The private Worker surface (`worker.proto`): the handshake, a file chunk
//! split mid-codepoint, the absent-versus-present content version, and the
//! closed proxy operation numbers.

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
fn private_worker_identity_and_partial_utf8_chunks() {
    check(
        "worker_hello",
        WorkerRequest {
            request_id: "request-worker".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            deadline_unix_ms: 1788557900000,
            expected_instance_id: String::new(),
            action: Some(worker_request::Action::Hello(WorkerHelloRequest {
                protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            })),
        },
    );
    check(
        "worker_chunk",
        WorkerResponse {
            request_id: "chunk-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::FileChunk(WorkerFileChunk {
                root_id: "root-1".into(),
                path: "正文.txt".into(),
                mime_type: "text/plain".into(),
                sha256: vec![7; 32],
                total_bytes: 4,
                offset: 1,
                data: vec![0x9f, 0x99, 0x82],
                eof: true,
            })),
        },
    );
}

/// The remote execution surface (H02). Two things have to survive the wire
/// exactly: whether a save carried a content version at all — absent means
/// create-only, and a lost `optional` would turn a refusal into an overwrite —
/// and the operation enum, whose numbers are the closed proxy allowlist.
#[test]
fn remote_writes_keep_an_absent_content_version_distinct_from_a_present_one() {
    check(
        "worker_write",
        WorkerRequest {
            request_id: "write-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1788557900000,
            action: Some(worker_request::Action::WriteFile(WorkerWriteFileRequest {
                root_id: "root-1".into(),
                path: "正文.txt".into(),
                content: "内容\n".into(),
                expected_sha256: Some("a".repeat(64)),
                bom: true,
            })),
        },
    );
    check(
        "worker_write_new",
        WorkerRequest {
            request_id: "write-2".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1788557900000,
            action: Some(worker_request::Action::WriteFile(WorkerWriteFileRequest {
                root_id: "root-1".into(),
                path: "new.txt".into(),
                content: String::new(),
                expected_sha256: None,
                bom: false,
            })),
        },
    );
}

#[test]
fn a_proxied_operation_keeps_its_status_and_its_closed_operation_number() {
    assert_eq!(WorkerServiceOperation::Unspecified as i32, 0);
    assert_eq!(WorkerServiceOperation::GitCommit as i32, 17);
    check(
        "worker_service",
        WorkerRequest {
            request_id: "service-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1788557900000,
            action: Some(worker_request::Action::Service(WorkerServiceRequest {
                root_id: "root-1".into(),
                operation: WorkerServiceOperation::GitCommit as i32,
                request_json: r#"{"path":".","message":"提交"}"#.as_bytes().to_vec(),
                allow_write: true,
                allow_execute: true,
            })),
        },
    );
    check(
        "worker_service_reply",
        WorkerResponse {
            request_id: "service-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::Service(WorkerServiceResponse {
                http_status: 409,
                response_json: "{\"code\":\"conflict\",\"message\":\"版本不匹配\"}"
                    .as_bytes()
                    .to_vec(),
            })),
        },
    );
}
