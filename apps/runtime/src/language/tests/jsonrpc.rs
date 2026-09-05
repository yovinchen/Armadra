//! Framing, classification and id namespacing.

use crate::language::{
    MAX_MESSAGE_BYTES,
    jsonrpc::{Decoder, Kind, Message, encode, namespaced, session_of},
};

fn frames(chunks: &[&[u8]]) -> Vec<crate::language::jsonrpc::Frame> {
    let mut decoder = Decoder::default();
    let mut out = Vec::new();
    for chunk in chunks {
        decoder.push(chunk);
        while let Ok(Some(frame)) = decoder.next_frame() {
            out.push(frame);
        }
    }
    out
}

#[test]
fn a_read_boundary_is_not_a_message_boundary() {
    let first = encode(br#"{"jsonrpc":"2.0","id":1,"method":"a"}"#);
    let second = encode(br#"{"jsonrpc":"2.0","method":"b"}"#);
    let stream: Vec<u8> = first.iter().chain(second.iter()).copied().collect();
    // Split at every possible point: a decoder that assumes a read is a frame
    // works for exactly one of these.
    for split in 0..stream.len() {
        let decoded = frames(&[&stream[..split], &stream[split..]]);
        assert_eq!(decoded.len(), 2, "split at {split}");
        assert_eq!(
            Message::parse(&decoded[0].body).unwrap().method,
            "a",
            "split at {split}"
        );
    }
}

#[test]
fn the_shape_of_a_message_decides_what_it_is() {
    let request = Message::parse(br#"{"id":1,"method":"textDocument/hover"}"#).unwrap();
    assert_eq!(request.kind, Kind::Request);
    assert_eq!(request.id_string(), "1");
    let notification = Message::parse(br#"{"method":"initialized"}"#).unwrap();
    assert_eq!(notification.kind, Kind::Notification);
    assert!(notification.id.is_none());
    let response = Message::parse(br#"{"id":"7:abc","result":null}"#).unwrap();
    assert_eq!(response.kind, Kind::Response);
    assert_eq!(response.id_string(), "7:abc");
    // A null id is absent, not an id of null: JSON-RPC uses it for "we could
    // not read the request", which is not something to route back.
    let orphan = Message::parse(br#"{"id":null,"error":{}}"#).unwrap();
    assert!(orphan.id.is_none());
    assert!(Message::parse(b"[1,2]").is_err());
    assert!(Message::parse(b"not json").is_err());
}

#[test]
fn an_oversize_frame_still_carries_its_id() {
    // Past the ceiling but under the hard limit: the body comes back so the
    // waiting session can be told its request failed, instead of waiting
    // forever for an answer that was silently dropped.
    let body = format!(
        r#"{{"id":"3:session","result":"{}"}}"#,
        "x".repeat(MAX_MESSAGE_BYTES as usize + 16)
    );
    let decoded = frames(&[&encode(body.as_bytes())]);
    assert_eq!(decoded.len(), 1);
    assert!(decoded[0].oversize);
    assert_eq!(
        Message::parse(&decoded[0].body).unwrap().id_string(),
        "3:session"
    );
}

#[test]
fn a_frame_past_the_hard_limit_is_skipped_and_the_stream_recovers() {
    let huge = encode(&vec![b'x'; crate::language::jsonrpc::HARD_LIMIT + 1]);
    let good = encode(br#"{"method":"after"}"#);
    let stream: Vec<u8> = huge.iter().chain(good.iter()).copied().collect();
    let mut decoder = Decoder::default();
    decoder.push(&stream);
    assert!(matches!(
        decoder.next_frame(),
        Err(crate::language::jsonrpc::Error::TooLarge(_))
    ));
    let next = decoder.next_frame().unwrap().unwrap();
    assert_eq!(Message::parse(&next.body).unwrap().method, "after");
}

#[test]
fn a_namespaced_id_names_exactly_one_session() {
    let id = namespaced(7, "session-a");
    assert_eq!(id, "7:session-a");
    assert_eq!(session_of(&id), Some("session-a"));
    // Two sessions both counting from 1 do not collide.
    assert_ne!(namespaced(1, "session-a"), namespaced(1, "session-b"));
    // A client id that merely looks like one of ours is not one of ours.
    assert_eq!(session_of("plain"), None);
    assert_eq!(session_of("abc:session"), None);
    assert_eq!(session_of("7:"), None);
}

#[test]
fn a_header_that_never_ends_is_refused_rather_than_buffered() {
    let mut decoder = Decoder::default();
    decoder.push(&vec![b'A'; 9 * 1024]);
    assert!(matches!(
        decoder.next_frame(),
        Err(crate::language::jsonrpc::Error::BadHeader)
    ));
}
