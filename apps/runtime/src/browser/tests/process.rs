//! The browser process across a Runtime crash, and the URL policy across a
//! redirect. Both need a real browser and both use the local page server; no
//! test here reaches the network.

use super::support::*;

/// A `kill -9` of the Runtime cannot ask the browser to stop, so the browser
/// is still running when the Runtime comes back. Dropping the `Live` without
/// terminating is exactly what that looks like from this module: the row and
/// the process identity survive in the database, the process survives on the
/// machine, and nothing tidied the profile.
///
/// Then the browser itself is killed, which leaves the `SingletonLock` behind
/// — the case that used to make the next launch fail — and the same `restore`
/// has to clear it and start again.
#[tokio::test]
async fn a_killed_runtime_reattaches_and_then_clears_a_stale_profile_lock() {
    let fixture = fixture("cdp-process").await;
    if browser_or_skip(&fixture.state, "a_killed_runtime_reattaches…").is_none() {
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
            url: Some(page.url("/")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let live = session::require_live(&fixture.state, &first.session_id)
        .await
        .unwrap();
    // Something only this page instance knows. A relaunch would load the same
    // URL and lose it; a re-attach keeps the document that already exists.
    session::type_text(&live, Target::Selector("#name"), "存活", false, false)
        .await
        .unwrap();

    let stored = crate::browser::stored(&fixture.state.pool, &first.session_id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        stored.process.is_recorded(),
        "a launched session records the process it can be found by again"
    );
    assert_ne!(stored.process.cdp_port, 0);

    // The Runtime is killed: the registry entry goes, the browser does not.
    let orphan = crate::browser::service(&fixture.state)
        .remove(&first.session_id)
        .expect("the session was live");
    let pid = orphan.pid.load(std::sync::atomic::Ordering::SeqCst);
    drop(orphan);

    let restarted = AppState {
        remote: Default::default(),
        hooks: HookService::new(fixture.directory.path().join("data-restarted"), None),
        ..fixture.state.clone()
    };
    assert_eq!(session::restore(&restarted).await.unwrap(), 1);
    let live = crate::browser::service(&restarted)
        .live(&first.session_id)
        .expect("the session should have come back");
    let record = live.snapshot();
    assert_eq!(record.url, page.url("/"));
    assert_eq!(record.reason_code, "");
    assert_eq!(
        record.generation,
        first.generation + 1,
        "a new connection is a new generation even when the page is the old one"
    );
    let read = session::read(&live, ReadMode::Elements, 40, 8_192)
        .await
        .unwrap();
    assert!(
        read.elements.iter().any(|element| element.value == "存活"),
        "re-attached to the same document, so what was typed is still there: {:?}",
        read.elements
    );

    // Now the browser dies outright, leaving the singleton files behind.
    let orphan = crate::browser::service(&restarted)
        .remove(&first.session_id)
        .expect("the session was live");
    let profile = orphan.profile.clone();
    drop(orphan);
    kill_hard(pid);
    for _ in 0..100 {
        if crate::browser::launch::process::started_at(pid).is_none() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        crate::browser::launch::process::started_at(pid).is_none(),
        "the browser should be gone"
    );

    let again = AppState {
        remote: Default::default(),
        hooks: HookService::new(fixture.directory.path().join("data-again"), None),
        ..fixture.state.clone()
    };
    assert_eq!(
        session::restore(&again).await.unwrap(),
        1,
        "a stale SingletonLock must not stop the relaunch"
    );
    let live = crate::browser::service(&again)
        .live(&first.session_id)
        .expect("the session should be running again");
    assert_eq!(live.snapshot().url, page.url("/"));
    assert_eq!(live.profile, profile, "same profile, so same logins");
    let read = session::read(&live, ReadMode::Elements, 40, 8_192)
        .await
        .unwrap();
    assert!(
        !read.elements.iter().any(|element| element.value == "存活"),
        "this one really is a fresh document"
    );

    session::close(&again, &first.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// The address a caller typed is only the first hop. `Fetch` pauses every
/// document request, so the hop that actually asks for cloud metadata is the
/// one that gets refused — and the page says why.
#[tokio::test]
async fn a_redirect_is_re_checked_at_every_hop() {
    let fixture = fixture("cdp-redirect").await;
    if browser_or_skip(&fixture.state, "a_redirect_is_re_checked…").is_none() {
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

    // An ordinary redirect still works: the check is a check, not a wall.
    session::navigate(
        &live,
        &NavigateRequest {
            action: "goto".into(),
            url: Some(page.url("/allowed")),
        },
    )
    .await
    .unwrap();
    let read = session::read(&live, ReadMode::Text, 10, 4_096)
        .await
        .unwrap();
    assert!(read.text.contains("第二页"), "got {:?}", read.text);

    // Two hops, the last of which asks for the instance metadata address.
    // `Page.navigate` itself succeeds — only the later hop is refused.
    let _ = session::navigate(
        &live,
        &NavigateRequest {
            action: "goto".into(),
            url: Some(page.url("/hops")),
        },
    )
    .await;
    let mut blocked = None;
    for _ in 0..100 {
        let console = session::read(&live, ReadMode::Console, 100, 8_192)
            .await
            .unwrap();
        if let Some(entry) = console
            .console
            .iter()
            .find(|entry| entry.text.starts_with("navigation_blocked"))
        {
            blocked = Some(entry.clone());
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let blocked = blocked.expect("the metadata hop should have been refused");
    assert!(
        blocked.text.contains("metadata_address"),
        "the console says which rule refused it: {:?}",
        blocked.text
    );
    assert!(
        blocked.url.contains("169.254.169.254"),
        "and which hop it was: {:?}",
        blocked.url
    );
    assert!(
        !live.snapshot().url.contains("169.254.169.254"),
        "the browser never arrived there"
    );

    session::close(&fixture.state, &session.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// `kill -9` on the browser's whole process group, which is what an operating
/// system crash or an impatient user does.
#[cfg(unix)]
fn kill_hard(pid: u32) {
    // SAFETY: the pid is a browser this test started into its own group.
    unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
}

#[cfg(not(unix))]
fn kill_hard(pid: u32) {
    crate::browser::launch::kill_group_now(pid);
}
