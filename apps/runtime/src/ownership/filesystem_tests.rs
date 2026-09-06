//! The filesystem domain's two directions, from the Runtime's side.
//!
//! Reading is what a switch and a handback are both verified against, and
//! applying is the rollback itself. Between them they carry the whole claim
//! this domain makes: the Host decides where a workspace's files are and who
//! may touch them, and when it hands that back the rows here say exactly what
//! the package said.

use armadra_protocol::v1::{
    ApplyReverseExportRequest, CanvasWorkspacePermissions, ReverseExportRecord, WorkspaceRoot,
};

use super::records::encode_records;
use super::{OwnershipDomain, WriteOwner, filesystem, filesystem_import, import};
use crate::db;
use crate::model::WorkspacePermissions;

async fn pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("filesystem.db").display()
    ))
    .await
    .unwrap();
    (pool, directory)
}

fn permissions(read: bool, write: bool, execute: bool) -> WorkspacePermissions {
    WorkspacePermissions {
        read,
        write,
        execute,
    }
}

/// Writes one package the way the Host does: `export.json` plus one
/// length-prefixed entity file per workspace.
fn write_package(
    directory: &std::path::Path,
    epoch: u64,
    roots: &[WorkspaceRoot],
) -> Vec<serde_json::Value> {
    let mut files = Vec::new();
    for root in roots {
        let payload = encode_records(&[ReverseExportRecord {
            entity: Some(
                armadra_protocol::v1::reverse_export_record::Entity::WorkspaceRoot(root.clone()),
            ),
        }]);
        let name = format!("{}.pb", root.workspace_id);
        std::fs::write(directory.join(&name), &payload).unwrap();
        files.push(serde_json::json!({
            "name": name,
            "workspaceId": root.workspace_id,
            "bytes": payload.len(),
            "sha256": import::format_digest(&super::records::digest(&payload)),
            "contentSha256": import::format_digest(&filesystem::content_digest(root)),
            "entityCount": 1,
        }));
    }
    let index = serde_json::json!({
        "formatVersion": 2,
        "hostId": "0123456789abcdef0123456789abcdef",
        "epoch": epoch,
        "eventSequence": 7,
        "domain": "filesystem",
        "entityCount": files.len(),
        "files": files,
    });
    std::fs::write(
        directory.join("export.json"),
        serde_json::to_vec_pretty(&index).unwrap(),
    )
    .unwrap();
    Vec::new()
}

fn request(directory: &std::path::Path, epoch: u64, import_id: &str) -> ApplyReverseExportRequest {
    ApplyReverseExportRequest {
        domain: "filesystem".into(),
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
            domain: OwnershipDomain::Filesystem,
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
async fn roots_report_where_the_files_are_and_what_is_allowed() {
    let (pool, _directory) = pool().await;
    db::create_workspace(
        &pool,
        "本地",
        "/项目/一",
        None,
        Some(&permissions(true, true, false)),
    )
    .await
    .unwrap();
    db::create_remote_workspace(
        &pool,
        "远端",
        "构建机",
        "/srv/项目",
        Some(&permissions(true, false, false)),
    )
    .await
    .unwrap();
    let roots = filesystem::worker_roots(&pool).await.unwrap();
    assert_eq!(roots.len(), 2);
    let remote = roots
        .iter()
        .find(|root| root.execution_host_id == "构建机")
        .unwrap();
    assert_eq!(remote.canonical_path, "/srv/项目");
    assert_eq!(
        remote.permissions,
        Some(CanvasWorkspacePermissions {
            read: true,
            write: false,
            execute: false,
        })
    );
    // The Host's own facts are never invented here: a revision, a proof and a
    // registration time this Runtime has nowhere to store stay empty rather
    // than being filled in with something plausible.
    assert_eq!(remote.revision, 0);
    assert!(remote.proof_sha256.is_empty());
    assert_eq!(remote.registered_at_unix_ms, 0);
}

#[tokio::test]
async fn a_handback_writes_the_permissions_the_host_decided_and_reads_them_straight_back() {
    let (pool, directory) = pool().await;
    let workspace = db::create_workspace(
        &pool,
        "本地",
        "/项目/一",
        None,
        Some(&permissions(true, true, false)),
    )
    .await
    .unwrap();
    hand_to_host(&pool, 2).await;

    // What the Host decided while it owned the domain: execute granted.
    let root = WorkspaceRoot {
        workspace_id: workspace.id.clone(),
        canonical_path: "/项目/一".into(),
        permissions: Some(CanvasWorkspacePermissions {
            read: true,
            write: true,
            execute: true,
        }),
        ..Default::default()
    };
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, std::slice::from_ref(&root));

    let report = filesystem_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap();
    assert!(!report.replayed);
    assert_eq!(report.reexported.len(), 1);
    // The digest in the report is taken from a fresh read of the row, which is
    // the only reason comparing it with the package proves anything.
    assert_eq!(
        report.reexported[0].content_sha256,
        filesystem::content_digest(&root)
    );
    let stored = db::get_workspace(&pool, &workspace.id).await.unwrap();
    assert!(stored.permissions.execute);

    // The same request again replays the recorded report rather than writing
    // a second time.
    let replay = filesystem_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.reexported.len(), 1);
}

#[tokio::test]
async fn a_package_is_refused_unless_the_host_owns_the_domain_at_the_named_epoch() {
    let (pool, directory) = pool().await;
    let workspace = db::create_workspace(&pool, "本地", "/项目/一", None, None)
        .await
        .unwrap();
    let root = WorkspaceRoot {
        workspace_id: workspace.id.clone(),
        canonical_path: "/项目/一".into(),
        permissions: Some(CanvasWorkspacePermissions {
            read: true,
            write: true,
            execute: false,
        }),
        ..Default::default()
    };
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, std::slice::from_ref(&root));

    // The Runtime still owns the domain: applying would overwrite rows it is
    // serving.
    let refused = filesystem_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap_err();
    assert!(format!("{refused:?}").contains("reverse.not_host_owned"));

    hand_to_host(&pool, 2).await;
    // A package taken at another epoch describes a different state.
    let mismatched = directory.path().join("mismatched");
    std::fs::create_dir_all(&mismatched).unwrap();
    write_package(&mismatched, 5, std::slice::from_ref(&root));
    let refused = filesystem_import::apply(&pool, &request(&mismatched, 0, "handback-2"))
        .await
        .unwrap_err();
    assert!(format!("{refused:?}").contains("reverse.epoch_mismatch"));
}

#[tokio::test]
async fn a_root_for_a_workspace_this_database_does_not_have_blocks_the_handback() {
    let (pool, directory) = pool().await;
    hand_to_host(&pool, 2).await;
    let root = WorkspaceRoot {
        workspace_id: "missing-workspace".into(),
        canonical_path: "/项目/一".into(),
        permissions: Some(CanvasWorkspacePermissions {
            read: true,
            write: true,
            execute: false,
        }),
        ..Default::default()
    };
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, std::slice::from_ref(&root));
    let refused = filesystem_import::apply(&pool, &request(&package, 2, "handback-1"))
        .await
        .unwrap_err();
    assert!(format!("{refused:?}").contains("reverse.missing_workspace"));
    // Nothing was applied, so the ledger has no record of it and the same
    // identifier is free for the corrected attempt.
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM host_imports")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(recorded, 0);
}

/// A canvas package must not be applied as a filesystem one, and the other way
/// round. Both would rewrite rows nobody exported.
#[tokio::test]
async fn a_package_is_applied_to_the_domain_it_names() {
    let (pool, directory) = pool().await;
    hand_to_host(&pool, 2).await;
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &[]);
    let mut canvas = request(&package, 2, "handback-1");
    canvas.domain = "canvas".into();
    let refused = import::apply(&pool, &canvas).await.unwrap_err();
    assert!(format!("{refused:?}").contains("is not the canvas domain"));

    let mut unknown = request(&package, 2, "handback-2");
    unknown.domain = "sessions".into();
    let refused = import::apply(&pool, &unknown).await.unwrap_err();
    assert!(format!("{refused:?}").contains("no reverse importer"));
}

/// The write guard is per domain. Registering a root is refused once the Host
/// owns the filesystem, and every other domain keeps answering.
#[tokio::test]
async fn the_filesystem_guard_moves_on_its_own() {
    let (pool, _directory) = pool().await;
    super::require_local_write(&pool, OwnershipDomain::Filesystem)
        .await
        .unwrap();
    hand_to_host(&pool, 2).await;
    let refused = super::require_local_write(&pool, OwnershipDomain::Filesystem)
        .await
        .unwrap_err();
    assert!(matches!(refused, crate::error::AppError::OwnershipMoved(_)));
    for domain in OwnershipDomain::ALL {
        if domain == OwnershipDomain::Filesystem {
            continue;
        }
        super::require_local_write(&pool, domain).await.unwrap();
    }
}
