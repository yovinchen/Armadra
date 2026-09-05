package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// Reverse export package v2 (Go Host 业务所有权迁移 §2.12).
//
// The package travels from the Host to the Runtime and back again as a
// report, so the three runtimes have to agree on it byte for byte. Two
// properties matter more than the rest and are pinned here:
//
//   - the two digests per file are separate fields. `sha256` describes the
//     bytes on disk and `content_sha256` describes the canonical records; an
//     encoder that collapsed them would let a package verify against itself.
//   - an entity file is a sequence of ReverseExportRecord, and each record's
//     oneof names exactly one entity. A record with no member set is a reader
//     error, not an empty row, so the empty encoding must stay distinguishable.
func TestReverseExportPackageWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"reverse_export_index": &pb.ReverseExportIndex{
			FormatVersion: 2,
			HostId:        "0123456789abcdef0123456789abcdef",
			Epoch:         9007199254740993,
			EventSequence: math.MaxUint64,
			Domain:        "canvas",
			EntityCount:   3,
			Files: []*pb.ReverseExportFile{{
				Name:          "6ff1d1de4b2ba01b7b0e4b2a6cbb0a51.pb",
				WorkspaceId:   "工作区-1",
				Bytes:         512,
				Sha256:        bytes.Repeat([]byte{4}, 32),
				ContentSha256: bytes.Repeat([]byte{5}, 32),
				EntityCount:   3,
			}},
		},
		"reverse_export_record": &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Node{Node: &pb.CanvasNode{
			NodeId:          "节点-1",
			CanvasId:        "canvas-1",
			Type:            "sticky",
			Title:           "便签📌",
			Color:           "#0a84ff",
			Position:        &pb.CanvasPoint{X: -1.5, Y: 2},
			ParentId:        "frame-1",
			DataJson:        []byte(`{"text":"内容"}`),
			CreatedAtUnixMs: 1788557000000,
			UpdatedAtUnixMs: 1788557000001,
		}}},
		// An absent oneof member is what a truncated or foreign record decodes
		// to, and it has to stay an empty message rather than a default entity.
		"reverse_export_record_absent": &pb.ReverseExportRecord{},
		"reverse_apply_request": &pb.WorkerRequest{
			RequestId:          "reverse-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_ApplyReverseExport{ApplyReverseExport: &pb.ApplyReverseExportRequest{
				Domain:        "canvas",
				PackagePath:   "/data/reverse-export",
				IndexSha256:   bytes.Repeat([]byte{6}, 32),
				ExpectedEpoch: 2,
				ImportId:      "reverse-import-1",
			}},
		},
		"reverse_import_report": &pb.WorkerResponse{
			RequestId:  "reverse-1",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_ReverseImport{ReverseImport: &pb.ReverseImportReport{
				ImportId:        "reverse-import-1",
				Domain:          "canvas",
				Epoch:           2,
				IndexSha256:     bytes.Repeat([]byte{6}, 32),
				EntityCount:     3,
				Replayed:        true,
				AppliedAtUnixMs: 1788557000000,
				Reexported: []*pb.ReverseExportFile{{
					WorkspaceId:   "工作区-1",
					ContentSha256: bytes.Repeat([]byte{5}, 32),
					EntityCount:   3,
				}},
				Tables: []*pb.ExportTable{{Name: "nodes", RowCount: 1, Readable: true}},
				Issues: []*pb.ExportIssue{{Code: "reverse.unsupported_entity", Severity: "error", Entity: "nodes/节点-2", Detail: "记录类型未知"}},
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
			t.Fatalf("%s changed across the reverse export contract", name)
		}
	}
}

// The two digests describe different things, so a file that carries only one
// of them must not read as though it carried both.
func TestReverseExportDigestsAreIndependent(t *testing.T) {
	onDisk := &pb.ReverseExportFile{Sha256: bytes.Repeat([]byte{1}, 32)}
	content := &pb.ReverseExportFile{ContentSha256: bytes.Repeat([]byte{1}, 32)}
	left, err := proto.Marshal(onDisk)
	if err != nil {
		t.Fatal(err)
	}
	right, err := proto.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(left, right) {
		t.Fatal("the on-disk and canonical digests share a field number")
	}
	decoded := &pb.ReverseExportFile{}
	if err = proto.Unmarshal(left, decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.ContentSha256) != 0 {
		t.Fatal("an on-disk digest was read as a canonical one")
	}
}
