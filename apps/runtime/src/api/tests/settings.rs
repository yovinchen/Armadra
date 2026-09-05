//! The settings document and its terminal-backend patch.

use axum::http::StatusCode;
use serde_json::json;

use super::support::*;

#[tokio::test]
async fn settings_expose_and_patch_the_terminal_backend_choice() {
    let (router, _directory) = router_fixture("api-settings").await;
    let (status, settings) = call(&router, "GET", "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["terminal"]["backend"], "direct");
    assert_eq!(settings["terminal"]["detachedGraceMinutes"], 1440);

    let (status, patched) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "terminal": { "backend": "auto" }, "future": { "key": 1 } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["terminal"]["backend"], "auto");
    // Untouched keys survive, unknown ones are kept rather than dropped.
    assert_eq!(patched["terminal"]["detachedGraceMinutes"], 1440);
    assert_eq!(patched["future"]["key"], 1);

    let (status, error) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "terminal": { "backend": "screen" } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "bad_request");
}
