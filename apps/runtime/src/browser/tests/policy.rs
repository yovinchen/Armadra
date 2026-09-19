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
        lease: crate::browser::Lease::default(),
        lease_generation: 0,
        active_tab_id: "t1".into(),
        tab_count: 2,
        pending_dialog: None,
        pending_file_chooser: None,
    };
    let json = serde_json::to_value(WorkspaceEvent::BrowserSession {
        session: Box::new(session),
    })
    .unwrap();
    assert_eq!(json["type"], "browser.session");
    assert_eq!(json["session"]["state"], "ready");
    assert_eq!(json["session"]["navigationEpoch"], 3);
    assert_eq!(json["session"]["canGoBack"], true);

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
            tab_id: "t1".into(),
            sha256: String::new(),
        }),
    })
    .unwrap();
    assert_eq!(json["type"], "browser.download");
    assert_eq!(json["download"]["state"], "pending");
    assert_eq!(json["download"]["reasonCode"], "awaiting_confirmation");
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

/* --------------------------- per-request admission ------------------------- */

/// The decision a paused document request gets. Pure: a URL, whatever the host
/// resolved to, and the workspace's policy — no browser anywhere near it.
#[test]
fn a_document_request_is_judged_on_the_address_it_would_actually_reach() {
    use std::net::IpAddr;

    let policy = NetworkPolicy::default();
    let resolve = |text: &str| -> Vec<IpAddr> { vec![text.parse().unwrap()] };

    // The ordinary case: a name that resolves to a public address.
    assert_eq!(
        admit_document(
            "https://example.test/page",
            &resolve("93.184.216.34"),
            &policy
        ),
        Admission::Admit
    );
    // The same name, resolving to the address that hands out cloud
    // credentials. The URL says nothing about it, which is the point.
    assert_eq!(
        admit_document(
            "https://redirect.test/",
            &resolve("169.254.169.254"),
            &policy
        ),
        Admission::Refuse("link_local_address")
    );
    // And when it is spelled out, it is refused by name before any lookup.
    assert_eq!(
        admit_document("http://169.254.169.254/latest/", &[], &policy),
        Admission::Refuse("metadata_address")
    );
    assert_eq!(
        admit_document("http://metadata.google.internal/", &[], &policy),
        Admission::Refuse("metadata_address")
    );
    // Armadra's own ports are not a browsing target, under any name.
    assert_eq!(
        admit_document("http://127.0.0.1:43120/api", &[], &policy),
        Admission::Refuse("reserved_port")
    );
    assert_eq!(
        admit_document("http://dev.test:43121/", &resolve("127.0.0.1"), &policy),
        Admission::Refuse("reserved_port")
    );
    // A name nobody can resolve is refused rather than admitted on the chance
    // that the browser resolves it to something harmless.
    assert_eq!(
        admit_document("https://nowhere.test/", &[], &policy),
        Admission::Refuse("unresolvable")
    );
    // Not http(s) at all.
    assert_eq!(
        admit_document("file:///etc/passwd", &[], &policy),
        Admission::Refuse("scheme_not_allowed")
    );
    // The project's own dev server on loopback is the whole reason the node
    // exists.
    assert_eq!(
        admit_document("http://127.0.0.1:5173/", &[], &policy),
        Admission::Admit
    );
}

/// The workspace can narrow the default, and the default is deliberately open:
/// looking at a device on the LAN is an ordinary thing to want.
#[test]
fn a_workspace_can_narrow_which_networks_its_browser_may_reach() {
    use std::net::IpAddr;

    let resolve = |text: &str| -> Vec<IpAddr> { vec![text.parse().unwrap()] };
    let open = NetworkPolicy::default();
    assert!(open.allow_private_networks);
    assert_eq!(
        admit_document("http://printer.lan/", &resolve("192.168.1.4"), &open),
        Admission::Admit
    );

    let closed = NetworkPolicy {
        allow_private_networks: false,
        ..NetworkPolicy::default()
    };
    assert_eq!(
        admit_document("http://printer.lan/", &resolve("192.168.1.4"), &closed),
        Admission::Refuse("private_network")
    );
    assert_eq!(
        admit_document("http://internal.test/", &resolve("fd12::1"), &closed),
        Admission::Refuse("private_network")
    );
    // Loopback is not "private network"; it is the dev server.
    assert_eq!(
        admit_document("http://127.0.0.1:5173/", &[], &closed),
        Admission::Admit
    );

    let listed = NetworkPolicy {
        loopback_ports: LoopbackPorts::Listed(vec![5173]),
        ..NetworkPolicy::default()
    };
    assert_eq!(
        admit_document("http://127.0.0.1:5173/", &[], &listed),
        Admission::Admit
    );
    assert_eq!(
        admit_document("http://127.0.0.1:9229/", &[], &listed),
        Admission::Refuse("loopback_port_not_allowed")
    );
    // A listed port still cannot be one of Armadra's own.
    assert_eq!(
        admit_document("http://127.0.0.1:43120/", &[], &listed),
        Admission::Refuse("reserved_port")
    );
}

/// Sub-resources get the cheap check, because one page load is hundreds of
/// them and a DNS lookup each would be its own denial of service.
#[test]
fn a_sub_resource_is_checked_without_a_lookup() {
    assert_eq!(
        admit_subresource("http://169.254.169.254/latest/"),
        Admission::Refuse("metadata_address")
    );
    assert_eq!(
        admit_subresource("http://127.0.0.1:43121/api"),
        Admission::Refuse("reserved_port")
    );
    assert_eq!(
        admit_subresource("https://cdn.example.test/app.js"),
        Admission::Admit
    );
    // A scheme the browser handles by itself is not this policy's business.
    assert_eq!(
        admit_subresource("data:image/png;base64,AAA"),
        Admission::Admit
    );
}

/// The default port matters: `https://host` reaches 443, and a rule about
/// ports has to know that without being told.
#[test]
fn a_target_knows_the_port_a_connection_would_use() {
    assert_eq!(
        parse_target("https://example.test/a?b#c").unwrap(),
        UrlTarget {
            scheme: "https".into(),
            host: "example.test".into(),
            port: None,
        }
    );
    assert_eq!(
        parse_target("https://example.test/")
            .unwrap()
            .effective_port(),
        443
    );
    assert_eq!(
        parse_target("http://example.test/")
            .unwrap()
            .effective_port(),
        80
    );
    assert_eq!(parse_target("http://[::1]:43120/").unwrap().host, "::1");
    assert_eq!(
        parse_target("http://user:pw@example.test/").unwrap().host,
        "example.test"
    );
    assert!(parse_target("file:///etc/passwd").is_none());
    assert!(parse_target("not a url").is_none());
}
