//! `/api/models/catalog` — the provenance the cost panel shows.
//!
//! Only the read route is exercised; the refresh route reaches models.dev and
//! the test suite never touches the network.

use axum::http::StatusCode;

use super::support::*;

#[tokio::test]
async fn the_catalog_route_says_where_the_prices_came_from() {
    let (router, _directory) = router_fixture("api-model-catalog").await;
    let (status, document) = call(&router, "GET", "/api/models/catalog", None).await;
    assert_eq!(status, StatusCode::OK);
    // A fixture Runtime has no cache and has fetched nothing, so the honest
    // answer is "the tables this build shipped with" rather than a timestamp.
    assert_eq!(document["source"], "builtIn");
    assert!(document["fetchedAt"].is_null());
    assert!(document["ageHours"].is_null());
    assert_eq!(document["url"], crate::models::catalog::CATALOG_URL);
    assert_eq!(document["models"], serde_json::json!([]));
    // The built-in rows are still prices, and the page counts them.
    assert!(
        document["pricedModels"].as_u64().unwrap_or_default() > 0,
        "{document}"
    );
    assert!(document["refreshError"].is_null());
}
