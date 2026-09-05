//! The delivery log route and the header/body helpers behind it.

use super::support::*;

/// `GET /api/workspaces/{id}/deliveries` backs the 投递记录 panel.
#[tokio::test]
async fn the_delivery_log_route_returns_this_workspace_only() {
    let fixture = fixture("collab-deliveries").await;
    db::insert_delivery(
        &fixture.state.pool,
        db::DeliveryRecord {
            trace_id: "trace-1",
            workspace_id: &fixture.workspace_id,
            source_node_id: &fixture.caller_id,
            target_node_id: &fixture.peer_id,
            outcome: "delivered",
            receipt: Some("newTurn"),
            body_chars: 42,
        },
    )
    .await
    .unwrap();

    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/workspaces/{}/deliveries",
                    fixture.workspace_id
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let rows: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["outcome"], "delivered");
    assert_eq!(rows[0]["bodyChars"], 42);
    // The body itself is never stored, so it can never leak through here.
    assert!(rows[0].get("body").is_none());
}

/* --------------------------------- helpers -------------------------------- */

#[test]
fn header_fields_are_collapsed_and_bodies_lose_their_escapes() {
    assert_eq!(collapse_newlines("a\nb\r\n  c  "), "a b c");
    assert_eq!(collapse_newlines("   "), "");
    assert_eq!(strip_control("a\x1b[31mb\x07\tc\nd"), "a[31mb\tc\nd");
    assert_eq!(nonce(12).len(), 12);
    assert_ne!(nonce(12), nonce(12));
    assert_eq!(truncate("abc", 10), "abc");
    assert!(truncate("中文中文中文", 7).ends_with("（已截断）"));
}
