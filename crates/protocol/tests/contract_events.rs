//! The Host -> client event stream, decoded from the shared fixtures the Go
//! runtime produced (host business migration §2.3).
//!
//! The Worker does not serve this stream, but it does relay and archive its
//! frames, so the same three statements have to survive here: a deletion is a
//! tombstone rather than an empty entity, a cursor the Host cannot serve is a
//! named status rather than an empty page, and the frame oneof keeps a
//! subscription, a page, a heartbeat, an ack and an error apart.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check<M: Message + Default + PartialEq + std::fmt::Debug>(name: &str, expected: M) {
    let wire = fixture(name);
    assert_eq!(M::decode(wire.as_slice()).unwrap(), expected);
    assert_eq!(
        expected.encode_to_vec(),
        wire,
        "{name} differs across runtimes"
    );
}

#[test]
fn envelopes_carry_identity_ordering_and_entity() {
    check(
        "events_envelope_node",
        EventEnvelope {
            sequence: 9_007_199_254_740_993,
            transaction_id: u64::MAX,
            operation_id: "canvas/工作区-1/画布-1/7".into(),
            transaction_index: 2,
            transaction_size: 3,
            workspace_id: "工作区-1".into(),
            domain: EventDomain::Canvas as i32,
            kind: "node".into(),
            entity_id: "节点-1".into(),
            priority: EventPriority::Normal as i32,
            revision: u64::MAX,
            deleted: false,
            entity: Some(event_envelope::Entity::CanvasNode(CanvasNode {
                node_id: "节点-1".into(),
                canvas_id: "画布-1".into(),
                r#type: "terminal".into(),
                title: "终端📟".into(),
                position: Some(CanvasPoint { x: -1.5, y: 2.25 }),
                data_json: br#"{"backend":"tmux"}"#.to_vec(),
                revision: 7,
                ..Default::default()
            })),
        },
    );
}

/// A deletion states an id and a revision and nothing else. Decoding it into an
/// entity with default fields would read like a cleared node instead of a
/// removed one, so the `entity` oneof must stay absent.
#[test]
fn a_deletion_is_a_tombstone_not_an_empty_entity() {
    let wire = fixture("events_envelope_deleted");
    let decoded = EventEnvelope::decode(wire.as_slice()).unwrap();
    assert!(decoded.deleted);
    assert!(decoded.entity.is_none());
    assert_eq!(decoded.entity_id, "画布-1");
    assert_eq!(decoded.revision, 4);
    assert_eq!(decoded.encode_to_vec(), wire);
}

/// Prost maps an unrecognised enum value onto the raw integer rather than onto
/// the zero variant, which is what lets a relay pass a domain it was built
/// before without renaming it to "unspecified".
#[test]
fn an_unknown_domain_survives_a_relay() {
    let decoded = EventEnvelope::decode(fixture("events_envelope_future_domain").as_slice()).unwrap();
    assert_eq!(decoded.domain, 99);
    assert!(EventDomain::try_from(decoded.domain).is_err());
    assert_eq!(decoded.priority, EventPriority::High as i32);
}

#[test]
fn subscription_states_cursor_scope_and_budget() {
    check(
        "events_subscribe",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Subscribe(
                SubscribeEventsRequest {
                    after_sequence: 9_007_199_254_740_993,
                    workspace_ids: vec!["工作区-1".into(), "workspace-2".into()],
                    domains: vec![EventDomain::Canvas as i32, EventDomain::Agent as i32],
                    page_bytes: 262_144,
                    min_priority: EventPriority::High as i32,
                },
            )),
        },
    );
}

/// The two refusals are separate statuses, and both carry the floor and the
/// watermark: those are exactly the numbers a client needs to decide between
/// re-seeding from a snapshot and refusing to rewind.
#[test]
fn a_cursor_that_cannot_be_served_is_named() {
    check(
        "events_page_snapshot_required",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Page(EventPage {
                status: EventCursorStatus::SnapshotRequired as i32,
                min_cursor: 40,
                high_watermark: 120,
                ..Default::default()
            })),
        },
    );
    check(
        "events_page_cursor_ahead",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Page(EventPage {
                status: EventCursorStatus::CursorAhead as i32,
                min_cursor: 1,
                high_watermark: 3,
                ..Default::default()
            })),
        },
    );
    // The zero value must not be readable as OK: applying such a page would
    // advance a cursor past events that were never delivered.
    assert_ne!(
        EventCursorStatus::Unspecified as i32,
        EventCursorStatus::Ok as i32
    );
    assert_eq!(EventPage::default().status, 0);
}

#[test]
fn frames_keep_page_heartbeat_ack_and_error_apart() {
    check(
        "events_page_ok",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Page(EventPage {
                status: EventCursorStatus::Ok as i32,
                events: vec![EventEnvelope {
                    sequence: 6,
                    transaction_id: 4,
                    transaction_size: 1,
                    workspace_id: "工作区-1".into(),
                    domain: EventDomain::Canvas as i32,
                    kind: "edge".into(),
                    entity_id: "连线-1".into(),
                    revision: 1,
                    ..Default::default()
                }],
                next_cursor: 6,
                min_cursor: 2,
                high_watermark: 9,
                has_more: true,
            })),
        },
    );
    check(
        "events_heartbeat",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Heartbeat(EventHeartbeat {
                high_watermark: 9_007_199_254_740_993,
                sent_at_unix_ms: 1_788_557_900_000,
            })),
        },
    );
    check(
        "events_ack",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Ack(StreamAck {
                received_through: u64::MAX,
                available_credit_bytes: 4_194_304,
            })),
        },
    );
    check(
        "events_error",
        EventStreamFrame {
            payload: Some(event_stream_frame::Payload::Error(ErrorResponse {
                code: "RESOURCE_EXHAUSTED".into(),
                message: "订阅队列已满".into(),
            })),
        },
    );
    // Concatenated frames leave the last member, never a merge of the two.
    let mut wire = fixture("events_page_ok");
    wire.extend(fixture("events_error"));
    let decoded = EventStreamFrame::decode(wire.as_slice()).unwrap();
    assert!(matches!(
        decoded.payload,
        Some(event_stream_frame::Payload::Error(_))
    ));
}
