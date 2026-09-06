use armadra_protocol::{Message, v1::*};
use armadra_runtime::worker::{MAX_CHUNK, MAX_FRAME, Worker, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const HOST: &str = "0123456789abcdef0123456789abcdef";

fn request(instance: &str, action: worker_request::Action) -> WorkerRequest {
    WorkerRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        host_id: HOST.into(),
        expected_instance_id: instance.into(),
        deadline_unix_ms: chrono::Utc::now().timestamp_millis() + 10_000,
        action: Some(action),
    }
}
async fn hello(worker: &mut Worker) -> String {
    let response = worker
        .handle(request(
            "",
            worker_request::Action::Hello(WorkerHelloRequest {
                protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            }),
        ))
        .await;
    let Some(worker_response::Result::Hello(hello)) = response.result else {
        panic!("handshake failed")
    };
    assert_eq!(hello.host_id, HOST);
    assert_eq!(hello.instance_id, response.instance_id);
    assert!(hello.capabilities.contains(&"files.text-read.v1".into()));
    // Editor saves and the proxied execution surface are advertised (H02);
    // terminals and PTY attachment are still not part of this bridge.
    assert!(hello.capabilities.contains(&"files.text-write.v1".into()));
    assert!(hello.capabilities.contains(&"remote.execution.v1".into()));
    assert!(
        !hello
            .capabilities
            .iter()
            .any(|cap| cap.contains("terminal"))
    );
    // A controller proxying version-locked payloads has to be able to check
    // that the Worker is the same build it is.
    assert_eq!(hello.runtime_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(hello.max_file_chunk_bytes, MAX_CHUNK as u32);
    response.instance_id
}
fn code(response: WorkerResponse) -> String {
    let Some(worker_response::Result::Error(error)) = response.result else {
        panic!("expected error")
    };
    error.code
}
async fn register(
    worker: &mut Worker,
    instance: &str,
    id: &str,
    path: &std::path::Path,
) -> WorkerResponse {
    worker
        .handle(request(
            instance,
            worker_request::Action::RegisterRoot(RegisterRootRequest {
                root_id: id.into(),
                path: path.to_str().unwrap().into(),
            }),
        ))
        .await
}

#[tokio::test]
async fn identity_deadline_and_handshake_are_enforced_before_file_access() {
    let mut worker = Worker::default();
    let action = worker_request::Action::ListDirectory(WorkerListDirectoryRequest {
        root_id: "root".into(),
        path: ".".into(),
    });
    assert_eq!(
        code(worker.handle(request("", action.clone())).await),
        "PERMISSION_DENIED"
    );
    assert_eq!(
        code(
            worker
                .handle(request(
                    "",
                    worker_request::Action::Hello(WorkerHelloRequest {
                        protocol: Some(ProtocolVersion { major: 2, minor: 0 })
                    })
                ))
                .await
        ),
        "UNSUPPORTED"
    );
    let instance = hello(&mut worker).await;
    assert_eq!(
        code(worker.handle(request("old-worker", action.clone())).await),
        "STALE_GENERATION"
    );
    let mut wrong = request(&instance, action.clone());
    wrong.host_id = "f".repeat(32);
    assert_eq!(code(worker.handle(wrong).await), "STALE_GENERATION");
    let mut expired = request(&instance, action.clone());
    expired.deadline_unix_ms = 1;
    assert_eq!(code(worker.handle(expired).await), "TIMEOUT");
    let mut invalid = request(&instance, action.clone());
    invalid.deadline_unix_ms = chrono::Utc::now().timestamp_millis() + 180_000;
    assert_eq!(code(worker.handle(invalid).await), "INVALID_ARGUMENT");
    assert_eq!(
        code(worker.handle(request(&instance, action)).await),
        "NOT_FOUND"
    );
}

#[tokio::test]
async fn root_registration_is_idempotent_and_cannot_rebind_or_escape() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("note.txt"), "note").unwrap();
    let mut worker = Worker::default();
    let instance = hello(&mut worker).await;
    for _ in 0..2 {
        assert!(matches!(
            register(&mut worker, &instance, "root", directory.path())
                .await
                .result,
            Some(worker_response::Result::RegisteredRoot(_))
        ));
    }
    assert_eq!(
        code(register(&mut worker, &instance, "root", outside.path()).await),
        "CONFLICT"
    );
    let read = worker
        .handle(request(
            &instance,
            worker_request::Action::ListDirectory(WorkerListDirectoryRequest {
                root_id: "root".into(),
                path: ".".into(),
            }),
        ))
        .await;
    let Some(worker_response::Result::Directory(list)) = read.result else {
        panic!("directory failed")
    };
    assert_eq!(list.entries.len(), 1);
    assert_eq!(list.entries[0].name, "note.txt");
    assert_eq!(
        code(
            worker
                .handle(request(
                    &instance,
                    worker_request::Action::ListDirectory(WorkerListDirectoryRequest {
                        root_id: "root".into(),
                        path: "../".into()
                    })
                ))
                .await
        ),
        "PERMISSION_DENIED"
    );
    #[cfg(unix)]
    {
        std::fs::write(outside.path().join("private.txt"), "private bytes").unwrap();
        std::fs::write(
            directory.path().join("back\\slash.txt"),
            "portable path limit",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.txt"),
            directory.path().join("escape.txt"),
        )
        .unwrap();
        let listing = worker
            .handle(request(
                &instance,
                worker_request::Action::ListDirectory(WorkerListDirectoryRequest {
                    root_id: "root".into(),
                    path: ".".into(),
                }),
            ))
            .await;
        let Some(worker_response::Result::Directory(listing)) = listing.result else {
            panic!("directory failed")
        };
        assert!(
            !listing
                .entries
                .iter()
                .any(|entry| entry.name == "escape.txt")
        );
        assert!(
            !listing
                .entries
                .iter()
                .any(|entry| entry.name.contains('\\'))
        );
        assert!(listing.truncated);
        assert_eq!(
            code(
                worker
                    .handle(request(
                        &instance,
                        worker_request::Action::ReadFile(WorkerReadFileRequest {
                            root_id: "root".into(),
                            path: "escape.txt".into(),
                            offset: 0,
                            max_bytes: 100,
                            expected_sha256: None,
                            raw: false,
                        })
                    ))
                    .await
            ),
            "PERMISSION_DENIED"
        );
    }
}

#[tokio::test]
async fn byte_chunks_preserve_unicode_and_require_a_stable_content_version() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("中文.txt");
    let text = "正文🙂\nremaining";
    std::fs::write(&path, text).unwrap();
    let mut worker = Worker::default();
    let instance = hello(&mut worker).await;
    register(&mut worker, &instance, "root", directory.path()).await;
    let read = WorkerReadFileRequest {
        root_id: "root".into(),
        path: "中文.txt".into(),
        offset: 0,
        max_bytes: 5,
        expected_sha256: None,
        raw: false,
    };
    let first = worker
        .handle(request(
            &instance,
            worker_request::Action::ReadFile(read.clone()),
        ))
        .await;
    let Some(worker_response::Result::FileChunk(first)) = first.result else {
        panic!("read failed")
    };
    assert_eq!(first.data.len(), 5);
    assert!(!first.eof);
    let mut next = read.clone();
    next.offset = 5;
    next.max_bytes = 100;
    assert_eq!(
        code(
            worker
                .handle(request(
                    &instance,
                    worker_request::Action::ReadFile(next.clone())
                ))
                .await
        ),
        "INVALID_ARGUMENT"
    );
    next.expected_sha256 = Some(first.sha256.clone());
    let second = worker
        .handle(request(
            &instance,
            worker_request::Action::ReadFile(next.clone()),
        ))
        .await;
    let Some(worker_response::Result::FileChunk(second)) = second.result else {
        panic!("second chunk failed")
    };
    assert!(second.eof);
    assert_eq!([first.data, second.data].concat(), text.as_bytes());
    std::fs::write(&path, "changed").unwrap();
    assert_eq!(
        code(
            worker
                .handle(request(&instance, worker_request::Action::ReadFile(next)))
                .await
        ),
        "CONFLICT"
    );
    let mut invalid = read;
    invalid.max_bytes = MAX_CHUNK as u32 + 1;
    assert_eq!(
        code(
            worker
                .handle(request(
                    &instance,
                    worker_request::Action::ReadFile(invalid)
                ))
                .await
        ),
        "INVALID_ARGUMENT"
    );
}

#[tokio::test]
async fn framed_handshake_flushes_and_clean_eof_terminates() {
    let (mut client, server) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(server);
    let task = tokio::spawn(serve(reader, writer, None, None));
    let hello = request(
        "",
        worker_request::Action::Hello(WorkerHelloRequest {
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
        }),
    );
    let bytes = hello.encode_to_vec();
    client.write_u32(bytes.len() as u32).await.unwrap();
    client.write_all(&bytes).await.unwrap();
    let length = client.read_u32().await.unwrap() as usize;
    assert!(length <= MAX_FRAME);
    let mut bytes = vec![0; length];
    client.read_exact(&mut bytes).await.unwrap();
    let response = WorkerResponse::decode(bytes.as_slice()).unwrap();
    assert_eq!(response.request_id, hello.request_id);
    client.shutdown().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn malformed_truncated_and_oversized_frames_fail_closed() {
    for bytes in [
        vec![0, 0],
        vec![0, 0, 0, 0],
        ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec(),
        vec![0, 0, 0, 2, 255],
        vec![0, 0, 0, 1, 255],
    ] {
        let mut output = vec![];
        // Owned rather than borrowed: the reader half runs in its own task now,
        // so what is handed to `serve` has to outlive this call.
        assert!(
            serve(std::io::Cursor::new(bytes), &mut output, None, None)
                .await
                .is_err()
        );
        assert!(output.is_empty());
    }
}

fn ownership(response: WorkerResponse) -> WorkerWriteOwnership {
    let Some(worker_response::Result::WriteOwnership(record)) = response.result else {
        panic!("expected a write ownership record")
    };
    record
}

fn set_ownership(owner: i32, epoch: u64, expected: u64) -> worker_request::Action {
    worker_request::Action::SetWriteOwnership(SetWriteOwnershipRequest {
        domain: "canvas".into(),
        owner,
        epoch,
        expected_epoch: expected,
        reason_code: "ownership.switch.verified".into(),
    })
}

const RUNTIME: i32 = CanvasOwnershipOwner::Runtime as i32;
const HOST_OWNER: i32 = CanvasOwnershipOwner::Host as i32;

/// A Worker started without `--canvas-database` has no database to answer
/// from, and inventing a record would let a controller believe a handoff it
/// never made had been persisted.
#[tokio::test]
async fn ownership_actions_are_unsupported_without_a_canvas_database() {
    let mut worker = Worker::default();
    let instance = hello(&mut worker).await;
    for action in [
        set_ownership(HOST_OWNER, 2, 1),
        worker_request::Action::GetWriteOwnership(GetWriteOwnershipRequest {
            domain: "canvas".into(),
        }),
    ] {
        assert_eq!(
            code(worker.handle(request(&instance, action)).await),
            "UNSUPPORTED"
        );
    }
}

#[tokio::test]
async fn a_configured_worker_persists_the_handoff_and_refuses_a_stale_epoch() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("canvas.db");
    let pool = armadra_runtime::db::connect(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap();
    pool.close().await;
    let opened = armadra_runtime::worker::open_canvas_database(&path)
        .await
        .unwrap();
    let mut worker = Worker::with_canvas(opened);
    let instance = hello(&mut worker).await;
    let get = worker_request::Action::GetWriteOwnership(GetWriteOwnershipRequest {
        domain: "canvas".into(),
    });
    let before = ownership(worker.handle(request(&instance, get.clone())).await);
    assert_eq!(before.owner, RUNTIME);
    assert_eq!(before.epoch, 1);
    // The seeded stamp is the epoch, so a Runtime that never handed anything
    // over reports a record rather than a guess.
    assert_eq!(before.updated_at_unix_ms, 0);
    let moved = ownership(
        worker
            .handle(request(&instance, set_ownership(HOST_OWNER, 2, 1)))
            .await,
    );
    assert_eq!((moved.owner, moved.epoch), (HOST_OWNER, 2));
    // Read back through a second request, so the answer came from the file.
    assert_eq!(
        ownership(worker.handle(request(&instance, get.clone())).await).owner,
        HOST_OWNER
    );
    // A repeat of the same handoff is the Host retrying a lost answer.
    assert_eq!(
        ownership(
            worker
                .handle(request(&instance, set_ownership(HOST_OWNER, 2, 1)))
                .await
        ),
        moved
    );
    for (action, expected) in [
        (set_ownership(RUNTIME, 2, 1), "CONFLICT"),
        (set_ownership(RUNTIME, 1, 1), "CONFLICT"),
        (set_ownership(RUNTIME, 3, 1), "CONFLICT"),
        (set_ownership(0, 3, 2), "INVALID_ARGUMENT"),
        (set_ownership(999, 3, 2), "INVALID_ARGUMENT"),
        (
            worker_request::Action::SetWriteOwnership(SetWriteOwnershipRequest {
                domain: "terminal".into(),
                owner: HOST_OWNER,
                epoch: 3,
                expected_epoch: 2,
                reason_code: String::new(),
            }),
            "INVALID_ARGUMENT",
        ),
        // "terminal" is not a domain, which is a different answer from "that
        // domain's record is missing": the six names are a closed set, so the
        // request is refused before anything is looked up.
        (
            worker_request::Action::GetWriteOwnership(GetWriteOwnershipRequest {
                domain: "terminal".into(),
            }),
            "INVALID_ARGUMENT",
        ),
    ] {
        assert_eq!(
            code(worker.handle(request(&instance, action)).await),
            expected
        );
    }
    assert_eq!(
        ownership(worker.handle(request(&instance, get)).await),
        moved
    );
    // The other five domains are readable over the same frame and were not
    // moved along with the canvas: one switch is one domain.
    for domain in ["settings", "filesystem", "session", "agent", "git"] {
        let record = ownership(
            worker
                .handle(request(
                    &instance,
                    worker_request::Action::GetWriteOwnership(GetWriteOwnershipRequest {
                        domain: domain.into(),
                    }),
                ))
                .await,
        );
        assert_eq!(record.domain, domain);
        assert_eq!((record.owner, record.epoch), (RUNTIME, 1));
    }
}

/// The capability is what a controller plans against, so it may only appear
/// when a database was actually opened.
#[tokio::test]
async fn the_ownership_capability_follows_the_configured_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("canvas.db");
    armadra_runtime::db::connect(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap()
        .close()
        .await;
    let capabilities = |mut worker: Worker| async move {
        let response = worker
            .handle(request(
                "",
                worker_request::Action::Hello(WorkerHelloRequest {
                    protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
                }),
            ))
            .await;
        let Some(worker_response::Result::Hello(hello)) = response.result else {
            panic!("handshake failed")
        };
        hello.capabilities
    };
    assert!(
        !capabilities(Worker::default())
            .await
            .contains(&"canvas.ownership.v1".into())
    );
    let opened = armadra_runtime::worker::open_canvas_database(&path)
        .await
        .unwrap();
    assert!(
        capabilities(Worker::with_canvas(opened))
            .await
            .contains(&"canvas.ownership.v1".into())
    );
}

/// A Runtime that has never migrated must not be upgraded, or created, by a
/// Worker that was merely pointed at its file.
#[tokio::test]
async fn an_unmigrated_or_missing_database_is_refused_rather_than_created() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("absent.db");
    assert!(
        armadra_runtime::worker::open_canvas_database(&missing)
            .await
            .is_err()
    );
    assert!(!missing.exists());
    let empty = directory.path().join("empty.db");
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite://{}?mode=rwc", empty.display()))
        .await
        .unwrap()
        .close()
        .await;
    assert!(
        armadra_runtime::worker::open_canvas_database(&empty)
            .await
            .is_err()
    );
    assert!(
        armadra_runtime::worker::open_canvas_database(std::path::Path::new("canvas.db"))
            .await
            .is_err()
    );
}
