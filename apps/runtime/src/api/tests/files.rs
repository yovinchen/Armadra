//! File routes: import round-trip, versioned saves, write access and the
//! watch subscriptions.

use tempfile::tempdir;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::support::*;
use crate::{AppState, db, events::EventHub};

#[tokio::test]
async fn file_import_roundtrip_preserves_binary_bytes_and_download_boundary() {
    let (router, directory) = router_fixture("file-import").await;
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let id = asset_workspace(&router, root.to_str().unwrap()).await;
    let data = b"%PDF-1.7\n\0binary";
    let mut body = b"--test-boundary\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{\"paths\":[\"report.pdf\"]}\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"0\"; filename=\"ignored.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".to_vec();
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n--test-boundary--\r\n");
    let (status, _, result) = raw(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/imports"),
        "multipart/form-data; boundary=test-boundary",
        body,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&result)
    );
    let result: Value = serde_json::from_slice(&result).unwrap();
    let path = result["files"][0]["path"].as_str().unwrap();
    assert!(path.starts_with(".armadra/imports/"));
    assert_eq!(result["files"][0]["preview"], "download");
    assert_eq!(std::fs::read(root.join(path)).unwrap(), data);
    let (status, headers, downloaded) = raw(
        &router,
        "GET",
        &format!("/api/workspaces/{id}/file-download?path={path}"),
        "application/json",
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(downloaded, data);
    assert!(
        headers["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let outside = directory.path().join("secret.txt");
    std::fs::write(&outside, "secret").unwrap();
    let (status, _) = call(
        &router,
        "GET",
        &format!(
            "/api/workspaces/{id}/file-download?path={}",
            outside.display()
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn file_import_rejects_traversal_incomplete_payloads_and_readonly_workspaces() {
    let (router, directory) = router_fixture("file-import-invalid").await;
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let id = asset_workspace(&router, root.to_str().unwrap()).await;
    for path in ["../escape", "a.txt"] {
        let body = format!("--b\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{{\"paths\":[\"{path}\"]}}\r\n--b--\r\n").into_bytes();
        let (status, _, _) = raw(
            &router,
            "POST",
            &format!("/api/workspaces/{id}/imports"),
            "multipart/form-data; boundary=b",
            body,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        std::fs::read_dir(root.join(".armadra/imports"))
            .unwrap()
            .count(),
        0
    );
    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{id}"),
        Some(json!({"permissions":{"read":true,"write":false,"execute":true,"network":true}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/imports/local"),
        Some(json!({"paths":["file.txt"]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn file_saves_require_content_versions_and_preserve_external_edits() {
    let (router, directory) = router_fixture("api-file-version").await;
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note.txt"), "old").unwrap();
    let (status, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({
            "name":"files", "rootPath":root.to_string_lossy()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let uri = format!("/api/workspaces/{}/file", workspace["id"].as_str().unwrap());
    let (status, read) = call(&router, "GET", &format!("{uri}?path=note.txt"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["sha256"].as_str().unwrap().len(), 64);
    std::fs::write(root.join("note.txt"), "new").unwrap();
    let (status, _) = call(
        &router,
        "PUT",
        &uri,
        Some(json!({
            "path":"note.txt", "content":"mine", "expectedSize":3, "expectedSha256":read["sha256"]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &router,
        "PUT",
        &uri,
        Some(json!({
            "path":"note.txt", "content":"mine", "expectedSize":3
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &router,
        "PUT",
        &uri,
        Some(json!({"path":"note.txt", "content":"mine"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(root.join("note.txt")).unwrap(),
        "new"
    );
    let (_, fresh) = call(&router, "GET", &format!("{uri}?path=note.txt"), None).await;
    let (status, saved) = call(
        &router,
        "PUT",
        &uri,
        Some(json!({
            "path":"note.txt", "content":"mine", "expectedSha256":fresh["sha256"]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, latest) = call(&router, "GET", &format!("{uri}?path=note.txt"), None).await;
    assert_eq!(saved["sha256"], latest["sha256"]);
    assert_eq!(latest["content"], "mine");
}

/// Create / rename / delete over the wire: the write gate, the trash round
/// trip, and that a refused operation leaves the bytes exactly where they
/// were.
#[tokio::test]
async fn file_operations_require_write_access_and_delete_only_to_the_trash() {
    let (router, directory) = router_fixture("api-file-entries").await;
    let root = directory.path().join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/old.txt"), "content").unwrap();
    let (_, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({"name":"files", "rootPath":root.to_string_lossy()})),
    )
    .await;
    let id = workspace["id"].as_str().unwrap().to_owned();
    let entries = format!("/api/workspaces/{id}/file-entries");

    let (status, created) = call(
        &router,
        "POST",
        &entries,
        Some(json!({"path":"src/fresh.txt", "kind":"file"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["path"], "src/fresh.txt");
    assert!(root.join("src/fresh.txt").is_file());

    let (status, _) = call(
        &router,
        "POST",
        &entries,
        Some(json!({"path":"../escape.txt", "kind":"file"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, renamed) = call(
        &router,
        "POST",
        &format!("{entries}/rename"),
        Some(json!({"from":"src/old.txt", "to":"src/new.txt"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["path"], "src/new.txt");
    assert_eq!(
        std::fs::read_to_string(root.join("src/new.txt")).unwrap(),
        "content"
    );

    let (status, trashed) = call(
        &router,
        "POST",
        &format!("{entries}/trash"),
        Some(json!({"path":"src/new.txt"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(trashed["originalPath"], "src/new.txt");
    assert!(!root.join("src/new.txt").exists());

    let (_, listed) = call(&router, "GET", &format!("{entries}/trash"), None).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    let (status, restored) = call(
        &router,
        "POST",
        &format!("{entries}/restore"),
        Some(json!({"id":trashed["id"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored["path"], "src/new.txt");
    assert_eq!(
        std::fs::read_to_string(root.join("src/new.txt")).unwrap(),
        "content"
    );

    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{id}"),
        Some(json!({"permissions":{"read":true,"write":false,"execute":false}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for (uri, body) in [
        (
            entries.clone(),
            json!({"path":"blocked.txt", "kind":"file"}),
        ),
        (
            format!("{entries}/rename"),
            json!({"from":"src/new.txt", "to":"src/blocked.txt"}),
        ),
        (format!("{entries}/trash"), json!({"path":"src/new.txt"})),
    ] {
        let (status, error) = call(&router, "POST", &uri, Some(body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri} must require write");
        assert_eq!(error["code"], "forbidden");
    }
    assert!(root.join("src/new.txt").is_file());
    assert!(!root.join("blocked.txt").exists());
}

/// E01/M4 over the wire: registration, the pushed change, the on-demand
/// fallback, and what revoking read access does to a live watcher.
#[tokio::test]
async fn watched_files_report_external_changes_until_read_access_is_revoked() {
    let directory = tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("api-file-watch.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let events = EventHub::new();
    let (terminals, settings) = test_terminals(&pool, &events, directory.path());
    let router = crate::router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals,
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory.path()),
        events: events.clone(),
        pool,
    });
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note.txt"), "old\n").unwrap();
    let (status, workspace) = call(
        &router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "watch", "rootPath": root.to_string_lossy() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let workspace_id = workspace["id"].as_str().unwrap().to_owned();
    let mut stream = events.subscribe(&workspace_id);

    let watch_uri = format!("/api/workspaces/{workspace_id}/file-watch");
    let (status, registration) = call(
        &router,
        "POST",
        &watch_uri,
        Some(json!({ "path": "note.txt", "nodeId": "node-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(registration["status"], "watching");
    assert_eq!(registration["version"]["exists"], true);
    assert_eq!(
        registration["version"]["sha256"].as_str().unwrap().len(),
        64
    );

    std::fs::write(root.join("note.txt"), "changed outside\n").unwrap();
    let pushed = tokio::time::timeout(std::time::Duration::from_secs(10), stream.recv())
        .await
        .expect("a file.changed event")
        .unwrap();
    let pushed = serde_json::to_value(&pushed).unwrap();
    assert_eq!(pushed["type"], "file.changed");
    assert_eq!(pushed["workspaceId"], workspace_id.as_str());
    assert_eq!(pushed["path"], "note.txt");
    assert_eq!(pushed["kind"], "modified");

    // The on-demand fallback answers the same question without a watcher.
    let (status, version) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{workspace_id}/file-version?path=note.txt"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(version["sha256"], pushed["sha256"]);
    assert_eq!(version["size"], 16);

    // Read access goes away → the watcher goes with it.
    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{workspace_id}"),
        Some(json!({ "permissions": { "read": false, "write": false, "execute": false } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    std::fs::write(root.join("note.txt"), "after revocation\n").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    assert!(
        stream.try_recv().is_err(),
        "a workspace without read access must not push file changes"
    );
    let (status, denied) = call(
        &router,
        "POST",
        &watch_uri,
        Some(json!({ "path": "note.txt", "nodeId": "node-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(denied["code"], "forbidden");
    let (status, _) = call(
        &router,
        "DELETE",
        &format!("{watch_uri}?path=note.txt&nodeId=node-1"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}
