//! The bearer and the per-node token that gate every hook route.

use super::support::*;

#[tokio::test]
async fn the_bearer_gates_every_hook_route() {
    let fixture = fixture("hook-bearer").await;

    // No bearer at all.
    assert_eq!(
        fixture
            .post_hook("claude", json!({ "nodeId": fixture.node_id }), &[])
            .await,
        StatusCode::FORBIDDEN
    );
    // The client sends the header even when the endpoint file had no token.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": fixture.node_id }),
                &[("x-armadra-hook-token", "")],
            )
            .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": fixture.node_id }),
                &[("x-armadra-hook-token", "not-the-token")],
            )
            .await,
        StatusCode::FORBIDDEN
    );

    let verify = |token: Option<&str>| {
        let mut request = Request::builder().method("GET").uri("/verify");
        if let Some(token) = token {
            request = request.header("x-armadra-hook-token", token);
        }
        fixture
            .router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
    };
    assert_eq!(
        verify(Some(&fixture.bearer)).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(verify(None).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_forged_node_token_is_refused_and_a_missing_one_is_merely_legacy() {
    let fixture = fixture("hook-verdict").await;
    let good = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let (kid, _) = good.split_once('.').unwrap();

    // Our key id, wrong MAC: someone is guessing.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({ "nodeId": fixture.node_id, "payload": { "hook_event_name": "Stop" } }),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &format!("{kid}.wrong")),
                ],
            )
            .await,
        StatusCode::FORBIDDEN
    );
    assert!(fixture.status().await.is_none(), "nothing was written");

    // No node token at all: accepted, but flagged unverified.
    assert_eq!(
        fixture
            .post_hook(
                "claude",
                json!({
                    "nodeId": fixture.node_id,
                    "payload": { "hook_event_name": "UserPromptSubmit" }
                }),
                &[("x-armadra-hook-token", &fixture.bearer)],
            )
            .await,
        StatusCode::NO_CONTENT
    );
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("working"));
    assert!(!status.verified);

    // With the real token the row is verified.
    assert_eq!(
        fixture.report(json!({ "hook_event_name": "Stop" })).await,
        StatusCode::NO_CONTENT
    );
    assert!(fixture.status().await.unwrap().verified);
}
