#![cfg(unix)]
//! Validating an execution host (Go Host 业务所有权迁移 §2.4).
//!
//! "Can I reach that machine" and "is the Armadra Worker there the build I am
//! talking to" are two different questions with two different fixes, and a
//! person told only "failed" cannot tell which one they have. So the answer
//! carries both, and this proves the three outcomes are actually
//! distinguishable rather than three spellings of an error.
//!
//! The machine is the pseudo-SSH harness the other remote tests use: the real
//! launch line, the real `armadra-runtime worker --stdio` binary, the real
//! framed handshake, and no network or credentials anywhere.

#[path = "support/remote.rs"]
mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::{app_without_worker, call, fixture, install_launcher, json_request, worker_binary};

#[test]
fn validating_an_execution_host_separates_reachability_from_the_handshake() {
    let temp = tempfile::tempdir().unwrap();
    install_launcher(temp.path());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(scenario());
}

async fn scenario() {
    let fixture = fixture(worker_binary()).await;
    let app = &fixture.app;

    // An id nothing registered is a 404, not a probe of nothing.
    let (status, _) = call(
        app,
        json_request(
            "POST",
            "/api/execution-hosts/nope/validate".into(),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, hosts) = call(app, support::get("/api/execution-hosts".into())).await;
    assert_eq!(status, StatusCode::OK, "{hosts}");
    // This machine first, always, and never as a registered row.
    assert_eq!(hosts[0]["executionHostId"], "");
    assert_eq!(hosts[0]["kind"], "local");
    assert_eq!(hosts[1]["executionHostId"], support::HOST_ID);
    assert_eq!(hosts[1]["workerConfigured"], true);

    let (status, result) = call(
        app,
        json_request(
            "POST",
            format!("/api/execution-hosts/{}/validate", support::HOST_ID),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["reachable"], true, "{result}");
    assert_eq!(result["workerOk"], true, "{result}");
    // The handshake is what carries these; a reachability probe cannot know
    // any of them.
    assert!(result["runtimeVersion"].is_string(), "{result}");
    assert!(result["platform"].is_string(), "{result}");
    assert!(
        result["capabilities"]
            .as_array()
            .is_some_and(|list| !list.is_empty()),
        "{result}"
    );
    assert!(result.get("reason").is_none(), "{result}");

    // A host that is reachable but has no Worker configured runs terminals and
    // nothing else. That is a different answer from "unreachable", and the
    // settings page has to be able to say which.
    let terminals_only = app_without_worker().await;
    let (status, result) = call(
        &terminals_only,
        json_request(
            "POST",
            format!("/api/execution-hosts/{}/validate", support::HOST_ID),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["reachable"], true, "{result}");
    assert_eq!(result["workerOk"], false, "{result}");
    assert_eq!(result["reason"], "noWorkerConfigured", "{result}");
}
