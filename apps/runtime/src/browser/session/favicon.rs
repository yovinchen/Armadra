//! The tab strip's icons (§2.8).
//!
//! The icon is fetched *by the page*, inside the controlled session, and
//! travels with the tab as a `data:` URL. The alternative — publishing the
//! icon's URL and letting each client load it — would send every site a
//! request from every viewer's own browser, with that viewer's cookies, from
//! wherever they happen to be: a phone on the far side of the Host included.
//! The session that is already visiting the site is the one that should be
//! asking it for its icon.

use super::*;

/// How long the page gets to hand back its icon before this gives up. The
/// fetch happens inside the page, so it is a real network request to whatever
/// site the tab is on; a slow one costs a letter in the strip and nothing else.
const FAVICON_TIMEOUT: Duration = Duration::from_secs(5);

/// Asks one tab for its icon, off the event pump.
///
/// Spawned rather than awaited: the pump processes every CDP event for the
/// whole session, and a command that waits on a page's own `fetch` would hold
/// up navigations, frames and the picture behind it. The answer is dropped if
/// the tab navigated again while it was in flight — a stale icon beside a new
/// page is worse than no icon.
pub(super) fn refresh(live: &Live, session: &str) {
    let (tab_id, epoch) = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match targets.tabs.iter().find(|tab| tab.session == session) {
            Some(tab) => (tab.tab_id.clone(), tab.epoch),
            None => return,
        }
    };
    let session = session.to_owned();
    let handle = live.clone_handle();
    tokio::spawn(async move {
        let Some(live) = handle.upgrade() else { return };
        let call = live.call_in(
            &session,
            "Runtime.evaluate",
            json!({
                "expression": dom::FAVICON,
                "returnByValue": true,
                // The helper is a promise: without this the value comes back
                // as the promise object rather than the icon.
                "awaitPromise": true,
                "userGesture": false,
            }),
        );
        let Ok(Ok(result)) = tokio::time::timeout(FAVICON_TIMEOUT, call).await else {
            return;
        };
        let favicon = result
            .get("result")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Only ever a `data:` URL, and only up to what the helper's own
        // ceiling allows plus base64's overhead. Whatever else a page manages
        // to return is not something a client is asked to render.
        if !favicon.starts_with("data:image/") || favicon.len() > 16_384 {
            return;
        }
        let changed = {
            let mut targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match targets.tab_mut(&tab_id) {
                Some(tab) if tab.epoch == epoch && tab.favicon != favicon => {
                    tab.favicon = favicon.to_owned();
                    true
                }
                _ => false,
            }
        };
        if changed {
            live.publish_tabs();
        }
    });
}
