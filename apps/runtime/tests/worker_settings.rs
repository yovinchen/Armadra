//! The settings domain over the Worker channel (Go Host 业务所有权迁移 §2.4,
//! frame 25).
//!
//! What is covered here is the boundary the switch actually depends on: the
//! bytes on disk are the bytes on the wire, an import is refused unless the
//! Host already owns the domain, and the answer to an import is a re-read
//! rather than an echo. A test that only checked field plumbing would pass
//! while every one of those properties was broken.

use armadra_protocol::{Message, v1::*};
use armadra_runtime::{
    db,
    error::AppError,
    ownership::{self, OwnershipDomain, OwnershipHandoff, WriteOwner},
    worker::{Worker, settings},
};
use sha2::{Digest, Sha256};

const HOST: &str = "0123456789abcdef0123456789abcdef";

/// A settings file with one SSH host that carries a key nothing projects, so a
/// leak into the entity list is visible rather than theoretical.
const DOCUMENT: &str = r#"{
  "terminal": { "backend": "tmux" },
  "power": { "policy": "never" },
  "ssh": {
    "hosts": [
      {
        "id": "build-box",
        "name": "构建机",
        "host": "example.com",
        "user": "ada",
        "port": 2222,
        "identityFile": "/home/ada/.ssh/id_ed25519",
        "password": "hunter2",
        "worker": { "path": "/opt/armadra/armadra-runtime", "stateDir": "/var/lib/armadra" }
      }
    ]
  }
}"#;

struct Fixture {
    pool: sqlx::SqlitePool,
    file: std::path::PathBuf,
    _directory: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("canvas.db");
    db::connect(&format!("sqlite://{}?mode=rwc", database.display()))
        .await
        .unwrap()
        .close()
        .await;
    Fixture {
        pool: armadra_runtime::worker::open_canvas_database(&database)
            .await
            .unwrap(),
        file: directory.path().join("data").join("settings.json"),
        _directory: directory,
    }
}

fn write(fixture: &Fixture, contents: &str) {
    std::fs::create_dir_all(fixture.file.parent().unwrap()).unwrap();
    std::fs::write(&fixture.file, contents).unwrap();
}

async fn hand_settings_to_the_host(fixture: &Fixture) {
    ownership::apply(
        &fixture.pool,
        OwnershipHandoff {
            domain: OwnershipDomain::Settings,
            owner: WriteOwner::Host,
            epoch: 2,
            expected_epoch: 1,
            reason_code: "ownership.switch.verified".into(),
        },
    )
    .await
    .unwrap();
}

fn document(bytes: &[u8]) -> SettingsDocument {
    SettingsDocument {
        scope: SettingsScope::Global as i32,
        document: bytes.to_vec(),
        sha256: Sha256::digest(bytes).to_vec(),
        schema_version: 1,
        ..SettingsDocument::default()
    }
}

fn import_request(bytes: &[u8], import_id: &str, expected_epoch: u64) -> WorkerSettingsRequest {
    WorkerSettingsRequest {
        direction: WorkerSettingsDirection::Import as i32,
        document: Some(document(bytes)),
        expected_epoch,
        import_id: import_id.into(),
    }
}

/* --------------------------------- export --------------------------------- */

/// A fresh install has never written the file. Failing the export would make
/// the first switch depend on the user having opened the settings page once.
#[tokio::test]
async fn a_missing_settings_file_exports_the_normalized_defaults() {
    let fixture = fixture().await;
    let snapshot = settings::export(&fixture.file).unwrap();
    let exported = snapshot.document.unwrap();
    assert!(!snapshot.applied && !snapshot.replayed);
    assert_eq!(exported.scope, SettingsScope::Global as i32);
    assert_eq!(exported.schema_version, 1);
    assert_eq!(exported.revision, 0);
    assert_eq!(exported.sha256, Sha256::digest(&exported.document).to_vec());
    assert!(exported.updated_at_unix_ms > 0);
    // The defaults `SettingsStore::patch` would have written, parsed back to
    // prove they are a document rather than an empty object.
    let parsed: serde_json::Value = serde_json::from_slice(&exported.document).unwrap();
    assert_eq!(parsed["terminal"]["backend"], "auto");
    assert_eq!(snapshot.local.unwrap().terminal_backend, "auto");
    assert!(snapshot.execution_hosts.is_empty());
    // Reading must not create the file: an export changes nothing.
    assert!(!fixture.file.exists());
}

/// The digest every consistency check across the switch compares is over what
/// is on disk. Re-serializing a parsed tree would make it depend on Rust and
/// Go agreeing about key order, spacing and escaping.
#[tokio::test]
async fn an_existing_file_is_exported_byte_for_byte_with_its_projections() {
    let fixture = fixture().await;
    write(&fixture, DOCUMENT);
    let snapshot = settings::export(&fixture.file).unwrap();
    let exported = snapshot.document.unwrap();
    assert_eq!(exported.document, DOCUMENT.as_bytes());
    assert_eq!(
        exported.sha256,
        Sha256::digest(DOCUMENT.as_bytes()).to_vec()
    );

    // The local half is what this machine actually holds, taken from the same
    // bytes rather than from a running Runtime's in-memory store.
    let local = snapshot.local.unwrap();
    assert_eq!(local.terminal_backend, "tmux");
    assert_eq!(local.power_policy, "never");
    assert!(!local.browser_available);

    // Execution hosts are a projection of `ssh.hosts[]`. The local machine is
    // not among them: it needs no registration.
    assert_eq!(snapshot.execution_hosts.len(), 1);
    let host = &snapshot.execution_hosts[0];
    assert_eq!(host.execution_host_id, "build-box");
    assert_eq!(host.name, "构建机");
    assert_eq!(host.kind, ExecutionHostKind::Ssh as i32);
    assert_eq!(
        host.ssh,
        Some(SshExecutionHost {
            host: "example.com".into(),
            port: 2222,
            user: "ada".into(),
            identity_file: "/home/ada/.ssh/id_ed25519".into(),
            worker_path: "/opt/armadra/armadra-runtime".into(),
            state_dir: "/var/lib/armadra".into(),
        })
    );
    assert_eq!(host.updated_at_unix_ms, exported.updated_at_unix_ms);
    // Nothing that is not one of the projected fields travels as an entity.
    // The document itself still carries the key, because the document is the
    // bytes; the entity list must not.
    assert!(!String::from_utf8_lossy(&host.encode_to_vec()).contains("hunter2"));
}

/* --------------------------------- import --------------------------------- */

/// Importing while this Runtime is the writer would overwrite a document it is
/// still serving through `GET /api/settings`.
#[tokio::test]
async fn an_import_is_refused_until_the_host_owns_the_domain() {
    let fixture = fixture().await;
    write(&fixture, DOCUMENT);
    let next = br#"{"terminal":{"backend":"direct"}}"#;
    let refused = settings::import(
        &fixture.file,
        &fixture.pool,
        import_request(next, "import-1", 0),
    )
    .await;
    assert!(
        matches!(&refused, Err(AppError::Conflict(message)) if message.starts_with("reverse.not_host_owned")),
        "{refused:?}"
    );
    assert_eq!(std::fs::read_to_string(&fixture.file).unwrap(), DOCUMENT);
}

/// The request is checked before anything is written, so every refusal leaves
/// the file exactly as it was.
#[tokio::test]
async fn a_malformed_import_is_refused_without_touching_the_file() {
    let fixture = fixture().await;
    write(&fixture, DOCUMENT);
    hand_settings_to_the_host(&fixture).await;
    let next = br#"{"terminal":{"backend":"direct"}}"#;

    let mut wrong_digest = import_request(next, "import-1", 0);
    wrong_digest.document.as_mut().unwrap().sha256 = vec![7; 32];
    let mut wrong_schema = import_request(next, "import-1", 0);
    wrong_schema.document.as_mut().unwrap().schema_version = 2;
    let mut not_an_object = import_request(b"[1,2,3]", "import-1", 0);
    not_an_object.document.as_mut().unwrap().sha256 = Sha256::digest(b"[1,2,3]").to_vec();
    let mut too_large = import_request(next, "import-1", 0);
    too_large.document.as_mut().unwrap().document = vec![b'a'; (1 << 20) + 1];
    let mut a_device_overlay = import_request(next, "import-1", 0);
    a_device_overlay.document.as_mut().unwrap().scope = SettingsScope::Device as i32;

    for (name, request) in [
        // A stated epoch that disagrees names a switch this database is no
        // longer part of.
        ("epoch", import_request(next, "import-1", 9)),
        ("digest", wrong_digest),
        ("schema", wrong_schema),
        ("object", not_an_object),
        ("size", too_large),
        ("device", a_device_overlay),
        ("empty id", import_request(next, "", 0)),
        ("path id", import_request(next, "/etc/passwd", 0)),
        ("long id", import_request(next, &"a".repeat(129), 0)),
        // A document that went missing on the way is a refused import, never
        // an empty file: applying it would erase the user's settings and
        // report success.
        (
            "no document",
            WorkerSettingsRequest {
                direction: WorkerSettingsDirection::Import as i32,
                import_id: "import-1".into(),
                ..WorkerSettingsRequest::default()
            },
        ),
    ] {
        let refused = settings::import(&fixture.file, &fixture.pool, request).await;
        assert!(refused.is_err(), "{name} should have been refused");
        assert_eq!(
            std::fs::read_to_string(&fixture.file).unwrap(),
            DOCUMENT,
            "{name} changed the file"
        );
    }
    // Nothing above reached the ledger, so the identifier is still free.
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM host_imports")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(ledger, 0);
}

/// The happy path, and the property that makes it verifiable: the digest in
/// the answer is taken from the file after the write, not from the request.
#[tokio::test]
async fn an_accepted_import_writes_the_file_and_reports_the_re_read() {
    let fixture = fixture().await;
    hand_settings_to_the_host(&fixture).await;
    let snapshot = settings::import(
        &fixture.file,
        &fixture.pool,
        import_request(DOCUMENT.as_bytes(), "import-1", 2),
    )
    .await
    .unwrap();
    assert!(snapshot.applied && !snapshot.replayed);
    let stored = snapshot.document.unwrap();
    assert_eq!(std::fs::read(&fixture.file).unwrap(), DOCUMENT.as_bytes());
    assert_eq!(stored.document, DOCUMENT.as_bytes());
    assert_eq!(stored.sha256, Sha256::digest(DOCUMENT.as_bytes()).to_vec());
    // Local settings and hosts describe the document that is now on disk.
    assert_eq!(snapshot.local.unwrap().terminal_backend, "tmux");
    assert_eq!(snapshot.execution_hosts.len(), 1);
    // One document, one entity, recorded under the epoch the switch is at.
    let row = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT domain, epoch, entity_count FROM host_imports WHERE import_id = 'import-1'",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(row, ("settings".into(), 2, 1));

    // The file is the Runtime's own, and a settings file is not world
    // readable however it was produced.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&fixture.file)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
    }
    // The rename left nothing behind under a name anything else reads.
    let strays: Vec<_> = std::fs::read_dir(fixture.file.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
        .filter(|name| name != "settings.json")
        .collect();
    assert!(strays.is_empty(), "{strays:?}");
}

/// A controller that lost the answer retries. Writing again would be harmless
/// here only by luck; the ledger makes it harmless by construction, and the
/// replayed answer is the one the write actually produced.
#[tokio::test]
async fn a_replay_writes_nothing_and_a_reused_identifier_is_refused() {
    let fixture = fixture().await;
    hand_settings_to_the_host(&fixture).await;
    let first = settings::import(
        &fixture.file,
        &fixture.pool,
        import_request(DOCUMENT.as_bytes(), "import-1", 2),
    )
    .await
    .unwrap();

    // Change the file behind the ledger's back. A replay that re-read the disk
    // would report this instead of what the first run verified.
    write(&fixture, r#"{"tampered":true}"#);
    let replay = settings::import(
        &fixture.file,
        &fixture.pool,
        import_request(DOCUMENT.as_bytes(), "import-1", 2),
    )
    .await
    .unwrap();
    assert!(replay.replayed);
    // "The write happened in this exchange" is false the second time, however
    // true it was the first.
    assert!(!replay.applied);
    assert_eq!(replay.document, first.document);
    assert_eq!(replay.execution_hosts, first.execution_hosts);
    assert_eq!(
        std::fs::read_to_string(&fixture.file).unwrap(),
        r#"{"tampered":true}"#,
        "a replay must not write"
    );

    // Two different documents claiming one identity is a controller bug, not a
    // retry, so it is refused rather than applied over the first.
    let reused = settings::import(
        &fixture.file,
        &fixture.pool,
        import_request(br#"{"terminal":{"backend":"direct"}}"#, "import-1", 2),
    )
    .await;
    assert!(
        matches!(&reused, Err(AppError::Conflict(message)) if message.starts_with("reverse.import_id_reused")),
        "{reused:?}"
    );
    // A second identifier for the same document is a second import and is
    // applied, which is what makes an intentional re-apply possible at all.
    assert!(
        settings::import(
            &fixture.file,
            &fixture.pool,
            import_request(DOCUMENT.as_bytes(), "import-2", 2),
        )
        .await
        .unwrap()
        .applied
    );
    assert_eq!(std::fs::read_to_string(&fixture.file).unwrap(), DOCUMENT);
}

/* ------------------------------- the frame -------------------------------- */

fn request(instance: &str, action: worker_request::Action) -> WorkerRequest {
    WorkerRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        host_id: HOST.into(),
        expected_instance_id: instance.into(),
        deadline_unix_ms: chrono::Utc::now().timestamp_millis() + 10_000,
        action: Some(action),
    }
}

async fn hello(worker: &mut Worker) -> (String, Vec<String>) {
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
    (response.instance_id, hello.capabilities)
}

fn code(response: WorkerResponse) -> String {
    match response.result {
        Some(worker_response::Result::Error(error)) => error.code,
        other => panic!("expected an error, got {other:?}"),
    }
}

/// The capability is what a controller plans against, so it may only appear
/// when both halves are there: the file to read and write, and the ownership
/// row an import has to check before it writes.
#[tokio::test]
async fn the_settings_frame_and_its_capability_follow_the_configured_file() {
    let fixture = fixture().await;
    write(&fixture, DOCUMENT);
    let export = worker_request::Action::Settings(WorkerSettingsRequest {
        direction: WorkerSettingsDirection::Export as i32,
        ..WorkerSettingsRequest::default()
    });

    let mut bare = Worker::default();
    let (instance, capabilities) = hello(&mut bare).await;
    assert!(!capabilities.contains(&settings::CAPABILITY.into()));
    assert_eq!(
        code(bare.handle(request(&instance, export.clone())).await),
        "UNSUPPORTED"
    );

    // A settings file with no database can still export; it must not claim the
    // capability, because an import is half of what the capability promises.
    let mut file_only = Worker::default().with_settings_file(fixture.file.clone());
    let (instance, capabilities) = hello(&mut file_only).await;
    assert!(!capabilities.contains(&settings::CAPABILITY.into()));
    assert_eq!(
        code(
            file_only
                .handle(request(
                    &instance,
                    worker_request::Action::Settings(import_request(
                        DOCUMENT.as_bytes(),
                        "import-1",
                        0,
                    )),
                ))
                .await
        ),
        "UNSUPPORTED"
    );

    let mut worker = Worker::with_canvas(fixture.pool.clone()).with_settings_file(fixture.file);
    let (instance, capabilities) = hello(&mut worker).await;
    assert!(capabilities.contains(&settings::CAPABILITY.into()));
    let Some(worker_response::Result::Settings(snapshot)) =
        worker.handle(request(&instance, export)).await.result
    else {
        panic!("the export did not answer with a settings snapshot")
    };
    assert_eq!(snapshot.document.unwrap().document, DOCUMENT.as_bytes());

    // Zero is not a direction. Reading it as EXPORT would answer a malformed
    // frame with the user's settings; reading it as IMPORT would write over
    // them.
    assert_eq!(
        code(
            worker
                .handle(request(
                    &instance,
                    worker_request::Action::Settings(WorkerSettingsRequest::default()),
                ))
                .await
        ),
        "INVALID_ARGUMENT"
    );
}
