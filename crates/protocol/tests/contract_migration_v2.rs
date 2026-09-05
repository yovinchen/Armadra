//! Reverse export package v2 (Go Host 业务所有权迁移 §2.12).
//!
//! The Runtime is the reader of this package and the writer of the report the
//! Host verifies, so these fixtures are the ones that decide whether a rollback
//! can hand the epoch back. They are produced by the Go contract test and
//! decoded here independently.

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
fn the_index_carries_the_domain_epoch_and_both_digests() {
    check(
        "reverse_export_index",
        ReverseExportIndex {
            format_version: 2,
            host_id: "0123456789abcdef0123456789abcdef".into(),
            epoch: 9_007_199_254_740_993,
            event_sequence: u64::MAX,
            domain: "canvas".into(),
            entity_count: 3,
            files: vec![ReverseExportFile {
                name: "6ff1d1de4b2ba01b7b0e4b2a6cbb0a51.pb".into(),
                workspace_id: "工作区-1".into(),
                bytes: 512,
                sha256: vec![4; 32],
                content_sha256: vec![5; 32],
                entity_count: 3,
            }],
        },
    );
}

#[test]
fn an_entity_record_names_exactly_one_entity_and_may_name_none() {
    check(
        "reverse_export_record",
        ReverseExportRecord {
            entity: Some(reverse_export_record::Entity::Node(CanvasNode {
                node_id: "节点-1".into(),
                canvas_id: "canvas-1".into(),
                r#type: "sticky".into(),
                title: "便签📌".into(),
                color: "#0a84ff".into(),
                position: Some(CanvasPoint { x: -1.5, y: 2.0 }),
                parent_id: "frame-1".into(),
                data_json: r#"{"text":"内容"}"#.as_bytes().to_vec(),
                created_at_unix_ms: 1_788_557_000_000,
                updated_at_unix_ms: 1_788_557_000_001,
                ..Default::default()
            })),
        },
    );
    // A record with no member is what a foreign or truncated package decodes
    // to. It has to stay distinguishable from "a workspace with empty fields",
    // because the importer refuses on it instead of writing a blank row.
    check("reverse_export_record_absent", ReverseExportRecord::default());
    let absent = fixture("reverse_export_record_absent");
    assert!(absent.is_empty());
}

#[test]
fn the_worker_action_and_its_report_round_trip() {
    check(
        "reverse_apply_request",
        WorkerRequest {
            request_id: "reverse-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::ApplyReverseExport(
                ApplyReverseExportRequest {
                    domain: "canvas".into(),
                    package_path: "/data/reverse-export".into(),
                    index_sha256: vec![6; 32],
                    expected_epoch: 2,
                    import_id: "reverse-import-1".into(),
                },
            )),
        },
    );
    check(
        "reverse_import_report",
        WorkerResponse {
            request_id: "reverse-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::ReverseImport(ReverseImportReport {
                import_id: "reverse-import-1".into(),
                domain: "canvas".into(),
                epoch: 2,
                index_sha256: vec![6; 32],
                entity_count: 3,
                replayed: true,
                applied_at_unix_ms: 1_788_557_000_000,
                reexported: vec![ReverseExportFile {
                    workspace_id: "工作区-1".into(),
                    content_sha256: vec![5; 32],
                    entity_count: 3,
                    ..Default::default()
                }],
                tables: vec![ExportTable {
                    name: "nodes".into(),
                    row_count: 1,
                    readable: true,
                    schema_sha256: Vec::new(),
                }],
                issues: vec![ExportIssue {
                    code: "reverse.unsupported_entity".into(),
                    severity: "error".into(),
                    entity: "nodes/节点-2".into(),
                    detail: "记录类型未知".into(),
                }],
            })),
        },
    );
}
