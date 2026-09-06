package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The filesystem domain's registration record (Go Host 业务所有权迁移 §2.5).
//
// Four shapes are pinned, because each one is a decision the other two runtimes
// have to read the same way: a remote root with its registration proof, a
// permission change under CAS, the tombstone an unregistration leaves, and the
// Worker's own reading of its roots — which is what a switch and a handback are
// verified against.
func TestFilesystemRootWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		// A remote root: the path is on the execution host, the proof is that
		// host's Worker canonicalizing it, and execute is off while read and
		// write are on — the combination that lets a device edit a file and
		// not start a program.
		"filesystem_remote_root": &pb.WorkspaceRoot{
			WorkspaceId:        "0123456789abcdef0123456789abcdef",
			ExecutionHostId:    "构建机",
			CanonicalPath:      "/srv/项目/armadra",
			ProofSha256:        bytes.Repeat([]byte{5}, 32),
			Permissions:        &pb.CanvasWorkspacePermissions{Read: true, Write: true},
			RegisteredAtUnixMs: 1788557000000,
			UpdatedAtUnixMs:    1788557900000,
			Revision:           9007199254740993,
		},
		"filesystem_update_root": &pb.UpdateWorkspaceRootRequest{
			Meta:             &pb.CommandMeta{RequestId: "filesystem-1", Scope: &pb.Scope{WorkspaceId: "0123456789abcdef0123456789abcdef"}},
			OperationId:      "filesystem/0123456789abcdef0123456789abcdef/permissions-1",
			ExpectedRevision: math.MaxUint64,
			WorkspaceId:      "0123456789abcdef0123456789abcdef",
			Permissions:      &pb.CanvasWorkspacePermissions{Read: true, Write: true, Execute: true},
		},
		// The tombstone. `deleted` alone is the statement; the revision is what
		// a later re-registration has to name, so neither may be dropped.
		"filesystem_root_tombstone": &pb.WorkspaceRoot{
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			UpdatedAtUnixMs: 1788557900000,
			Revision:        4,
			Deleted:         true,
		},
		"filesystem_worker_roots": &pb.FilesystemWorkerResponse{
			Result: &pb.FilesystemWorkerResponse_Roots{Roots: &pb.WorkerWorkspaceRoots{Roots: []*pb.WorkspaceRoot{
				{WorkspaceId: "0123456789abcdef0123456789abcdef", CanonicalPath: "/home/用户/项目", Permissions: &pb.CanvasWorkspacePermissions{Read: true, Write: true}},
				{WorkspaceId: "abcdef0123456789abcdef0123456789", ExecutionHostId: "构建机", CanonicalPath: "/srv/项目/armadra", Permissions: &pb.CanvasWorkspacePermissions{Read: true}},
			}}},
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

// A root with every permission cleared is not the same message as a root that
// names no permissions at all. The first says "this workspace may not be read";
// the second says "nobody has decided yet", and a Host that read them alike
// would grant access to a workspace whose record was never filled in.
func TestFilesystemPermissionsAbsentIsNotDenied(t *testing.T) {
	denied := &pb.WorkspaceRoot{WorkspaceId: "w", Permissions: &pb.CanvasWorkspacePermissions{}}
	absent := &pb.WorkspaceRoot{WorkspaceId: "w"}
	deniedWire, err := proto.Marshal(denied)
	if err != nil {
		t.Fatal(err)
	}
	absentWire, err := proto.Marshal(absent)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(deniedWire, absentWire) {
		t.Fatal("a cleared permission set encodes like an absent one")
	}
	decoded := new(pb.WorkspaceRoot)
	if err = proto.Unmarshal(absentWire, decoded); err != nil || decoded.GetPermissions() != nil {
		t.Fatal("an absent permission set decoded as a present one")
	}
}

// The registration envelope carries the CAS token separately from the record it
// is registering. A caller that read revision 3 and a record that claims 3 are
// two different statements, and the second one must never stand in for the
// first: `expected_revision` is what the store compares.
func TestFilesystemRegisterEnvelope(t *testing.T) {
	request := &pb.RegisterWorkspaceRootRequest{
		Meta:             &pb.CommandMeta{RequestId: "register-1"},
		OperationId:      "filesystem/w/register-1",
		ExpectedRevision: 0,
		Root: &pb.WorkspaceRoot{
			WorkspaceId:   "0123456789abcdef0123456789abcdef",
			CanonicalPath: "/home/用户/项目",
			Permissions:   &pb.CanvasWorkspacePermissions{Read: true, Write: true},
			Revision:      7,
		},
	}
	data, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.RegisterWorkspaceRootRequest)
	if err = proto.Unmarshal(data, decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.GetExpectedRevision() != 0 || decoded.GetRoot().GetRevision() != 7 {
		t.Fatal("the CAS token and the record's own revision were confused")
	}
	// Unregistering answers with the identifier and the receipt, never with a
	// root: a caller that got an empty record back would read it as a
	// workspace whose registration had been cleared rather than removed.
	response := &pb.UnregisterWorkspaceRootResponse{
		WorkspaceId: "0123456789abcdef0123456789abcdef",
		Receipt:     &pb.CanvasOperationReceipt{OperationId: "filesystem/w/unregister-1", TransactionId: 4, FirstSequence: 9, LastSequence: 9},
	}
	if wire, err := proto.Marshal(response); err != nil || len(wire) == 0 {
		t.Fatal("the unregister response does not encode")
	}
}

// The filesystem domain travels on the shared Worker connection as action 26
// and on the shared event stream as envelope member 140. Both numbers are
// contract: a frame that landed on another domain's number would be answered by
// the wrong handler on a peer that has both.
func TestFilesystemChannelNumbers(t *testing.T) {
	request := &pb.WorkerRequest{
		RequestId: "h-filesystem-1",
		HostId:    "0123456789abcdef0123456789abcdef",
		Action:    &pb.WorkerRequest_Filesystem{Filesystem: &pb.FilesystemWorkerRequest{Action: &pb.FilesystemWorkerRequest_ListRoots{ListRoots: &pb.ListWorkerRootsRequest{}}}},
	}
	data, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.WorkerRequest)
	if err = proto.Unmarshal(data, decoded); err != nil || decoded.GetFilesystem().GetListRoots() == nil {
		t.Fatal("the filesystem worker frame changed")
	}
	if field := request.ProtoReflect().Descriptor().Fields().ByName("filesystem"); field == nil || field.Number() != 26 {
		t.Fatal("the filesystem worker action is not field 26")
	}
	if field := new(pb.WorkerResponse).ProtoReflect().Descriptor().Fields().ByName("filesystem"); field == nil || field.Number() != 26 {
		t.Fatal("the filesystem worker result is not field 26")
	}
	envelope := &pb.EventEnvelope{
		Sequence:    12,
		Domain:      pb.EventDomain_EVENT_DOMAIN_FILESYSTEM,
		Kind:        "root",
		EntityId:    "0123456789abcdef0123456789abcdef",
		Revision:    3,
		WorkspaceId: "0123456789abcdef0123456789abcdef",
		Entity:      &pb.EventEnvelope_FilesystemRoot{FilesystemRoot: &pb.WorkspaceRoot{WorkspaceId: "0123456789abcdef0123456789abcdef", CanonicalPath: "/home/用户/项目", Revision: 3}},
	}
	if field := envelope.ProtoReflect().Descriptor().Fields().ByName("filesystem_root"); field == nil || field.Number() != 140 {
		t.Fatal("the filesystem event entity is not field 140")
	}
	wire, err := proto.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	back := new(pb.EventEnvelope)
	if err = proto.Unmarshal(wire, back); err != nil || back.GetFilesystemRoot().GetCanonicalPath() != "/home/用户/项目" {
		t.Fatal("the filesystem event envelope changed")
	}
	// A reverse export package carries the same record, so a handback is
	// compared against the entity the stream published rather than a second
	// spelling of it.
	record := &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_WorkspaceRoot{WorkspaceRoot: &pb.WorkspaceRoot{WorkspaceId: "w", CanonicalPath: "/项目"}}}
	if wire, err = proto.Marshal(record); err != nil || len(wire) == 0 {
		t.Fatal("the reverse export record does not carry a workspace root")
	}
}
