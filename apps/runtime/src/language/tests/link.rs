//! The link envelope and its credit window (design §2.7).
//!
//! Back pressure is the part worth testing on its own: the end-to-end test
//! proves frames cross a real connection, but it cannot easily prove that a
//! writer *stops* when the peer stops acknowledging — and a window that never
//! blocks is an unbounded buffer with extra bookkeeping.

use armadra_protocol::v1::language_frame;

use crate::language::{
    jsonrpc,
    link::{CREDIT_BYTES, LanguageLink, LocalLink, Window, ack_frame, message_frame},
};

fn frame_epoch(frame: &armadra_protocol::v1::LanguageFrame) -> &str {
    &frame.link_epoch
}

#[tokio::test]
async fn a_full_window_stops_the_writer_until_an_acknowledgement_arrives() {
    let window = std::sync::Arc::new(Window::new(64));
    assert_eq!(window.reserve(64).await, Some(1));
    assert_eq!(window.used(), 64);
    assert_eq!(window.available(), 0);

    // The second frame has nowhere to go. It must wait rather than being
    // dropped or queued without bound.
    let waiting = tokio::spawn({
        let window = std::sync::Arc::clone(&window);
        async move { window.reserve(16).await }
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            // Nothing to await here but the clock: if the reserve had gone
            // through, the window would already be over its limit.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        })
        .await
        .is_ok(),
    );
    assert_eq!(window.used(), 64, "nothing was admitted past the limit");

    window.acknowledge(1);
    let sequence = tokio::time::timeout(std::time::Duration::from_secs(2), waiting)
        .await
        .expect("the waiter is woken by the acknowledgement")
        .expect("the task ran");
    assert_eq!(sequence, Some(2));
    assert_eq!(window.used(), 16);
    assert_eq!(window.available(), 48);
}

#[tokio::test]
async fn an_acknowledgement_releases_every_frame_before_it() {
    let window = Window::new(CREDIT_BYTES);
    for expected in 1..=4 {
        assert_eq!(window.reserve(1_000).await, Some(expected));
    }
    assert_eq!(window.used(), 4_000);
    window.acknowledge(3);
    assert_eq!(window.used(), 1_000, "only the fourth frame is outstanding");
    // An acknowledgement for something already released changes nothing; a
    // peer that repeats itself must not free credit twice.
    window.acknowledge(3);
    assert_eq!(window.used(), 1_000);
}

#[tokio::test]
async fn one_frame_larger_than_the_window_still_travels_when_nothing_else_is_out() {
    // Refusing it would be a deadlock: the message ceiling has already bounded
    // how large a single message can be, and there is nothing to wait for.
    let window = Window::new(16);
    assert_eq!(window.reserve(1_024).await, Some(1));
    assert_eq!(window.available(), 0);
}

#[tokio::test]
async fn a_closed_link_releases_its_waiters_instead_of_parking_them_forever() {
    let window = std::sync::Arc::new(Window::new(8));
    assert_eq!(window.reserve(8).await, Some(1));
    let waiting = tokio::spawn({
        let window = std::sync::Arc::clone(&window);
        async move { window.reserve(8).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    window.close();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(2), waiting)
            .await
            .expect("the waiter is woken by the close")
            .expect("the task ran"),
        None,
        "a closed window admits nothing",
    );
    assert_eq!(window.reserve(1).await, None);
}

#[tokio::test]
async fn every_frame_leaves_stamped_with_the_link_that_sent_it() {
    // The stamp is what makes the epoch check possible at the far end: a frame
    // that arrives without one could not be told apart from a frame belonging
    // to a connection that has already gone away.
    let (mut controller, host) = LocalLink::pair();
    let epoch = controller.epoch().to_owned();
    assert_eq!(host.epoch(), epoch);
    host.send(message_frame(
        "s-1",
        1,
        jsonrpc::Kind::Notification,
        "textDocument/publishDiagnostics",
        "",
        b"{}".to_vec(),
    ))
    .expect("the host writes");
    let received = tokio::time::timeout(std::time::Duration::from_secs(2), controller.recv())
        .await
        .expect("a frame arrives")
        .expect("the link is open");
    assert_eq!(frame_epoch(&received), epoch);

    // And a link whose far end is gone reports that, rather than waiting.
    drop(host);
    assert!(controller.recv().await.is_none());
}

#[test]
fn the_envelope_carries_what_routing_needs_without_opening_the_payload() {
    let frame = message_frame(
        "s-1",
        7,
        jsonrpc::Kind::Response,
        "textDocument/hover",
        "42",
        b"{\"result\":\"\xe4\xb8\xad\xe6\x96\x87\"}".to_vec(),
    );
    let Some(language_frame::Payload::Message(message)) = frame.payload else {
        panic!("a message frame");
    };
    assert_eq!(message.sequence, 7);
    assert_eq!(message.method, "textDocument/hover");
    assert_eq!(message.request_id, "42");
    assert_eq!(
        message.kind,
        armadra_protocol::v1::LanguageMessageKind::Response as i32,
    );

    let ack = ack_frame("s-1", 7, 4_096);
    let Some(language_frame::Payload::Ack(ack)) = ack.payload else {
        panic!("an ack frame");
    };
    assert_eq!(ack.received_through, 7);
    assert_eq!(ack.available_credit_bytes, 4_096);
}
