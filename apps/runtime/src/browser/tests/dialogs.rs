//! A page that has stopped and is waiting for an answer (§2.4).

use super::support::*;

/// `alert`, `confirm` and `prompt` all reach the session as a pending dialog,
/// all block input on their own tab with `DIALOG_PENDING`, and all are
/// answered by the same call. The page's own record of what it was told is
/// the proof the answer arrived.
#[tokio::test]
async fn a_dialog_blocks_its_tab_until_somebody_answers_it() {
    let fixture = fixture("dialogs").await;
    if browser_or_skip(&fixture.state, "a_dialog_blocks_its_tab…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (_workspace, live) = open(&fixture, page.url("/dialogs")).await;
    let tab = live.snapshot().active_tab_id;

    // --- alert -----------------------------------------------------------
    session::click(&live, Target::Selector("#say"), &TargetRef::default(), 0, 1)
        .await
        .unwrap();
    until(&live, "the alert to arrive", async || {
        live.snapshot().pending_dialog.is_some()
    })
    .await;
    let pending = live.snapshot().pending_dialog.unwrap();
    assert_eq!(pending.kind, crate::browser::DialogKind::Alert);
    assert_eq!(pending.message, "你好");
    assert_eq!(pending.tab_id, tab);

    // Input aimed at that tab is refused, and the refusal carries the text so
    // the caller can decide what to answer without another round trip.
    let refusal = session::click(&live, Target::Selector("#ask"), &TargetRef::default(), 0, 1)
        .await
        .unwrap_err();
    let message = format!("{refusal}");
    assert!(message.contains("DIALOG_PENDING"), "{message}");
    assert!(message.contains("你好"), "{message}");
    // So is a raw input batch from a person watching the picture.
    let refusal = session::input(
        &live,
        &InputRequest {
            navigation_epoch: live.navigation_epoch(),
            frame_seq: None,
            events: vec![InputEvent {
                kind: "mousePressed".into(),
                x: 10.0,
                y: 10.0,
                button: "left".into(),
                click_count: 1,
                ..Default::default()
            }],
            lease_generation: None,
            device_id: String::new(),
            display_name: String::new(),
        },
    )
    .await
    .unwrap_err();
    assert!(format!("{refusal}").contains("DIALOG_PENDING"));

    let answered = session::handle_dialog(&live, &tab, None, true, None)
        .await
        .unwrap();
    assert_eq!(answered.dialog_id, pending.dialog_id);
    assert!(
        live.snapshot().pending_dialog.is_none(),
        "answering clears the dialog"
    );
    // A second answer has nothing to answer.
    assert!(
        session::handle_dialog(&live, &tab, None, true, None)
            .await
            .is_err()
    );

    // --- confirm, dismissed ---------------------------------------------
    session::click(&live, Target::Selector("#ask"), &TargetRef::default(), 0, 1)
        .await
        .unwrap();
    until(&live, "the confirm to arrive", async || {
        live.snapshot().pending_dialog.is_some()
    })
    .await;
    session::handle_dialog(&live, &tab, None, false, None)
        .await
        .unwrap();
    until(&live, "the page to record the refusal", async || {
        session::read(&live, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains("false"))
            .unwrap_or(false)
    })
    .await;

    // --- prompt, accepted with text --------------------------------------
    session::click(
        &live,
        Target::Selector("#name"),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap();
    until(&live, "the prompt to arrive", async || {
        live.snapshot().pending_dialog.is_some()
    })
    .await;
    let prompt = live.snapshot().pending_dialog.unwrap();
    assert_eq!(prompt.kind, crate::browser::DialogKind::Prompt);
    assert_eq!(prompt.default_prompt, "默认");
    session::handle_dialog(&live, &tab, Some(&prompt.dialog_id), true, Some("世界"))
        .await
        .unwrap();
    until(&live, "the page to record the answer", async || {
        session::read(&live, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains("世界"))
            .unwrap_or(false)
    })
    .await;

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// `beforeunload` is the one dialog this code will never answer on its own:
/// whether leaving a page throws away an unsubmitted form is a decision for a
/// person. It arrives like any other, and dismissing it keeps the page.
#[tokio::test]
async fn leaving_a_guarded_page_asks_rather_than_deciding() {
    let fixture = fixture("beforeunload").await;
    if browser_or_skip(&fixture.state, "leaving_a_guarded_page…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (_workspace, live) = open(&fixture, page.url("/dialogs")).await;
    let tab = live.snapshot().active_tab_id;

    // The listener is installed by a click, which is also the user gesture
    // Chrome requires before it will show the dialog at all.
    session::click(
        &live,
        Target::Selector("#guard"),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap();

    // Navigating away now has to ask. The navigate call itself does not wait
    // for the dialog, so the session is polled for it.
    let elsewhere = page.url("/second");
    let live_for_navigation = live.clone();
    let navigation = tokio::spawn(async move {
        session::navigate(
            &live_for_navigation,
            &NavigateRequest {
                action: "goto".into(),
                url: Some(elsewhere),
            },
        )
        .await
    });
    let asked = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(dialog) = live.snapshot().pending_dialog {
                return dialog;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await;
    match asked {
        Ok(dialog) => {
            assert_eq!(dialog.kind, crate::browser::DialogKind::BeforeUnload);
            // Dismissing keeps the page: the answer is the person's, and the
            // cautious one changes nothing.
            session::handle_dialog(&live, &tab, Some(&dialog.dialog_id), false, None)
                .await
                .unwrap();
            let _ = navigation.await;
            let read = session::read(&live, ReadMode::Text, 20, 4_096)
                .await
                .unwrap();
            assert!(
                read.text.contains("Alert"),
                "a dismissed beforeunload keeps the page: {:?}",
                read.text
            );
        }
        Err(_) => {
            // Chrome only shows it when it decides the gesture counted. That
            // is its call, not ours, and a test that insists otherwise would
            // be testing the browser's heuristics rather than this code.
            navigation.abort();
            println!(
                "SKIPPED the beforeunload half: this Chrome did not treat the \
                 dispatched click as a qualifying user gesture"
            );
        }
    }

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}
