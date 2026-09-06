//! Tabs a page opens for itself, tabs a caller opens, and the two refusals
//! that keep the set bounded (§2.2).

use super::support::*;

/// `window.open` becomes a tab of the same session — same process, same
/// profile — and is addressable, switchable and closable by name. The last
/// tab is not closable at all: ending a session is `terminate`, not `close`.
#[tokio::test]
async fn a_page_that_opens_a_window_gets_a_tab_that_can_be_driven() {
    let fixture = fixture("tabs").await;
    if browser_or_skip(&fixture.state, "a_page_that_opens_a_window…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (_workspace, live) = open(&fixture, page.url("/popup")).await;

    let opened = session::tab_list(&live);
    assert_eq!(opened.tabs.len(), 1);
    assert_eq!(opened.limit, crate::browser::MAX_TABS as u32);
    let first = opened.active_tab_id.clone();

    // A click is a user gesture, which is what `window.open` needs.
    session::click(
        &live,
        Target::Selector("#open"),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap();
    until(&live, "the popup to attach", async || {
        session::tab_list(&live).tabs.len() == 2
    })
    .await;

    let list = session::tab_list(&live);
    let popup = list
        .tabs
        .iter()
        .find(|tab| tab.tab_id != first)
        .expect("the popup should be a tab of this session");
    assert_eq!(
        popup.opener_tab_id, first,
        "a popup names the tab that opened it"
    );
    assert_eq!(
        list.active_tab_id, first,
        "opening a popup must not move the picture on its own"
    );

    // Reading the popup by address, without switching to it.
    let address = TargetRef {
        tab_id: popup.tab_id.clone(),
        frame_id: String::new(),
    };
    until(&live, "the popup to load", async || {
        session::read_in(&live, &address, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains("第二页"))
            .unwrap_or(false)
    })
    .await;

    // Switching moves the active tab, and with it the session's own record.
    let popup_id = popup.tab_id.clone();
    let switched = session::switch_tab(&live, &popup_id).await.unwrap();
    assert_eq!(switched.active_tab_id, popup_id);
    assert_eq!(live.snapshot().active_tab_id, popup_id);
    assert_eq!(live.snapshot().tab_count, 2);
    assert!(
        live.snapshot().url.contains("/second"),
        "the session follows the active tab: {}",
        live.snapshot().url
    );

    // An unknown tab is refused rather than silently treated as the active
    // one — acting on the wrong page is worse than not acting.
    let refusal = session::switch_tab(&live, "t99").await.unwrap_err();
    assert!(format!("{refusal}").contains("STALE_TARGET"), "{refusal}");

    // Closing takes it back to one tab, and then refuses.
    let closed = session::close_tab(&live, &popup_id).await.unwrap();
    assert_eq!(closed.tabs.len(), 1);
    assert_eq!(closed.active_tab_id, first);
    let refusal = session::close_tab(&live, &first).await.unwrap_err();
    assert!(
        format!("{refusal}").contains("LAST_TAB"),
        "the last tab must not be closable: {refusal}"
    );

    // A caller can open one itself, and the address goes through the same
    // policy every navigation does.
    let list = session::new_tab(&live, &page.url("/second")).await.unwrap();
    assert_eq!(list.tabs.len(), 2);
    assert!(
        session::new_tab(&live, "http://169.254.169.254/")
            .await
            .is_err(),
        "a new tab is not a way around the address policy"
    );

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// With the workspace policy set to `block`, a popup is closed on sight and
/// the reason is written where somebody can read it.
#[tokio::test]
async fn a_blocked_popup_is_closed_and_the_reason_is_recorded() {
    let fixture = fixture("popup-block").await;
    if browser_or_skip(&fixture.state, "a_blocked_popup…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (_workspace, live) = open(&fixture, page.url("/popup")).await;
    live.set_policy(NetworkPolicy {
        popups: crate::browser::PopupPolicy::Block,
        ..NetworkPolicy::default()
    });

    session::click(
        &live,
        Target::Selector("#open"),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap();
    until(&live, "the popup to be refused", async || {
        session::read(&live, ReadMode::Console, 50, 1_024)
            .await
            .map(|read| {
                read.console
                    .iter()
                    .any(|entry| entry.text.starts_with("popup_blocked"))
            })
            .unwrap_or(false)
    })
    .await;
    assert_eq!(
        session::tab_list(&live).tabs.len(),
        1,
        "a blocked popup must not stay open"
    );

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}
