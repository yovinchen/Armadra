//! Subscription lifecycle: sampling runs only while somebody is watching, and
//! the cadence follows the slowest subscriber without trapping a faster one.

use super::*;

/// Sampling only happens while somebody is subscribed, and the sample arrives
/// on the workspace event socket that is already open.
#[tokio::test(flavor = "multi_thread")]
async fn samples_are_pushed_only_while_a_subscription_is_live() {
    let fixture = fixture().await;
    let mut stream = fixture.events().subscribe(&fixture.workspace_id);

    // Nothing subscribed: no sample within a couple of intervals.
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    assert!(
        stream.try_recv().is_err(),
        "a closed panel must not cause sampling"
    );

    let subscription = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    assert_eq!(subscription.interval_ms, 500);

    let sample = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(WorkspaceEvent::ResourceSample { snapshot }) = stream.recv().await {
                return snapshot;
            }
        }
    })
    .await
    .expect("a subscribed panel must receive samples");
    assert_eq!(sample.workspace_id, fixture.workspace_id);
    assert_eq!(sample.interval_ms, 500);

    // Unsubscribing stops it again.
    fixture
        .resources()
        .unsubscribe(&subscription.subscription_id);
    // Drain whatever was already in flight, then confirm the stream goes quiet.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    while stream.try_recv().is_ok() {}
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(
        stream.try_recv().is_err(),
        "sampling must stop when the last subscription goes away"
    );
}

/// Renewing keeps the same id; a lapsed id is replaced rather than refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_subscription_is_renewed_in_place() {
    let fixture = fixture().await;
    let first = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    let renewed = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: Some(first.subscription_id.clone()),
            interval_ms: None,
        },
    );
    assert_eq!(renewed.subscription_id, first.subscription_id);
    assert!(renewed.expires_at >= first.expires_at);

    let replaced = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: Some("long-gone".into()),
            interval_ms: None,
        },
    );
    assert_ne!(replaced.subscription_id, "long-gone");
    fixture.resources().unsubscribe(&first.subscription_id);
    fixture.resources().unsubscribe(&replaced.subscription_id);
}

/// An offscreen node badge asks for a slow cadence and gets it; an open panel
/// asking for the configured one brings everybody back to it (roadmap §4.3).
/// A subscriber can always ask for *less* work and never for more.
#[tokio::test(flavor = "multi_thread")]
async fn a_slow_subscriber_slows_sampling_and_a_fast_one_speeds_it_up_again() {
    let fixture = fixture().await;
    let slow = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(30_000),
        },
    );
    assert_eq!(slow.interval_ms, 30_000, "an offscreen badge asked for 30s");
    assert_eq!(
        slow.effective_interval_ms, 30_000,
        "nobody else is watching, so the loop runs at the slow cadence"
    );

    // The panel opens and asks for the configured interval.
    let panel = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    assert_eq!(panel.interval_ms, 500);
    assert_eq!(
        panel.effective_interval_ms, 500,
        "one fast subscriber sets the cadence for everybody"
    );
    // …and the slow subscriber's own renewal cadence is unchanged: it renews
    // every 30s, it just happens to see faster samples while the panel is up.
    let renewed = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: Some(slow.subscription_id.clone()),
            interval_ms: Some(30_000),
        },
    );
    assert_eq!(renewed.interval_ms, 30_000);
    assert_eq!(renewed.effective_interval_ms, 500);

    // The setting is the budget: asking for 1ms does not buy a faster loop.
    let greedy = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(1),
        },
    );
    assert_eq!(greedy.interval_ms, 500);

    // Nor does asking for an hour park a subscription that never samples.
    let lazy = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(3_600_000),
        },
    );
    assert_eq!(lazy.interval_ms, 60_000);

    for id in [
        slow.subscription_id,
        panel.subscription_id,
        greedy.subscription_id,
        lazy.subscription_id,
    ] {
        fixture.resources().unsubscribe(&id);
    }
}

/// A slow subscriber must not make an opening panel wait out the slow cadence
/// it had already committed to: the loop is woken when somebody asks faster.
#[tokio::test(flavor = "multi_thread")]
async fn an_opening_panel_does_not_wait_out_an_offscreen_badge_s_interval() {
    let fixture = fixture().await;
    let mut stream = fixture.events().subscribe(&fixture.workspace_id);
    let slow = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(30_000),
        },
    );
    // The loop is now asleep for 30 seconds.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(stream.try_recv().is_err());

    let panel = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    let sample = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(WorkspaceEvent::ResourceSample { snapshot }) = stream.recv().await {
                return snapshot;
            }
        }
    })
    .await
    .expect("the panel must not wait 30 seconds for its first pushed sample");
    assert_eq!(sample.interval_ms, 500);

    fixture.resources().unsubscribe(&slow.subscription_id);
    fixture.resources().unsubscribe(&panel.subscription_id);
}
