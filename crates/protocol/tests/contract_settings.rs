//! The settings domain (Go Host 业务所有权迁移 §2.4).
//!
//! The Runtime is the side that gives the settings document up and the side
//! that takes it back, so it decodes these fixtures independently of the Go
//! implementation that produced them. Two properties matter more than the
//! field numbers:
//!
//!   - the document is bytes. What the Runtime writes into `settings.json` is
//!     what the Host stores and what comes back, byte for byte, because a
//!     digest over a re-serialized tree would depend on two languages agreeing
//!     about key order, escaping and number formatting;
//!   - the Worker frame names its direction. An export and an import differ by
//!     an enum, not by whether a field happened to be populated, so a dropped
//!     document is a refused import rather than a settings file wiped clean.

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

const DOCUMENT: &str = r#"{"terminal":{"backend":"tmux"},"主题":"深色"}"#;

fn global_document(revision: u64) -> SettingsDocument {
    SettingsDocument {
        scope: SettingsScope::Global as i32,
        document: DOCUMENT.as_bytes().to_vec(),
        sha256: vec![3; 32],
        schema_version: 1,
        revision,
        ..SettingsDocument::default()
    }
}

#[test]
fn settings_documents_cross_the_wire_unchanged() {
    check(
        "settings_document_global",
        SettingsDocument {
            updated_at_unix_ms: 1_788_557_900_000,
            ..global_document(9_007_199_254_740_993)
        },
    );
    check(
        "settings_document_device",
        SettingsDocument {
            scope: SettingsScope::Device as i32,
            device_id: "0123456789abcdef0123456789abcdef".into(),
            document: br#"{"keymap":{"mac":{"canvas.tidy":"Mod+Shift+K"}}}"#.to_vec(),
            sha256: vec![4; 32],
            schema_version: 1,
            revision: 1,
            ..SettingsDocument::default()
        },
    );
}

#[test]
fn execution_hosts_keep_their_identity_and_kind() {
    check(
        "settings_execution_host_ssh",
        ExecutionHost {
            execution_host_id: "盒子-1".into(),
            name: "构建机".into(),
            kind: ExecutionHostKind::Ssh as i32,
            ssh: Some(SshExecutionHost {
                host: "example.com".into(),
                port: 2222,
                user: "ada".into(),
                identity_file: "~/.ssh/id_ed25519".into(),
                worker_path: "/opt/armadra/armadra-runtime".into(),
                state_dir: "/var/lib/armadra".into(),
            }),
            updated_at_unix_ms: 1_788_557_900_000,
            revision: u64::MAX,
        },
    );
    // The local host's identifier is the empty string, the same convention
    // migration 0009 stores for a workspace that executes on this machine. It
    // has to survive the wire still empty rather than acquiring a name.
    check(
        "settings_execution_host_local",
        ExecutionHost {
            kind: ExecutionHostKind::Local as i32,
            name: "本机".into(),
            revision: 2,
            ..ExecutionHost::default()
        },
    );
}

#[test]
fn the_https_surface_carries_the_document_its_hosts_and_its_sequence() {
    check(
        "settings_get_response",
        GetSettingsResponse {
            document: Some(global_document(4)),
            execution_hosts: vec![ExecutionHost {
                execution_host_id: "盒子-1".into(),
                kind: ExecutionHostKind::Ssh as i32,
                revision: 4,
                ..ExecutionHost::default()
            }],
            event_sequence: 9_007_199_254_740_993,
        },
    );
    // Revision 0 states "this document has never been written". It encodes to
    // nothing, which is exactly why the field must not be optional: a caller
    // that omitted it and a caller that meant "create" have to be the same
    // request, and both have to be refused when a document already exists.
    check(
        "settings_put_create",
        PutSettingsRequest {
            meta: Some(CommandMeta {
                request_id: "settings-1".into(),
                scope: Some(Scope {
                    host_id: "0123456789abcdef0123456789abcdef".into(),
                    ..Scope::default()
                }),
                ..CommandMeta::default()
            }),
            operation_id: "settings/global/0".into(),
            expected_revision: 0,
            document: Some(global_document(0)),
        },
    );
    check(
        "settings_put_response",
        PutSettingsResponse {
            document: Some(global_document(5)),
            receipt: Some(CanvasOperationReceipt {
                operation_id: "settings/global/4".into(),
                transaction_id: 12,
                first_sequence: 30,
                last_sequence: 31,
                ..CanvasOperationReceipt::default()
            }),
        },
    );
}

#[test]
fn the_worker_frame_names_its_direction_in_both_directions() {
    let export = WorkerSettingsRequest {
        direction: WorkerSettingsDirection::Export as i32,
        ..WorkerSettingsRequest::default()
    };
    // An export is a request with no payload at all. Only the direction says
    // so, which is why it is encoded rather than inferred from an empty
    // document — the same bytes with the field missing would be an import
    // that lost its document, and applying that would erase the file.
    assert_eq!(export.encode_to_vec().len(), 3);
    check(
        "settings_worker_export",
        WorkerRequest {
            request_id: "settings-export-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Settings(export)),
        },
    );
    check(
        "settings_worker_import",
        WorkerRequest {
            request_id: "settings-import-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Settings(WorkerSettingsRequest {
                direction: WorkerSettingsDirection::Import as i32,
                document: Some(global_document(6)),
                expected_epoch: 2,
                import_id: "0123456789abcdef0123456789abcdef".into(),
            })),
        },
    );
    check(
        "settings_worker_snapshot",
        WorkerResponse {
            request_id: "settings-import-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::Settings(WorkerSettingsSnapshot {
                document: Some(global_document(0)),
                local: Some(WorkerLocalSettings {
                    terminal_backend: "tmux".into(),
                    browser_available: true,
                    power_policy: "manual".into(),
                    path_augmented: true,
                }),
                execution_hosts: vec![ExecutionHost {
                    execution_host_id: "盒子-1".into(),
                    kind: ExecutionHostKind::Ssh as i32,
                    ssh: Some(SshExecutionHost {
                        host: "example.com".into(),
                        worker_path: "/opt/armadra/armadra-runtime".into(),
                        ..SshExecutionHost::default()
                    }),
                    ..ExecutionHost::default()
                }],
                applied: true,
                replayed: false,
            })),
        },
    );
}

#[test]
fn the_stream_envelope_carries_a_host_wide_document() {
    let wire = fixture("settings_event_envelope");
    let envelope = EventEnvelope::decode(wire.as_slice()).unwrap();
    // Host-wide, so no workspace. A subscription admits it on the settings
    // grant alone; attributing it to one workspace would hide the change from
    // every other one the client follows.
    assert!(envelope.workspace_id.is_empty());
    assert_eq!(envelope.domain, EventDomain::Settings as i32);
    assert_eq!(envelope.kind, "document");
    match envelope.entity {
        Some(event_envelope::Entity::SettingsDocument(ref document)) => {
            assert_eq!(document.document, DOCUMENT.as_bytes());
            assert_eq!(document.revision, 5);
        }
        _ => panic!("the settings envelope does not carry a settings document"),
    }
    assert_eq!(envelope.encode_to_vec(), wire);
}

/// Zero is not a scope, not a kind and not a direction. Reading zero as GLOBAL
/// would let an unnamed device overlay replace the document every device
/// reads; reading it as IMPORT would turn a malformed frame into a write.
#[test]
fn unspecified_values_stay_unspecified() {
    assert_eq!(SettingsDocument::default().scope, 0);
    assert_eq!(ExecutionHost::default().kind, 0);
    assert_eq!(WorkerSettingsRequest::default().direction, 0);
    assert_eq!(SettingsScope::try_from(0), Ok(SettingsScope::Unspecified));
    assert!(SettingsScope::try_from(99).is_err());
    assert!(ExecutionHostKind::try_from(99).is_err());
    assert!(WorkerSettingsDirection::try_from(99).is_err());
}
