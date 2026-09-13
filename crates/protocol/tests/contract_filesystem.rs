//! The filesystem domain's registration record (Go Host 业务所有权迁移 §2.5).
//!
//! The Runtime is the side that gives this domain up and the side that has to
//! read the Host's record back on a rollback, so it decodes these fixtures
//! independently of the Go implementation that produced them.
//!
//! Two properties are pinned beyond the field numbers, and both are the
//! difference between "not allowed" and "not decided":
//!
//!   * a permission set that is present and empty is not the same wire as one
//!     that is absent, so a workspace whose record was never filled in cannot
//!     be read as a workspace that denies everything (or the reverse);
//!   * a tombstone keeps its revision, because re-registering a root has to
//!     name it rather than start from zero.

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
fn workspace_roots_cross_the_wire_unchanged() {
    check(
        "filesystem_remote_root",
        WorkspaceRoot {
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            execution_host_id: "构建机".into(),
            canonical_path: "/srv/项目/armadra".into(),
            proof_sha256: vec![5; 32],
            permissions: Some(CanvasWorkspacePermissions {
                read: true,
                write: true,
                execute: false,
            }),
            registered_at_unix_ms: 1_788_557_000_000,
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 9_007_199_254_740_993,
            deleted: false,
        },
    );
    check(
        "filesystem_update_root",
        UpdateWorkspaceRootRequest {
            meta: Some(CommandMeta {
                request_id: "filesystem-1".into(),
                scope: Some(Scope {
                    workspace_id: "0123456789abcdef0123456789abcdef".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            operation_id: "filesystem/0123456789abcdef0123456789abcdef/permissions-1".into(),
            expected_revision: u64::MAX,
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            permissions: Some(CanvasWorkspacePermissions {
                read: true,
                write: true,
                execute: true,
            }),
        },
    );
    check(
        "filesystem_root_tombstone",
        WorkspaceRoot {
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 4,
            deleted: true,
            ..Default::default()
        },
    );
    check(
        "filesystem_worker_roots",
        FilesystemWorkerResponse {
            result: Some(filesystem_worker_response::Result::Roots(
                WorkerWorkspaceRoots {
                    roots: vec![
                        WorkspaceRoot {
                            workspace_id: "0123456789abcdef0123456789abcdef".into(),
                            canonical_path: "/home/用户/项目".into(),
                            permissions: Some(CanvasWorkspacePermissions {
                                read: true,
                                write: true,
                                execute: false,
                            }),
                            ..Default::default()
                        },
                        WorkspaceRoot {
                            workspace_id: "abcdef0123456789abcdef0123456789".into(),
                            execution_host_id: "构建机".into(),
                            canonical_path: "/srv/项目/armadra".into(),
                            permissions: Some(CanvasWorkspacePermissions {
                                read: true,
                                write: false,
                                execute: false,
                            }),
                            ..Default::default()
                        },
                    ],
                },
            )),
        },
    );
}

#[test]
fn an_absent_permission_set_is_not_a_denied_one() {
    let denied = WorkspaceRoot {
        workspace_id: "w".into(),
        permissions: Some(CanvasWorkspacePermissions::default()),
        ..Default::default()
    };
    let absent = WorkspaceRoot {
        workspace_id: "w".into(),
        ..Default::default()
    };
    assert_ne!(denied.encode_to_vec(), absent.encode_to_vec());
    let decoded = WorkspaceRoot::decode(absent.encode_to_vec().as_slice()).unwrap();
    assert!(decoded.permissions.is_none());
    let decoded = WorkspaceRoot::decode(denied.encode_to_vec().as_slice()).unwrap();
    assert_eq!(
        decoded.permissions,
        Some(CanvasWorkspacePermissions::default())
    );
}

#[test]
fn the_filesystem_travels_on_worker_action_26_and_event_member_140() {
    let request = WorkerRequest {
        request_id: "h-filesystem-1".into(),
        host_id: "0123456789abcdef0123456789abcdef".into(),
        action: Some(worker_request::Action::Filesystem(
            FilesystemWorkerRequest {
                action: Some(filesystem_worker_request::Action::ListRoots(
                    ListWorkerRootsRequest {},
                )),
            },
        )),
        ..Default::default()
    };
    let wire = request.encode_to_vec();
    // Field 26, length-delimited: (26 << 3) | 2 == 210, which prost writes as
    // the two-byte varint d2 01. A frame that landed on another number would
    // be answered by another domain's handler on a peer that has both.
    assert!(wire.windows(2).any(|pair| pair == [0xd2, 0x01]));
    assert_eq!(WorkerRequest::decode(wire.as_slice()).unwrap(), request);

    let envelope = EventEnvelope {
        sequence: 12,
        domain: EventDomain::Filesystem as i32,
        kind: "root".into(),
        entity_id: "0123456789abcdef0123456789abcdef".into(),
        workspace_id: "0123456789abcdef0123456789abcdef".into(),
        revision: 3,
        entity: Some(event_envelope::Entity::FilesystemRoot(WorkspaceRoot {
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            canonical_path: "/home/用户/项目".into(),
            revision: 3,
            ..Default::default()
        })),
        ..Default::default()
    };
    let decoded = EventEnvelope::decode(envelope.encode_to_vec().as_slice()).unwrap();
    assert_eq!(decoded, envelope);

    // The reverse export package carries the same record, so a handback is
    // compared against the entity the stream published rather than against a
    // second spelling of it.
    let record = ReverseExportRecord {
        entity: Some(reverse_export_record::Entity::WorkspaceRoot(
            WorkspaceRoot {
                workspace_id: "w".into(),
                canonical_path: "/项目".into(),
                ..Default::default()
            },
        )),
    };
    assert_eq!(
        ReverseExportRecord::decode(record.encode_to_vec().as_slice()).unwrap(),
        record
    );
}
