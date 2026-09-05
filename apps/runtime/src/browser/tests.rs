//! B01 tests.
//!
//! The CDP half needs a real Chromium-family browser, and there is no bundled
//! one yet (design §5 leaves the managed download to a later round). Those
//! tests therefore **skip loudly** when [`launch::availability`] finds nothing,
//! printing which paths were looked at — a silent pass would be worse than no
//! test. Everything that does not need a browser runs everywhere.
//!
//! No test reaches the public internet: the page under test is served by an
//! axum listener on `127.0.0.1:0`, and the profile is a throwaway directory
//! inside the test's own temporary data directory.

use std::net::SocketAddr;

use axum::{Router, routing::get};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::{
    AppState, db,
    events::{EventHub, WorkspaceEvent},
    hook::HookService,
    model::{
        CanvasNode, ContextLink, DEFAULT_NODE_COLOR, Position, Size, Viewport as CanvasViewport,
    },
    settings::SettingsStore,
    terminal::TerminalManager,
};

use super::{
    ReadMode, SessionState, Viewport, Visibility, admit_url, launch, safe_filename,
    session::{
        self, CreateRequest, InputEvent, InputRequest, NavigateRequest, Target, WaitRequest,
    },
};

/* --------------------------------- fixture --------------------------------- */

struct Fixture {
    state: AppState,
    workspace_id: String,
    /// The browser node.
    node_id: String,
    /// An agent terminal node linked to it.
    agent_id: String,
    directory: TempDir,
}

impl Drop for Fixture {
    /// A test that panics must not leave a browser behind. The ordinary path
    /// is `session::close`; this is the safety net, and it is why the suite
    /// can be run repeatedly without collecting orphan renderers.
    fn drop(&mut self) {
        session::kill_all_now(&self.state);
    }
}

async fn fixture(name: &str) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join(format!("{name}.db")).display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    // Node ids on a board are UUIDs; the browser session row is keyed by one.
    let node_id = uuid::Uuid::now_v7().to_string();
    let agent_id = uuid::Uuid::now_v7().to_string();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[
                canvas_node(
                    &board.id,
                    &node_id,
                    "browser",
                    "预览",
                    0.0,
                    json!({ "kind": "browser", "url": "" }),
                ),
                canvas_node(
                    &board.id,
                    &agent_id,
                    "terminal",
                    "Claude",
                    900.0,
                    json!({ "kind": "terminal", "cwd": ".", "agent": { "id": "claude" } }),
                ),
            ],
            edges: &[],
            viewport: CanvasViewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    db::put_context_links(
        &pool,
        &workspace.id,
        &agent_id,
        &[ContextLink {
            id: node_id.clone(),
            title: "预览".into(),
            kind: "browser".into(),
            content: None,
        }],
    )
    .await
    .unwrap();

    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    let data_dir = directory.path().join(format!("data-{name}"));
    std::fs::create_dir_all(&data_dir).unwrap();
    let state = AppState {
        remote: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: HookService::new(data_dir, None),
        events,
        pool,
    };
    Fixture {
        state,
        workspace_id: workspace.id,
        node_id,
        agent_id,
        directory,
    }
}

fn canvas_node(
    board_id: &str,
    id: &str,
    node_type: &str,
    title: &str,
    x: f64,
    data: Value,
) -> CanvasNode {
    let now = chrono::Utc::now().to_rfc3339();
    CanvasNode {
        id: id.to_owned(),
        board_id: board_id.to_owned(),
        node_type: node_type.to_owned(),
        title: title.to_owned(),
        color: DEFAULT_NODE_COLOR.to_owned(),
        position: Position { x, y: 0.0 },
        size: Some(Size {
            width: 640.0,
            height: 440.0,
        }),
        collapsed: None,
        expanded_height: None,
        parent_id: None,
        labels: Vec::new(),
        note: String::new(),
        data,
        created_at: now.clone(),
        updated_at: now,
    }
}

/* ------------------------------- the local page ---------------------------- */

/// The page every CDP test drives. Deliberately self-contained: no external
/// asset, no font, no network of any kind.
const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>Armadra 受控浏览器</title></head><body style="font:24px sans-serif;margin:32px">
<h1 id="heading">受控浏览器测试页</h1>
<p id="result">Waiting</p>
<label>Name <input id="name"></label>
<button id="submit" onclick="document.getElementById('result').textContent='Hello ' + document.getElementById('name').value">Submit</button>
<a id="next" href="/second">Second page</a>
<div style="height:1500px"></div>
</body></html>"#;

const SECOND: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>第二页</title></head><body><h1 id="heading">第二页</h1></body></html>"#;

struct Page {
    address: SocketAddr,
    handle: tokio::task::JoinHandle<()>,
}

impl Page {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.address.port())
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Serves the fixture on an ephemeral loopback port, never one Armadra itself
/// uses.
async fn serve_page() -> Page {
    let router = Router::new()
        .route("/", get(|| async { axum::response::Html(PAGE) }))
        .route("/second", get(|| async { axum::response::Html(SECOND) }));
    let listener = loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        if ![43120_u16, 43121, 1420, 1421].contains(&port) {
            break listener;
        }
    };
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Page { address, handle }
}

/// `None` plus a printed note when this machine has no browser to drive.
fn browser_or_skip(state: &AppState, test: &str) -> Option<String> {
    let availability = launch::availability(&state.settings);
    if availability.available {
        return Some(availability.executable);
    }
    println!(
        "SKIPPED {test}: no Chromium-family browser on this host. Looked at: {}. \
         Set ARMADRA_BROWSER_PATH or CHROME_PATH to run it.",
        availability.searched.join(", ")
    );
    None
}

/* ------------------------- checks that need no browser --------------------- */

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
    assert_eq!(clamped.width, super::MIN_VIEWPORT);
    assert_eq!(clamped.height, super::MAX_VIEWPORT);
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
    let session = super::BrowserSession {
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
        download: Box::new(super::Download {
            download_id: "d-1".into(),
            session_id: "browser-1".into(),
            url: "http://127.0.0.1:5173/a.pdf".into(),
            suggested_filename: "a.pdf".into(),
            state: super::DownloadState::Pending,
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
    let availability = super::availability(&fixture.state);
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
        super::stored_for_node(&fixture.state.pool, &fixture.node_id)
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
        super::stored(&fixture.state.pool, "browser-nope")
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
    let refusal = super::agent::run(&fixture.state, &caller, "read", &crate::collab::Args(&args))
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
    let refusal = super::agent::run(
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
    let refusal = super::agent::run(
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
    let refusal = super::agent::run(&fixture.state, &caller, "read", &crate::collab::Args(&args))
        .await
        .unwrap_err();
    assert_eq!(refusal.status, axum::http::StatusCode::FORBIDDEN);
    assert!(refusal.message.contains("browser"));
}

/* ------------------------- checks that drive a browser --------------------- */

/// The whole B01 loop against a real Chrome: launch, navigate, read, click,
/// type, capture, screencast, and the epoch rule that protects input.
#[tokio::test]
async fn a_real_browser_session_navigates_reads_clicks_types_and_captures() {
    let fixture = fixture("cdp-loop").await;
    if browser_or_skip(&fixture.state, "a_real_browser_session…").is_none() {
        return;
    }
    let page = serve_page().await;
    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let session = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            url: Some(page.url("/")),
            viewport: Some(Viewport {
                width: 1000,
                height: 700,
                device_scale_factor: 1.0,
            }),
            headful: Some(false),
        },
    )
    .await
    .unwrap();
    assert_eq!(session.state, SessionState::Ready);
    assert_eq!(session.generation, 1);
    let live = session::require_live(&fixture.state, &session.session_id)
        .await
        .unwrap();

    // The profile is ours, private, and inside the test's data directory.
    assert!(live.profile.exists());
    assert!(live.profile.starts_with(fixture.directory.path()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&live.profile)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o700,
            "the profile must not be group readable"
        );
    }

    // --- read ------------------------------------------------------------
    let read = session::read(&live, ReadMode::Text, 40, super::MAX_TEXT_BYTES)
        .await
        .unwrap();
    assert!(
        read.text.contains("受控浏览器测试页"),
        "got {:?}",
        read.text
    );
    assert!(read.text.contains("Waiting"));
    let titled = session::read(&live, ReadMode::Title, 40, 1_024)
        .await
        .unwrap();
    assert_eq!(titled.title, "Armadra 受控浏览器");

    // --- type then click, the way a person would --------------------------
    session::type_text(&live, Target::Selector("#name"), "世界", true, false)
        .await
        .unwrap();
    session::click(&live, Target::Selector("#submit"), 0, 1)
        .await
        .unwrap();
    let read = session::read(&live, ReadMode::Text, 40, super::MAX_TEXT_BYTES)
        .await
        .unwrap();
    assert!(read.text.contains("Hello 世界"), "got {:?}", read.text);

    // --- element references are bound to the navigation epoch -------------
    let elements = session::read(&live, ReadMode::Elements, 40, 1_024)
        .await
        .unwrap();
    let button = elements
        .elements
        .iter()
        .find(|element| element.role == "button")
        .expect("the submit button should be in the element read");
    let stale = format!("e{}-0", elements.navigation_epoch + 7);
    let refusal = session::click(&live, Target::ElementRef(&stale), 0, 1)
        .await
        .unwrap_err();
    assert!(
        format!("{refusal}").contains("STALE_TARGET"),
        "got {refusal}"
    );
    // A fresh one still works.
    session::click(&live, Target::ElementRef(&button.element_ref), 0, 1)
        .await
        .unwrap();

    // --- wait is bounded and says so when it gives up ---------------------
    let outcome = session::wait(
        &live,
        &WaitRequest {
            selector: Some("#heading".into()),
            timeout_ms: Some(2_000),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(outcome.matched);
    let outcome = session::wait(
        &live,
        &WaitRequest {
            selector: Some("#nothing-here".into()),
            timeout_ms: Some(300),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!outcome.matched);
    assert_eq!(outcome.reason_code, "timeout");
    // Exactly one condition, or it is a bad request rather than a guess.
    assert!(session::wait(&live, &WaitRequest::default()).await.is_err());

    // --- navigation bumps the epoch and refuses input aimed at the old page
    let before = live.navigation_epoch();
    session::navigate(
        &live,
        &NavigateRequest {
            action: "goto".into(),
            url: Some(page.url("/second")),
        },
    )
    .await
    .unwrap();
    let after = live.navigation_epoch();
    assert!(after > before, "navigating must bump the epoch");
    let refusal = session::input(
        &live,
        &InputRequest {
            navigation_epoch: before,
            frame_seq: Some(1),
            events: vec![InputEvent {
                kind: "mousePressed".into(),
                x: 10.0,
                y: 10.0,
                button: "left".into(),
                click_count: 1,
                ..Default::default()
            }],
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(refusal, crate::error::AppError::Conflict(_)));
    // The current epoch is accepted.
    assert_eq!(
        session::input(
            &live,
            &InputRequest {
                navigation_epoch: after,
                frame_seq: None,
                events: vec![InputEvent {
                    kind: "wheel".into(),
                    x: 100.0,
                    y: 100.0,
                    delta_y: 120.0,
                    ..Default::default()
                }],
            },
        )
        .await
        .unwrap(),
        1
    );
    // Going back returns to the first page.
    session::navigate(
        &live,
        &NavigateRequest {
            action: "back".into(),
            url: None,
        },
    )
    .await
    .unwrap();
    let read = session::read(&live, ReadMode::Text, 40, super::MAX_TEXT_BYTES)
        .await
        .unwrap();
    assert!(read.text.contains("受控浏览器测试页"));

    // --- capture lands inside the workspace, not on the host at large -----
    let capture = session::capture(&live, &workspace, &Default::default())
        .await
        .unwrap();
    assert!(capture.path.starts_with(".armadra/browser/"));
    assert!(capture.bytes > 0);
    assert_eq!(capture.sha256.len(), 64);
    let absolute = std::path::Path::new(&workspace.root_path).join(&capture.path);
    assert_eq!(std::fs::metadata(&absolute).unwrap().len(), capture.bytes);
    assert_eq!(&std::fs::read(&absolute).unwrap()[1..4], b"PNG");

    session::close(&fixture.state, &session.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// Frames only flow while somebody is subscribed, and the picture stopping
/// does not stop the page (design §9).
#[tokio::test]
async fn frames_flow_only_while_a_subscriber_wants_them() {
    let fixture = fixture("cdp-frames").await;
    if browser_or_skip(&fixture.state, "frames_flow_only_while…").is_none() {
        return;
    }
    let page = serve_page().await;
    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let mut stream = fixture.state.events.subscribe(&fixture.workspace_id);
    let session = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            url: Some(page.url("/")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let live = session::require_live(&fixture.state, &session.session_id)
        .await
        .unwrap();

    let subscription = session::subscribe(
        &live,
        &session::SubscribeRequest {
            subscription_id: None,
            visibility: Visibility::Focused,
        },
    )
    .await
    .unwrap();
    assert!(subscription.max_fps > 0);
    assert!(subscription.quality > 0);

    // Something has to repaint for a frame to exist.
    session::navigate(
        &live,
        &NavigateRequest {
            action: "reload".into(),
            url: None,
        },
    )
    .await
    .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if let Ok(WorkspaceEvent::BrowserFrame { frame }) = stream.recv().await {
                return frame;
            }
        }
    })
    .await
    .expect("a focused subscriber should receive a screencast frame");
    assert_eq!(frame.session_id, session.session_id);
    assert_eq!(frame.encoding, "jpeg");
    assert!(frame.frame_seq >= 1);
    assert!(!frame.data.is_empty());
    // Base64 JPEG: the decoded bytes start with the JPEG SOI marker.
    use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
    let bytes = BASE64.decode(&frame.data).unwrap();
    assert_eq!(&bytes[..2], &[0xff, 0xd8]);

    // Dropping the subscription stops the picture but not the page.
    session::unsubscribe(&live, &subscription.subscription_id).await;
    let read = session::read(&live, ReadMode::Title, 10, 1_024)
        .await
        .unwrap();
    assert_eq!(read.title, "Armadra 受控浏览器");

    session::close(&fixture.state, &session.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// A Runtime restart brings the session back from its own profile at the URL
/// it was on. A second `AppState` with its own data directory is exactly what
/// a restarted process looks like to this module: a fresh live registry over
/// the same database rows and the same profiles on disk.
#[tokio::test]
async fn a_kept_session_comes_back_after_a_runtime_restart() {
    let fixture = fixture("cdp-restore").await;
    if browser_or_skip(&fixture.state, "a_kept_session_comes_back…").is_none() {
        return;
    }
    let page = serve_page().await;
    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let first = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            url: Some(page.url("/second")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(first.keep_alive, "sessions are kept by default (design §9)");
    let profile = session::require_live(&fixture.state, &first.session_id)
        .await
        .unwrap()
        .profile
        .clone();

    // The Runtime goes away: browsers die, rows and profiles do not.
    session::shutdown(&fixture.state).await;
    assert!(profile.exists());

    let restarted = AppState {
        remote: Default::default(),
        hooks: HookService::new(fixture.directory.path().join("data-restarted"), None),
        ..fixture.state.clone()
    };
    assert_eq!(session::restore(&restarted).await.unwrap(), 1);
    let live = super::service(&restarted)
        .live(&first.session_id)
        .expect("the session should be running again");
    let second = live.snapshot();
    assert_eq!(second.session_id, first.session_id);
    assert_eq!(second.url, page.url("/second"));
    assert_eq!(
        second.generation,
        first.generation + 1,
        "a relaunch is a new generation, so a client can tell"
    );
    assert_eq!(second.node_id, fixture.node_id);
    // The same profile, so whatever was logged in still is.
    assert_eq!(live.profile, profile);
    let read = session::read(&live, ReadMode::Text, 10, 4_096)
        .await
        .unwrap();
    assert!(read.text.contains("第二页"), "got {:?}", read.text);

    // Terminating is the only thing that removes the profile.
    session::close(&restarted, &first.session_id, true)
        .await
        .unwrap();
    assert!(!profile.exists());
    assert!(
        super::stored(&restarted.pool, &first.session_id)
            .await
            .unwrap()
            .is_none()
    );
    drop(page);
}

/// The agent surface drives the same session a person would, and `read`
/// answers with the page's own text.
#[tokio::test]
async fn a_linked_agent_reads_and_drives_the_same_session() {
    let fixture = fixture("cdp-agent").await;
    if browser_or_skip(&fixture.state, "a_linked_agent_reads…").is_none() {
        return;
    }
    let page = serve_page().await;
    // The node's data carries the URL, which is what the verb opens.
    let node = crate::collab::load_node(&fixture.state.pool, &fixture.node_id)
        .await
        .unwrap()
        .unwrap();
    let board_id = node.board_id.clone();
    let board = db::load_board(&fixture.state.pool, &fixture.workspace_id, &board_id)
        .await
        .unwrap();
    let mut nodes = board.nodes.clone();
    for node in &mut nodes {
        if node.id == fixture.node_id {
            node.data = json!({ "kind": "browser", "url": page.url("/") });
        }
    }
    db::save_board(
        &fixture.state.pool,
        &fixture.workspace_id,
        &board_id,
        db::SaveBoardRequest {
            expected_updated_at: &board.board.updated_at,
            nodes: &nodes,
            edges: &board.edges,
            viewport: board.board.viewport,
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    let agent = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    let caller = crate::collab::Caller {
        node: agent,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let args = serde_json::Map::new();
    let body = super::agent::run(&fixture.state, &caller, "read", &crate::collab::Args(&args))
        .await
        .unwrap();
    assert!(body.contains("受控浏览器测试页"), "got {body}");
    assert!(body.contains("Armadra 受控浏览器"));

    // The verb opened one session, bound to the node — the same one a person
    // driving that node would be looking at.
    let stored = super::stored_for_node(&fixture.state.pool, &fixture.node_id)
        .await
        .unwrap()
        .expect("the verb should have opened the node's session");
    let live = session::require_live(&fixture.state, &stored.id)
        .await
        .unwrap();

    // Typing and clicking through the agent surface changes that same page.
    let mut typed = serde_json::Map::new();
    typed.insert("selector".into(), json!("#name"));
    typed.insert("text".into(), json!("代理"));
    super::agent::run(
        &fixture.state,
        &caller,
        "type",
        &crate::collab::Args(&typed),
    )
    .await
    .unwrap();
    let mut clicked = serde_json::Map::new();
    clicked.insert("selector".into(), json!("#submit"));
    super::agent::run(
        &fixture.state,
        &caller,
        "click",
        &crate::collab::Args(&clicked),
    )
    .await
    .unwrap();
    let read = session::read(&live, ReadMode::Text, 40, super::MAX_TEXT_BYTES)
        .await
        .unwrap();
    assert!(read.text.contains("Hello 代理"), "got {:?}", read.text);

    // The activity trace records what the agent did to the node.
    let log = std::fs::read_to_string(
        std::path::Path::new(&fixture.directory.path()).join(".armadra/board-log.jsonl"),
    )
    .unwrap();
    assert!(log.contains("browser.read"), "got {log}");
    assert!(log.contains("browser.click"));
    assert!(log.contains(&fixture.node_id));

    session::close(&fixture.state, &stored.id, true)
        .await
        .unwrap();
    drop(page);
}

/// Closing a node stops the picture; the page keeps running (design §9).
#[tokio::test]
async fn closing_a_node_stops_the_picture_and_not_the_page() {
    let fixture = fixture("cdp-detach").await;
    if browser_or_skip(&fixture.state, "closing_a_node_stops…").is_none() {
        return;
    }
    let page = serve_page().await;
    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let session = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            url: Some(page.url("/")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let live = session::require_live(&fixture.state, &session.session_id)
        .await
        .unwrap();
    session::subscribe(
        &live,
        &session::SubscribeRequest {
            subscription_id: None,
            visibility: Visibility::Focused,
        },
    )
    .await
    .unwrap();

    session::close(&fixture.state, &session.session_id, false)
        .await
        .unwrap();
    // Still running, still readable, still stored.
    let live = session::require_live(&fixture.state, &session.session_id)
        .await
        .unwrap();
    assert_eq!(live.snapshot().state, SessionState::Ready);
    let read = session::read(&live, ReadMode::Title, 10, 1_024)
        .await
        .unwrap();
    assert_eq!(read.title, "Armadra 受控浏览器");
    assert!(
        super::stored(&fixture.state.pool, &session.session_id)
            .await
            .unwrap()
            .is_some()
    );

    // Reopening the node reattaches to the same session rather than launching
    // a second browser.
    let again = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(again.session_id, session.session_id);
    assert_eq!(again.generation, session.generation);

    session::close(&fixture.state, &session.session_id, true)
        .await
        .unwrap();
    assert!(
        session::require_live(&fixture.state, &session.session_id)
            .await
            .is_err()
    );
    drop(page);
}
