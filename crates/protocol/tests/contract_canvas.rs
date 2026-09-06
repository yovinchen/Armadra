//! The canvas surface the ownership handover moves (`canvas.proto`).

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

fn canvas_node() -> CanvasNode {
    CanvasNode {
        node_id: "node-终端".into(),
        canvas_id: "canvas-1".into(),
        r#type: "terminal".into(),
        title: "构建 📦".into(),
        color: "#0a84ff".into(),
        position: Some(CanvasPoint {
            x: -1024.5,
            y: 2048.25,
        }),
        size: Some(CanvasSize {
            width: 640.0,
            height: 480.0,
        }),
        collapsed: Some(false),
        expanded_height: Some(0.0),
        // Frame nesting is a plain parent reference, so a migration can compare
        // it without understanding what a frame draws like.
        parent_id: "node-frame".into(),
        data_json: br#"{"sessionId":"session-1"}"#.to_vec(),
        assets: vec![CanvasAssetRef {
            asset_id: "asset-1".into(),
            workspace_id: "workspace-1".into(),
            relative_path: ".armadra/assets/ab/cd/图片.png".into(),
            sha256: vec![5; 32],
            bytes: 9_007_199_254_740_993,
            mime_type: "image/png".into(),
        }],
        created_at_unix_ms: 1_788_557_000_000,
        updated_at_unix_ms: 1_788_557_900_000,
        revision: 9_007_199_254_740_993,
    }
}

/// The canvas surface the ownership handover moves (host protocol design §4).
/// Each fixture pins a statement that migration depends on: an absent optional
/// is not a zero, a nested frame keeps its parent, an asset keeps its digest,
/// and a 64-bit revision or epoch survives the trip in all three runtimes.
#[test]
fn canvas_documents_events_and_the_ownership_handoff() {
    check(
        "canvas_document",
        CanvasDocument {
            canvas: Some(Canvas {
                canvas_id: "canvas-1".into(),
                workspace_id: "workspace-1".into(),
                name: "默认画布".into(),
                sort_order: i64::MIN,
                viewport: Some(CanvasViewport {
                    x: -0.5,
                    y: 12.25,
                    zoom: 1.5,
                }),
                whiteboard: Some(CanvasWhiteboard {
                    schema_version: 2,
                    engine_version: "armadra-flow".into(),
                    snapshot: vec![0x00, 0x9f, 0x99, 0x82],
                    sha256: vec![1; 32],
                    bytes: 4,
                }),
                created_at_unix_ms: 1_788_557_000_000,
                updated_at_unix_ms: 1_788_557_900_000,
                revision: u64::MAX,
            }),
            nodes: vec![
                canvas_node(),
                CanvasNode {
                    node_id: "node-frame".into(),
                    canvas_id: "canvas-1".into(),
                    r#type: "group".into(),
                    title: "Frame".into(),
                    position: Some(CanvasPoint::default()),
                    created_at_unix_ms: 1_788_557_000_000,
                    updated_at_unix_ms: 1_788_557_000_000,
                    revision: 1,
                    ..Default::default()
                },
            ],
            edges: vec![CanvasEdge {
                edge_id: "edge-1".into(),
                canvas_id: "canvas-1".into(),
                source_node_id: "node-终端".into(),
                target_node_id: "node-frame".into(),
                kind: CanvasEdgeKind::Link as i32,
                created_at_unix_ms: 1_788_557_000_000,
                updated_at_unix_ms: 1_788_557_000_000,
                revision: 1,
            }],
            annotations: vec![CanvasAnnotation {
                annotation_id: "annotation-1".into(),
                canvas_id: "canvas-1".into(),
                node_id: "node-终端".into(),
                labels: vec!["构建".into(), "夜间".into()],
                note: "备注 🈶".into(),
                created_at_unix_ms: 1_788_557_000_000,
                updated_at_unix_ms: 1_788_557_900_000,
                revision: 2,
            }],
            event_sequence: 9_007_199_254_740_993,
        },
    );
    check(
        "canvas_save_request",
        SaveCanvasDocumentRequest {
            meta: Some(CommandMeta {
                request_id: "save-1".into(),
                scope: Some(Scope {
                    host_id: "0123456789abcdef0123456789abcdef".into(),
                    workspace_id: "workspace-1".into(),
                    execution_host_id: "0123456789abcdef0123456789abcdef".into(),
                }),
                idempotency_key: "canvas/workspace-1/canvas-1/7".into(),
                expected_revision: None,
                deadline_unix_ms: 0,
            }),
            operation_id: "canvas/workspace-1/canvas-1/7".into(),
            canvas: Some(Canvas {
                canvas_id: "canvas-1".into(),
                workspace_id: "workspace-1".into(),
                name: "默认画布".into(),
                viewport: Some(CanvasViewport {
                    x: 0.0,
                    y: 0.0,
                    zoom: 1.0,
                }),
                ..Default::default()
            }),
            expected_revision: 9_007_199_254_740_993,
            nodes: vec![canvas_node()],
            edges: vec![],
            annotations: vec![],
        },
    );
    // An absent size means "the client's default for this node type"; a
    // zero-sized node is a different statement and must encode differently.
    check(
        "canvas_node_absent_size",
        CanvasNode {
            node_id: "node-裸".into(),
            canvas_id: "canvas-1".into(),
            r#type: "sticky".into(),
            position: Some(CanvasPoint { x: 0.0, y: 0.0 }),
            revision: 1,
            ..Default::default()
        },
    );
    check(
        "canvas_receipt",
        CanvasOperationReceipt {
            operation_id: "canvas/workspace-1/canvas-1/7".into(),
            transaction_id: 9_007_199_254_740_993,
            first_sequence: 9_007_199_254_740_993,
            last_sequence: u64::MAX,
            replayed: true,
            revisions: vec![
                CanvasRevision {
                    kind: CanvasEntityKind::Canvas as i32,
                    entity_id: "canvas-1".into(),
                    revision: 2,
                    deleted: false,
                },
                CanvasRevision {
                    kind: CanvasEntityKind::Node as i32,
                    entity_id: "node-终端".into(),
                    revision: u64::MAX,
                    deleted: true,
                },
            ],
        },
    );
    check(
        "canvas_event",
        CanvasEventEnvelope {
            sequence: 9_007_199_254_740_993,
            transaction_id: 42,
            operation_id: "canvas/workspace-1/canvas-1/7".into(),
            transaction_index: 1,
            transaction_size: 3,
            workspace_id: "workspace-1".into(),
            kind: CanvasEntityKind::Node as i32,
            entity_id: "node-终端".into(),
            revision: u64::MAX,
            deleted: false,
            entity: Some(canvas_event_envelope::Entity::Node(canvas_node())),
        },
    );
    check(
        "canvas_event_snapshot_required",
        CanvasEventPage {
            status: CanvasCursorStatus::SnapshotRequired as i32,
            events: vec![],
            next_cursor: 0,
            min_cursor: 9_007_199_254_740_993,
            high_watermark: u64::MAX,
            has_more: false,
        },
    );
    check(
        "canvas_ownership_switching",
        CanvasOwnership {
            domain: "canvas".into(),
            owner: CanvasOwnershipOwner::Runtime as i32,
            epoch: 9_007_199_254_740_993,
            phase: CanvasOwnershipPhase::Switching as i32,
            import_id: "0123456789abcdef0123456789abcdef".into(),
            reason_code: "ownership.switch.verified".into(),
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 3,
        },
    );
    check(
        "canvas_consistency_report",
        CanvasConsistencyReport {
            import_id: "0123456789abcdef0123456789abcdef".into(),
            export_id: "导出-1".into(),
            manifest_sha256: vec![2; 32],
            checks: vec![
                CanvasConsistencyCheck {
                    check: "nodes".into(),
                    expected_count: 2,
                    actual_count: 2,
                    matched: true,
                    differences: vec![],
                },
                CanvasConsistencyCheck {
                    check: "assets".into(),
                    expected_count: 1,
                    actual_count: 0,
                    matched: false,
                    differences: vec!["asset-1".into()],
                },
            ],
            matched: false,
            entity_count: 9_007_199_254_740_993,
            verified_at_unix_ms: 1_788_557_900_000,
        },
    );
    // The epoch handoff itself: the Host names the epoch and the epoch it
    // believes is stored, so a repeat is idempotent and a stale one fails.
    check(
        "worker_set_ownership",
        WorkerRequest {
            request_id: "ownership-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: String::new(),
            deadline_unix_ms: 0,
            action: Some(worker_request::Action::SetWriteOwnership(
                SetWriteOwnershipRequest {
                    domain: "canvas".into(),
                    owner: CanvasOwnershipOwner::Host as i32,
                    epoch: 9_007_199_254_740_993,
                    expected_epoch: 9_007_199_254_740_992,
                    reason_code: "ownership.switch.verified".into(),
                },
            )),
        },
    );
    check(
        "worker_write_ownership",
        WorkerResponse {
            request_id: "ownership-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::WriteOwnership(
                WorkerWriteOwnership {
                    domain: "canvas".into(),
                    owner: CanvasOwnershipOwner::Host as i32,
                    epoch: 9_007_199_254_740_993,
                    updated_at_unix_ms: 1_788_557_900_000,
                    reason_code: "ownership.switch.verified".into(),
                },
            )),
        },
    );

    // A node whose size was never set and one explicitly stored at zero are
    // different documents. Losing that distinction silently resizes canvases.
    let absent = CanvasNode {
        node_id: "n".into(),
        canvas_id: "c".into(),
        ..Default::default()
    };
    let zero = CanvasNode {
        size: Some(CanvasSize::default()),
        collapsed: Some(false),
        expanded_height: Some(0.0),
        ..absent.clone()
    };
    assert_ne!(absent.encode_to_vec(), zero.encode_to_vec());
    let decoded = CanvasNode::decode(absent.encode_to_vec().as_slice()).unwrap();
    assert!(decoded.size.is_none() && decoded.collapsed.is_none());
    assert!(decoded.expanded_height.is_none());

    // Zero is reserved everywhere: a default-constructed message never claims
    // to be a real entity kind, edge kind, cursor status, owner or phase.
    assert_eq!(CanvasEntityKind::Unspecified as i32, 0);
    assert_eq!(CanvasEdgeKind::Unspecified as i32, 0);
    assert_eq!(CanvasCursorStatus::Unspecified as i32, 0);
    assert_eq!(CanvasOwnershipOwner::Unspecified as i32, 0);
    assert_eq!(CanvasOwnershipPhase::Unspecified as i32, 0);
    // And an owner a newer peer introduced stays unknown rather than folding
    // into RUNTIME, which would hand writes back to a process that lost them.
    let unknown = CanvasOwnership {
        domain: "canvas".into(),
        owner: 999,
        epoch: 2,
        ..Default::default()
    };
    assert_eq!(
        CanvasOwnership::decode(unknown.encode_to_vec().as_slice())
            .unwrap()
            .owner,
        999
    );
}
