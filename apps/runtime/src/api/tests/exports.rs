//! The board PNG export route.

use axum::http::StatusCode;
use serde_json::json;

use super::support::*;

/// docs/design/canvas-react-flow.md §2.5: an export is a whiteboard item, not
/// a node, so the id only has to be a uuid.
#[tokio::test]
async fn exports_no_longer_need_a_node() {
    let (router, directory) = router_fixture("api-exports").await;
    let root = directory.path().to_string_lossy().into_owned();
    let workspace_id = asset_workspace(&router, &root).await;
    let data_url = format!("data:image/png;base64,{TINY_PNG}");

    // Nothing with this id exists anywhere; it is a whiteboard shape.
    let export_id = uuid::Uuid::now_v7().to_string();
    let (status, exported) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/exports/{export_id}/png"),
        Some(json!({ "dataUrl": data_url })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{exported}");
    assert_eq!(
        exported["relativePath"],
        format!(".armadra/exports/{export_id}.png")
    );
    assert!(
        directory
            .path()
            .join(".armadra/exports")
            .join(format!("{export_id}.png"))
            .is_file()
    );

    // An id that is not a uuid would be a file name, so it is refused.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/exports/..%2F..%2Fescape/png"),
        Some(json!({ "dataUrl": data_url })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Only a PNG data URL is accepted.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/exports/{export_id}/png"),
        Some(json!({ "dataUrl": "data:image/svg+xml;base64,PHN2Zy8+" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
