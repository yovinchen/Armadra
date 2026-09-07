//! The execution host registry: CRUD and the portable package
//! (Go Host 业务所有权迁移 §2.4).
//!
//! Validation needs a machine to reach, so it lives in
//! `tests/execution_hosts.rs` against the pseudo-SSH harness the other remote
//! tests use — the real launch line, the real handshake, no network.

use axum::http::StatusCode;
use serde_json::json;

use super::support::*;

fn host(id: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": "Build box",
        "host": "example.com",
        "user": "ada",
        "worker": { "path": "/opt/armadra/armadra-runtime" },
    })
}

/// The list always begins with this machine, and it is not something anybody
/// registered: it has no id, no SSH block and no row to delete.
#[tokio::test]
async fn this_machine_is_always_listed_and_cannot_be_registered_or_removed() {
    let (router, _directory) = router_fixture("api-execution-hosts-local").await;
    let (status, hosts) = call(&router, "GET", "/api/execution-hosts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hosts.as_array().unwrap().len(), 1);
    assert_eq!(hosts[0]["executionHostId"], "");
    assert_eq!(hosts[0]["kind"], "local");
    assert!(hosts[0].get("ssh").is_none());

    let (status, _) = call(
        &router,
        "PUT",
        "/api/execution-hosts/",
        Some(json!({ "id": "", "name": "x", "host": "example.com" })),
    )
    .await;
    // The empty id is not a path segment at all, so the router never reaches a
    // handler; either way there is no route by which this machine is written.
    assert!(status == StatusCode::NOT_FOUND || status == StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_host_is_created_replaced_and_removed_through_the_settings_document() {
    let (state, _directory) = state_fixture("api-execution-hosts-crud").await;
    let router = crate::router_with_state(state.clone());

    let (status, hosts) = call(
        &router,
        "PUT",
        "/api/execution-hosts/build-box",
        Some(host("build-box")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{hosts}");
    assert_eq!(hosts.as_array().unwrap().len(), 2);
    assert_eq!(hosts[1]["executionHostId"], "build-box");
    assert_eq!(hosts[1]["workerConfigured"], true);
    assert_eq!(hosts[1]["workspaceCount"], 0);
    // One store, not two: the document is what was written.
    assert_eq!(
        state.settings.document()["ssh"]["hosts"][0]["id"],
        "build-box"
    );

    // A replace is a replace: clearing a field has to be expressible.
    let mut renamed = host("build-box");
    renamed["name"] = json!("Renamed");
    renamed.as_object_mut().unwrap().remove("worker");
    let (status, hosts) = call(
        &router,
        "PUT",
        "/api/execution-hosts/build-box",
        Some(renamed),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hosts[1]["name"], "Renamed");
    assert_eq!(hosts[1]["workerConfigured"], false);

    let (status, hosts) = call(&router, "DELETE", "/api/execution-hosts/build-box", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hosts.as_array().unwrap().len(), 1);
    let (status, _) = call(&router, "DELETE", "/api/execution-hosts/build-box", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// The runtime drops entries that fail validation when it reads the document,
/// so a create that fails them has to be refused *here* — otherwise the host
/// disappears on the next read and nobody is told why.
#[tokio::test]
async fn an_entry_the_runtime_would_drop_is_refused_with_the_field_that_is_wrong() {
    let (router, _directory) = router_fixture("api-execution-hosts-invalid").await;
    let mut evil = host("build-box");
    evil["host"] = json!("a;rm -rf /");
    let (status, error) = call(&router, "PUT", "/api/execution-hosts/build-box", Some(evil)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["message"].as_str().unwrap().contains("host"));

    // The path and the body have to agree, or one of them is being ignored.
    let (status, _) = call(
        &router,
        "PUT",
        "/api/execution-hosts/other",
        Some(host("build-box")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// Removing a host whose workspaces still point at it would leave them naming
/// a machine nothing can reach — and their files are on it.
#[tokio::test]
async fn a_host_that_still_has_workspaces_is_not_removed() {
    let (state, _directory) = state_fixture("api-execution-hosts-bound").await;
    let router = crate::router_with_state(state.clone());
    call(
        &router,
        "PUT",
        "/api/execution-hosts/build-box",
        Some(host("build-box")),
    )
    .await;
    crate::db::create_remote_workspace(&state.pool, "Remote", "build-box", "/srv/project", None)
        .await
        .unwrap();

    let (status, hosts) = call(&router, "GET", "/api/execution-hosts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hosts[1]["workspaceCount"], 1);
    let (status, error) = call(&router, "DELETE", "/api/execution-hosts/build-box", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(error["message"].as_str().unwrap().contains("workspace"));
}

/// The package carries where a host is and how the Worker starts there. There
/// is no field a password or key could travel in, which is what makes moving
/// one between two of a person's own machines safe.
#[tokio::test]
async fn the_package_round_trips_and_a_collision_is_refused_unless_overwrite_is_asked_for() {
    let (router, _directory) = router_fixture("api-execution-hosts-package").await;
    call(
        &router,
        "PUT",
        "/api/execution-hosts/build-box",
        Some(host("build-box")),
    )
    .await;
    let (status, package) = call(&router, "GET", "/api/execution-hosts/export", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(package["version"], 1);
    assert_eq!(package["hosts"][0]["id"], "build-box");
    let serialized = serde_json::to_string(&package).unwrap();
    for secret in ["password", "passphrase", "privateKey"] {
        assert!(!serialized.contains(secret), "{secret}");
    }

    // Importing the same package over itself is a collision, not a silent
    // replace: the two entries could differ in a field nobody compared.
    let (status, _) = call(
        &router,
        "POST",
        "/api/execution-hosts/import",
        Some(package.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let mut overwrite = package.clone();
    overwrite["overwrite"] = json!(true);
    overwrite["hosts"][0]["name"] = json!("From package");
    let (status, hosts) = call(
        &router,
        "POST",
        "/api/execution-hosts/import",
        Some(overwrite),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hosts[1]["name"], "From package");

    // A shape this build does not read is refused rather than guessed at.
    let mut future = package.clone();
    future["version"] = json!(99);
    let (status, _) = call(&router, "POST", "/api/execution-hosts/import", Some(future)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// A package with one bad entry writes nothing at all: a half-applied import
/// leaves a registry nobody chose, and the result cannot say which half landed.
#[tokio::test]
async fn an_import_with_one_invalid_entry_writes_none_of_them() {
    let (state, _directory) = state_fixture("api-execution-hosts-atomic").await;
    let router = crate::router_with_state(state.clone());
    let mut evil = host("evil");
    evil["identityFile"] = json!("relative/key");
    let (status, _) = call(
        &router,
        "POST",
        "/api/execution-hosts/import",
        Some(json!({ "version": 1, "hosts": [host("good"), evil] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(state.settings.ssh_hosts().is_empty());
}
