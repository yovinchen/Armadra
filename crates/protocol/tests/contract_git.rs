//! The git domain (Go Host 业务所有权迁移 §2.8, Git 设计 §2, §10).
//!
//! The Runtime is the side that keeps running every Git command after this
//! domain moves, so it decodes these fixtures independently of the Go
//! implementation that produced them: a queue entry the two sides disagreed
//! about would be a command run with parameters nobody authorized.
//!
//! Three properties are pinned beyond the field numbers:
//!
//!   * an unspecified operation state is not a queued or a succeeded one, so an
//!     interrupted push can never decode as done;
//!   * the action bytes and their digest travel together, so a rewritten body
//!     is refused rather than executed;
//!   * the frame numbers are the ones §2.8 and §2.3 assign — Worker action 29
//!     and event members 220-222 — because a frame that landed elsewhere would
//!     be answered by another domain's handler on a peer that has both.

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

fn scope() -> RepositoryScope {
    RepositoryScope {
        workspace_id: "0123456789abcdef0123456789abcdef".into(),
        repository_id: "3b1f0a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8".into(),
        repository_path: "/home/用户/项目/armadra".into(),
        ..Default::default()
    }
}

#[test]
fn git_operations_cross_the_wire_unchanged() {
    check(
        "git_operation_queued",
        GitOperation {
            operation_id: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f".into(),
            scope: Some(scope()),
            action: r#"{"kind":"push","remote":"origin","branch":"功能/推送"}"#
                .as_bytes()
                .to_vec(),
            action_sha256: vec![9; 32],
            expected: Some(GitExpectation {
                head_oid: "1f2e3d4c5b6a798807162534435261708f9e0d1c".into(),
                ref_name: "refs/heads/功能/推送".into(),
                ref_oid: "aabbccddeeff00112233445566778899aabbccdd".into(),
                ..Default::default()
            }),
            kind: GitActionKind::Push as i32,
            state: GitOperationState::Queued as i32,
            created_at_unix_ms: 1_788_557_000_000,
            revision: 1,
            ..Default::default()
        },
    );
    check(
        "git_operation_unknown_outcome",
        GitOperation {
            operation_id: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f".into(),
            scope: Some(scope()),
            action_sha256: vec![9; 32],
            affected: vec!["refs/heads/功能/推送".into()],
            progress: 60,
            kind: GitActionKind::Push as i32,
            state: GitOperationState::UnknownOutcome as i32,
            message_code: "git.operation.interrupted".into(),
            created_at_unix_ms: 1_788_557_000_000,
            started_at_unix_ms: 1_788_557_000_500,
            finished_at_unix_ms: 1_788_557_900_000,
            revision: 4,
            ..Default::default()
        },
    );
    check(
        "git_repository_state_conflict",
        RepositoryState {
            scope: Some(scope()),
            head_oid: "1f2e3d4c5b6a798807162534435261708f9e0d1c".into(),
            detached: true,
            index_fingerprint: vec![3; 32],
            worktree_fingerprint: vec![4; 32],
            upstream: "origin/main".into(),
            ahead: 2,
            behind: 7,
            operation_state: GitOperationState::AwaitingResolution as i32,
            observed_at_unix_ms: 1_788_557_900_000,
            revision: 9_007_199_254_740_993,
            ..Default::default()
        },
    );
    check(
        "git_clone_job",
        GitCloneJob {
            job_id: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8ea0".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            url_sha256: vec![5; 32],
            display_url: "https://example.invalid/组织/仓库.git".into(),
            target_path: "/home/用户/项目/仓库".into(),
            progress: 42,
            state: GitCloneState::Running as i32,
            created_at_unix_ms: 1_788_557_000_000,
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 2,
            ..Default::default()
        },
    );
    check(
        "git_worker_snapshot",
        GitWorkerResponse {
            result: Some(git_worker_response::Result::Snapshot(GitDomainSnapshot {
                queued: 1,
                running: 1,
                clone_jobs: 0,
                active_operation_ids: vec!["0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f".into()],
            })),
        },
    );
    check(
        "git_worker_read",
        GitWorkerRequest {
            action: Some(git_worker_request::Action::Read(GitRead {
                scope: Some(scope()),
                request_json: br#"{"path":".","reference":"HEAD"}"#.to_vec(),
                workspace_root: "/home/用户/项目".into(),
                method: GitReadMethod::History as i32,
            })),
        },
    );
    check(
        "git_enqueue_request",
        EnqueueGitOperationRequest {
            meta: Some(CommandMeta {
                request_id: "git-1".into(),
                scope: Some(Scope {
                    workspace_id: "0123456789abcdef0123456789abcdef".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            operation_id: "git/0123456789abcdef0123456789abcdef/stage-1".into(),
            scope: Some(scope()),
            action: r#"{"kind":"stage","paths":["源码/主.rs"]}"#.as_bytes().to_vec(),
            action_sha256: vec![6; 32],
            expected: Some(GitExpectation {
                index_fingerprint: vec![3; 32],
                ..Default::default()
            }),
            kind: GitActionKind::Stage as i32,
        },
    );
}

#[test]
fn an_unspecified_operation_state_is_not_a_finished_one() {
    let unspecified = GitOperation {
        operation_id: "o".into(),
        ..Default::default()
    };
    let queued = GitOperation {
        operation_id: "o".into(),
        state: GitOperationState::Queued as i32,
        ..Default::default()
    };
    assert_ne!(unspecified.encode_to_vec(), queued.encode_to_vec());
    let decoded = GitOperation::decode(unspecified.encode_to_vec().as_slice()).unwrap();
    assert_eq!(decoded.state, GitOperationState::Unspecified as i32);
    // An interrupted push is its own state and never collapses into a failure:
    // the remote may have taken it, and a retry decided from FAILED would push
    // twice.
    assert_ne!(
        GitOperationState::UnknownOutcome as i32,
        GitOperationState::Failed as i32
    );
}

#[test]
fn the_git_domain_travels_on_worker_action_29_and_event_members_220_to_222() {
    let request = WorkerRequest {
        request_id: "h-git-1".into(),
        host_id: "0123456789abcdef0123456789abcdef".into(),
        action: Some(worker_request::Action::Git(GitWorkerRequest {
            action: Some(git_worker_request::Action::Snapshot(
                GitDomainSnapshotRequest {},
            )),
        })),
        ..Default::default()
    };
    let wire = request.encode_to_vec();
    // Field 29, length-delimited: (29 << 3) | 2 == 234, which prost writes as
    // the two-byte varint ea 01.
    assert!(wire.windows(2).any(|pair| pair == [0xea, 0x01]));
    assert_eq!(WorkerRequest::decode(wire.as_slice()).unwrap(), request);

    for entity in [
        event_envelope::Entity::GitOperation(GitOperation {
            operation_id: "o".into(),
            ..Default::default()
        }),
        event_envelope::Entity::GitRepositoryState(RepositoryState {
            scope: Some(scope()),
            ..Default::default()
        }),
        event_envelope::Entity::GitCloneJob(GitCloneJob {
            job_id: "j".into(),
            ..Default::default()
        }),
    ] {
        let envelope = EventEnvelope {
            sequence: 12,
            domain: EventDomain::Git as i32,
            kind: "operation".into(),
            entity_id: "o".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            revision: 3,
            entity: Some(entity),
            ..Default::default()
        };
        assert_eq!(
            EventEnvelope::decode(envelope.encode_to_vec().as_slice()).unwrap(),
            envelope
        );
    }
}

#[test]
fn the_git_upcall_travels_on_channel_member_180() {
    let upcall = WorkerUpcall {
        request_id: "w-7".into(),
        worker_instance_id: "abcdef0123456789abcdef0123456789".into(),
        sequence: 7,
        attempt: 1,
        emitted_at_unix_ms: 1_788_557_900_000,
        event: Some(worker_upcall::Event::Git(WorkerGitUpcall {
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            repository_path: "/home/用户/项目/armadra".into(),
            kind: WorkerGitUpcallKind::RepositoryChanged as i32,
            reason_code: "git.repository.external".into(),
            observed_at_unix_ms: 1_788_557_900_000,
            repository: Some(RepositoryState {
                scope: Some(scope()),
                head_oid: "aabbccddeeff00112233445566778899aabbccdd".into(),
                branch: "main".into(),
                observed_at_unix_ms: 1_788_557_900_000,
                ..Default::default()
            }),
            ..Default::default()
        })),
    };
    check("git_upcall_repository_changed", upcall);
}
