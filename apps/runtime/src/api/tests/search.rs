//! The workspace search surface: paging, camelCase and read access.

use axum::http::StatusCode;
use serde_json::json;

use super::support::*;

/// E01/M4 over the wire: 快速打开, 项目搜索 and the language-service probe.
/// All three are read surfaces, so a workspace without read access is a
/// 403 rather than an empty answer.
#[tokio::test]
async fn search_surfaces_are_paged_camel_cased_and_gated_on_read_access() {
    let (router, directory) = router_fixture("api-file-search").await;
    let root = directory.path().join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("node_modules")).unwrap();
    std::fs::write(root.join("src/client.ts"), "const needle = 1;\n").unwrap();
    std::fs::write(root.join("README.md"), "needle\n").unwrap();
    std::fs::write(root.join("node_modules/hidden.ts"), "needle\n").unwrap();
    let (_, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({"name":"files", "rootPath":root.to_string_lossy()})),
    )
    .await;
    let id = workspace["id"].as_str().unwrap().to_owned();

    let (status, index) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{id}/file-index?query=client"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(index["entries"][0]["path"], "src/client.ts");
    assert_eq!(index["truncated"], false);

    let (status, page) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/file-search"),
        Some(json!({"query":"needle", "limit":1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["files"].as_array().unwrap().len(), 1);
    assert_eq!(page["files"][0]["path"], "README.md");
    assert_eq!(page["nextOffset"], 1);
    assert_eq!(page["totalMatches"], 1);

    let (_, rest) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/file-search"),
        Some(json!({"query":"needle", "limit":10, "offset":1})),
    )
    .await;
    let paths: Vec<&str> = rest["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, vec!["src/client.ts"]);
    assert!(rest["nextOffset"].is_null());

    let (status, invalid) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/file-search"),
        Some(json!({"query":"(unclosed", "regex":true})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid["code"], "bad_request");

    let (status, probe) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{id}/language-service"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe["status"], "unavailable");

    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{id}"),
        Some(json!({"permissions":{"read":false,"write":false,"execute":false}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for (method, uri, body) in [
        (
            "GET",
            format!("/api/workspaces/{id}/file-index?query=client"),
            None,
        ),
        (
            "POST",
            format!("/api/workspaces/{id}/file-search"),
            Some(json!({"query":"needle"})),
        ),
        (
            "GET",
            format!("/api/workspaces/{id}/language-service"),
            None,
        ),
    ] {
        let (status, _) = call(&router, method, &uri, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri} must require read");
    }
}
