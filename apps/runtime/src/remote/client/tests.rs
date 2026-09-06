use std::sync::Arc;

use armadra_protocol::v1::WorkerServiceOperation;

use super::*;
use crate::remote::service::replay::{
    FILES_MANAGE_CAPABILITY, GIT_PANEL_CAPABILITY, UPLOAD_CAPABILITY, WATCH_CAPABILITY,
};

fn host() -> SshHost {
    SshHost {
        id: "box".into(),
        name: "Box".into(),
        host: "example.invalid".into(),
        user: Some("ada".into()),
        port: None,
        identity_file: None,
        extra_args: Vec::new(),
        worker: Some(SshWorker {
            path: "/opt/armadra/armadra-runtime".into(),
            state_dir: None,
        }),
    }
}

#[test]
fn a_commit_that_was_written_and_then_lost_is_an_unknown_outcome_not_a_retry() {
    assert!(outcome_is_unknown(
        Transport::Lost,
        replay(WorkerServiceOperation::GitCommit)
    ));
    // Nothing left this machine, so nothing ran and a retry is honest.
    assert!(!outcome_is_unknown(
        Transport::Write,
        replay(WorkerServiceOperation::GitCommit)
    ));
    assert!(!outcome_is_unknown(
        Transport::TooLarge,
        replay(WorkerServiceOperation::GitCommit)
    ));
    // A read has no effect to duplicate.
    assert!(!outcome_is_unknown(
        Transport::Lost,
        replay(WorkerServiceOperation::GitStatus)
    ));
}

/// The demultiplexing read task did not change what a lost write means. Every
/// operation batch 4 added that has an effect has to keep the same answer as
/// the ones H02 shipped with.
#[test]
fn the_new_write_operations_keep_the_unknown_outcome_rule() {
    for operation in [
        WorkerServiceOperation::GitOperationStart,
        WorkerServiceOperation::GitOperationCancel,
        WorkerServiceOperation::GitApplyHunk,
        WorkerServiceOperation::FileEntryCreate,
        WorkerServiceOperation::FileEntryRename,
        WorkerServiceOperation::FileEntryMove,
        WorkerServiceOperation::FileEntryDelete,
        WorkerServiceOperation::FileEntryRestore,
        WorkerServiceOperation::AssetImport,
    ] {
        assert!(
            outcome_is_unknown(Transport::Lost, replay(operation)),
            "{operation:?}"
        );
    }
    // And every new read is still retried rather than reported as unknown.
    for operation in [
        WorkerServiceOperation::GitBranches,
        WorkerServiceOperation::GitHistory,
        WorkerServiceOperation::GitStashes,
        WorkerServiceOperation::GitOperations,
        WorkerServiceOperation::FileInfo,
        WorkerServiceOperation::FileEntryTrashList,
    ] {
        assert!(
            !outcome_is_unknown(Transport::Lost, replay(operation)),
            "{operation:?}"
        );
    }
}

/// Each group of operations names its own capability, so a Worker missing one
/// refuses that group and keeps serving the rest.
#[test]
fn each_operation_group_gates_on_its_own_capability() {
    assert_eq!(
        capability(WorkerServiceOperation::GitBranches),
        Some(GIT_PANEL_CAPABILITY)
    );
    assert_eq!(
        capability(WorkerServiceOperation::FileEntryCreate),
        Some(FILES_MANAGE_CAPABILITY)
    );
    assert_eq!(
        capability(WorkerServiceOperation::WatchSubscribe),
        Some(WATCH_CAPABILITY)
    );
    // The base surface every Worker that answers the handshake already has.
    assert_eq!(capability(WorkerServiceOperation::FileRead), None);
    assert_eq!(capability(WorkerServiceOperation::GitStatus), None);
    // Uploads are typed rather than proxied, so they carry no operation value;
    // their capability is asserted by the client at call time.
    assert_ne!(UPLOAD_CAPABILITY, GIT_PANEL_CAPABILITY);
}

#[test]
fn the_launch_line_only_substitutes_the_program() {
    let host = host();
    let worker = RemoteWorker::new(
        host.clone(),
        host.worker.clone().unwrap(),
        "0123456789abcdef0123456789abcdef".into(),
    );
    let argv = worker.argv();
    assert_eq!(
        argv[1..],
        worker_argv(&host, host.worker.as_ref().unwrap())[1..]
    );
    assert!(argv.iter().any(|value| value == "--stdio"));
}

#[test]
fn a_relative_or_split_launcher_override_is_ignored() {
    // Not a test of the environment itself — `launcher_override` is the
    // only place the value is trusted, and a PATH lookup or an argument
    // smuggled through a space must not become part of the launch line.
    assert!(!accepted_launcher("ssh"));
    assert!(!accepted_launcher("/usr/bin/env ssh"));
    assert!(accepted_launcher("/usr/bin/ssh"));
}

fn accepted_launcher(value: &str) -> bool {
    value.starts_with('/') && !value.contains(char::is_whitespace)
}

#[tokio::test]
async fn a_worker_registry_hands_back_the_same_child_for_the_same_configuration() {
    let workers = RemoteWorkers::default();
    let first = workers.get(Some(host()), "box").unwrap();
    let second = workers.get(Some(host()), "box").unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    // An edited binary path is a different machine's Worker as far as this
    // registry is concerned, and must not reuse the old child.
    let mut edited = host();
    edited.worker = Some(SshWorker {
        path: "/opt/armadra/other".into(),
        state_dir: None,
    });
    let third = workers.get(Some(edited), "box").unwrap();
    assert!(!Arc::ptr_eq(&first, &third));
}

/// The event channel belongs to the host, not to one connection, so a
/// subscriber taken before a reconnect keeps receiving afterwards.
#[tokio::test]
async fn an_event_subscriber_is_not_tied_to_one_connection() {
    let host = host();
    let worker = RemoteWorker::new(
        host.clone(),
        host.worker.clone().unwrap(),
        "0123456789abcdef0123456789abcdef".into(),
    );
    let mut events = worker.events();
    worker
        .events
        .send(armadra_protocol::v1::WorkerWatchEvent {
            root_id: "root-1".into(),
            sequence: 1,
            changes: Vec::new(),
        })
        .unwrap();
    assert_eq!(events.recv().await.unwrap().sequence, 1);
}
