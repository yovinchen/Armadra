//! Remote execution completion, batches 4 and 5 (remote completion design
//! §3.8). The Runtime is the end that speaks these frames on the execution
//! host, so its encoding is the one a Go Host will actually parse: it has to
//! match the shared fixtures byte for byte, not merely round-trip against
//! itself.
//!
//! The Host never reads `request_json`; it forwards the envelope and checks the
//! root and the grants. What has to survive across versions is exactly what is
//! typed here — the operation numbers, the upload byte stream and the
//! unsolicited watch frame.

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

/// The controller resolved the grants, but the Worker re-checks them on the
/// execution host, so both flags have to travel rather than be implied by the
/// operation number.
#[test]
fn a_repository_read_carries_the_grants_the_controller_resolved() {
    check(
        "worker_service_branches",
        WorkerRequest {
            request_id: "branches-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Service(WorkerServiceRequest {
                root_id: "root-1".into(),
                operation: WorkerServiceOperation::GitBranches as i32,
                request_json: br#"{"path":"."}"#.to_vec(),
                allow_write: false,
                allow_execute: true,
            })),
        },
    );
}

/// Starting a queued Git operation is a write *and* an execution. A request
/// that carries only one of the two is refused on the host, so the pair must
/// stay independently representable rather than collapse into one grant.
#[test]
fn starting_a_queued_operation_needs_both_grants_on_the_wire() {
    check(
        "worker_service_operation_start",
        WorkerRequest {
            request_id: "queue-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Service(WorkerServiceRequest {
                root_id: "root-1".into(),
                operation: WorkerServiceOperation::GitOperationStart as i32,
                request_json:
                    br#"{"path":".","action":{"kind":"fetch"},"expected":{"head":"HEAD"}}"#.to_vec(),
                allow_write: true,
                allow_execute: true,
            })),
        },
    );
}

/// Deleting to the trash is a move under the execution host's own
/// `.armadra/trash/`, and the number that does it must not be confused with the
/// read that lists what is in there: the two have opposite replay rules.
#[test]
fn deleting_to_the_trash_is_a_write_under_its_own_number() {
    check(
        "worker_service_trash",
        WorkerRequest {
            request_id: "trash-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Service(WorkerServiceRequest {
                root_id: "root-1".into(),
                operation: WorkerServiceOperation::FileEntryDelete as i32,
                request_json: r#"{"path":"文档/草稿.md"}"#.as_bytes().to_vec(),
                allow_write: true,
                allow_execute: false,
            })),
        },
    );
}

/// A remote failure keeps the status the same operation would have returned
/// over the Runtime's own HTTP surface. An operation this build has never heard
/// of has to come back as "unsupported" rather than as a generic 500, which a
/// controller would retry.
#[test]
fn an_unsupported_operation_answers_with_its_own_status() {
    check(
        "worker_service_unknown_operation",
        WorkerResponse {
            request_id: "unknown-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::Service(WorkerServiceResponse {
                http_status: 501,
                response_json: r#"{"code":"unsupported","message":"未知操作"}"#.as_bytes().to_vec(),
            })),
        },
    );
}

/// The contract version is what replaced the exact `runtime_version` match
/// (§3.5), so the two have to be separately representable: this Worker is a
/// different patch build that still speaks contract 1 and stays usable.
#[test]
fn the_handshake_separates_the_contract_from_the_build() {
    check(
        "worker_hello_contract",
        WorkerResponse {
            request_id: "hello-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::Hello(WorkerHelloResponse {
                protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
                host_id: "0123456789abcdef0123456789abcdef".into(),
                instance_id: "abcdef0123456789abcdef0123456789".into(),
                platform: "linux".into(),
                architecture: "aarch64".into(),
                capabilities: vec![
                    "remote.execution.v1".into(),
                    "remote.git.panel.v1".into(),
                    "remote.files.manage.v1".into(),
                    "remote.upload.v1".into(),
                    "remote.watch.v1".into(),
                ],
                max_frame_bytes: 1 << 20,
                max_file_chunk_bytes: 256 << 10,
                max_text_file_bytes: 1 << 20,
                runtime_version: "0.1.1".into(),
                service_contract_version: 1,
                commands: None,
                channel: None,
            })),
        },
    );
}

/// Subscribing names the paths, and unsubscribing names them too, because one
/// root can have several editors open: closing one must not blind the others.
/// The receipt answers with the cursor the next event will carry, so a
/// reconnect knows where the new stream starts instead of guessing.
#[test]
fn a_watch_subscription_names_its_paths_and_answers_with_a_cursor() {
    check(
        "worker_watch_subscribe",
        WorkerRequest {
            request_id: "watch-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Watch(WorkerWatchRequest {
                root_id: "root-1".into(),
                operation: WorkerServiceOperation::WatchSubscribe as i32,
                paths: vec!["README.md".into(), "文档/草稿.md".into()],
            })),
        },
    );
    check(
        "worker_watch_receipt",
        WorkerResponse {
            request_id: "watch-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::Watch(WorkerWatchSubscription {
                root_id: "root-1".into(),
                watched_paths: 2,
                sequence: 1,
            })),
        },
    );
}

/// The unsolicited frame. An empty `request_id` is the whole signal that this
/// is not an answer, so it has to be encodable as empty and stay
/// distinguishable from an answer to a request literally named "". The sequence
/// also has to survive past 2^53, which is where a browser's number would round
/// two neighbouring events into one.
#[test]
fn an_unsolicited_watch_event_reports_changes_and_removals() {
    check(
        "worker_watch_event",
        WorkerResponse {
            request_id: String::new(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::WatchEvent(WorkerWatchEvent {
                root_id: "root-1".into(),
                sequence: 9_007_199_254_740_993,
                changes: vec![
                    WorkerWatchChange {
                        path: "README.md".into(),
                        kind: "modified".into(),
                        sha256: "abc".into(),
                        size: 12,
                        mtime: "2026-09-06T00:00:00Z".into(),
                    },
                    // A removal has no digest, size or mtime to report, and an
                    // empty digest must not read as "hashed to nothing".
                    WorkerWatchChange {
                        path: "文档/草稿.md".into(),
                        kind: "removed".into(),
                        ..Default::default()
                    },
                ],
            })),
        },
    );
}

/// Begin carries the whole-file digest so the Worker can refuse at the end
/// rather than publish bytes nobody vouched for.
#[test]
fn an_upload_begins_with_the_digest_it_will_be_held_to() {
    check(
        "worker_upload_begin",
        WorkerRequest {
            request_id: "upload-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Upload(WorkerUploadRequest {
                step: Some(worker_upload_request::Step::Begin(WorkerUploadBegin {
                    root_id: "root-1".into(),
                    path: ".armadra/assets/图片.png".into(),
                    total_bytes: 3_145_728,
                    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .into(),
                    overwrite_sha256: Some(
                        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210".into(),
                    ),
                    allow_write: true,
                })),
            })),
        },
    );
}

/// A create-only begin leaves `overwrite_sha256` absent. Absent and
/// present-but-empty must not collapse into each other: one refuses an existing
/// file, the other would claim it had an empty version.
#[test]
fn a_create_only_upload_leaves_the_overwrite_digest_absent() {
    check(
        "worker_upload_begin_new",
        WorkerRequest {
            request_id: "upload-2".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Upload(WorkerUploadRequest {
                step: Some(worker_upload_request::Step::Begin(WorkerUploadBegin {
                    root_id: "root-1".into(),
                    path: "new.bin".into(),
                    total_bytes: 0,
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                        .into(),
                    overwrite_sha256: None,
                    allow_write: true,
                })),
            })),
        },
    );
    let decoded = WorkerRequest::decode(fixture("worker_upload_begin_new").as_slice()).unwrap();
    let begin = match decoded.action {
        Some(worker_request::Action::Upload(WorkerUploadRequest {
            step: Some(worker_upload_request::Step::Begin(begin)),
        })) => begin,
        _ => panic!("the begin step was lost"),
    };
    assert!(begin.overwrite_sha256.is_none());
}

/// Offsets are file positions, not chunk indices, so one past a 32-bit file has
/// to encode without wrapping. The payload keeps NUL and newline bytes to prove
/// the field is never treated as text on the way through.
#[test]
fn an_upload_chunk_addresses_bytes_beyond_a_thirty_two_bit_file() {
    check(
        "worker_upload_chunk",
        WorkerRequest {
            request_id: "upload-3".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Upload(WorkerUploadRequest {
                step: Some(worker_upload_request::Step::Chunk(WorkerUploadChunk {
                    upload_id: "u-0123456789abcdef".into(),
                    offset: u64::from(u32::MAX),
                    data: vec![0, 255, 27, 10],
                })),
            })),
        },
    );
}

/// Commit and abort are the same shape and differ only by their oneof number.
/// Reading one as the other would either publish a half-written file or discard
/// a finished one, so the two must never share a tag.
#[test]
fn commit_and_abort_stay_distinct_steps_of_the_same_upload() {
    check(
        "worker_upload_commit",
        WorkerRequest {
            request_id: "upload-4".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Upload(WorkerUploadRequest {
                step: Some(worker_upload_request::Step::Commit(WorkerUploadCommit {
                    upload_id: "u-0123456789abcdef".into(),
                })),
            })),
        },
    );
    check(
        "worker_upload_abort",
        WorkerRequest {
            request_id: "upload-5".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
            deadline_unix_ms: 1_788_557_900_000,
            action: Some(worker_request::Action::Upload(WorkerUploadRequest {
                step: Some(worker_upload_request::Step::Abort(WorkerUploadAbort {
                    upload_id: "u-0123456789abcdef".into(),
                })),
            })),
        },
    );
}

/// The commit receipt reports the destination the file actually landed on, not
/// the one the caller asked for: the Worker resolves it against its own root,
/// and the caller has no other way to learn where the bytes went.
#[test]
fn the_upload_receipt_reports_the_destination_the_worker_chose() {
    check(
        "worker_upload_receipt",
        WorkerResponse {
            request_id: "upload-4".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::Upload(WorkerUploadResponse {
                upload_id: "u-0123456789abcdef".into(),
                received_bytes: 3_145_728,
                sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                path: ".armadra/assets/图片.png".into(),
            })),
        },
    );
}

/// The numbers are the contract; a renamed constant that moved would be a
/// silently different operation on the other machine.
#[test]
fn the_service_operation_numbers_are_frozen() {
    for (operation, number) in [
        (WorkerServiceOperation::GitRepositories, 19),
        (WorkerServiceOperation::GitBranches, 20),
        (WorkerServiceOperation::GitHistory, 21),
        (WorkerServiceOperation::GitCommitDetail, 22),
        (WorkerServiceOperation::GitCommitFileDiff, 23),
        (WorkerServiceOperation::GitWorktrees, 24),
        (WorkerServiceOperation::GitRebaseTodo, 25),
        (WorkerServiceOperation::GitTags, 26),
        (WorkerServiceOperation::GitRemotes, 27),
        (WorkerServiceOperation::GitStashes, 28),
        (WorkerServiceOperation::GitStashDetail, 29),
        (WorkerServiceOperation::GitIntegration, 30),
        (WorkerServiceOperation::GitCherryPickPreview, 31),
        (WorkerServiceOperation::GitHunks, 32),
        (WorkerServiceOperation::GitMessageSource, 33),
        (WorkerServiceOperation::GitOperations, 34),
        (WorkerServiceOperation::GitOperationGet, 35),
        (WorkerServiceOperation::GitOperationStart, 36),
        (WorkerServiceOperation::GitOperationCancel, 37),
        (WorkerServiceOperation::GitApplyHunk, 38),
        (WorkerServiceOperation::FileEntryTrashList, 39),
        (WorkerServiceOperation::FileInfo, 40),
        (WorkerServiceOperation::FileEntryCreate, 41),
        (WorkerServiceOperation::FileEntryRename, 42),
        (WorkerServiceOperation::FileEntryMove, 43),
        (WorkerServiceOperation::FileEntryDelete, 44),
        (WorkerServiceOperation::FileEntryRestore, 45),
        (WorkerServiceOperation::AssetImport, 46),
        (WorkerServiceOperation::WatchSubscribe, 47),
        (WorkerServiceOperation::WatchUnsubscribe, 48),
    ] {
        assert_eq!(operation as i32, number, "{operation:?} moved");
    }
}

/// An unsolicited frame is exactly "a response with no request_id". If an empty
/// request_id ever started being serialized, a controller's demultiplexer would
/// see a reply to a request nobody made, so field 1 has to be absent from the
/// bytes rather than merely empty after decoding.
#[test]
fn a_watch_event_carries_no_request_id() {
    let encoded = WorkerResponse {
        instance_id: "abcdef0123456789abcdef0123456789".into(),
        result: Some(worker_response::Result::WatchEvent(WorkerWatchEvent {
            root_id: "root-1".into(),
            sequence: 1,
            changes: Vec::new(),
        })),
        ..Default::default()
    }
    .encode_to_vec();
    let decoded = WorkerResponse::decode(encoded.as_slice()).unwrap();
    assert_eq!(decoded.request_id, "");
    assert!(
        !top_level_field_numbers(&encoded).contains(&1),
        "field 1 was serialized on a frame that has no request id"
    );
}

/// Walks the frame the way a foreign parser would, so the assertion is about
/// the bytes rather than about what this crate chooses to hand back.
fn top_level_field_numbers(frame: &[u8]) -> Vec<u32> {
    let mut numbers = Vec::new();
    let mut rest = frame;
    while !rest.is_empty() {
        let (tag, after_tag) = varint(rest);
        numbers.push((tag >> 3) as u32);
        rest = match tag & 7 {
            0 => varint(after_tag).1,
            1 => &after_tag[8..],
            2 => {
                let (length, body) = varint(after_tag);
                &body[length as usize..]
            }
            5 => &after_tag[4..],
            kind => panic!("unexpected wire type {kind}"),
        };
    }
    numbers
}

fn varint(bytes: &[u8]) -> (u64, &[u8]) {
    let mut value = 0u64;
    for (index, byte) in bytes.iter().enumerate() {
        value |= u64::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            return (value, &bytes[index + 1..]);
        }
    }
    panic!("the frame is not valid protobuf");
}
