//! The session domain's two directions, from the Runtime's side.
//!
//! Reading is what a switch and a handback are both verified against, and
//! applying is the rollback itself. Between them they carry this domain's whole
//! claim: the Host decides whether a terminal should exist and this side runs
//! it, and when the Host hands the decision back the rows here say exactly what
//! the package said — including the sessions it closed while it held them.

use armadra_protocol::v1::{
    ApplyReverseExportRequest, ReverseExportRecord, Session, SessionAttachState, SessionKind,
    SessionLaunch, SessionRun, SessionStatus, TerminationIntent,
};

use super::records::encode_records;
use super::{OwnershipDomain, WriteOwner, import, session, session_import};
use crate::db;
use crate::model::WorkspacePermissions;

async fn pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("session.db").display()
    ))
    .await
    .unwrap();
    (pool, directory)
}

/// Inserts one `terminal_sessions` row directly. Going through the manager
/// would start a real process, and what is under test here is the projection.
async fn insert(
    pool: &sqlx::SqlitePool,
    id: &str,
    workspace: &str,
    key: &str,
    kind: &str,
    node: Option<&str>,
    status: &str,
    intent: &str,
    generation: i64,
) {
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, session_key, kind, owner_node_id, \
         agent_id, cwd, shell, command, status, exit_code, backend_kind, backend_ref, generation, \
         attach_state, termination_intent, created_at, ended_at, last_output_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(workspace)
    .bind(key)
    .bind(kind)
    .bind(node)
    .bind(if kind == "agent" {
        Some("claude")
    } else {
        None
    })
    .bind("/项目/一")
    .bind("/bin/zsh")
    .bind(None::<String>)
    .bind(status)
    .bind(if status == "running" { None } else { Some(0) })
    .bind("tmux")
    .bind(format!("armadra-{key}:0.0"))
    .bind(generation)
    .bind(if status == "running" {
        "detached"
    } else {
        "exited"
    })
    .bind(intent)
    .bind("2026-09-01T10:00:00Z")
    .bind(if status == "running" {
        None
    } else {
        Some("2026-09-01T12:00:00Z")
    })
    .bind(None::<String>)
    .execute(pool)
    .await
    .unwrap();
}

async fn workspace(pool: &sqlx::SqlitePool) -> String {
    db::create_workspace(
        pool,
        "本地",
        "/项目/一",
        None,
        Some(&WorkspacePermissions {
            read: true,
            write: true,
            execute: true,
        }),
    )
    .await
    .unwrap()
    .id
}

/// Writes one package the way the Host does: `export.json` plus one
/// length-prefixed entity file per workspace, each carrying every session and
/// the runs behind it.
fn write_package(
    directory: &std::path::Path,
    epoch: u64,
    workspace_id: &str,
    sessions: &[Session],
    runs: &[SessionRun],
) {
    let mut records = Vec::new();
    for stored in sessions {
        records.push(ReverseExportRecord {
            entity: Some(
                armadra_protocol::v1::reverse_export_record::Entity::Session(stored.clone()),
            ),
        });
        for run in runs
            .iter()
            .filter(|run| run.session_id == stored.session_id)
        {
            records.push(ReverseExportRecord {
                entity: Some(
                    armadra_protocol::v1::reverse_export_record::Entity::SessionRun(run.clone()),
                ),
            });
        }
    }
    let payload = encode_records(&records);
    let name = format!("{workspace_id}.pb");
    std::fs::write(directory.join(&name), &payload).unwrap();
    let index = serde_json::json!({
        "formatVersion": 2,
        "hostId": "0123456789abcdef0123456789abcdef",
        "epoch": epoch,
        "eventSequence": 7,
        "domain": "session",
        "entityCount": records.len(),
        "files": [{
            "name": name,
            "workspaceId": workspace_id,
            "bytes": payload.len(),
            "sha256": import::format_digest(&super::records::digest(&payload)),
            "contentSha256": import::format_digest(&session::content_digest(&records)),
            "entityCount": records.len(),
        }],
    });
    std::fs::write(
        directory.join("export.json"),
        serde_json::to_vec_pretty(&index).unwrap(),
    )
    .unwrap();
}

fn request(directory: &std::path::Path, epoch: u64, import_id: &str) -> ApplyReverseExportRequest {
    ApplyReverseExportRequest {
        domain: "session".into(),
        package_path: directory.to_string_lossy().into_owned(),
        index_sha256: Vec::new(),
        expected_epoch: epoch,
        import_id: import_id.into(),
    }
}

async fn hand_to_host(pool: &sqlx::SqlitePool, epoch: u64) {
    super::apply(
        pool,
        super::OwnershipHandoff {
            domain: OwnershipDomain::Session,
            owner: WriteOwner::Host,
            epoch,
            expected_epoch: epoch - 1,
            reason_code: "ownership.switch.verified".into(),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn states_report_what_this_runtime_believes_and_carry_no_revision() {
    let (pool, _directory) = pool().await;
    let id = workspace(&pool).await;
    insert(
        &pool,
        "s-agent",
        &id,
        "node-one",
        "agent",
        Some("node-one"),
        "running",
        "none",
        3,
    )
    .await;
    insert(
        &pool,
        "s-plain",
        &id,
        "s-plain",
        "terminal",
        None,
        "terminated",
        "process",
        1,
    )
    .await;
    let states = session::worker_states(&pool).await.unwrap();
    assert_eq!(states.len(), 2);
    let agent = states
        .iter()
        .find(|state| state.session_id == "s-agent")
        .unwrap();
    assert_eq!(agent.kind, SessionKind::Agent as i32);
    assert_eq!(agent.status, SessionStatus::Running as i32);
    assert_eq!(agent.generation, 3);
    assert_eq!(agent.session_key, "node-one");
    // The backend reference is a handle on an object in this process. It is
    // reported because a handback compares it, and it is opaque because the
    // Host has no business parsing it.
    assert_eq!(agent.backend_ref, "armadra-node-one:0.0");
    // A `terminated` row is EXITED, and the intent it was ended under survives.
    let plain = states
        .iter()
        .find(|state| state.session_id == "s-plain")
        .unwrap();
    assert_eq!(plain.status, SessionStatus::Exited as i32);
    assert_eq!(plain.termination_intent, TerminationIntent::User as i32);
    // Nothing here carries a revision: this Runtime stores no CAS token for a
    // domain it no longer owns, and a value would be one the Host could
    // mistake for agreement.
    let sessions = session::sessions(&pool).await.unwrap();
    assert!(sessions.iter().all(|stored| stored.revision == 0));
}

/// The rollback itself: the package goes back into the rows, and the re-read
/// this Runtime produces is what the Host compares its own package against.
#[tokio::test]
async fn a_handback_writes_the_package_back_and_reads_it_straight_back() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    insert(
        &pool,
        "s-one",
        &id,
        "node-one",
        "terminal",
        Some("node-one"),
        "running",
        "none",
        1,
    )
    .await;
    hand_to_host(&pool, 2).await;

    // The Host recycled the pane and then ended it while it held the domain.
    let mut moved = session::sessions(&pool).await.unwrap()[0].clone();
    moved.generation = 2;
    moved.status = SessionStatus::Exited as i32;
    moved.attach_state = SessionAttachState::Exited as i32;
    moved.termination_intent = TerminationIntent::User as i32;
    moved.reason_code = "session.termination.session".into();
    moved.exit_code = Some(130);
    moved.ended_at_unix_ms = 1_788_557_900_000;
    let runs = vec![SessionRun {
        session_id: "s-one".into(),
        generation: 2,
        worker_instance_id: "worker-b".into(),
        backend_ref: "armadra-node-one:0.1".into(),
        exit_code: Some(130),
        reason_code: "session.termination.session".into(),
        started_at_unix_ms: 1_788_557_000_000,
        ended_at_unix_ms: 1_788_557_900_000,
        revision: 4,
    }];
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, std::slice::from_ref(&moved), &runs);

    let report = session_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap();
    assert!(report.issues.is_empty());
    assert_eq!(report.reexported.len(), 1);

    let stored = session::sessions(&pool).await.unwrap();
    assert_eq!(stored[0].generation, 2);
    assert_eq!(stored[0].status, SessionStatus::Exited as i32);
    assert_eq!(stored[0].exit_code, Some(130));
    // The Runtime's own termination word came back verbatim, because the enum
    // is lossy: `process` and `session` are both TerminationIntent::USER, and
    // deriving the column from it would have silently changed how hard the
    // session was killed.
    let intent: String =
        sqlx::query_scalar("SELECT termination_intent FROM terminal_sessions WHERE id = 's-one'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(intent, "session");
    // And the run's backend reference reached the row, so a reclaim can name
    // the pane the generation describes.
    let backend: Option<String> =
        sqlx::query_scalar("SELECT backend_ref FROM terminal_sessions WHERE id = 's-one'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(backend.as_deref(), Some("armadra-node-one:0.1"));

    // Replaying the same identifier returns the stored answer rather than
    // applying twice.
    let replay = session_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap();
    assert!(replay.replayed);
}

/// A session the Host closed is a session the user removed. Restoring the row
/// would resurrect a terminal nobody asked for, which is the one direction a
/// rollback must never quietly take.
#[tokio::test]
async fn a_tombstone_removes_the_row_rather_than_restoring_it() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    insert(
        &pool,
        "s-one",
        &id,
        "node-one",
        "terminal",
        Some("node-one"),
        "running",
        "none",
        1,
    )
    .await;
    hand_to_host(&pool, 2).await;

    let closed = Session {
        session_id: "s-one".into(),
        workspace_id: id.clone(),
        session_key: "node-one".into(),
        deleted: true,
        created_at_unix_ms: 1_788_557_000_000,
        ..Session::default()
    };
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, &[closed], &[]);

    session_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap();
    assert!(session::sessions(&pool).await.unwrap().is_empty());
}

/// A session the Host opened while it held the domain has no row here, and its
/// row would reference a workspace the canvas domain rolls back *after* this
/// one. It is reported and blocks the handback rather than being invented.
#[tokio::test]
async fn a_session_this_database_never_had_blocks_the_handback() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    hand_to_host(&pool, 2).await;

    let unknown = Session {
        session_id: "s-new".into(),
        workspace_id: id.clone(),
        session_key: "node-new".into(),
        kind: SessionKind::Terminal as i32,
        status: SessionStatus::Running as i32,
        attach_state: SessionAttachState::Detached as i32,
        termination_intent: TerminationIntent::None as i32,
        generation: 1,
        launch: Some(SessionLaunch {
            shell: "/bin/zsh".into(),
            working_directory: "/项目/一".into(),
            ..SessionLaunch::default()
        }),
        created_at_unix_ms: 1_788_557_000_000,
        ..Session::default()
    };
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, &[unknown], &[]);

    let refused = session_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap_err();
    assert!(
        format!("{refused}").contains("reverse.missing_session"),
        "{refused}"
    );
    // Nothing was applied: the transaction was dropped without a commit.
    assert!(session::sessions(&pool).await.unwrap().is_empty());
}

/// A package that does not describe itself is refused before the transaction
/// opens, so nothing is half-understood.
#[tokio::test]
async fn a_package_whose_index_disagrees_with_its_records_is_refused() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    insert(
        &pool,
        "s-one",
        &id,
        "node-one",
        "terminal",
        Some("node-one"),
        "running",
        "none",
        1,
    )
    .await;
    hand_to_host(&pool, 2).await;

    let stored = session::sessions(&pool).await.unwrap();
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, &stored, &[]);
    // Rewrite the index's digest so it describes bytes the file does not hold.
    let raw = std::fs::read_to_string(package.join("export.json")).unwrap();
    let mut index: serde_json::Value = serde_json::from_str(&raw).unwrap();
    index["files"][0]["contentSha256"] =
        serde_json::json!("0000000000000000000000000000000000000000000000000000000000000000");
    std::fs::write(
        package.join("export.json"),
        serde_json::to_vec_pretty(&index).unwrap(),
    )
    .unwrap();

    let refused = session_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap_err();
    assert!(
        format!("{refused}").contains("reverse.package_invalid"),
        "{refused}"
    );
    // The row is untouched, so the operator can fix the package and try again.
    assert_eq!(session::sessions(&pool).await.unwrap()[0].generation, 1);
}

/// A canvas package must not be applied by the session importer, and a session
/// package must not be applied by the canvas one. Each domain's rollback writes
/// its own tables and nothing else.
#[tokio::test]
async fn each_domain_refuses_the_other_domains_package() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    hand_to_host(&pool, 2).await;
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, &[], &[]);

    let mut canvas = request(&package, 2, "handback-1");
    canvas.domain = "canvas".into();
    let refused = import::apply(&pool, &canvas).await.unwrap_err();
    assert!(format!("{refused}").contains("reverse."), "{refused}");
}
