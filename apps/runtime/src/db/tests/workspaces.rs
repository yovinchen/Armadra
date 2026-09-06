//! Workspace rows: re-opening a root, summary ordering and partial patches.

use super::support::*;
use crate::db::*;
use crate::model::*;

#[tokio::test]
async fn authorizing_the_same_root_reopens_the_existing_workspace() {
    let (pool, directory, first) = fixture("idempotent-workspace").await;
    let root = directory.path().to_str().unwrap();
    let reopened = create_workspace(&pool, "Ignored replacement", root, None, None)
        .await
        .unwrap();

    assert_eq!(reopened.id, first.id);
    assert_eq!(reopened.name, "fixture");
    assert_eq!(list_workspaces(&pool).await.unwrap().len(), 1);
    let boards = list_boards(&pool, &first.id).await.unwrap();
    assert_eq!(boards.len(), 1);
    assert_eq!(boards[0].name, "Default");
    assert_eq!(boards[0].viewport.zoom, 1.0);
}

#[tokio::test]
async fn workspace_summaries_are_ordered_by_last_opened() {
    let (pool, directory, first) = fixture("summaries").await;
    let second_root = directory.path().join("second");
    std::fs::create_dir(&second_root).unwrap();
    let second = create_workspace(
        &pool,
        "second",
        second_root.to_str().unwrap(),
        Some("#abcdef"),
        Some(&WorkspacePermissions {
            read: true,
            write: false,
            execute: true,
        }),
    )
    .await
    .unwrap();
    assert_eq!(second.color, "#ABCDEF");
    assert!(!second.permissions.write);

    touch_workspace_opened(&pool, &first.id).await.unwrap();
    let summaries = list_workspaces(&pool).await.unwrap();
    assert_eq!(summaries[0].workspace.id, first.id);
    assert_eq!(summaries[0].boards.len(), 1);
    assert_eq!(summaries[0].boards[0].node_count, 0);
    assert_eq!(summaries[1].workspace.id, second.id);
}

#[tokio::test]
async fn workspace_patch_updates_only_the_supplied_fields() {
    let (pool, _directory, workspace) = fixture("patch").await;
    let updated = update_workspace(
        &pool,
        &workspace.id,
        WorkspacePatch {
            name: None,
            color: Some("#123456".into()),
            permissions: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(updated.name, "fixture");
    assert_eq!(updated.color, "#123456");
    assert!(matches!(
        update_workspace(
            &pool,
            &workspace.id,
            WorkspacePatch {
                name: None,
                color: Some("red".into()),
                permissions: None,
            },
        )
        .await,
        Err(AppError::BadRequest(_))
    ));
}

/// A fresh database gets one project under the data directory, with its
/// board, and a database that already has any workspace is left alone.
#[tokio::test]
async fn an_empty_database_gets_a_default_workspace_once() {
    let directory = tempfile::tempdir().unwrap();
    let pool = connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("fresh.db").display()
    ))
    .await
    .unwrap();
    let created = ensure_default_workspace(&pool, directory.path())
        .await
        .unwrap()
        .expect("a fresh database gets the default workspace");
    assert_eq!(created.name, DEFAULT_WORKSPACE_NAME);
    let expected = directory
        .path()
        .join("workspaces")
        .join("default")
        .canonicalize()
        .unwrap();
    assert_eq!(created.root_path, expected.to_string_lossy());
    assert!(created.permissions.execute);
    let boards = list_boards(&pool, &created.id).await.unwrap();
    assert_eq!(boards.len(), 1);
    assert_eq!(boards[0].name, DEFAULT_BOARD_NAME);

    // Second start: the row exists, so nothing is added.
    assert!(
        ensure_default_workspace(&pool, directory.path())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(list_workspaces(&pool).await.unwrap().len(), 1);

    // A database the user already populated is never touched either, even
    // when their workspace lives somewhere else entirely.
    let (other_pool, other_directory, _) = fixture("populated").await;
    assert!(
        ensure_default_workspace(&other_pool, other_directory.path())
            .await
            .unwrap()
            .is_none()
    );
    assert!(!other_directory.path().join("workspaces").exists());
}
