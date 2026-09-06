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

/// Once the Host owns the settings domain the Runtime stops writing it and
/// keeps reading it (Go Host 业务所有权迁移 §2.2). Both halves matter: a read
/// that also failed would leave the settings page with nothing to render, and
/// a write that still succeeded would let two processes edit one document.
#[tokio::test]
async fn moving_the_settings_domain_stops_the_patch_and_leaves_the_read() {
    let (state, _directory) = state_fixture("api-settings-ownership").await;
    let router = crate::router_with_state(state.clone());
    let move_domain = |domain| {
        let pool = state.pool.clone();
        async move {
            crate::ownership::apply(
                &pool,
                crate::ownership::OwnershipHandoff {
                    domain,
                    owner: crate::ownership::WriteOwner::Host,
                    epoch: 2,
                    expected_epoch: 1,
                    reason_code: "ownership.switch.verified".into(),
                },
            )
            .await
            .unwrap()
        }
    };

    // A different domain moving says nothing about this one: the epochs are
    // independent, and that is the whole point of a per-domain record.
    move_domain(crate::ownership::OwnershipDomain::Canvas).await;
    let (status, patched) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "terminal": { "backend": "tmux" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["terminal"]["backend"], "tmux");

    move_domain(crate::ownership::OwnershipDomain::Settings).await;
    let (status, error) = call(
        &router,
        "PATCH",
        "/api/settings",
        Some(json!({ "terminal": { "backend": "direct" } })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "ownership_moved");

    // The refusal comes before the patch is validated, so a malformed one
    // still reports the ownership: the Runtime does not write either way, and
    // "fix your patch" would be advice that changes nothing.
    let (status, error) = call(&router, "PATCH", "/api/settings", Some(json!([]))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "ownership_moved");

    let (status, settings) = call(&router, "GET", "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    // Still the document the last accepted patch left, untouched by the
    // refusals above.
    assert_eq!(settings["terminal"]["backend"], "tmux");
}
