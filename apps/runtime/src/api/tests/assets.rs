//! The whiteboard asset store: deduplication, import from a path and the
//! read-back boundary.

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::support::*;
use crate::api::*;

/// Tldraw plan §6.2: content-addressed upload, both body shapes, and a
/// crafted id that must not become a path.
#[tokio::test]
async fn assets_are_deduplicated_and_served_back() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let (router, directory) = router_fixture("api-assets").await;
    let root = directory.path().to_string_lossy().into_owned();
    let workspace_id = asset_workspace(&router, &root).await;
    let png = STANDARD.decode(TINY_PNG).unwrap();

    // A `File` is posted raw with its own content type.
    let (status, _, body) = raw(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets"),
        "image/png",
        png.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let uploaded: Value = serde_json::from_slice(&body).unwrap();
    let id = uploaded["id"].as_str().unwrap().to_owned();
    assert!(id.ends_with(".png"));
    assert_eq!(uploaded["path"], format!(".armadra/assets/{id}"));
    assert_eq!(
        uploaded["url"],
        format!("/api/workspaces/{workspace_id}/assets/{id}")
    );
    assert_eq!(uploaded["mimeType"], "image/png");
    assert_eq!(uploaded["bytes"], png.len());
    assert!(directory.path().join(".armadra/assets").join(&id).is_file());

    // The same bytes as a data URL land on the same file: the name is the
    // content hash, so nothing is stored twice.
    let (status, same) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets"),
        Some(json!({ "dataUrl": format!("data:image/png;base64,{TINY_PNG}") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(same["id"], id);
    assert_eq!(
        std::fs::read_dir(directory.path().join(".armadra/assets"))
            .unwrap()
            .count(),
        1
    );

    // …and it reads back with the right type and an immutable cache header.
    let (status, headers, served) = raw(
        &router,
        "GET",
        &format!("/api/workspaces/{workspace_id}/assets/{id}"),
        "",
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/png");
    assert!(
        headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("immutable")
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(served, png);

    // A type outside the whitelist is refused before anything is written.
    let (status, _, _) = raw(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets"),
        "application/x-sh",
        b"#!/bin/sh\nrm -rf /".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The id is matched, never resolved: traversal is a 400, not a read.
    for crafted in [
        "..%2F..%2Fetc%2Fpasswd",
        "..%2F..%2Fpasswd.png",
        "0011223344556677.sh",
        "nothex0011223344.png",
    ] {
        let (status, _, _) = raw(
            &router,
            "GET",
            &format!("/api/workspaces/{workspace_id}/assets/{crafted}"),
            "",
            Vec::new(),
        )
        .await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "{crafted} came back {status}"
        );
    }
    // A well-formed id nothing was uploaded under is a 404.
    let (status, _, _) = raw(
        &router,
        "GET",
        &format!("/api/workspaces/{workspace_id}/assets/00112233445566ff.png"),
        "",
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Tldraw plan §8 Phase 3: importing by path lands in the same
/// content-addressed store as an upload, and refuses everything that is not
/// a readable image file.
#[tokio::test]
async fn assets_are_imported_from_a_path() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let (router, directory) = router_fixture("api-asset-import").await;
    let root = directory.path().to_string_lossy().into_owned();
    let workspace_id = asset_workspace(&router, &root).await;
    let png = STANDARD.decode(TINY_PNG).unwrap();

    // A picture the user dragged in from outside the workspace.
    let outside = tempfile::tempdir().unwrap();
    let source = outside.path().join("shot.PNG");
    std::fs::write(&source, &png).unwrap();

    let (status, imported) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets/import"),
        Some(json!({ "path": source.to_string_lossy() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{imported}");
    let id = imported["id"].as_str().unwrap().to_owned();
    assert!(id.ends_with(".png"), "{id}");
    assert_eq!(imported["path"], format!(".armadra/assets/{id}"));
    assert_eq!(
        imported["url"],
        format!("/api/workspaces/{workspace_id}/assets/{id}")
    );
    assert_eq!(imported["mimeType"], "image/png");
    assert_eq!(imported["bytes"], png.len());
    assert!(directory.path().join(".armadra/assets").join(&id).is_file());

    // The same bytes uploaded the normal way are the same file: import and
    // upload share one content-addressed store.
    let (status, uploaded) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets"),
        Some(json!({ "dataUrl": format!("data:image/png;base64,{TINY_PNG}") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    assert_eq!(uploaded["id"], id);
    assert_eq!(
        std::fs::read_dir(directory.path().join(".armadra/assets"))
            .unwrap()
            .count(),
        1
    );

    // A workspace-relative path works too, and reaches the same file.
    std::fs::write(directory.path().join("inside.png"), &png).unwrap();
    let (status, relative) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets/import"),
        Some(json!({ "path": "inside.png" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relative}");
    assert_eq!(relative["id"], id);

    // A path nobody wrote is a 404.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets/import"),
        Some(json!({ "path": outside.path().join("missing.png").to_string_lossy() })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A directory, a non-image and a relative path climbing out are 400s.
    std::fs::write(directory.path().join("notes.txt"), b"hello").unwrap();
    for bad in [
        outside.path().to_string_lossy().into_owned(),
        "notes.txt".to_owned(),
        "../escape.png".to_owned(),
    ] {
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets/import"),
            Some(json!({ "path": bad })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} came back {body}");
    }

    // A symlink out of the workspace is refused rather than followed.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, directory.path().join("link.png")).unwrap();
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/workspaces/{workspace_id}/assets/import"),
            Some(json!({ "path": "link.png" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // Over the ceiling: refused from the metadata, nothing new on disk.
    let big = outside.path().join("big.png");
    std::fs::write(&big, vec![0_u8; MAX_ASSET_BYTES + 1]).unwrap();
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{workspace_id}/assets/import"),
        Some(json!({ "path": big.to_string_lossy() })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::read_dir(directory.path().join(".armadra/assets"))
            .unwrap()
            .count(),
        1
    );
}
