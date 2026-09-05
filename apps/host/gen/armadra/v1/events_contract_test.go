package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// The event stream's wire shape, pinned by shared fixtures (host business
// migration §2.3). Three properties are load-bearing and each has a case:
//
//   - a deletion is a tombstone with no entity, distinct from an entity whose
//     fields happen to be empty;
//   - a cursor that cannot be served is a named status carried with the floor
//     and watermark, never an empty page;
//   - the frame oneof separates a subscription, a page, a heartbeat, an ack and
//     an error, so a client never has to infer which one it received.
func eventCases() map[string]proto.Message {
	return map[string]proto.Message{
		"events_envelope_node": &pb.EventEnvelope{
			Sequence:         9007199254740993,
			TransactionId:    math.MaxUint64,
			OperationId:      "canvas/工作区-1/画布-1/7",
			TransactionIndex: 2,
			TransactionSize:  3,
			WorkspaceId:      "工作区-1",
			Domain:           pb.EventDomain_EVENT_DOMAIN_CANVAS,
			Kind:             "node",
			EntityId:         "节点-1",
			Priority:         pb.EventPriority_EVENT_PRIORITY_NORMAL,
			Revision:         math.MaxUint64,
			Entity: &pb.EventEnvelope_CanvasNode{CanvasNode: &pb.CanvasNode{
				NodeId:   "节点-1",
				CanvasId: "画布-1",
				Type:     "terminal",
				Title:    "终端📟",
				Position: &pb.CanvasPoint{X: -1.5, Y: 2.25},
				DataJson: []byte(`{"backend":"tmux"}`),
				Revision: 7,
			}},
		},
		// A tombstone: id and revision are the whole statement.
		"events_envelope_deleted": &pb.EventEnvelope{
			Sequence:        4,
			TransactionId:   2,
			OperationId:     "canvas/工作区-1/画布-1/delete/3",
			TransactionSize: 1,
			WorkspaceId:     "工作区-1",
			Domain:          pb.EventDomain_EVENT_DOMAIN_CANVAS,
			Kind:            "canvas",
			EntityId:        "画布-1",
			Revision:        4,
			Deleted:         true,
		},
		// An unknown domain must survive a relay unchanged rather than being
		// folded onto UNSPECIFIED, which would read as "no domain".
		"events_envelope_future_domain": &pb.EventEnvelope{
			Sequence:        5,
			TransactionId:   3,
			TransactionSize: 1,
			WorkspaceId:     "工作区-1",
			Domain:          pb.EventDomain(99),
			Kind:            "unheard-of",
			EntityId:        "实体-1",
			Priority:        pb.EventPriority_EVENT_PRIORITY_HIGH,
			Revision:        1,
		},
		"events_subscribe": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Subscribe{Subscribe: &pb.SubscribeEventsRequest{
			AfterSequence: 9007199254740993,
			WorkspaceIds:  []string{"工作区-1", "workspace-2"},
			Domains:       []pb.EventDomain{pb.EventDomain_EVENT_DOMAIN_CANVAS, pb.EventDomain_EVENT_DOMAIN_AGENT},
			PageBytes:     262144,
			MinPriority:   pb.EventPriority_EVENT_PRIORITY_HIGH,
		}}},
		"events_page_ok": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Page{Page: &pb.EventPage{
			Status:        pb.EventCursorStatus_EVENT_CURSOR_STATUS_OK,
			Events:        []*pb.EventEnvelope{{Sequence: 6, TransactionId: 4, TransactionSize: 1, WorkspaceId: "工作区-1", Domain: pb.EventDomain_EVENT_DOMAIN_CANVAS, Kind: "edge", EntityId: "连线-1", Revision: 1}},
			NextCursor:    6,
			MinCursor:     2,
			HighWatermark: 9,
			HasMore:       true,
		}}},
		// The floor and watermark travel with the refusal: they are what the
		// client needs to re-seed, and an empty page would say neither.
		"events_page_snapshot_required": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Page{Page: &pb.EventPage{
			Status:        pb.EventCursorStatus_EVENT_CURSOR_STATUS_SNAPSHOT_REQUIRED,
			MinCursor:     40,
			HighWatermark: 120,
		}}},
		"events_page_cursor_ahead": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Page{Page: &pb.EventPage{
			Status:        pb.EventCursorStatus_EVENT_CURSOR_STATUS_CURSOR_AHEAD,
			MinCursor:     1,
			HighWatermark: 3,
		}}},
		"events_heartbeat": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Heartbeat{Heartbeat: &pb.EventHeartbeat{
			HighWatermark: 9007199254740993,
			SentAtUnixMs:  1788557900000,
		}}},
		"events_ack": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Ack{Ack: &pb.StreamAck{ReceivedThrough: math.MaxUint64, AvailableCreditBytes: 4194304}}},
		"events_error": &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Error{Error: &pb.ErrorResponse{Code: "RESOURCE_EXHAUSTED", Message: "订阅队列已满"}}},
	}
}

func TestEventStreamWire(t *testing.T) {
	for name, message := range eventCases() {
		t.Run(name, func(t *testing.T) {
			data, err := proto.Marshal(message)
			if err != nil {
				t.Fatal(err)
			}
			wire := fixture(t, name, data)
			decoded := message.ProtoReflect().New().Interface()
			if err = proto.Unmarshal(wire, decoded); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(message, decoded) {
				t.Fatal("event stream message changed values or presence")
			}
		})
	}
}

// A tombstone must stay distinguishable from an entity that decoded to its
// zero value: the two demand opposite repairs in a client's document.
func TestEventDeletionCarriesNoEntity(t *testing.T) {
	deleted := eventCases()["events_envelope_deleted"].(*pb.EventEnvelope)
	if deleted.GetEntity() != nil || !deleted.GetDeleted() {
		t.Fatal("a deletion must be a tombstone, not an empty entity")
	}
	data, err := proto.Marshal(deleted)
	if err != nil {
		t.Fatal(err)
	}
	// No field number in the entity oneof range may appear on the wire.
	for rest := data; len(rest) > 0; {
		number, _, size := protowire.ConsumeTag(rest)
		if size < 0 {
			t.Fatal("tombstone wire is malformed")
		}
		if number >= 100 && number <= 239 {
			t.Fatalf("tombstone carried entity field %d", number)
		}
		skip := protowire.ConsumeFieldValue(number, protowire.Type(rest[0]&7), rest[size:])
		if skip < 0 {
			t.Fatal("tombstone wire is malformed")
		}
		rest = rest[size+skip:]
	}
}

// An unspecified status is not "probably OK": a client that applied such a page
// would advance its cursor past events it never saw. The zero value therefore
// has to stay distinct from OK on the wire.
func TestEventCursorStatusZeroIsNotOK(t *testing.T) {
	if pb.EventCursorStatus_EVENT_CURSOR_STATUS_UNSPECIFIED == pb.EventCursorStatus_EVENT_CURSOR_STATUS_OK {
		t.Fatal("unspecified cursor status collided with OK")
	}
	page := &pb.EventPage{}
	if page.GetStatus() != pb.EventCursorStatus_EVENT_CURSOR_STATUS_UNSPECIFIED {
		t.Fatal("an absent status decoded as a usable one")
	}
}

// The frame oneof is how a client tells a subscription from a page from an
// error. Concatenating two frames must leave the last member, never a merge.
func TestEventFrameOneofLastMemberWins(t *testing.T) {
	page, _ := proto.Marshal(eventCases()["events_page_ok"])
	failure, _ := proto.Marshal(eventCases()["events_error"])
	decoded := &pb.EventStreamFrame{}
	if err := proto.Unmarshal(append(page, failure...), decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.GetError() == nil || decoded.GetPage() != nil {
		t.Fatal("event frame oneof was not replaced by its last member")
	}
}
