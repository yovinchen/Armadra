package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// The settings domain's wire shape (Go Host 业务所有权迁移 §2.4).
//
// Four properties are what the switch rests on, and each has a case below:
//
//   - the document travels as bytes, so its digest does not depend on two
//     languages agreeing about JSON key order, escaping or number formatting;
//   - a device overlay is a distinct scope with a device named on it, never the
//     global document with an extra field;
//   - an execution host is a projection with its own revision, so a
//     consistency check can name the host that differed rather than reporting
//     that "the document changed";
//   - the Worker frame carries the direction explicitly, so a request with no
//     document is an export rather than an import that lost its payload.
func settingsCases() map[string]proto.Message {
	document := []byte(`{"terminal":{"backend":"tmux"},"主题":"深色"}`)
	return map[string]proto.Message{
		"settings_document_global": &pb.SettingsDocument{
			Scope:           pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
			Document:        document,
			Sha256:          bytes.Repeat([]byte{3}, 32),
			SchemaVersion:   1,
			UpdatedAtUnixMs: 1788557900000,
			Revision:        9007199254740993,
		},
		// The third keybinding layer. It names the device it overrides for; a
		// DEVICE document with no device is refused rather than read as global.
		"settings_document_device": &pb.SettingsDocument{
			Scope:         pb.SettingsScope_SETTINGS_SCOPE_DEVICE,
			DeviceId:      "0123456789abcdef0123456789abcdef",
			Document:      []byte(`{"keymap":{"mac":{"canvas.tidy":"Mod+Shift+K"}}}`),
			Sha256:        bytes.Repeat([]byte{4}, 32),
			SchemaVersion: 1,
			Revision:      1,
		},
		"settings_execution_host_ssh": &pb.ExecutionHost{
			ExecutionHostId: "盒子-1",
			Name:            "构建机",
			Kind:            pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH,
			Ssh: &pb.SshExecutionHost{
				Host:         "example.com",
				Port:         2222,
				User:         "ada",
				IdentityFile: "~/.ssh/id_ed25519",
				WorkerPath:   "/opt/armadra/armadra-runtime",
				StateDir:     "/var/lib/armadra",
			},
			UpdatedAtUnixMs: 1788557900000,
			Revision:        math.MaxUint64,
		},
		// This machine. The empty identifier is the same convention Runtime
		// migration 0009 stores for a workspace that executes locally, so a
		// local host must survive the wire with that identifier still empty.
		"settings_execution_host_local": &pb.ExecutionHost{
			Kind:     pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL,
			Name:     "本机",
			Revision: 2,
		},
		"settings_get_response": &pb.GetSettingsResponse{
			Document: &pb.SettingsDocument{
				Scope:         pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
				Document:      document,
				Sha256:        bytes.Repeat([]byte{3}, 32),
				SchemaVersion: 1,
				Revision:      4,
			},
			ExecutionHosts: []*pb.ExecutionHost{
				{ExecutionHostId: "盒子-1", Kind: pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH, Revision: 4},
			},
			EventSequence: 9007199254740993,
		},
		// A first write states revision 0: "this document has never existed".
		// It must stay distinguishable from a write that omitted the field.
		"settings_put_create": &pb.PutSettingsRequest{
			Meta:             &pb.CommandMeta{RequestId: "settings-1", Scope: &pb.Scope{HostId: "0123456789abcdef0123456789abcdef"}},
			OperationId:      "settings/global/0",
			ExpectedRevision: 0,
			Document:         &pb.SettingsDocument{Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, Document: document, Sha256: bytes.Repeat([]byte{3}, 32), SchemaVersion: 1},
		},
		"settings_put_response": &pb.PutSettingsResponse{
			Document: &pb.SettingsDocument{Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, Document: document, Sha256: bytes.Repeat([]byte{3}, 32), SchemaVersion: 1, Revision: 5},
			Receipt: &pb.CanvasOperationReceipt{
				OperationId:   "settings/global/4",
				TransactionId: 12,
				FirstSequence: 30,
				LastSequence:  31,
			},
		},
		// The export asks and carries nothing. Without the explicit direction
		// an empty document would be the only signal, which is exactly how a
		// dropped payload turns into a wipe.
		"settings_worker_export": &pb.WorkerRequest{
			RequestId:          "settings-export-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Settings{Settings: &pb.WorkerSettingsRequest{
				Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_EXPORT,
			}},
		},
		"settings_worker_import": &pb.WorkerRequest{
			RequestId:          "settings-import-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Settings{Settings: &pb.WorkerSettingsRequest{
				Direction:     pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT,
				Document:      &pb.SettingsDocument{Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, Document: document, Sha256: bytes.Repeat([]byte{3}, 32), SchemaVersion: 1, Revision: 6},
				ExpectedEpoch: 2,
				ImportId:      "0123456789abcdef0123456789abcdef",
			}},
		},
		"settings_worker_snapshot": &pb.WorkerResponse{
			RequestId:  "settings-import-1",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_Settings{Settings: &pb.WorkerSettingsSnapshot{
				Document: &pb.SettingsDocument{Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, Document: document, Sha256: bytes.Repeat([]byte{3}, 32), SchemaVersion: 1},
				// Facts about the machine the Worker is on, never stored here.
				Local: &pb.WorkerLocalSettings{
					TerminalBackend:  "tmux",
					BrowserAvailable: true,
					PowerPolicy:      "manual",
					PathAugmented:    true,
				},
				ExecutionHosts: []*pb.ExecutionHost{
					{ExecutionHostId: "盒子-1", Kind: pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH, Ssh: &pb.SshExecutionHost{Host: "example.com", WorkerPath: "/opt/armadra/armadra-runtime"}},
				},
				Applied: true,
			}},
		},
		// The settings envelope on the shared stream. Its workspace is empty
		// on purpose: the document is host-wide, and naming one workspace
		// would hide the change from every other one.
		"settings_event_envelope": &pb.EventEnvelope{
			Sequence:        31,
			TransactionId:   12,
			OperationId:     "settings/global/4",
			TransactionSize: 1,
			Domain:          pb.EventDomain_EVENT_DOMAIN_SETTINGS,
			Kind:            "document",
			EntityId:        "global",
			Priority:        pb.EventPriority_EVENT_PRIORITY_NORMAL,
			Revision:        5,
			Entity: &pb.EventEnvelope_SettingsDocument{SettingsDocument: &pb.SettingsDocument{
				Scope:         pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
				Document:      document,
				Sha256:        bytes.Repeat([]byte{3}, 32),
				SchemaVersion: 1,
				Revision:      5,
			}},
		},
	}
}

func TestSettingsWire(t *testing.T) {
	for name, message := range settingsCases() {
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
				t.Fatal("settings message changed values or presence")
			}
		})
	}
}

// The document is bytes, not a struct. Re-encoding a parsed tree would make
// the digest depend on key order and escaping, which is exactly the agreement
// two languages cannot be relied on to keep.
func TestSettingsDocumentIsOpaqueBytes(t *testing.T) {
	document := settingsCases()["settings_document_global"].(*pb.SettingsDocument)
	data, err := proto.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, document.GetDocument()) {
		t.Fatal("the document did not travel as its own bytes")
	}
}

// An export must not be a marshalled request that merely happens to have no
// document: the direction field is what a Worker decides on, so it has to be
// present on the wire even though EXPORT is the first non-zero value.
func TestSettingsExportNamesItsDirection(t *testing.T) {
	request := settingsCases()["settings_worker_export"].(*pb.WorkerRequest).GetSettings()
	if request.GetDirection() != pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_EXPORT {
		t.Fatal("the export case does not name EXPORT")
	}
	data, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	fields := map[protowire.Number]bool{}
	for rest := data; len(rest) > 0; {
		number, _, size := protowire.ConsumeField(rest)
		if size < 0 {
			t.Fatal("the encoded export does not decode")
		}
		fields[number] = true
		rest = rest[size:]
	}
	if !fields[30] {
		t.Fatal("the direction is absent from the encoded export")
	}
	if len(fields) != 1 {
		t.Fatal("an export must carry its direction and nothing else")
	}
}

// Zero is not a scope and not a kind. A document that arrived with neither set
// must stay refusable: reading zero as GLOBAL would let an unnamed device
// overlay replace the document every device reads.
func TestSettingsZeroValuesAreUnspecified(t *testing.T) {
	if (&pb.SettingsDocument{}).GetScope() != pb.SettingsScope_SETTINGS_SCOPE_UNSPECIFIED {
		t.Fatal("the zero scope is not unspecified")
	}
	if (&pb.ExecutionHost{}).GetKind() != pb.ExecutionHostKind_EXECUTION_HOST_KIND_UNSPECIFIED {
		t.Fatal("the zero execution host kind is not unspecified")
	}
	if (&pb.WorkerSettingsRequest{}).GetDirection() != pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_UNSPECIFIED {
		t.Fatal("the zero worker settings direction is not unspecified")
	}
}
