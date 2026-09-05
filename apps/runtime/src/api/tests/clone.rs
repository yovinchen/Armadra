//! The Git clone routes and their validation.

use axum::http::StatusCode;
use serde_json::json;

use super::support::*;

#[tokio::test]
async fn clone_routes_validate_before_running_git() {
    let (router, directory) = router_fixture("api-clone").await;

    let (status, error) = call(
        &router,
        "POST",
        "/api/git/clone",
        Some(json!({
            "url": "file:///tmp/repo.git",
            "parent": directory.path().to_string_lossy()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "bad_request");

    let (status, _) = call(
        &router,
        "POST",
        "/api/git/clone",
        Some(json!({
            "url": "https://example.test/team/repo.git",
            "parent": directory.path().join("missing").to_string_lossy()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(&router, "GET", "/api/git/clone/unknown", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&router, "DELETE", "/api/git/clone/unknown", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
