//! `GET …/language-service` and the session routes over HTTP.
//!
//! The probe is deliberately written so it never depends on what this machine
//! has installed: what is asserted is that every language is listed, that
//! "not usable" always carries a reason, and that the execute gate is applied
//! to the answer rather than to whether the answer exists.

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::support::{call, router_fixture};

async fn workspace(router: &axum::Router, root: &std::path::Path) -> String {
    let (status, workspace) = call(
        router,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "语言", "rootPath": root.to_string_lossy() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    workspace["id"].as_str().unwrap().to_owned()
}

fn rows(probe: &Value) -> Vec<&Value> {
    probe["servers"].as_array().unwrap().iter().collect()
}

#[tokio::test]
async fn every_language_is_listed_and_anything_unusable_says_why() {
    let (router, directory) = router_fixture("language-probe").await;
    let id = workspace(&router, directory.path()).await;

    let (status, probe) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{id}/language-service"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // One row per language in the registry — a missing server is listed as
    // missing, because "we looked and it is not there" is what the settings
    // page has to be able to say.
    assert_eq!(
        rows(&probe).len(),
        crate::language::registry::languages().len()
    );
    for row in rows(&probe) {
        assert!(!row["serverId"].as_str().unwrap().is_empty());
        assert!(!row["languageId"].as_str().unwrap().is_empty());
        assert!(!row["fileExtensions"].as_array().unwrap().is_empty());
        if row["state"] == "unsupported" {
            let reason = row["reason"].as_str().unwrap_or_default();
            assert!(
                [
                    "server_not_found",
                    "server_probe_failed",
                    "execution_not_granted",
                    "disabled",
                ]
                .contains(&reason),
                "unexpected reason {reason}"
            );
        }
        // A server that is not running has no pid at all. A pid of 0 would be
        // a process the resource panel could try to claim.
        if row["state"] != "running" {
            assert!(row["pid"].is_null(), "{row}");
        }
    }
}

#[tokio::test]
async fn a_workspace_without_execute_may_still_look_but_starts_nothing() {
    let (router, directory) = router_fixture("language-execute").await;
    let id = workspace(&router, directory.path()).await;
    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{id}"),
        Some(json!({ "permissions": { "read": true, "write": true, "execute": false } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, probe) = call(
        &router,
        "GET",
        &format!("/api/workspaces/{id}/language-service"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // The probe itself is the runtime's own `--version`, not the project's
    // code, so it still runs. What changes is the answer.
    assert_eq!(probe["status"], "unavailable");
    assert_eq!(probe["reason"], "execution_not_granted");
    for row in rows(&probe) {
        assert_eq!(row["state"], "unsupported", "{row}");
        assert!(row["pid"].is_null());
    }

    // And opening a session is refused before anything is spawned.
    let (status, error) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/language/sessions"),
        Some(json!({ "languageId": "python", "clientId": "node-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], "forbidden");
}

#[tokio::test]
async fn a_language_nobody_serves_is_refused_by_name() {
    let (router, directory) = router_fixture("language-unknown").await;
    let id = workspace(&router, directory.path()).await;
    // A workspace is not executable by default; the point of this test is the
    // language name, so the grant is given first.
    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{id}"),
        Some(json!({ "permissions": { "read": true, "write": true, "execute": true } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/language/sessions"),
        Some(json!({ "languageId": "cobol", "clientId": "node-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["message"], "language_unknown");
}

#[tokio::test]
async fn a_session_id_nobody_owns_is_not_a_capability() {
    let (router, directory) = router_fixture("language-session-id").await;
    let id = workspace(&router, directory.path()).await;
    for (method, path) in [
        (
            "DELETE",
            format!("/api/workspaces/{id}/language/sessions/made-up"),
        ),
        (
            "POST",
            format!("/api/workspaces/{id}/language/servers/made-up/stop"),
        ),
    ] {
        let (status, _) = call(&router, method, &path, None).await;
        assert!(
            status == StatusCode::OK || status == StatusCode::NOT_FOUND,
            "{path} answered {status}"
        );
    }
    // Applying an edit through a session that does not exist finds nothing to
    // apply it with, rather than falling back to applying it anyway.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/language/sessions/made-up/edits"),
        Some(json!({ "edit": { "changes": {} }, "expectedSha256": {} })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_read_only_workspace_cannot_apply_a_language_edit() {
    let (router, directory) = router_fixture("language-edit-gate").await;
    let id = workspace(&router, directory.path()).await;
    let (status, _) = call(
        &router,
        "PATCH",
        &format!("/api/workspaces/{id}"),
        Some(json!({ "permissions": { "read": true, "write": false, "execute": true } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = call(
        &router,
        "POST",
        &format!("/api/workspaces/{id}/language/sessions/any/edits"),
        Some(json!({ "edit": { "changes": {} }, "expectedSha256": {} })),
    )
    .await;
    // The write gate is checked before the session is looked up: a read-only
    // workspace is refused whether or not the session exists.
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], "forbidden");
}
