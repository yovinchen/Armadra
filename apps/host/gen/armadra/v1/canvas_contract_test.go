package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

func canvasNode() *pb.CanvasNode {
	return &pb.CanvasNode{
		NodeId:         "node-终端",
		CanvasId:       "canvas-1",
		Type:           "terminal",
		Title:          "构建 📦",
		Color:          "#0a84ff",
		Position:       &pb.CanvasPoint{X: -1024.5, Y: 2048.25},
		Size:           &pb.CanvasSize{Width: 640, Height: 480},
		Collapsed:      proto.Bool(false),
		ExpandedHeight: proto.Float64(0),
		// Frame nesting is a plain parent reference, so a migration can compare
		// it without understanding what a frame draws like.
		ParentId: "node-frame",
		DataJson: []byte(`{"sessionId":"session-1"}`),
		Assets: []*pb.CanvasAssetRef{{
			AssetId:      "asset-1",
			WorkspaceId:  "workspace-1",
			RelativePath: ".armadra/assets/ab/cd/图片.png",
			Sha256:       bytes.Repeat([]byte{5}, 32),
			Bytes:        9007199254740993,
			MimeType:     "image/png",
		}},
		CreatedAtUnixMs: 1788557000000,
		UpdatedAtUnixMs: 1788557900000,
		Revision:        9007199254740993,
	}
}

// Every fixture here pins a statement the migration depends on: an absent
// optional is not a zero, a nested frame keeps its parent, an asset keeps its
// digest, and a 64-bit revision survives a round trip in all three runtimes.
func TestCanvasWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"canvas_document": &pb.CanvasDocument{
			Canvas: &pb.Canvas{
				CanvasId:    "canvas-1",
				WorkspaceId: "workspace-1",
				Name:        "默认画布",
				SortOrder:   math.MinInt64,
				Viewport:    &pb.CanvasViewport{X: -0.5, Y: 12.25, Zoom: 1.5},
				Whiteboard: &pb.CanvasWhiteboard{
					SchemaVersion: 2,
					EngineVersion: "tldraw-5",
					Snapshot:      []byte{0x00, 0x9f, 0x99, 0x82},
					Sha256:        bytes.Repeat([]byte{1}, 32),
					Bytes:         4,
				},
				CreatedAtUnixMs: 1788557000000,
				UpdatedAtUnixMs: 1788557900000,
				Revision:        math.MaxUint64,
			},
			Nodes: []*pb.CanvasNode{canvasNode(), {
				NodeId:          "node-frame",
				CanvasId:        "canvas-1",
				Type:            "group",
				Title:           "Frame",
				Position:        &pb.CanvasPoint{},
				CreatedAtUnixMs: 1788557000000,
				UpdatedAtUnixMs: 1788557000000,
				Revision:        1,
			}},
			Edges: []*pb.CanvasEdge{{
				EdgeId:          "edge-1",
				CanvasId:        "canvas-1",
				SourceNodeId:    "node-终端",
				TargetNodeId:    "node-frame",
				Kind:            pb.CanvasEdgeKind_CANVAS_EDGE_KIND_LINK,
				CreatedAtUnixMs: 1788557000000,
				UpdatedAtUnixMs: 1788557000000,
				Revision:        1,
			}},
			Annotations: []*pb.CanvasAnnotation{{
				AnnotationId:    "annotation-1",
				CanvasId:        "canvas-1",
				NodeId:          "node-终端",
				Labels:          []string{"构建", "夜间"},
				Note:            "备注 🈶",
				CreatedAtUnixMs: 1788557000000,
				UpdatedAtUnixMs: 1788557900000,
				Revision:        2,
			}},
			EventSequence: 9007199254740993,
		},
		"canvas_save_request": &pb.SaveCanvasDocumentRequest{
			Meta: &pb.CommandMeta{
				RequestId: "save-1",
				Scope: &pb.Scope{
					HostId:          "0123456789abcdef0123456789abcdef",
					WorkspaceId:     "workspace-1",
					ExecutionHostId: "0123456789abcdef0123456789abcdef",
				},
				IdempotencyKey: "canvas/workspace-1/canvas-1/7",
			},
			OperationId: "canvas/workspace-1/canvas-1/7",
			Canvas: &pb.Canvas{
				CanvasId:    "canvas-1",
				WorkspaceId: "workspace-1",
				Name:        "默认画布",
				Viewport:    &pb.CanvasViewport{Zoom: 1},
			},
			ExpectedRevision: 9007199254740993,
			Nodes:            []*pb.CanvasNode{canvasNode()},
		},
		// An absent size means "the client's default for this node type"; a
		// zero-sized node is a different statement and must encode differently.
		"canvas_node_absent_size": &pb.CanvasNode{
			NodeId:   "node-裸",
			CanvasId: "canvas-1",
			Type:     "sticky",
			Position: &pb.CanvasPoint{X: 0, Y: 0},
			Revision: 1,
		},
		"canvas_receipt": &pb.CanvasOperationReceipt{
			OperationId:   "canvas/workspace-1/canvas-1/7",
			TransactionId: 9007199254740993,
			FirstSequence: 9007199254740993,
			LastSequence:  math.MaxUint64,
			Replayed:      true,
			Revisions: []*pb.CanvasRevision{
				{Kind: pb.CanvasEntityKind_CANVAS_ENTITY_KIND_CANVAS, EntityId: "canvas-1", Revision: 2},
				{Kind: pb.CanvasEntityKind_CANVAS_ENTITY_KIND_NODE, EntityId: "node-终端", Revision: math.MaxUint64, Deleted: true},
			},
		},
		"canvas_event": &pb.CanvasEventEnvelope{
			Sequence:         9007199254740993,
			TransactionId:    42,
			OperationId:      "canvas/workspace-1/canvas-1/7",
			TransactionIndex: 1,
			TransactionSize:  3,
			WorkspaceId:      "workspace-1",
			Kind:             pb.CanvasEntityKind_CANVAS_ENTITY_KIND_NODE,
			EntityId:         "node-终端",
			Revision:         math.MaxUint64,
			Entity:           &pb.CanvasEventEnvelope_Node{Node: canvasNode()},
		},
		"canvas_event_snapshot_required": &pb.CanvasEventPage{
			Status:        pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_SNAPSHOT_REQUIRED,
			NextCursor:    0,
			MinCursor:     9007199254740993,
			HighWatermark: math.MaxUint64,
		},
		"canvas_ownership_switching": &pb.CanvasOwnership{
			Domain:          "canvas",
			Owner:           pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME,
			Epoch:           9007199254740993,
			Phase:           pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SWITCHING,
			ImportId:        "0123456789abcdef0123456789abcdef",
			ReasonCode:      "ownership.switch.verified",
			UpdatedAtUnixMs: 1788557900000,
			Revision:        3,
		},
		"canvas_consistency_report": &pb.CanvasConsistencyReport{
			ImportId:       "0123456789abcdef0123456789abcdef",
			ExportId:       "导出-1",
			ManifestSha256: bytes.Repeat([]byte{2}, 32),
			Checks: []*pb.CanvasConsistencyCheck{
				{Check: "nodes", ExpectedCount: 2, ActualCount: 2, Matched: true},
				{Check: "assets", ExpectedCount: 1, ActualCount: 0, Matched: false, Differences: []string{"asset-1"}},
			},
			Matched:          false,
			EntityCount:      9007199254740993,
			VerifiedAtUnixMs: 1788557900000,
		},
		// The epoch handoff itself: the Host names the epoch and the epoch it
		// believes is stored, so a repeat is idempotent and a stale one fails.
		"worker_set_ownership": &pb.WorkerRequest{
			RequestId: "ownership-1",
			HostId:    "0123456789abcdef0123456789abcdef",
			Action: &pb.WorkerRequest_SetWriteOwnership{SetWriteOwnership: &pb.SetWriteOwnershipRequest{
				Domain:        "canvas",
				Owner:         pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
				Epoch:         9007199254740993,
				ExpectedEpoch: 9007199254740992,
				ReasonCode:    "ownership.switch.verified",
			}},
		},
		"worker_write_ownership": &pb.WorkerResponse{
			RequestId:  "ownership-1",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_WriteOwnership{WriteOwnership: &pb.WorkerWriteOwnership{
				Domain:          "canvas",
				Owner:           pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
				Epoch:           9007199254740993,
				UpdatedAtUnixMs: 1788557900000,
				ReasonCode:      "ownership.switch.verified",
			}},
		},
	} {
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		wire := fixture(t, name, data)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(wire, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s changed", name)
		}
	}
}

// A node whose size was never set and one that was explicitly stored at zero
// are different documents. Losing that distinction silently resizes canvases.
func TestCanvasAbsentOptionalIsNotZero(t *testing.T) {
	absent, err := proto.Marshal(&pb.CanvasNode{NodeId: "n", CanvasId: "c"})
	if err != nil {
		t.Fatal(err)
	}
	zero, err := proto.Marshal(&pb.CanvasNode{NodeId: "n", CanvasId: "c", Size: &pb.CanvasSize{}, Collapsed: proto.Bool(false), ExpandedHeight: proto.Float64(0)})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(absent, zero) {
		t.Fatal("an unset size encodes like a zero size")
	}
	var back pb.CanvasNode
	if err = proto.Unmarshal(absent, &back); err != nil || back.Size != nil || back.Collapsed != nil || back.ExpandedHeight != nil {
		t.Fatal("an absent node property decoded as a value")
	}
}

// Zero is reserved everywhere: a default-constructed message never claims to
// be a real entity kind, edge kind, cursor status, owner or phase.
func TestCanvasEnumsReserveZero(t *testing.T) {
	if pb.CanvasEntityKind_CANVAS_ENTITY_KIND_UNSPECIFIED != 0 ||
		pb.CanvasEdgeKind_CANVAS_EDGE_KIND_UNSPECIFIED != 0 ||
		pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_UNSPECIFIED != 0 ||
		pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_UNSPECIFIED != 0 ||
		pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_UNSPECIFIED != 0 {
		t.Fatal("a canvas enumeration gives 0 a meaning")
	}
}

// An unknown owner value from a newer peer must stay unknown. Decoding it as
// RUNTIME would hand write ownership back to a process that no longer has it.
func TestCanvasUnknownOwnerIsNotRuntime(t *testing.T) {
	wire, err := proto.Marshal(&pb.CanvasOwnership{Domain: "canvas", Owner: pb.CanvasOwnershipOwner(999), Epoch: 2})
	if err != nil {
		t.Fatal(err)
	}
	var back pb.CanvasOwnership
	if err = proto.Unmarshal(wire, &back); err != nil {
		t.Fatal(err)
	}
	if back.Owner != pb.CanvasOwnershipOwner(999) {
		t.Fatal("an unknown ownership owner was folded into a known one")
	}
}
