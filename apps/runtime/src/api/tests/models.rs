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

#[tokio::test]
async fn an_agents_model_list_falls_back_to_the_offline_table_and_says_so() {
    let (router, _directory) = router_fixture("api-agent-models").await;
    let (status, models) = call(&router, "GET", "/api/agents/codex/models", None).await;
    assert_eq!(status, StatusCode::OK);
    // No catalog in a fixture Runtime, and codex's help lists no models, so
    // what is left is the offline table — labelled as such rather than passed
    // off as something the CLI said.
    let entries = models.as_array().unwrap();
    assert!(!entries.is_empty());
    assert!(
        entries
            .iter()
            .all(|entry| entry["source"] == "builtin" || entry["source"] == "cli"),
        "{models}"
    );
    for entry in entries {
        assert!(entry["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(entry["label"], entry["label"]);
    }

    // A CLI we cannot attribute to a provider offers nothing rather than
    // another vendor's models.
    let (status, empty) = call(&router, "GET", "/api/agents/opencode/models", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty, serde_json::json!([]));

    let (status, _) = call(&router, "GET", "/api/agents/nobody/models", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
