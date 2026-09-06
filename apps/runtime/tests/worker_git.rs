//! The git frames of the Worker channel (business migration §2.8, §2.9).
//!
//! These run real `git` against a real repository, because the thing being
//! tested is that the Host's queue entry becomes the same command the HTTP
//! route would have run. A mocked repository would prove the translation
//! compiles and nothing else.
//!
//! Three properties matter here and each has a case:
//!
//!   * a stage through the frame stages the same file the route would;
//!   * a precondition that no longer holds is a *failure* with a named reason,
//!     not an overwrite, and not an unknown outcome — the command never ran;
//!   * a forwarded read keeps the status the Runtime's own route would have
//!     returned, so a not-found stays a not-found.

use std::path::Path;
use std::process::Command;

use armadra_protocol::v1::*;
use armadra_runtime::worker::Worker;

const HOST: &str = "0123456789abcdef0123456789abcdef";

fn git(project: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(project)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .status()
        .expect("git is available");
    assert!(status.success(), "git {args:?}");
}

fn repository(directory: &Path) -> std::path::PathBuf {
    let project = directory.join("project");
    std::fs::create_dir(&project).unwrap();
    git(&project, &["init", "--initial-branch=main"]);
    git(&project, &["config", "user.email", "test@example.invalid"]);
    git(&project, &["config", "user.name", "测试"]);
    std::fs::write(project.join("README.md"), "# 项目\n").unwrap();
    git(&project, &["add", "README.md"]);
    git(&project, &["commit", "-m", "initial"]);
    project
}

fn frame(instance: &str, action: git_worker_request::Action) -> WorkerRequest {
    WorkerRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        host_id: HOST.into(),
        expected_instance_id: instance.into(),
        deadline_unix_ms: chrono::Utc::now().timestamp_millis() + 60_000,
        action: Some(worker_request::Action::Git(GitWorkerRequest {
            action: Some(action),
        })),
    }
}

/// A Worker answers business frames only after the handshake has named the
/// controlling Host, exactly as it does for every other domain.
async fn connected() -> (Worker, String) {
    let mut worker = Worker::default();
    let response = worker
        .handle(WorkerRequest {
            request_id: "hello".into(),
            host_id: HOST.into(),
            deadline_unix_ms: chrono::Utc::now().timestamp_millis() + 10_000,
            action: Some(worker_request::Action::Hello(WorkerHelloRequest {
                protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            })),
            ..Default::default()
        })
        .await;
    let instance = response.instance_id.clone();
    let Some(worker_response::Result::Hello(hello)) = response.result else {
        panic!("handshake failed")
    };
    assert!(hello.capabilities.contains(&"git.worker.v1".into()));
    (worker, instance)
}

fn git_result(response: WorkerResponse) -> git_worker_response::Result {
    let Some(worker_response::Result::Git(git)) = response.result else {
        panic!("the frame was not answered by the git handler")
    };
    git.result.expect("the git response carries no result")
}

fn scope(project: &Path) -> RepositoryScope {
    RepositoryScope {
        workspace_id: "0123456789abcdef0123456789abcdef".into(),
        repository_path: project.to_string_lossy().into_owned(),
        ..Default::default()
    }
}

fn operation(
    project: &Path,
    kind: GitActionKind,
    body: &str,
    expected: Option<GitExpectation>,
) -> GitOperation {
    use sha2::{Digest, Sha256};
    GitOperation {
        operation_id: "0000000000000001-operation".into(),
        scope: Some(scope(project)),
        action: body.as_bytes().to_vec(),
        action_sha256: Sha256::digest(body.as_bytes()).to_vec(),
        expected,
        kind: kind as i32,
        state: GitOperationState::Running as i32,
        ..Default::default()
    }
}

#[tokio::test]
async fn a_queued_stage_runs_the_same_command_the_route_would() {
    let directory = tempfile::tempdir().unwrap();
    let project = repository(directory.path());
    std::fs::write(project.join("新文件.txt"), "内容\n").unwrap();
    let (mut worker, instance) = connected().await;

    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Run(RunGitOperationRequest {
                operation: Some(operation(
                    &project,
                    GitActionKind::Stage,
                    r#"{"paths":["新文件.txt"]}"#,
                    None,
                )),
                workspace_root: project.to_string_lossy().into_owned(),
            }),
        ))
        .await;
    let git_worker_response::Result::Operation(outcome) = git_result(response) else {
        panic!("expected an operation outcome")
    };
    let outcome = outcome.operation.unwrap();
    assert_eq!(outcome.state, GitOperationState::Succeeded as i32);
    assert_eq!(outcome.affected, vec!["新文件.txt".to_string()]);

    // The file is actually staged: the frame ran `git`, it did not describe it.
    let staged = Command::new("git")
        // `core.quotepath` escapes non-ASCII in Git's own output. The assertion
        // is about which file was staged, not about how Git prints it.
        .args([
            "-c",
            "core.quotepath=false",
            "diff",
            "--cached",
            "--name-only",
        ])
        .current_dir(&project)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "新文件.txt");
}

#[tokio::test]
async fn a_stale_precondition_fails_rather_than_overwriting() {
    let directory = tempfile::tempdir().unwrap();
    let project = repository(directory.path());
    let (mut worker, instance) = connected().await;

    // An external `git` moved the branch after the caller decided. The
    // operation names the OID it read; the service re-reads it and refuses.
    let body = r#"{"path":".","action":{"kind":"deleteBranch","name":"main","expectedOid":"aabbccddeeff00112233445566778899aabbccdd"},"expected":{"branch":"main"}}"#;
    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Run(RunGitOperationRequest {
                operation: Some(operation(
                    &project,
                    GitActionKind::DeleteBranch,
                    body,
                    Some(GitExpectation {
                        ref_oid: "aabbccddeeff00112233445566778899aabbccdd".into(),
                        ..Default::default()
                    }),
                )),
                workspace_root: project.to_string_lossy().into_owned(),
            }),
        ))
        .await;
    let git_worker_response::Result::Operation(outcome) = git_result(response) else {
        panic!("expected an operation outcome")
    };
    let outcome = outcome.operation.unwrap();
    // A refused command is a failure, not an unknown outcome: nothing ran, so
    // there is nothing anyone has to reconcile by hand.
    assert_ne!(outcome.state, GitOperationState::Succeeded as i32);
    assert_ne!(outcome.state, GitOperationState::UnknownOutcome as i32);
    assert!(
        outcome.message_code.starts_with("git.operation."),
        "the reason was not a stable key: {}",
        outcome.message_code
    );

    // The branch is still there.
    let branches = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&project)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&branches.stdout).contains("main"));
}

#[tokio::test]
async fn an_observation_reports_the_repository_with_the_time_it_was_read() {
    let directory = tempfile::tempdir().unwrap();
    let project = repository(directory.path());
    let (mut worker, instance) = connected().await;

    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Observe(ObserveRepositoryRequest {
                scope: Some(scope(&project)),
                workspace_root: project.to_string_lossy().into_owned(),
            }),
        ))
        .await;
    let git_worker_response::Result::Repository(state) = git_result(response) else {
        panic!("expected a repository state")
    };
    assert_eq!(state.branch, "main");
    assert!(!state.detached);
    assert_eq!(state.head_oid.len(), 40);
    // The time is what makes this a cache rather than an authority.
    assert!(state.observed_at_unix_ms > 0);
    assert_eq!(
        state.operation_state,
        GitOperationState::Unspecified as i32,
        "an idle repository reported an operation in progress"
    );
}

#[tokio::test]
async fn a_forwarded_read_keeps_the_status_the_route_would_have_returned() {
    let directory = tempfile::tempdir().unwrap();
    let project = repository(directory.path());
    let (mut worker, instance) = connected().await;

    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Read(GitRead {
                scope: Some(scope(&project)),
                request_json: br#"{"reference":"HEAD","limit":10}"#.to_vec(),
                workspace_root: project.to_string_lossy().into_owned(),
                method: GitReadMethod::History as i32,
            }),
        ))
        .await;
    let git_worker_response::Result::Read(result) = git_result(response) else {
        panic!("expected a read result")
    };
    assert_eq!(result.http_status, 200);
    let page: serde_json::Value = serde_json::from_slice(&result.response_json).unwrap();
    assert!(page["commits"].as_array().is_some_and(|c| !c.is_empty()));

    // A commit that does not exist is a not-found, and it stays one rather than
    // becoming a 500 on the way through.
    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Read(GitRead {
                scope: Some(scope(&project)),
                request_json: br#"{"oid":"aabbccddeeff00112233445566778899aabbccdd"}"#.to_vec(),
                workspace_root: project.to_string_lossy().into_owned(),
                method: GitReadMethod::CommitDetail as i32,
            }),
        ))
        .await;
    let git_worker_response::Result::Read(result) = git_result(response) else {
        panic!("expected a read result")
    };
    assert!(
        (400..500).contains(&result.http_status),
        "a missing commit answered {}",
        result.http_status
    );
    let body: serde_json::Value = serde_json::from_slice(&result.response_json).unwrap();
    assert!(body["code"].is_string(), "the failure carries no code");
}

// A repository outside the registered workspace root is refused rather than
// resolved. The root is the filesystem domain's record; a path that escaped it
// would be this process reading a directory the registration never covered.
#[tokio::test]
async fn a_repository_outside_the_root_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let project = repository(directory.path());
    let outside = directory.path().join("elsewhere");
    std::fs::create_dir(&outside).unwrap();
    let (mut worker, instance) = connected().await;

    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Observe(ObserveRepositoryRequest {
                scope: Some(RepositoryScope {
                    repository_path: outside.to_string_lossy().into_owned(),
                    ..scope(&project)
                }),
                workspace_root: project.to_string_lossy().into_owned(),
            }),
        ))
        .await;
    let Some(worker_response::Result::Error(error)) = response.result else {
        panic!("a path outside the root was answered rather than refused")
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
}

// The snapshot a switch reads. A Worker that has just started holds nothing,
// which is the correct answer rather than a useless one: the Runtime's git
// queue is in memory, so a Runtime that is not running has an empty queue by
// construction.
#[tokio::test]
async fn a_fresh_worker_reports_an_empty_git_queue() {
    let (mut worker, instance) = connected().await;
    let response = worker
        .handle(frame(
            &instance,
            git_worker_request::Action::Snapshot(GitDomainSnapshotRequest {}),
        ))
        .await;
    let git_worker_response::Result::Snapshot(snapshot) = git_result(response) else {
        panic!("expected a snapshot")
    };
    assert_eq!(snapshot.queued, 0);
    assert_eq!(snapshot.running, 0);
    assert_eq!(snapshot.clone_jobs, 0);
    assert!(snapshot.active_operation_ids.is_empty());
}

// Every Worker can answer a git frame, because a command needs the workspace
// root and nothing else. That is what lets a switch establish the queue is
// empty over the same link it moves the epoch on.
#[tokio::test]
async fn every_worker_advertises_the_git_capability() {
    // `connected` asserts it: a Worker started with no database, no state
    // directory and no settings file still answers git frames, because a
    // command needs the workspace root and nothing else.
    let (_worker, instance) = connected().await;
    assert!(!instance.is_empty());
}
