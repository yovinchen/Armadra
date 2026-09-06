//! Applying a Host reverse export package back into `canvas.db`
//! (Go Host 业务所有权迁移 §2.12).
//!
//! The rollback of a write-ownership switch is the dangerous direction: the
//! Host's canvas has to land in this database completely, or not at all. What
//! is covered here is exactly that boundary — one transaction, a verified
//! package, an idempotent retry, and a refusal that leaves the database as it
//! was rather than half-rolled-back.
//!
//! Packages are built here rather than by the Go Host, because a Rust test that
//! needed a Go binary would stop running. The Go side proves the same format
//! against the real writer in `apps/host/internal/canvashost`.

use armadra_protocol::v1::{ApplyReverseExportRequest, CanvasWhiteboard};
use armadra_runtime::{
    db,
    error::AppError,
    ownership::{
        self, OwnershipHandoff, WriteOwner,
        import::{self, PackageFile, PackageIndex},
        records::{self, WorkspaceRecords},
    },
};

const HOST_ID: &str = "0123456789abcdef0123456789abcdef";

struct Fixture {
    pool: sqlx::SqlitePool,
    workspace_id: String,
    board_id: String,
    directory: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("canvas.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(&pool, "回滚", project.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    Fixture {
        pool,
        workspace_id: workspace.id,
        board_id: board.id,
        directory,
    }
}

/// Seeds one canvas with every shape the projection has to carry: a nested
/// frame, a sized node, an unsized one, an annotation, a link and a whiteboard.
async fn seed(fixture: &Fixture) {
    let now = "2026-09-05T10:00:00.000Z";
    for (id, kind, x, y, size, parent, labels, note) in [
        (
            "frame-1",
            "group",
            0.0,
            0.0,
            Some((400.0, 300.0)),
            None,
            "[]",
            "",
        ),
        (
            "node-1",
            "sticky",
            10.5,
            -20.0,
            Some((200.0, 120.0)),
            Some("frame-1"),
            r#"["紧急","待办"]"#,
            "备注📝",
        ),
        ("node-2", "terminal", 500.0, 40.0, None, None, "[]", ""),
    ] {
        sqlx::query(
            "INSERT INTO nodes (id, board_id, type, x, y, width, height, title, color, collapsed, \
             expanded_height, parent_id, labels_json, note, data_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '#0a84ff', 0, NULL, ?, ?, ?, '{}', ?, ?)",
        )
        .bind(id)
        .bind(&fixture.board_id)
        .bind(kind)
        .bind(x)
        .bind(y)
        .bind(size.map(|(width, _)| width))
        .bind(size.map(|(_, height)| height))
        .bind(id)
        .bind(parent)
        .bind(labels)
        .bind(note)
        .bind(now)
        .bind(now)
        .execute(&fixture.pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, created_at, updated_at) \
         VALUES ('edge-1', ?, 'node-1', 'node-2', 'link', ?, ?)",
    )
    .bind(&fixture.board_id)
    .bind(now)
    .bind(now)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE boards SET whiteboard_json = ? WHERE id = ?")
        .bind(r#"{"records":[]}"#)
        .bind(&fixture.board_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
}

async fn read_records(pool: &sqlx::SqlitePool, workspace_id: &str) -> WorkspaceRecords {
    let mut connection = pool.acquire().await.unwrap();
    records::read_workspace(&mut connection, workspace_id)
        .await
        .unwrap()
}

/// Hands the canvas domain to the Host, which is the state a rollback starts
/// from: the Runtime refuses canvas writes and the package it is about to
/// receive is the Host's own.
async fn give_to_host(pool: &sqlx::SqlitePool, epoch: u64) {
    ownership::apply(
        pool,
        OwnershipHandoff {
            domain: ownership::domains::OwnershipDomain::Canvas,
            owner: WriteOwner::Host,
            epoch,
            expected_epoch: epoch - 1,
            reason_code: "ownership.switch.verified".into(),
        },
    )
    .await
    .unwrap();
}

/// Writes a version 2 package, the way `canvashost.Export` does.
fn write_package(directory: &std::path::Path, epoch: u64, workspaces: &[WorkspaceRecords]) {
    std::fs::create_dir_all(directory).unwrap();
    let mut index = PackageIndex {
        format_version: 2,
        host_id: HOST_ID.into(),
        epoch,
        event_sequence: 12,
        domain: "canvas".into(),
        entity_count: 0,
        files: Vec::new(),
    };
    for (position, records) in workspaces.iter().enumerate() {
        let payload = records::encode_records(&records.canonical());
        let name = format!("workspace-{position}.pb");
        std::fs::write(directory.join(&name), &payload).unwrap();
        index.entity_count += records.entity_count();
        index.files.push(PackageFile {
            name,
            workspace_id: records
                .workspace
                .as_ref()
                .map(|workspace| workspace.workspace_id.clone())
                .unwrap_or_default(),
            bytes: payload.len() as u64,
            sha256: import::format_digest(&records::digest(&payload)),
            content_sha256: import::format_digest(&records.content_digest()),
            entity_count: records.entity_count(),
        });
    }
    std::fs::write(
        directory.join(import::INDEX_FILE),
        serde_json::to_vec_pretty(&index).unwrap(),
    )
    .unwrap();
}

fn request(
    directory: &std::path::Path,
    import_id: &str,
    expected_epoch: u64,
) -> ApplyReverseExportRequest {
    ApplyReverseExportRequest {
        domain: "canvas".into(),
        package_path: directory.to_string_lossy().into_owned(),
        index_sha256: Vec::new(),
        expected_epoch,
        import_id: import_id.into(),
    }
}

#[tokio::test]
async fn an_applied_package_becomes_the_canvas_and_reads_back_as_the_package() {
    let fixture = fixture().await;
    seed(&fixture).await;
    let mut records = read_records(&fixture.pool, &fixture.workspace_id).await;
    // What the Host did while it owned the canvas: renamed a canvas, retitled a
    // node, dropped one and its link, and edited an annotation.
    records.canvases[0].name = "Host 改过的画布".into();
    records.nodes.retain(|node| node.node_id != "node-2");
    records.edges.clear();
    records.nodes[1].title = "Host 改过的便签".into();
    records.annotations[0].note = "Host 写的备注".into();
    records.annotations[0].labels = vec!["已完成".into()];

    give_to_host(&fixture.pool, 2).await;
    let package = fixture.directory.path().join("reverse");
    write_package(&package, 2, std::slice::from_ref(&records));

    let report = import::apply(&fixture.pool, &request(&package, "rollback-1", 2))
        .await
        .unwrap();
    assert!(!report.replayed);
    assert_eq!(report.epoch, 2);
    assert_eq!(report.entity_count, records.entity_count());
    // The digest the Host compares against is taken from the rows, after the
    // write, and has to be the package's own.
    assert_eq!(report.reexported.len(), 1);
    assert_eq!(
        report.reexported[0].content_sha256,
        records.content_digest()
    );

    let stored = read_records(&fixture.pool, &fixture.workspace_id).await;
    assert_eq!(stored, records);
    // An object the package no longer names is gone, not resurrected.
    let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM nodes ORDER BY id")
        .fetch_all(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(remaining, ["frame-1", "node-1"]);
    let edges: i64 = sqlx::query_scalar("SELECT count(*) FROM edges")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(edges, 0);
}

#[tokio::test]
async fn a_replay_writes_nothing_and_answers_with_the_recorded_report() {
    let fixture = fixture().await;
    seed(&fixture).await;
    let mut records = read_records(&fixture.pool, &fixture.workspace_id).await;
    records.canvases[0].name = "只导入一次".into();
    give_to_host(&fixture.pool, 2).await;
    let package = fixture.directory.path().join("reverse");
    write_package(&package, 2, std::slice::from_ref(&records));

    let first = import::apply(&fixture.pool, &request(&package, "rollback-1", 2))
        .await
        .unwrap();
    // Something changed the canvas between the two attempts. A replay must
    // report what the first import wrote, not what the database holds now.
    sqlx::query("UPDATE boards SET name = '之后被改动' WHERE id = ?")
        .bind(&fixture.board_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let replay = import::apply(&fixture.pool, &request(&package, "rollback-1", 2))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.index_sha256, first.index_sha256);
    assert_eq!(replay.reexported, first.reexported);
    assert_eq!(replay.applied_at_unix_ms, first.applied_at_unix_ms);
    let name: String = sqlx::query_scalar("SELECT name FROM boards WHERE id = ?")
        .bind(&fixture.board_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(name, "之后被改动", "the replay wrote to the database");

    // The same identifier naming different bytes is a controller bug, not a
    // retry, and it is refused rather than applied over the first import.
    records.canvases[0].name = "另一个包".into();
    let other = fixture.directory.path().join("other");
    write_package(&other, 2, std::slice::from_ref(&records));
    assert!(matches!(
        import::apply(&fixture.pool, &request(&other, "rollback-1", 2)).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.import_id_reused")
    ));
}

#[tokio::test]
async fn a_package_that_does_not_describe_itself_is_refused() {
    let fixture = fixture().await;
    seed(&fixture).await;
    let records = read_records(&fixture.pool, &fixture.workspace_id).await;
    give_to_host(&fixture.pool, 2).await;
    let before = read_records(&fixture.pool, &fixture.workspace_id).await;

    let flipped = fixture.directory.path().join("flipped");
    write_package(&flipped, 2, std::slice::from_ref(&records));
    let entity = flipped.join("workspace-0.pb");
    let mut payload = std::fs::read(&entity).unwrap();
    let last = payload.len() - 1;
    payload[last] ^= 0xff;
    std::fs::write(&entity, &payload).unwrap();
    assert!(matches!(
        import::apply(&fixture.pool, &request(&flipped, "rollback-1", 2)).await,
        Err(AppError::BadRequest(message)) if message.contains("are not the ones the index describes")
    ));

    let truncated = fixture.directory.path().join("truncated");
    write_package(&truncated, 2, std::slice::from_ref(&records));
    let entity = truncated.join("workspace-0.pb");
    let payload = std::fs::read(&entity).unwrap();
    std::fs::write(&entity, &payload[..payload.len() - 3]).unwrap();
    assert!(
        import::apply(&fixture.pool, &request(&truncated, "rollback-2", 2))
            .await
            .is_err()
    );

    // A version 1 package has no reader; it is named as such rather than
    // parsed on the chance that it happens to fit.
    let old = fixture.directory.path().join("v1");
    write_package(&old, 2, std::slice::from_ref(&records));
    let index = old.join(import::INDEX_FILE);
    let mut decoded: PackageIndex =
        serde_json::from_slice(&std::fs::read(&index).unwrap()).unwrap();
    decoded.format_version = 1;
    std::fs::write(&index, serde_json::to_vec(&decoded).unwrap()).unwrap();
    assert!(matches!(
        import::apply(&fixture.pool, &request(&old, "rollback-3", 2)).await,
        Err(AppError::BadRequest(message)) if message.contains("package format version 1")
    ));

    assert_eq!(
        read_records(&fixture.pool, &fixture.workspace_id).await,
        before
    );
}

#[tokio::test]
async fn an_entity_this_build_cannot_store_stops_the_whole_import() {
    let fixture = fixture().await;
    seed(&fixture).await;
    let base = read_records(&fixture.pool, &fixture.workspace_id).await;
    give_to_host(&fixture.pool, 2).await;
    let before = read_records(&fixture.pool, &fixture.workspace_id).await;

    let mut newer = base.clone();
    newer.canvases[0].name = "被拒绝的包".into();
    newer.canvases[0].whiteboard = Some(CanvasWhiteboard {
        schema_version: 99,
        engine_version: "armadra-flow".into(),
        snapshot: b"{}".to_vec(),
        sha256: records::digest(b"{}"),
        bytes: 2,
    });
    let package = fixture.directory.path().join("newer-whiteboard");
    write_package(&package, 2, std::slice::from_ref(&newer));
    assert!(matches!(
        import::apply(&fixture.pool, &request(&package, "rollback-1", 2)).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.unsupported_entity")
    ));

    let mut unknown = base.clone();
    unknown.canvases[0].name = "同样被拒绝".into();
    unknown.nodes[0].r#type = "hologram".into();
    let package = fixture.directory.path().join("unknown-node");
    write_package(&package, 2, std::slice::from_ref(&unknown));
    assert!(matches!(
        import::apply(&fixture.pool, &request(&package, "rollback-2", 2)).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.unsupported_entity")
    ));

    // Neither refusal wrote the canvas rename that came with it.
    assert_eq!(
        read_records(&fixture.pool, &fixture.workspace_id).await,
        before
    );
}

#[tokio::test]
async fn a_failure_on_the_second_workspace_leaves_the_first_one_alone() {
    let fixture = fixture().await;
    seed(&fixture).await;
    let second = fixture.directory.path().join("second");
    std::fs::create_dir(&second).unwrap();
    let other = db::create_workspace(
        &fixture.pool,
        "第二个",
        second.to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();

    let mut first = read_records(&fixture.pool, &fixture.workspace_id).await;
    let mut clash = read_records(&fixture.pool, &other.id).await;
    first.canvases[0].name = "第一个工作区的新名字".into();
    // `workspaces.root_path` is unique. The second workspace claiming the
    // first one's root fails inside the transaction rather than at the door,
    // which is exactly the case that has to roll the first one back.
    clash.workspace.as_mut().unwrap().root_path =
        first.workspace.as_ref().unwrap().root_path.clone();

    give_to_host(&fixture.pool, 2).await;
    let before = read_records(&fixture.pool, &fixture.workspace_id).await;
    let package = fixture.directory.path().join("reverse");
    write_package(&package, 2, &[first, clash]);
    assert!(
        import::apply(&fixture.pool, &request(&package, "rollback-1", 2))
            .await
            .is_err()
    );
    assert_eq!(
        read_records(&fixture.pool, &fixture.workspace_id).await,
        before
    );
    // A refused import leaves no ledger row, so retrying a fixed package with
    // the same identifier is an import rather than a replay of a failure.
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM host_imports")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(recorded, 0);
}

#[tokio::test]
async fn a_package_is_only_applied_while_the_host_owns_writes_at_that_epoch() {
    let fixture = fixture().await;
    seed(&fixture).await;
    let records = read_records(&fixture.pool, &fixture.workspace_id).await;
    let package = fixture.directory.path().join("reverse");
    write_package(&package, 2, std::slice::from_ref(&records));

    // The Runtime still owns the canvas: a Host package would overwrite rows
    // this process is serving, so it is refused before the transaction writes.
    assert!(matches!(
        import::apply(&fixture.pool, &request(&package, "rollback-1", 2)).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.not_host_owned")
    ));

    give_to_host(&fixture.pool, 2).await;
    // A package taken at a different epoch is a different rollback.
    let stale = fixture.directory.path().join("stale");
    write_package(&stale, 5, std::slice::from_ref(&records));
    assert!(matches!(
        import::apply(&fixture.pool, &request(&stale, "rollback-2", 0)).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.epoch_mismatch")
    ));
    // So is a controller that believes the database is somewhere else.
    assert!(matches!(
        import::apply(&fixture.pool, &request(&package, "rollback-3", 7)).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.epoch_mismatch")
    ));
    // And a package whose index is not the one the controller hashed.
    let mut mismatched = request(&package, "rollback-4", 2);
    mismatched.index_sha256 = vec![9; 32];
    assert!(matches!(
        import::apply(&fixture.pool, &mismatched).await,
        Err(AppError::Conflict(message)) if message.contains("reverse.index_mismatch")
    ));
    import::apply(&fixture.pool, &request(&package, "rollback-5", 2))
        .await
        .unwrap();
}

#[tokio::test]
async fn facts_the_canvas_never_carried_survive_the_round_trip() {
    let fixture = fixture().await;
    seed(&fixture).await;
    // Two columns that are not canvas entity fields and never reached the Host:
    // where the workspace executes, and the retired task-board archive.
    sqlx::query("UPDATE workspaces SET execution_host_id = 'remote-1' WHERE id = ?")
        .bind(&fixture.workspace_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let mut records = read_records(&fixture.pool, &fixture.workspace_id).await;
    records.canvases[0].name = "Host 改过的画布".into();
    give_to_host(&fixture.pool, 2).await;
    let package = fixture.directory.path().join("reverse");
    write_package(&package, 2, std::slice::from_ref(&records));
    import::apply(&fixture.pool, &request(&package, "rollback-1", 2))
        .await
        .unwrap();

    let host: String = sqlx::query_scalar("SELECT execution_host_id FROM workspaces WHERE id = ?")
        .bind(&fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(host, "remote-1");
    let kanban: String = sqlx::query_scalar("SELECT kanban_json FROM boards WHERE id = ?")
        .bind(&fixture.board_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(kanban, "{}");
    // The retirement trigger is still the one guarding that column, which it
    // would not be if the import had dropped and recreated the row's table.
    assert!(
        sqlx::query("UPDATE boards SET kanban_json = '{\"columns\":[]}' WHERE id = ?")
            .bind(&fixture.board_id)
            .execute(&fixture.pool)
            .await
            .is_err()
    );
    // Applying a package is not a handoff: the Host still owns the domain
    // until the epoch comes back over the ownership command.
    let record = ownership::read(&fixture.pool, ownership::domains::OwnershipDomain::Canvas)
        .await
        .unwrap();
    assert_eq!(record.owner, WriteOwner::Host);
    assert_eq!(record.epoch, 2);
}
