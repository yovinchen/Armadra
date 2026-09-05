//! One real browser session driven end to end.

use super::support::*;

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
    let read = session::read(&live, ReadMode::Text, 40, crate::browser::MAX_TEXT_BYTES)
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
    let read = session::read(&live, ReadMode::Text, 40, crate::browser::MAX_TEXT_BYTES)
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
    let read = session::read(&live, ReadMode::Text, 40, crate::browser::MAX_TEXT_BYTES)
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
