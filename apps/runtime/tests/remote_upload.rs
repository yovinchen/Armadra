#![cfg(unix)]
//! Chunked uploads and whiteboard assets on an execution host (design §3.1 and
//! §3.2, batch 4 acceptance 12).
//!
//! The interesting number is 3 MiB: at 256 KiB a chunk that is twelve round
//! trips, so a test that passes proves the state machine survives a stream and
//! not just a single frame. What it asserts at the end is the digest of the
//! bytes that actually landed on the "remote" disk, which is the only way to
//! tell a completed upload from a plausible-looking receipt.

#[path = "support/remote.rs"]
mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use support::{call, fixture, get, install_launcher, json_request, open_workspace, worker_binary};

#[test]
fn a_remote_workspace_uploads_files_and_assets_to_the_execution_host() {
    let temp = tempfile::tempdir().unwrap();
    install_launcher(temp.path());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(upload_scenario());
    runtime.block_on(asset_scenario());
}

/// A multipart import of one 3 MiB file: the bytes are cut into chunks, the
/// execution host verifies the whole-file digest before publishing, and the
/// file that appears there is byte-for-byte what was sent.
async fn upload_scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    let bytes: Vec<u8> = (0..3 * 1024 * 1024)
        .map(|index| (index % 251) as u8)
        .collect();
    let expected = format!("{:x}", Sha256::digest(&bytes));

    let (status, result) = call(
        app,
        multipart(
            format!("/api/workspaces/{id}/imports"),
            &json!({ "paths": ["big.bin"] }).to_string(),
            &[("0", "big.bin", &bytes)],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let stored = result["files"][0]["path"].as_str().unwrap().to_owned();
    assert_eq!(result["files"][0]["size"], bytes.len(), "{result}");

    let landed = fixture.root.join(&stored);
    assert!(landed.is_file(), "the upload never reached {stored}");
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(&landed).unwrap())),
        expected,
        "the bytes on the execution host are not the bytes that were sent"
    );

    // Nothing temporary survives a completed upload.
    let leftovers: Vec<String> = std::fs::read_dir(landed.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".armadra-upload-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // And the file reads back through the download route, which is the raw
    // chunked reader rather than the editor's text one.
    let (status, downloaded) = support::call_bytes(
        app,
        get(format!("/api/workspaces/{id}/file-download?path={stored}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(format!("{:x}", Sha256::digest(&downloaded)), expected);
}

/// A whiteboard asset, both ways: raw bytes posted by a browser, and a path
/// import that the execution host resolves and copies itself.
async fn asset_scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;
    let id = open_workspace(app, &fixture.root).await;

    // A one-pixel PNG. Small, but it goes through the same content-addressed
    // store as anything else.
    let png: Vec<u8> = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89,
    ];
    let (status, uploaded) = call(
        app,
        Request::builder()
            .method("POST")
            .uri(format!("/api/workspaces/{id}/assets"))
            .header("content-type", "image/png")
            .body(Body::from(png.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    let stored = uploaded["path"].as_str().unwrap().to_owned();
    assert!(stored.starts_with(".armadra/assets/"), "{uploaded}");
    assert_eq!(
        std::fs::read(fixture.root.join(&stored)).unwrap(),
        png,
        "the asset bytes on the execution host differ"
    );

    // Content addressing: the same picture uploaded twice is one file, and the
    // second upload answers with the same id rather than conflicting.
    let (status, again) = call(
        app,
        Request::builder()
            .method("POST")
            .uri(format!("/api/workspaces/{id}/assets"))
            .header("content-type", "image/png")
            .body(Body::from(png.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["id"], uploaded["id"]);

    // Importing by path: the source is on the execution host, and everything —
    // the read, the type check, the dedupe — happens there.
    std::fs::write(fixture.root.join("photo.png"), &png).unwrap();
    let (status, imported) = call(
        app,
        json_request(
            "POST",
            format!("/api/workspaces/{id}/assets/import"),
            json!({ "path": "photo.png" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{imported}");
    assert_eq!(imported["id"], uploaded["id"], "{imported}");
}

/// A multipart body in the shape `imports::read_manifest` expects: the manifest
/// first, then each file named by its index.
fn multipart(uri: String, manifest: &str, files: &[(&str, &str, &Vec<u8>)]) -> Request<Body> {
    const BOUNDARY: &str = "armadra-remote-upload-boundary";
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{manifest}\r\n"
        )
        .as_bytes(),
    );
    for (name, filename, bytes) in files {
        body.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"; \
                 filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(body))
        .unwrap()
}
