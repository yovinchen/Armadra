//! Board rows: creation, renaming, reordering and deletion.

use super::support::*;
use crate::db::*;

#[tokio::test]
async fn boards_can_be_created_renamed_reordered_and_deleted() {
    let (pool, _directory, workspace) = fixture("boards").await;
    let extra = create_board(&pool, &workspace.id, "Review").await.unwrap();
    assert_eq!(extra.sort_order, 1);
    let renamed = update_board(
        &pool,
        &workspace.id,
        &extra.id,
        Some("Reviewed".into()),
        Some(0),
    )
    .await
    .unwrap();
    assert_eq!(renamed.name, "Reviewed");
    assert_eq!(renamed.sort_order, 0);

    delete_board(&pool, &workspace.id, &extra.id).await.unwrap();
    let remaining = list_boards(&pool, &workspace.id).await.unwrap();
    assert_eq!(remaining.len(), 1);
    assert!(matches!(
        delete_board(&pool, &workspace.id, &remaining[0].id).await,
        Err(AppError::Conflict(_))
    ));
}
