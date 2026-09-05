//! Checks that need no browser: URL admission, filenames, viewports and
//! the capability gates around the browser verb.

use super::support::*;

#[test]
fn only_http_addresses_a_project_can_reach_are_admitted() {
    assert_eq!(
        admit_url("127.0.0.1:5173/app").unwrap(),
        "https://127.0.0.1:5173/app"
    );
    assert_eq!(
        admit_url("http://localhost:5173/").unwrap(),
        "http://localhost:5173/"
    );
    for refused in [
        "file:///etc/passwd",
        "chrome://settings",
        "devtools://devtools/bundled/inspector.html",
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
    ] {
        assert!(admit_url(refused).is_err(), "{refused} should be refused");
    }
    // Cloud instance metadata hands out credentials to whatever asks.
    assert!(admit_url("http://169.254.169.254/latest/meta-data/").is_err());
    assert!(admit_url("http://metadata.google.internal/").is_err());
    // Armadra's own control surfaces are not a browsing target.
    assert!(admit_url("http://127.0.0.1:43120/api/workspaces").is_err());
    assert!(admit_url("http://localhost:43121/").is_err());
    // …but the project's own dev server on loopback is exactly the point.
    assert!(admit_url("http://127.0.0.1:5173/").is_ok());
    assert!(admit_url("http://[::1]:5173/").is_ok());
    assert!(admit_url("http://[::1]:43120/").is_err());
    assert!(admit_url("   ").is_err());
}

#[test]
fn a_page_supplied_filename_becomes_one_safe_segment() {
    assert_eq!(safe_filename("report.pdf"), "report.pdf");
    assert_eq!(safe_filename("../../etc/passwd"), "_.._etc_passwd");
    assert_eq!(safe_filename("a\u{0}b\nc"), "a_b_c");
    assert_eq!(safe_filename("   "), "download");
    assert_eq!(safe_filename(".."), "download");
    assert_eq!(safe_filename("C:\\Windows\\x"), "C__Windows_x");
    assert!(safe_filename(&"名".repeat(400)).chars().count() <= 120);
}

#[test]
fn a_viewport_is_clamped_to_something_a_browser_can_render() {
    let clamped = Viewport {
        width: 10,
        height: 99_999,
        device_scale_factor: f64::NAN,
    }
    .clamped();
    assert_eq!(clamped.width, crate::browser::MIN_VIEWPORT);
    assert_eq!(clamped.height, crate::browser::MAX_VIEWPORT);
    assert_eq!(clamped.device_scale_factor, 1.0);
}

#[test]
fn a_hidden_subscriber_asks_for_no_frames_at_all() {
    assert!(Visibility::Focused > Visibility::Visible);
    assert!(Visibility::Visible > Visibility::Hidden);
    let (_, _, hidden_fps) = Visibility::Hidden.budget();
    assert_eq!(hidden_fps, 0);
    let (focused_quality, _, focused_fps) = Visibility::Focused.budget();
    let (visible_quality, _, visible_fps) = Visibility::Visible.budget();
    // Degradation is real, not cosmetic: a background node costs strictly less.
    assert!(focused_quality > visible_quality);
    assert!(focused_fps > visible_fps);
}

#[test]
fn browser_events_serialize_with_the_shared_discriminants() {
    let session = crate::browser::BrowserSession {
        session_id: "browser-1".into(),
        generation: 2,
        workspace_id: "w-1".into(),
        node_id: "n-1".into(),
        url: "http://127.0.0.1:5173/".into(),
        title: "预览".into(),
        viewport: Viewport::default(),
        state: SessionState::Ready,
        reason_code: String::new(),
        navigation_epoch: 3,
        headful: false,
        keep_alive: true,
        can_go_back: true,
        can_go_forward: false,
        created_at: "2026-09-06T00:00:00+00:00".into(),
        updated_at: "2026-09-06T00:00:01+00:00".into(),
    };
    let json = serde_json::to_value(WorkspaceEvent::BrowserSession {
        session: Box::new(session),
    })
    .unwrap();
    assert_eq!(json["type"], "browser.session");
    assert_eq!(json["session"]["state"], "ready");
    assert_eq!(json["session"]["navigationEpoch"], 3);
    assert_eq!(json["session"]["canGoBack"], true);

    // The frame is flattened: the client reads `sessionId` off the event.
    let json = serde_json::to_value(WorkspaceEvent::BrowserFrame {
        frame: Box::new(crate::events::BrowserFramePayload {
            session_id: "browser-1".into(),
            generation: 2,
            frame_seq: 9,
            navigation_epoch: 3,
            viewport_width: 1000,
            viewport_height: 700,
            device_scale_factor: 1.0,
            encoding: "jpeg",
            data: "AAA=".into(),
            captured_at: "2026-09-06T00:00:01+00:00".into(),
        }),
    })
    .unwrap();
    assert_eq!(json["type"], "browser.frame");
    assert_eq!(json["sessionId"], "browser-1");
    assert_eq!(json["frameSeq"], 9);
    assert_eq!(json["encoding"], "jpeg");
    assert!(json.get("frame").is_none());

    let json = serde_json::to_value(WorkspaceEvent::BrowserDownload {
        download: Box::new(crate::browser::Download {
            download_id: "d-1".into(),
            session_id: "browser-1".into(),
            url: "http://127.0.0.1:5173/a.pdf".into(),
            suggested_filename: "a.pdf".into(),
            state: crate::browser::DownloadState::Pending,
            path: String::new(),
            total_bytes: 0,
            received_bytes: 0,
            created_at: "2026-09-06T00:00:00+00:00".into(),
            reason_code: "awaiting_confirmation".into(),
        }),
    })
    .unwrap();
    assert_eq!(json["type"], "browser.download");
    assert_eq!(json["download"]["state"], "pending");
    assert_eq!(json["download"]["reasonCode"], "awaiting_confirmation");
}

#[tokio::test]
async fn a_host_with_no_browser_reports_unsupported_and_creates_nothing() {
    let fixture = fixture("unsupported").await;
    // A configured path that does not exist is never silently replaced by a
    // detected browser: the user asked for that binary.
    fixture
        .state
        .settings
        .patch(&json!({ "browser": { "executablePath": "/nonexistent/armadra/chrome" } }))
        .unwrap();
    let availability = crate::browser::availability(&fixture.state);
    assert!(!availability.available);
    assert_eq!(availability.reason_code, "chrome_not_found");
    assert_eq!(availability.source, "none");

    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let session = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(session.state, SessionState::Unsupported);
    assert_eq!(session.reason_code, "chrome_not_found");
    assert!(session.session_id.is_empty());
    // Nothing was persisted and no profile was created for a browser we do not
    // have — an unsupported host leaves no residue.
    assert!(
        crate::browser::stored_for_node(&fixture.state.pool, &fixture.node_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_unknown_session_is_not_found_rather_than_a_panic() {
    let fixture = fixture("missing").await;
    assert!(
        session::require_live(&fixture.state, "browser-nope")
            .await
            .is_err()
    );
    assert!(
        crate::browser::stored(&fixture.state.pool, "browser-nope")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn the_browser_verb_refuses_a_node_that_is_not_linked() {
    let fixture = fixture("unlinked").await;
    let node = crate::collab::load_node(&fixture.state.pool, &fixture.node_id)
        .await
        .unwrap()
        .unwrap();
    // The browser node itself has no links, so it may not drive anything.
    let caller = crate::collab::Caller {
        node,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let args = serde_json::Map::new();
    let refusal =
        crate::browser::agent::run(&fixture.state, &caller, "read", &crate::collab::Args(&args))
            .await
            .unwrap_err();
    assert_eq!(refusal.status, axum::http::StatusCode::FORBIDDEN);

    // An unknown verb never reaches the browser.
    let agent = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    let caller = crate::collab::Caller {
        node: agent,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let refusal = crate::browser::agent::run(
        &fixture.state,
        &caller,
        "evaluate",
        &crate::collab::Args(&args),
    )
    .await
    .unwrap_err();
    assert_eq!(refusal.status, axum::http::StatusCode::BAD_REQUEST);
    assert!(refusal.message.contains("navigate"));
}

#[tokio::test]
async fn a_legacy_token_may_not_drive_a_browser() {
    let fixture = fixture("legacy").await;
    let agent = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    let caller = crate::collab::Caller {
        node: agent,
        verdict: crate::hook::auth::Verdict::Legacy,
    };
    let args = serde_json::Map::new();
    let refusal = crate::browser::agent::run(
        &fixture.state,
        &caller,
        "navigate",
        &crate::collab::Args(&args),
    )
    .await
    .unwrap_err();
    assert_eq!(refusal.status, axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_custom_agent_can_have_its_browser_capability_switched_off() {
    let fixture = fixture("capability").await;
    fixture
        .state
        .settings
        .patch(&json!({"agents":{"custom":[{
            "id":"custom:narrow","label":"Narrow","launchCmd":"wrapper",
            "baseAgent":"claude","disabledCapabilities":["browser"]
        }]}}))
        .unwrap();
    let mut node = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    node.agent_id = Some("custom:narrow".into());
    let caller = crate::collab::Caller {
        node,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let args = serde_json::Map::new();
    let refusal =
        crate::browser::agent::run(&fixture.state, &caller, "read", &crate::collab::Args(&args))
            .await
            .unwrap_err();
    assert_eq!(refusal.status, axum::http::StatusCode::FORBIDDEN);
    assert!(refusal.message.contains("browser"));
}
