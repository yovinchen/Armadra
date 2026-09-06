//! The frame budget table in design §2.9, and how one screencast is shared.

use crate::browser::{BandwidthClass, Budget, MAX_UNACKED_FRAMES, Visibility};

#[test]
fn a_hidden_subscriber_costs_nothing_on_every_link() {
    for bandwidth in [
        BandwidthClass::Lan,
        BandwidthClass::Wan,
        BandwidthClass::Metered,
    ] {
        assert_eq!(Budget::of(Visibility::Hidden, bandwidth), Budget::NOTHING);
    }
}

#[test]
fn a_worse_link_gets_a_strictly_cheaper_picture() {
    let lan = Budget::of(Visibility::Focused, BandwidthClass::Lan);
    let wan = Budget::of(Visibility::Focused, BandwidthClass::Wan);
    let metered = Budget::of(Visibility::Focused, BandwidthClass::Metered);
    assert!(lan.max_fps > wan.max_fps && wan.max_fps > metered.max_fps);
    assert!(lan.quality > wan.quality && wan.quality > metered.quality);
    // A LAN viewer has no width ceiling; the other two do, and the metered
    // one is the tightest.
    assert_eq!(lan.max_width, 0);
    assert_eq!(wan.max_width, 1_280);
    assert_eq!(metered.max_width, 960);
}

#[test]
fn a_background_node_costs_less_than_the_one_being_used() {
    for bandwidth in [
        BandwidthClass::Lan,
        BandwidthClass::Wan,
        BandwidthClass::Metered,
    ] {
        let focused = Budget::of(Visibility::Focused, bandwidth);
        let visible = Budget::of(Visibility::Visible, bandwidth);
        assert!(focused.quality > visible.quality);
        assert!(focused.max_fps > visible.max_fps);
        assert!(visible.max_fps > 0, "a visible node still gets a picture");
    }
}

#[test]
fn a_client_ceiling_can_only_narrow_the_picture() {
    let lan = Budget::of(Visibility::Focused, BandwidthClass::Lan);
    assert_eq!(lan.with_client_ceiling(800).max_width, 800);
    let wan = Budget::of(Visibility::Focused, BandwidthClass::Wan);
    assert_eq!(
        wan.with_client_ceiling(4_000).max_width,
        1_280,
        "asking for more than the class allows does not widen it"
    );
    assert_eq!(wan.with_client_ceiling(0).max_width, 1_280);
}

#[test]
fn the_one_screencast_runs_at_the_most_demanding_subscribers_budget() {
    let phone = Budget::of(Visibility::Focused, BandwidthClass::Metered);
    let desktop = Budget::of(Visibility::Focused, BandwidthClass::Lan);
    let shared = phone.widen(desktop);
    assert_eq!(shared.quality, desktop.quality);
    assert_eq!(shared.max_fps, desktop.max_fps);
    assert_eq!(shared.every_nth, desktop.every_nth);
    // The desktop has no ceiling, so the shared stream has none — the phone
    // is thinned down by dropping frames, not by shrinking everyone's picture.
    assert_eq!(shared.max_width, 0);
}

#[test]
fn widening_ignores_a_subscriber_that_wants_nothing() {
    let watching = Budget::of(Visibility::Focused, BandwidthClass::Wan);
    assert_eq!(watching.widen(Budget::NOTHING), watching);
    assert_eq!(Budget::NOTHING.widen(watching), watching);
    assert_eq!(Budget::NOTHING.widen(Budget::NOTHING), Budget::NOTHING);
}

#[test]
fn two_ceilinged_subscribers_share_the_wider_of_the_two() {
    let wan = Budget::of(Visibility::Focused, BandwidthClass::Wan);
    let metered = Budget::of(Visibility::Focused, BandwidthClass::Metered);
    assert_eq!(wan.widen(metered).max_width, 1_280);
}

#[test]
fn backpressure_leaves_room_for_a_frame_in_flight() {
    // Two is not zero on purpose: a viewer is always one frame behind while
    // the next one is on the wire, and that is not a reason to skip it.
    const { assert!(MAX_UNACKED_FRAMES >= 2) };
}
