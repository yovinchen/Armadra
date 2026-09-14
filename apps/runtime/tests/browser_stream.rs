//! The dedicated per-session frame stream, over a real socket (design §2.9).
//!
//! This suite deliberately drives the HTTP and WebSocket surface rather than
//! the session module: the thing under test is the route, the binary Protobuf
//! frame, the acknowledgement and the lease, all of which the Host proxies
//! byte for byte to a phone. A test that called the functions directly would
//! prove none of that.
//!
//! It needs a real Chromium-family browser and **skips loudly** without one:
//! a silent pass here would be worse than no test.

use std::{net::SocketAddr, time::Duration};

use armadra_protocol::{
    Message,
    v1::{
        BrowserBandwidthClass, BrowserInputEvent, BrowserInputKind, BrowserInputRequest,
        BrowserStreamClient, BrowserStreamFrame, BrowserSubscribeRequest, BrowserVisibility,
        browser_stream_client,
    },
};
use armadra_runtime::{
    AppState, browser, db,
    events::EventHub,
    hook::HookService,
    model::{CanvasNode, DEFAULT_NODE_COLOR, Position, Size, Viewport as CanvasViewport},
    router_with_state,
    settings::SettingsStore,
    terminal::TerminalManager,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{
    Message as WsMessage, client::IntoClientRequest, http::header::ORIGIN,
};

/// Ports Armadra itself uses. A test must never take one of them: it would
/// pass here and break somebody's running app.
const RESERVED: [u16; 4] = [43120, 43121, 1420, 1421];

struct Fixture {
    address: SocketAddr,
    workspace_id: String,
    node_id: String,
    state: AppState,
    _directory: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        browser::session::kill_all_now(&self.state);
    }
}

impl Fixture {
    fn http(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.address.port())
    }

    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.address.port())
    }
}

async fn bind() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        if !RESERVED.contains(&listener.local_addr().unwrap().port()) {
            return listener;
        }
    }
}

/// A page that repaints on demand: every click moves a counter, which is what
/// makes "click → new frame" a thing that can be timed.
const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>帧流</title>
<style>body{font:20px sans-serif;margin:0}#box{width:100%;height:100vh;background:#123}</style>
</head><body><div id="box" onclick="
  window.n=(window.n||0)+1;
  this.style.background='hsl('+(window.n*37%360)+',70%,40%)';
  this.textContent=window.n;
"></div></body></html>"#;

async fn serve_page() -> SocketAddr {
    let listener = bind().await;
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new().route(
        "/",
        axum::routing::get(|| async { axum::response::Html(PAGE) }),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    address
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("canvas.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(
        &pool,
        "stream",
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
    let node_id = uuid::Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[CanvasNode {
                id: node_id.clone(),
                board_id: board.id.clone(),
                node_type: "browser".into(),
                title: "预览".into(),
                color: DEFAULT_NODE_COLOR.into(),
                position: Position { x: 0.0, y: 0.0 },
                size: Some(Size {
                    width: 390.0,
                    height: 844.0,
                }),
                collapsed: None,
                expanded_height: None,
                parent_id: None,
                labels: Vec::new(),
                note: String::new(),
                data: json!({ "kind": "browser", "url": "" }),
                created_at: now.clone(),
                updated_at: now,
            }],
            edges: &[],
            viewport: CanvasViewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();

    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    let data_dir = directory.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let state = AppState {
        language: Default::default(),
        remote: Default::default(),
        askpass: Default::default(),
        resources: armadra_runtime::resources::ResourceService::new(settings.clone()),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        usage: armadra_runtime::usage::UsageService::new(settings.clone()),
        settings,
        hooks: HookService::new(data_dir, None),
        events,
        pool,
    };
    let listener = bind().await;
    let address = listener.local_addr().unwrap();
    let router = router_with_state(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Fixture {
        address,
        workspace_id: workspace.id,
        node_id,
        state,
        _directory: directory,
    }
}

/// `None` plus a printed note when this machine has no browser to drive.
fn browser_or_skip(state: &AppState, test: &str) -> Option<()> {
    let availability = browser::availability(state);
    if availability.available {
        return Some(());
    }
    println!(
        "SKIPPED {test}: no Chromium-family browser on this host. Looked at: {}. \
         Set ARMADRA_BROWSER_PATH or CHROME_PATH to run it.",
        availability.searched.join(", ")
    );
    None
}

async fn post(fixture: &Fixture, path: &str, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .post(fixture.http(path))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let value = response.json().await.unwrap_or(Value::Null);
    (status, value)
}

async fn open_stream(
    fixture: &Fixture,
    session_id: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!(
        "ws://127.0.0.1:{}/api/workspaces/{}/browser/sessions/{session_id}/stream",
        fixture.address.port(),
        fixture.workspace_id
    );
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, fixture.origin().parse().unwrap());
    let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
}

fn hello(visibility: BrowserVisibility, bandwidth: BrowserBandwidthClass) -> Vec<u8> {
    hello_accepting(visibility, bandwidth, &[])
}

/// The same, from a subscriber that says what it can decode. An empty list is
/// a client that cannot say, which is JPEG (§2.9).
fn hello_accepting(
    visibility: BrowserVisibility,
    bandwidth: BrowserBandwidthClass,
    encodings: &[&str],
) -> Vec<u8> {
    BrowserStreamClient {
        message: Some(browser_stream_client::Message::Hello(
            BrowserSubscribeRequest {
                visibility: visibility as i32,
                bandwidth_class: bandwidth as i32,
                device_id: "device-under-test".into(),
                accepted_encodings: encodings.iter().map(|value| (*value).to_owned()).collect(),
                ..BrowserSubscribeRequest::default()
            },
        )),
    }
    .encode_to_vec()
}

/// The subscription receipt the stream answers a `hello` or a `visibility`
/// with. It is the only text frame this socket carries.
async fn next_receipt<S>(socket: &mut S) -> Value
where
    S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .expect("the stream answered")
        {
            Some(Ok(WsMessage::Text(text))) => return serde_json::from_str(&text).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("the stream closed before answering: {other:?}"),
        }
    }
}

/// Waits for the next binary frame, up to `budget`.
async fn next_frame<S>(socket: &mut S, budget: Duration) -> Option<BrowserStreamFrame>
where
    S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, socket.next()).await {
            Ok(Some(Ok(WsMessage::Binary(bytes)))) => {
                return BrowserStreamFrame::decode(bytes.as_ref()).ok();
            }
            // A refusal comes back as the same `{ code, message }` an HTTP
            // route would have answered with. It is a test failure here.
            Ok(Some(Ok(WsMessage::Text(text)))) if text.contains("\"code\"") => {
                panic!("the stream refused the input: {text}");
            }
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

/// The 95th percentile of a set of samples, nearest-rank.
fn p95(samples: &mut [u128]) -> u128 {
    samples.sort_unstable();
    let rank = ((samples.len() as f64) * 0.95).ceil().max(1.0) as usize;
    samples[rank.min(samples.len()) - 1]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_sized_viewer_sees_frames_and_its_clicks_produce_new_ones() {
    let fixture = fixture().await;
    if browser_or_skip(&fixture.state, "browser_stream::frames").is_none() {
        return;
    }
    let page = serve_page().await;
    let (status, session) = post(
        &fixture,
        &format!("/api/workspaces/{}/browser/sessions", fixture.workspace_id),
        json!({
            "nodeId": fixture.node_id,
            "url": format!("http://127.0.0.1:{}/", page.port()),
            // A phone in portrait: the same viewport the focus page asks for.
            "viewport": { "width": 390, "height": 844, "deviceScaleFactor": 1 },
        }),
    )
    .await;
    assert_eq!(status, 200, "{session}");
    let session_id = session["sessionId"].as_str().unwrap().to_owned();

    let mut socket = open_stream(&fixture, &session_id).await;
    socket
        .send(WsMessage::Binary(
            hello(BrowserVisibility::Focused, BrowserBandwidthClass::Lan).into(),
        ))
        .await
        .unwrap();

    // The receipt reports the budget the Worker settled on, not the one asked
    // for, so a client shows the degradation rather than assuming it happened.
    let receipt = next_receipt(&mut socket).await;
    assert!(!receipt["subscriptionId"].as_str().unwrap().is_empty());
    let lan_fps = receipt["maxFps"].as_u64().unwrap();
    assert!(lan_fps > 0);
    assert!(receipt["quality"].as_u64().unwrap() > 0);

    let first = next_frame(&mut socket, Duration::from_secs(20))
        .await
        .expect("a subscriber gets a picture without anything moving");
    assert_eq!(first.session_id, session_id);
    assert_eq!(first.encoding, "jpeg");
    assert!(!first.data.is_empty(), "the frame carries real bytes");
    assert!(
        first.data.starts_with(&[0xff, 0xd8]),
        "and they are a JPEG, not base64 of one"
    );
    assert_eq!(first.viewport_width, 390);

    // Click → new frame, twenty times, acknowledging each frame so the
    // per-subscriber backpressure keeps letting frames through.
    let mut samples = Vec::new();
    let mut last_seq = first.frame_seq;
    let mut epoch = first.navigation_epoch;
    for round in 0..20 {
        socket
            .send(WsMessage::Binary(
                BrowserStreamClient {
                    message: Some(browser_stream_client::Message::Ack(last_seq)),
                }
                .encode_to_vec()
                .into(),
            ))
            .await
            .unwrap();
        let click = BrowserStreamClient {
            message: Some(browser_stream_client::Message::Input(BrowserInputRequest {
                session_id: session_id.clone(),
                navigation_epoch: epoch,
                frame_seq: last_seq,
                device_id: "device-under-test".into(),
                events: vec![
                    BrowserInputEvent {
                        kind: BrowserInputKind::MousePressed as i32,
                        x: 195.0,
                        y: 300.0 + f64::from(round),
                        button: "left".into(),
                        click_count: 1,
                        ..BrowserInputEvent::default()
                    },
                    BrowserInputEvent {
                        kind: BrowserInputKind::MouseReleased as i32,
                        x: 195.0,
                        y: 300.0 + f64::from(round),
                        button: "left".into(),
                        click_count: 1,
                        ..BrowserInputEvent::default()
                    },
                ],
                ..BrowserInputRequest::default()
            })),
        };
        let sent = std::time::Instant::now();
        socket
            .send(WsMessage::Binary(click.encode_to_vec().into()))
            .await
            .unwrap();
        let frame = next_frame(&mut socket, Duration::from_secs(10))
            .await
            .expect("a click repaints the page");
        samples.push(sent.elapsed().as_millis());
        assert!(frame.frame_seq > last_seq, "a new frame, not the old one");
        last_seq = frame.frame_seq;
        epoch = frame.navigation_epoch;
    }
    let median = {
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        sorted[sorted.len() / 2]
    };
    println!(
        "browser_stream click→frame over the local path: median {median} ms, \
         p95 {} ms over {} samples (design §8 target: p95 ≤ 350 ms)",
        p95(&mut samples.clone()),
        samples.len()
    );
    // The assertion is loud rather than tight: a wedge has to fail, but the
    // number itself is recorded and judged against the target by a person, on
    // a machine whose load is known.
    assert!(
        p95(&mut samples) < 3_000,
        "click → frame is not merely slow but stalled: {samples:?}"
    );

    // The same socket restating its link as metered gets a smaller budget
    // back, and is told so rather than having to infer it (§2.9).
    socket
        .send(WsMessage::Binary(
            BrowserStreamClient {
                message: Some(browser_stream_client::Message::Visibility(
                    BrowserSubscribeRequest {
                        visibility: BrowserVisibility::Focused as i32,
                        bandwidth_class: BrowserBandwidthClass::Metered as i32,
                        device_id: "device-under-test".into(),
                        ..BrowserSubscribeRequest::default()
                    },
                )),
            }
            .encode_to_vec()
            .into(),
        ))
        .await
        .unwrap();
    let metered = next_receipt(&mut socket).await;
    assert!(
        metered["maxFps"].as_u64().unwrap() < lan_fps,
        "a metered link is served fewer frames: {metered}"
    );
    assert_eq!(
        metered["subscriptionId"], receipt["subscriptionId"],
        "restating the budget does not take a second subscription"
    );

    // Closing the socket is the unsubscribe: nothing else has to be called.
    socket.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (status, receipt) = post(
        &fixture,
        &format!(
            "/api/workspaces/{}/browser/sessions/{session_id}/subscription",
            fixture.workspace_id
        ),
        json!({ "visibility": "hidden" }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        receipt["quality"], 0,
        "a session nobody is watching runs no screencast"
    );
    assert_eq!(receipt["maxFps"], 0);
}

/// A subscriber that says it decodes WebP gets WebP, and one that does not
/// keeps JPEG — from a real browser, because Chrome's own protocol dump lists
/// only jpeg and png for `Page.startScreencast` and the fact that it answers
/// `webp` anyway is exactly the kind of claim that has to be tested rather
/// than read (§2.9).
#[tokio::test(flavor = "multi_thread")]
async fn a_subscriber_that_decodes_webp_is_sent_webp() {
    let fixture = fixture().await;
    if browser_or_skip(&fixture.state, "browser_stream::webp").is_none() {
        return;
    }
    let page = serve_page().await;
    let (status, session) = post(
        &fixture,
        &format!("/api/workspaces/{}/browser/sessions", fixture.workspace_id),
        json!({
            "nodeId": fixture.node_id,
            "url": format!("http://127.0.0.1:{}/", page.port()),
            "viewport": { "width": 800, "height": 600, "deviceScaleFactor": 1 },
        }),
    )
    .await;
    assert_eq!(status, 200, "{session}");
    let session_id = session["sessionId"].as_str().unwrap().to_owned();

    // 1. JPEG first, so the two encodings are measured on the same page.
    let mut plain = open_stream(&fixture, &session_id).await;
    plain
        .send(WsMessage::Binary(
            hello(BrowserVisibility::Focused, BrowserBandwidthClass::Lan).into(),
        ))
        .await
        .unwrap();
    let receipt = next_receipt(&mut plain).await;
    assert_eq!(
        receipt["encoding"], "jpeg",
        "a client that did not say what it decodes gets the old encoding"
    );
    let jpeg = next_frame(&mut plain, Duration::from_secs(20))
        .await
        .expect("a subscriber gets a picture");
    assert_eq!(jpeg.encoding, "jpeg");
    assert!(jpeg.data.starts_with(&[0xff, 0xd8]));
    plain.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 2. The same page to a subscriber that can decode WebP.
    let mut socket = open_stream(&fixture, &session_id).await;
    socket
        .send(WsMessage::Binary(
            hello_accepting(
                BrowserVisibility::Focused,
                BrowserBandwidthClass::Lan,
                &["webp", "jpeg"],
            )
            .into(),
        ))
        .await
        .unwrap();
    let receipt = next_receipt(&mut socket).await;
    let negotiated = receipt["encoding"].as_str().unwrap().to_owned();
    let frame = next_frame(&mut socket, Duration::from_secs(20))
        .await
        .expect("a subscriber gets a picture");
    assert_eq!(frame.encoding, negotiated, "the frame says what it is");
    if negotiated == "jpeg" {
        // A browser that takes its own enum literally. The fallback is the
        // behaviour under test here: the viewer still has a picture.
        println!("browser_stream: this browser refused a WebP screencast; served JPEG");
        assert!(frame.data.starts_with(&[0xff, 0xd8]));
        socket.close(None).await.unwrap();
        return;
    }
    assert_eq!(negotiated, "webp");
    assert!(
        frame.data.starts_with(b"RIFF") && frame.data[8..12] == *b"WEBP",
        "the bytes are a real WebP container, not a relabelled JPEG"
    );
    println!(
        "browser_stream 800x600 first frame: jpeg {} bytes, webp {} bytes",
        jpeg.data.len(),
        frame.data.len()
    );

    // 3. One subscriber that cannot decode WebP takes the whole session back
    //    to JPEG: there is one screencast, and half a picture for one viewer
    //    is worse than a larger one for both.
    let mut old = open_stream(&fixture, &session_id).await;
    old.send(WsMessage::Binary(
        hello(BrowserVisibility::Focused, BrowserBandwidthClass::Lan).into(),
    ))
    .await
    .unwrap();
    let old_receipt = next_receipt(&mut old).await;
    assert_eq!(old_receipt["encoding"], "jpeg");
    // A WebP frame the old screencast had already produced can still be in
    // flight when the restart lands; it is labelled by its bytes, so the
    // viewer can decode it. The one after the restart is what matters.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let downgraded = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = next_frame(&mut socket, remaining)
            .await
            .expect("the webp viewer keeps getting frames, in the other encoding");
        if frame.encoding == "jpeg" {
            break frame;
        }
        assert_eq!(
            frame.encoding, "webp",
            "a frame is one of the two encodings"
        );
    };
    assert!(downgraded.data.starts_with(&[0xff, 0xd8]));

    old.close(None).await.unwrap();
    socket.close(None).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn taking_over_revokes_the_agents_lease() {
    let fixture = fixture().await;
    if browser_or_skip(&fixture.state, "browser_stream::lease").is_none() {
        return;
    }
    let page = serve_page().await;
    let (status, session) = post(
        &fixture,
        &format!("/api/workspaces/{}/browser/sessions", fixture.workspace_id),
        json!({
            "nodeId": fixture.node_id,
            "url": format!("http://127.0.0.1:{}/", page.port()),
        }),
    )
    .await;
    assert_eq!(status, 200, "{session}");
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    let live = browser::session::require_live(&fixture.state, &session_id)
        .await
        .unwrap();
    let lease_path = format!(
        "/api/workspaces/{}/browser/sessions/{session_id}/lease",
        fixture.workspace_id
    );

    // An agent takes the lease the way its verbs do.
    let agent = browser::session::Actor::agent("node-agent", &session_id, "Claude");
    browser::session::lease::acquire(&live, &agent, None)
        .await
        .unwrap();
    let (status, lease) = post(&fixture, &lease_path, json!({ "action": "status" })).await;
    assert_eq!(status, 200);
    assert_eq!(lease["state"], "agent");
    assert_eq!(lease["holder"]["id"], "node-agent");

    // A person presses "take over".
    let (status, lease) = post(
        &fixture,
        &lease_path,
        json!({ "action": "takeover", "deviceId": "phone-1", "displayName": "iPhone" }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(lease["state"], "humanTakeover");
    assert_eq!(lease["holder"]["id"], "phone-1");

    // The agent's next action is refused at once — it does not queue behind a
    // deliberate takeover (§2.6).
    let refusal = browser::session::lease::acquire(&live, &agent, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(refusal.contains("LEASE_REVOKED"), "{refusal}");

    // Handing it back frees it, and the generation only ever goes up.
    let before = lease["generation"].as_u64().unwrap();
    let (status, lease) = post(
        &fixture,
        &lease_path,
        json!({ "action": "release", "deviceId": "phone-1" }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(lease["state"], "free");
    assert!(lease["generation"].as_u64().unwrap() > before);
    browser::session::lease::acquire(&live, &agent, None)
        .await
        .expect("the agent may drive it again once it is handed back");

    // A person typing makes the agent wait, and then refuses rather than
    // queueing without end.
    let person = browser::session::Actor::human("phone-1", "iPhone");
    browser::session::lease::acquire(&live, &person, None)
        .await
        .unwrap();
    let waited = std::time::Instant::now();
    let refusal = browser::session::lease::acquire(&live, &agent, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(refusal.contains("LEASE_HELD_BY_HUMAN"), "{refusal}");
    let waited = waited.elapsed();
    assert!(
        waited >= Duration::from_secs(4) && waited < Duration::from_secs(8),
        "the agent waited {waited:?}, not the five seconds §2.6 allows"
    );
}
