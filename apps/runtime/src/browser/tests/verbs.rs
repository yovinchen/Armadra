//! The verbs added in this round, and the table both ends check (§2.7).

use super::support::*;

/// `select`, `press` and `scroll` against a real page, plus the two refusals
/// that keep them honest: a non-`<select>` target and a key that is not on the
/// whitelist.
#[tokio::test]
async fn select_press_and_scroll_do_what_the_page_can_observe() {
    let fixture = fixture("verbs").await;
    if browser_or_skip(&fixture.state, "select_press_and_scroll…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (_workspace, live) = open(&fixture, page.url("/form")).await;

    // --- select ----------------------------------------------------------
    session::select(
        &live,
        &SelectRequest {
            selector: Some("#pick".into()),
            values: vec!["b".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    until(&live, "the page to see the choice", async || {
        session::read(&live, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains('b'))
            .unwrap_or(false)
    })
    .await;
    // By label as well as by value, because that is what a person reads.
    session::select(
        &live,
        &SelectRequest {
            selector: Some("#pick".into()),
            labels: vec!["Gamma".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    until(&live, "the label to have been matched", async || {
        session::read(&live, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains('c'))
            .unwrap_or(false)
    })
    .await;

    let refusal = session::select(
        &live,
        &SelectRequest {
            selector: Some("#file".into()),
            values: vec!["b".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        format!("{refusal}").contains("NOT_SELECTABLE"),
        "a file input is not a `<select>`: {refusal}"
    );
    let refusal = session::select(
        &live,
        &SelectRequest {
            selector: Some("#pick".into()),
            values: vec!["nope".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(refusal, crate::error::AppError::NotFound(_)),
        "a value no option carries is not silently ignored: {refusal}"
    );
    assert!(
        session::select(
            &live,
            &SelectRequest {
                selector: Some("#pick".into()),
                ..Default::default()
            },
        )
        .await
        .is_err(),
        "selecting nothing is a bad request, not a no-op"
    );

    // --- press -----------------------------------------------------------
    session::type_text(
        &live,
        Target::Selector("#pick"),
        &TargetRef::default(),
        "",
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        session::press(
            &live,
            &PressRequest {
                key: "ArrowDown".into(),
                repeat: 2,
                ..Default::default()
            },
        )
        .await
        .unwrap(),
        2
    );
    let refusal = session::press(
        &live,
        &PressRequest {
            key: "Meta+Q".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(refusal, crate::error::AppError::BadRequest(_)),
        "the key list is a whitelist, not a suggestion: {refusal}"
    );

    // --- scroll ----------------------------------------------------------
    let before = scroll_offset(&live).await;
    assert_eq!(
        session::scroll(
            &live,
            &ScrollRequest {
                direction: Some("down".into()),
                amount: Some(600.0),
                ..Default::default()
            },
        )
        .await
        .unwrap(),
        "down"
    );
    until(&live, "the page to have scrolled", async || {
        scroll_offset(&live).await > before
    })
    .await;
    assert_eq!(
        session::scroll(
            &live,
            &ScrollRequest {
                selector: Some("#pick".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap(),
        "into-view"
    );
    assert!(
        session::scroll(
            &live,
            &ScrollRequest {
                direction: Some("sideways".into()),
                ..Default::default()
            },
        )
        .await
        .is_err(),
        "an unknown direction is refused rather than guessed at"
    );

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}

async fn scroll_offset(live: &session::Live) -> f64 {
    session::read(live, ReadMode::Elements, 5, 1_024)
        .await
        .map(|read| {
            -read
                .elements
                .first()
                .map(|element| element.y)
                .unwrap_or(0.0)
        })
        .unwrap_or(0.0)
}

/// Both ends of the verb list are the same list. The hook checks it locally so
/// a typo costs an error line instead of a round trip, which is only true
/// while the two agree.
#[test]
fn the_hook_and_the_runtime_know_the_same_verbs() {
    let mut runtime = crate::browser::agent::VERBS.to_vec();
    let mut hook = armadra_hook::control::BROWSER_VERBS.to_vec();
    runtime.sort_unstable();
    hook.sort_unstable();
    assert_eq!(runtime, hook);
    assert_eq!(runtime.len(), 16);
    // `lease` is not here on purpose: the control lease arrives with the
    // badges and the frame stream, and a verb for a lease that does not exist
    // yet would be a promise this round does not keep.
    assert!(!runtime.contains(&"lease"));
    for verb in &runtime {
        assert!(
            armadra_hook::USAGE.contains(*verb),
            "`{verb}` is not in the hook's help text"
        );
    }
}
