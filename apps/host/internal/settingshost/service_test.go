package settingshost

import (
	"errors"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// A Host that has never switched serves reads and refuses every write with one
// stable code. There is no dual-write mode to fall into.
func TestWritesAreRefusedUntilThisHostOwnsTheDomain(t *testing.T) {
	f := newFixture(t)
	if _, err := f.put("save-1", baseDocument, 0); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("a Host that never switched accepted a settings write: %v", err)
	}
	if _, err := f.get(); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("a Host with no document answered something: %v", err)
	}
}

// The document is not workspace-scoped, so a grant that names one workspace is
// not the machine's settings grant.
func TestWorkspaceNarrowedGrantsDoNotReachTheDocument(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.caller.Scopes = []auth.Scope{
		{Permission: ScopeRead, WorkspaceID: "workspace-a", ExecutionHostID: fixtureHost},
		{Permission: ScopeWrite, WorkspaceID: "workspace-a", ExecutionHostID: fixtureHost},
	}
	if _, err := f.get(); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a workspace grant read the machine's document: %v", err)
	}
	if _, err := f.put("save-1", baseDocument, 0); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a workspace grant wrote the machine's document: %v", err)
	}
}

// Compare-and-set over the whole document. A stale revision and a "never
// written" claim against an existing document are both conflicts, because both
// mean the caller decided against a document it had not read.
func TestPutIsCompareAndSetOverTheWholeDocument(t *testing.T) {
	f := newFixture(t)
	f.own()
	first := f.mustPut("save-1", baseDocument, 0)
	if first.Document.Revision != 1 {
		t.Fatalf("the first write landed at revision %d", first.Document.Revision)
	}
	changed := strings.Replace(baseDocument, `"theme":"dark"`, `"theme":"light"`, 1)
	if _, err := f.put("save-2", changed, 0); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("revision 0 replaced an existing document: %v", err)
	}
	if _, err := f.put("save-3", changed, 99); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a stale revision was accepted: %v", err)
	}
	second := f.mustPut("save-4", changed, 1)
	if second.Document.Revision != 2 || !strings.Contains(string(second.Document.Document), `"light"`) {
		t.Fatalf("the second write stored %q at revision %d", second.Document.Document, second.Document.Revision)
	}
}

// An operation id is an idempotency key. The same id with the same content is
// the first answer again; with different content it is a reused id, refused
// rather than applied over what the id already produced.
func TestReplayedOperationIDsReturnTheFirstAnswer(t *testing.T) {
	f := newFixture(t)
	f.own()
	first := f.mustPut("save-1", baseDocument, 0)
	watermark := f.watermark()

	replay := f.mustPut("save-1", baseDocument, 0)
	if !replay.Receipt.Replayed || replay.Receipt.TransactionId != first.Receipt.TransactionId {
		t.Fatalf("a replay produced receipt %+v, not the first one %+v", replay.Receipt, first.Receipt)
	}
	if replay.Document.Revision != first.Document.Revision {
		t.Fatalf("a replay moved the revision to %d", replay.Document.Revision)
	}
	if f.watermark() != watermark {
		t.Fatal("a replay published events")
	}

	changed := strings.Replace(baseDocument, `"dark"`, `"light"`, 1)
	if _, err := f.put("save-1", changed, 1); !errors.Is(err, storage.ErrIdempotencyConflict) {
		t.Fatalf("a reused operation id wrote a different document: %v", err)
	}
}

// A write whose content already matched storage leaves it untouched. The
// alternative is an event for every save, including the ones that changed
// nothing, which a client cannot tell apart from a real change.
func TestUnchangedContentWritesNothing(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)
	watermark := f.watermark()
	again := f.mustPut("save-2", baseDocument, 1)
	if !again.Receipt.Replayed || again.Document.Revision != 1 {
		t.Fatalf("an identical save produced %+v at revision %d", again.Receipt, again.Document.Revision)
	}
	if f.watermark() != watermark {
		t.Fatal("an identical save published an event")
	}
}

// Structure only. Each of these is something a reader on either side would have
// to guess about; none of them is a judgement about what a setting means.
func TestStructuralValidationRefusesWhatCannotBeRead(t *testing.T) {
	f := newFixture(t)
	f.own()
	oversize := `{"blob":"` + strings.Repeat("x", MaxDocumentBytes) + `"}`
	for name, build := range map[string]func() *pb.SettingsDocument{
		"not an object": func() *pb.SettingsDocument { return document(`["theme"]`) },
		"a fragment":    func() *pb.SettingsDocument { return document(`{"theme":`) },
		"two values":    func() *pb.SettingsDocument { return document(`{"a":1}{"b":2}`) },
		"empty":         func() *pb.SettingsDocument { return document(``) },
		"oversize":      func() *pb.SettingsDocument { return document(oversize) },
		"wrong digest": func() *pb.SettingsDocument {
			value := document(baseDocument)
			value.Sha256 = digest([]byte("something else"))
			return value
		},
		"unknown schema version": func() *pb.SettingsDocument {
			value := document(baseDocument)
			value.SchemaVersion = 2
			return value
		},
		"a device document with no device": func() *pb.SettingsDocument {
			value := document(baseDocument)
			value.Scope = pb.SettingsScope_SETTINGS_SCOPE_DEVICE
			return value
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := f.service.Put(t.Context(), f.caller, &pb.PutSettingsRequest{OperationId: "save", Document: build()})
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

// The Host does not own this schema. A key it has never been taught about is
// stored and returned byte for byte, because the meaning of a setting is
// decided in packages/shared and in the Runtime, not here.
func TestUnknownTopLevelKeysSurviveUntouched(t *testing.T) {
	f := newFixture(t)
	f.own()
	body := `{"theme":"dark","somethingThisHostNeverHeardOf":{"nested":[1,2,{"deep":true}]},"trailing":"  spaced  "}`
	f.mustPut("save-1", body, 0)
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if string(stored.Document.Document) != body {
		t.Fatalf("the document came back as %q", stored.Document.Document)
	}
}

// The read reports the sequence it happened at, so a subscription continues
// from there rather than replaying the document's whole history.
func TestGetReportsTheSequenceItReadAt(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if stored.EventSequence != f.watermark() || stored.EventSequence == 0 {
		t.Fatalf("the read reported sequence %d, watermark is %d", stored.EventSequence, f.watermark())
	}
	// This machine is always the first row and is never stored.
	if len(stored.ExecutionHosts) != 2 {
		t.Fatalf("the read reported %d execution hosts", len(stored.ExecutionHosts))
	}
	local := stored.ExecutionHosts[0]
	if local.Kind != pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL || local.ExecutionHostId != "" || local.Revision != 0 {
		t.Fatalf("the implied local host came back as %+v", local)
	}
	if stored.ExecutionHosts[1].ExecutionHostId != "build-box" {
		t.Fatalf("the SSH host came back as %+v", stored.ExecutionHosts[1])
	}
}

// A per-device overlay is the third keybinding layer, not a second machine
// list: reading one as a registry would let a laptop delete the execution hosts
// every other device uses.
func TestDeviceOverlaysDoNotTouchTheRegistry(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)
	overlay := document(`{"keybindings":{"device":{"toggle":"ctrl+k"}},"ssh":{"hosts":[]}}`)
	overlay.Scope = pb.SettingsScope_SETTINGS_SCOPE_DEVICE
	overlay.DeviceId = "device-1"
	if _, err := f.service.Put(t.Context(), f.caller, &pb.PutSettingsRequest{OperationId: "overlay", Document: overlay}); err != nil {
		t.Fatal(err)
	}
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.ExecutionHosts) != 2 {
		t.Fatalf("a device overlay changed the registry to %d rows", len(stored.ExecutionHosts))
	}
	// And the two documents are separate rows, not one read as the other.
	device, err := f.service.Get(t.Context(), f.caller, pb.SettingsScope_SETTINGS_SCOPE_DEVICE, "device-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(device.Document.Document) == baseDocument {
		t.Fatal("the device overlay read back as the global document")
	}
}
