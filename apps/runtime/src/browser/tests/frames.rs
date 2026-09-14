//! Reading and clicking inside iframes, and what happens to a reference when
//! the frame under it navigates (§2.2).

use super::support::*;

/// The whole two-level addressing story against a real Chrome: a same-origin
/// iframe and a cross-*site* one — `localhost` and `127.0.0.1` are different
/// sites, so the second one gets its own renderer and its own CDP target —
/// are both read, both clicked, and both stop resolving once the page moves.
#[tokio::test]
async fn elements_inside_same_origin_and_cross_origin_frames_are_addressable() {
    let fixture = fixture("frames").await;
    if browser_or_skip(&fixture.state, "elements_inside_…_frames…").is_none() {
        return;
    }
    let (outer, inner) = serve_pair().await;
    let (_workspace, live) = open(&fixture, outer.url("/frames")).await;

    // Both frames have to have loaded and reported a context before their
    // elements can be read; the page itself is what says when.
    until(&live, "two frames", async || {
        session::read(&live, ReadMode::Elements, 60, 1_024)
            .await
            .map(|read| {
                read.elements
                    .iter()
                    .filter(|element| element.name.contains("Press"))
                    .count()
                    >= 2
            })
            .unwrap_or(false)
    })
    .await;

    let read = session::read(&live, ReadMode::Elements, 60, 1_024)
        .await
        .unwrap();
    let buttons: Vec<_> = read
        .elements
        .iter()
        .filter(|element| element.name.contains("Press"))
        .collect();
    assert_eq!(
        buttons.len(),
        2,
        "both frames' buttons should be in one read: {:?}",
        read.elements
    );
    for button in &buttons {
        assert!(
            !button.frame_id.is_empty(),
            "a frame's element must say which frame it is in"
        );
        assert!(
            button.element_ref.contains('@'),
            "a frame's reference carries its address: {}",
            button.element_ref
        );
        let (_, address) = button.element_ref.split_once('@').unwrap();
        assert!(
            address.starts_with(&format!("{}/", button.tab_id)),
            "the reference addresses its own tab and frame: {address}"
        );
    }

    // Clicking one of them changes that frame's own document, and only it.
    // The click is repeated until the frame records it: a cross-site frame
    // has its own renderer, and Chrome drops input aimed at it until that
    // renderer has submitted its first compositor frame — which, on a slow
    // headless host, can be after the DOM read above already saw the button.
    let target = buttons[0].element_ref.clone();
    let frame = buttons[0].frame_id.clone();
    let tab = buttons[0].tab_id.clone();
    let address = TargetRef {
        tab_id: tab.clone(),
        frame_id: frame.clone(),
    };
    until(&live, "the frame to record the click", async || {
        session::click(
            &live,
            Target::ElementRef(&target),
            &TargetRef::default(),
            0,
            1,
        )
        .await
        .unwrap();
        session::read_in(&live, &address, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains("clicked"))
            .unwrap_or(false)
    })
    .await;
    // The other frame is untouched: two documents, two states.
    let other = TargetRef {
        tab_id: buttons[1].tab_id.clone(),
        frame_id: buttons[1].frame_id.clone(),
    };
    let untouched = session::read_in(&live, &other, ReadMode::Text, 20, 4_096)
        .await
        .unwrap();
    assert!(
        untouched.text.contains("idle"),
        "clicking one frame must not touch the other: {:?}",
        untouched.text
    );

    // A read of a frame reports that frame's own address, not the page's.
    assert!(
        untouched.url.contains("/inner"),
        "a frame read reports the frame's URL: {}",
        untouched.url
    );

    // --- and the epoch rule holds one level down ------------------------
    session::navigate(
        &live,
        &NavigateRequest {
            action: "goto".into(),
            url: Some(outer.url("/second")),
        },
    )
    .await
    .unwrap();
    let refusal = session::click(
        &live,
        Target::ElementRef(&target),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap_err();
    assert!(
        format!("{refusal}").contains("STALE_TARGET"),
        "a reference into a frame that is gone must be refused: {refusal}"
    );

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop((outer, inner));
}

/// The parser is the half that needs no browser: an address in a reference
/// wins over the one on the request, and anything malformed is `STALE_TARGET`
/// rather than a guess.
#[test]
fn an_element_reference_carries_its_own_address() {
    let (epoch, index, address) = session::parse_ref("e7-12").unwrap();
    assert_eq!((epoch, index), (7, 12));
    assert!(address.is_none(), "a bare reference means the active tab");

    let (epoch, index, address) = session::parse_ref("e3-4@t2/F19").unwrap();
    assert_eq!((epoch, index), (3, 4));
    assert_eq!(
        address,
        Some(TargetRef {
            tab_id: "t2".into(),
            frame_id: "F19".into()
        })
    );

    // The main frame of another tab: an address with an empty frame half.
    let (_, _, address) = session::parse_ref("e1-0@t3/").unwrap();
    assert_eq!(
        address,
        Some(TargetRef {
            tab_id: "t3".into(),
            frame_id: String::new()
        })
    );

    for malformed in ["", "x1-2", "e1", "e1-2@t2", "ea-b", "e1-2@/"] {
        let refused = session::parse_ref(malformed);
        if let Ok((_, _, address)) = &refused {
            assert_eq!(
                malformed, "e1-2@/",
                "`{malformed}` should not have parsed; got {address:?}"
            );
            continue;
        }
        assert!(
            format!("{}", refused.unwrap_err()).contains("STALE_TARGET"),
            "`{malformed}` should be refused as stale"
        );
    }
}
