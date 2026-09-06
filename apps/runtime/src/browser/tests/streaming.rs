//! Frame delivery and what closing a node does to it.

use super::support::*;

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
            bandwidth_class: crate::browser::BandwidthClass::Lan,
            max_width: 0,
            device_id: String::new(),
            accepted_encodings: Vec::new(),
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
            bandwidth_class: crate::browser::BandwidthClass::Lan,
            max_width: 0,
            device_id: String::new(),
            accepted_encodings: Vec::new(),
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
        crate::browser::stored(&fixture.state.pool, &session.session_id)
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
