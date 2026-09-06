package settingshost

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func testBox() *pb.ExecutionHost {
	return &pb.ExecutionHost{
		ExecutionHostId: "test-box",
		Name:            "Test",
		Kind:            pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH,
		Ssh: &pb.SshExecutionHost{
			Host:       "test.example",
			WorkerPath: "/opt/armadra/worker",
		},
	}
}

// The list is what a client reads before it writes: this machine, then the
// registry, plus the revision the following write has to name. Reading them
// separately would be reading two moments.
func TestListingExecutionHostsCarriesTheRevisionAWriteNeeds(t *testing.T) {
	f := newFixture(t)
	f.own()

	// An installation nobody has configured has this machine and nothing else,
	// and that is an answer rather than a missing document.
	empty, err := f.service.ListExecutionHosts(t.Context(), f.caller)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.ExecutionHosts) != 1 || empty.ExecutionHosts[0].ExecutionHostId != "" {
		t.Fatalf("an unconfigured installation listed %+v", empty.ExecutionHosts)
	}
	if empty.DocumentRevision != 0 {
		t.Fatalf("an unwritten document reported revision %d", empty.DocumentRevision)
	}

	f.mustPut("save-1", baseDocument, 0)
	listed, err := f.service.ListExecutionHosts(t.Context(), f.caller)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.ExecutionHosts) != 2 || listed.ExecutionHosts[1].ExecutionHostId != "build-box" {
		t.Fatalf("the registry listed %+v", listed.ExecutionHosts)
	}
	if listed.ExecutionHosts[0].Kind != pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL {
		t.Fatal("this machine is not first in the listing")
	}
	if listed.DocumentRevision != 1 {
		t.Fatalf("the listing reported revision %d", listed.DocumentRevision)
	}
}

// Writing a host is writing the document, and every other byte of it has to
// come through unchanged — including the keys this Host has never been taught
// about, which is most of them.
func TestWritingOneHostPreservesTheRestOfTheDocument(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)

	saved, err := f.service.PutExecutionHost(t.Context(), f.caller, &pb.PutExecutionHostRequest{
		OperationId:      "host-1",
		ExpectedRevision: 1,
		ExecutionHost:    testBox(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.ExecutionHost.GetSsh().GetHost() != "test.example" {
		t.Fatalf("the stored host came back as %+v", saved.ExecutionHost)
	}
	document := map[string]json.RawMessage{}
	if err := json.Unmarshal(saved.Document.Document, &document); err != nil {
		t.Fatal(err)
	}
	if string(document["theme"]) != `"dark"` {
		t.Fatalf("theme survived as %s", document["theme"])
	}
	if !strings.Contains(string(document["keybindings"]), "cmd+k") {
		t.Fatalf("keybindings survived as %s", document["keybindings"])
	}
	// And the one that was already there is still there, with its own fields.
	listed, err := f.service.ListExecutionHosts(t.Context(), f.caller)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.ExecutionHosts) != 3 {
		t.Fatalf("the registry now holds %+v", listed.ExecutionHosts)
	}
	if listed.ExecutionHosts[1].GetSsh().GetIdentityFile() != "/keys/ci" {
		t.Fatalf("the untouched host came back as %+v", listed.ExecutionHosts[1])
	}

	// A replace really replaces: clearing a field has to be expressible.
	renamed := testBox()
	renamed.Name = "Renamed"
	renamed.Ssh.WorkerPath = ""
	if _, err = f.service.PutExecutionHost(t.Context(), f.caller, &pb.PutExecutionHostRequest{
		OperationId: "host-2", ExpectedRevision: saved.Document.Revision, ExecutionHost: renamed,
	}); err != nil {
		t.Fatal(err)
	}
	listed, err = f.service.ListExecutionHosts(t.Context(), f.caller)
	if err != nil {
		t.Fatal(err)
	}
	if listed.ExecutionHosts[2].Name != "Renamed" || listed.ExecutionHosts[2].GetSsh().GetWorkerPath() != "" {
		t.Fatalf("the replaced host came back as %+v", listed.ExecutionHosts[2])
	}
}

// The revision guarded is the document's, because that is what a host write
// actually writes. Naming a stale one has to conflict, or two people editing
// two different hosts would each publish a registry missing the other's.
func TestAHostWriteIsGuardedByTheDocumentRevision(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)
	_, err := f.service.PutExecutionHost(t.Context(), f.caller, &pb.PutExecutionHostRequest{
		OperationId: "host-1", ExpectedRevision: 0, ExecutionHost: testBox(),
	})
	conflict := new(storage.RevisionConflict)
	if !errors.As(err, &conflict) {
		t.Fatalf("a stale revision was answered with %v", err)
	}
}

func TestDeletingAHostRemovesItAndAnUnknownOneIsNotFound(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)

	deleted, err := f.service.DeleteExecutionHost(t.Context(), f.caller, &pb.DeleteExecutionHostRequest{
		OperationId: "delete-1", ExpectedRevision: 1, ExecutionHostId: "build-box",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(deleted.Document.Document), "build.example") {
		t.Fatalf("the host survived in %s", deleted.Document.Document)
	}
	listed, err := f.service.ListExecutionHosts(t.Context(), f.caller)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.ExecutionHosts) != 1 {
		t.Fatalf("the registry still holds %+v", listed.ExecutionHosts)
	}

	// Deleting nothing is not a successful delete. A client that thought it
	// removed a machine has to be told it did not.
	_, err = f.service.DeleteExecutionHost(t.Context(), f.caller, &pb.DeleteExecutionHostRequest{
		OperationId: "delete-2", ExpectedRevision: listed.DocumentRevision, ExecutionHostId: "build-box",
	})
	if !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("deleting an absent host answered %v", err)
	}
}

// This machine has no row, so there is nothing to write or remove. Its
// identifier is the empty string, which is not a storage key at all.
func TestThisMachineIsNeitherWrittenNorDeleted(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)
	local := &pb.ExecutionHost{Kind: pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL}
	if _, err := f.service.PutExecutionHost(t.Context(), f.caller, &pb.PutExecutionHostRequest{
		OperationId: "host-1", ExpectedRevision: 1, ExecutionHost: local,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("writing this machine answered %v", err)
	}
	if _, err := f.service.DeleteExecutionHost(t.Context(), f.caller, &pb.DeleteExecutionHostRequest{
		OperationId: "delete-1", ExpectedRevision: 1, ExecutionHostId: "",
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("deleting this machine answered %v", err)
	}
}

// While the Runtime owns the domain, the Host serves reads and refuses every
// mutation with one code. A host write is a mutation like any other.
func TestHostWritesRefuseUntilThisHostOwnsTheDomain(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.PutExecutionHost(t.Context(), f.caller, &pb.PutExecutionHostRequest{
		OperationId: "host-1", ExecutionHost: testBox(),
	}); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("a write before the switch answered %v", err)
	}
	// Validation is a read and stays answerable: refusing it would only make
	// the next save a blind one.
	if _, err := f.service.Validate(t.Context(), f.caller, &pb.ValidateSettingsRequest{
		Document: document(baseDocument),
	}); err != nil {
		t.Fatalf("validating before the switch answered %v", err)
	}
}

// Validation reports every problem it can see at once. A page that has to be
// saved, refused, fixed and saved again once per problem is a page nobody
// finishes.
func TestValidationListsProblemsAndProjectsWhatWouldBeStored(t *testing.T) {
	f := newFixture(t)
	good, err := f.service.Validate(t.Context(), f.caller, &pb.ValidateSettingsRequest{
		Document: document(baseDocument),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !good.Ok || len(good.Problems) != 0 {
		t.Fatalf("a good document reported %+v", good.Problems)
	}
	if len(good.ExecutionHosts) != 1 || good.ExecutionHosts[0].ExecutionHostId != "build-box" {
		t.Fatalf("validation projected %+v", good.ExecutionHosts)
	}

	broken := document(`[]`)
	broken.SchemaVersion = 99
	broken.Sha256 = []byte("not a digest")
	bad, err := f.service.Validate(t.Context(), f.caller, &pb.ValidateSettingsRequest{Document: broken})
	if err != nil {
		t.Fatal(err)
	}
	if bad.Ok {
		t.Fatal("a document that is an array validated")
	}
	reasons := map[string]bool{}
	for _, problem := range bad.Problems {
		reasons[problem.ReasonCode] = true
	}
	for _, expected := range []string{"unknownSchemaVersion", "notAnObject", "digestMismatch"} {
		if !reasons[expected] {
			t.Fatalf("the problems were %+v, missing %s", bad.Problems, expected)
		}
	}

	// A registry that cannot be projected is named as such rather than stored
	// as the source of a projection that does not exist.
	duplicate := `{"ssh":{"hosts":[{"id":"a","name":"A","host":"a.example"},{"id":"a","name":"B","host":"b.example"}]}}`
	registry, err := f.service.Validate(t.Context(), f.caller, &pb.ValidateSettingsRequest{
		Document: document(duplicate),
	})
	if err != nil {
		t.Fatal(err)
	}
	if registry.Ok || registry.Problems[0].Path != "ssh.hosts" {
		t.Fatalf("a duplicated host id reported %+v", registry.Problems)
	}
}

// A package is a configuration file, not a secret, and it carries no revision:
// a revision belongs to the store it came from.
func TestThePackageRoundTripsAndCarriesNoRevisionOrSecret(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)

	exported, err := f.service.ExportPackage(t.Context(), f.caller, pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, "")
	if err != nil {
		t.Fatal(err)
	}
	if exported.Package.Version != PackageVersion || exported.Revision != 1 {
		t.Fatalf("the package came back as version %d at revision %d", exported.Package.Version, exported.Revision)
	}
	if string(exported.Package.Document) != baseDocument {
		t.Fatal("the package is not the bytes that were stored")
	}
	if len(exported.Package.ExecutionHosts) != 1 {
		t.Fatalf("the package projected %+v", exported.Package.ExecutionHosts)
	}
	for _, secret := range []string{"password", "passphrase", "privateKey"} {
		if strings.Contains(string(exported.Package.Document), secret) {
			t.Fatalf("the package carries %q", secret)
		}
	}

	// Importing it into a store that has moved on is a conflict, exactly as a
	// save with a stale revision is.
	f.mustPut("save-2", twoHosts, 1)
	_, err = f.service.ImportPackage(t.Context(), f.caller, &pb.ImportSettingsRequest{
		OperationId:      "import-1",
		ExpectedRevision: exported.Revision,
		Scope:            pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
		Package:          exported.Package,
	})
	conflict := new(storage.RevisionConflict)
	if !errors.As(err, &conflict) {
		t.Fatalf("importing at a stale revision answered %v", err)
	}

	imported, err := f.service.ImportPackage(t.Context(), f.caller, &pb.ImportSettingsRequest{
		OperationId:      "import-2",
		ExpectedRevision: 2,
		Scope:            pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
		Package:          exported.Package,
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(imported.Document.Document) != baseDocument {
		t.Fatal("the import stored something other than the package")
	}
	// The registry comes from re-projecting the document, never from the
	// package's own list, so the two can never be stored disagreeing.
	if len(imported.ExecutionHosts) != 2 {
		t.Fatalf("the import projected %+v", imported.ExecutionHosts)
	}

	// A shape this build does not read is refused rather than guessed at.
	future, _ := proto.Clone(exported.Package).(*pb.SettingsPackage)
	future.Version = 99
	if _, err = f.service.ImportPackage(t.Context(), f.caller, &pb.ImportSettingsRequest{
		OperationId: "import-3", ExpectedRevision: 3, Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, Package: future,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown package version answered %v", err)
	}
}

// The splice is what makes "write one host" honest. Anything it does not touch
// has to survive byte for byte, including a section it shares with `hosts`.
func TestTheSpliceLeavesEverythingElseAlone(t *testing.T) {
	original := `{"z":1,"ssh":{"knownHosts":"ask","hosts":[]},"a":{"deep":[1,2]}}`
	next, err := spliceExecutionHosts([]byte(original), []*pb.ExecutionHost{testBox()})
	if err != nil {
		t.Fatal(err)
	}
	// Order is preserved: a Go map round trip would sort these, and the digest
	// a switch compares would then change for no reason anybody could read.
	if !strings.HasPrefix(string(next), `{"z":1,"ssh":{"knownHosts":"ask","hosts":[`) {
		t.Fatalf("the splice reordered the document: %s", next)
	}
	if !strings.Contains(string(next), `"a":{"deep":[1,2]}`) {
		t.Fatalf("an untouched section changed: %s", next)
	}
	if !strings.Contains(string(next), `"knownHosts":"ask"`) {
		t.Fatalf("a sibling of hosts was dropped: %s", next)
	}

	// A document with no `ssh` section at all grows one with just the registry.
	fresh, err := spliceExecutionHosts([]byte(`{"theme":"dark"}`), []*pb.ExecutionHost{testBox()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(fresh), `{"theme":"dark","ssh":{"hosts":[`) {
		t.Fatalf("a fresh registry was written as %s", fresh)
	}

	// A repeated key makes "which one is the document" a question about the
	// decoder, so it is refused rather than resolved.
	if _, err = spliceExecutionHosts([]byte(`{"a":1,"a":2}`), nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a repeated key answered %v", err)
	}
}
