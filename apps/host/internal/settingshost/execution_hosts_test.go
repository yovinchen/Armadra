package settingshost

import (
	"errors"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

const twoHosts = `{"theme":"dark","ssh":{"hosts":[` +
	`{"id":"build-box","name":"构建机","host":"build.example","user":"ci","port":2222,` +
	`"identityFile":"/keys/ci","worker":{"path":"/opt/armadra/worker","stateDir":"/var/lib/armadra"}},` +
	`{"id":"test-box","name":"Test","host":"test.example","worker":{"path":"/opt/armadra/worker"}}]}}`

// The registry is a projection of the document, written in the same
// transaction. That is what lets an event name the host that changed instead of
// saying only that the document did.
func TestOneSaveProducesOneEventPerChangedHost(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", baseDocument, 0)

	// Adding a host touches the document and the new host, and nothing else.
	before := f.watermark()
	f.mustPut("save-2", twoHosts, 1)
	added := f.events(before)
	if names := envelopeNames(added); names != "document:global executionHost:test-box" {
		t.Fatalf("adding a host published %q", names)
	}
	if added[1].GetSettingsExecutionHost().GetSsh().GetWorkerPath() != "/opt/armadra/worker" {
		t.Fatalf("the new host arrived as %+v", added[1].GetSettingsExecutionHost())
	}

	// Changing one host leaves the other alone.
	changed := strings.Replace(twoHosts, `"user":"ci"`, `"user":"builder"`, 1)
	before = f.watermark()
	f.mustPut("save-3", changed, 2)
	if names := envelopeNames(f.events(before)); names != "document:global executionHost:build-box" {
		t.Fatalf("changing one host published %q", names)
	}

	// Removing one leaves a tombstone, and a tombstone carries no entity: the
	// id and the revision are the whole statement.
	before = f.watermark()
	f.mustPut("save-4", strings.Replace(changed, `"user":"builder"`, `"user":"ci"`, 1), 3)
	f.mustPut("save-5", baseDocument, 4)
	removed := f.events(before)
	last := removed[len(removed)-1]
	if last.Kind != "executionHost" || last.EntityId != "test-box" || !last.Deleted || last.GetSettingsExecutionHost() != nil {
		t.Fatalf("the removal published %+v", last)
	}
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.ExecutionHosts) != 2 || stored.ExecutionHosts[1].ExecutionHostId != "build-box" {
		t.Fatalf("the registry came back as %+v", stored.ExecutionHosts)
	}
}

// A host that comes back must carry the tombstone's revision, or the storage
// kernel refuses the resurrection. The service reads tombstones for exactly
// this reason, so a removed host can be re-added.
func TestARemovedHostCanComeBack(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", twoHosts, 0)
	f.mustPut("save-2", baseDocument, 1)
	f.mustPut("save-3", twoHosts, 2)
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.ExecutionHosts) != 3 {
		t.Fatalf("the restored registry has %d rows", len(stored.ExecutionHosts))
	}
	if stored.ExecutionHosts[2].Revision != 3 {
		t.Fatalf("the restored host is at revision %d, not past its tombstone", stored.ExecutionHosts[2].Revision)
	}
}

// A registry the Host cannot read is refused rather than skipped: storing it
// would make the document the source of a projection that does not exist.
func TestARegistryThatCannotBeProjectedIsRefused(t *testing.T) {
	f := newFixture(t)
	f.own()
	for name, body := range map[string]string{
		"ssh is not an object": `{"ssh":"none"}`,
		"hosts is not a list":  `{"ssh":{"hosts":{"id":"a"}}}`,
		"a host has no id":     `{"ssh":{"hosts":[{"name":"nameless"}]}}`,
		"two hosts share an id": `{"ssh":{"hosts":[{"id":"a","host":"one.example"},` +
			`{"id":"a","host":"two.example"}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := f.put("save-"+name, body, 0); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

// The Runtime's own rule for an execution host id is `[A-Za-z0-9_-]`
// (`terminal/ssh.rs`, `packages/shared/src/api/ssh.ts`). Every id it accepts
// has to project here, because a narrower alphabet on this side would not
// reject a bad registry — it would make one ordinary host named `build_box`
// unprojectable, and the settings domain could then never be switched at all.
func TestEveryIdentifierTheRuntimeAcceptsCanBeProjected(t *testing.T) {
	f := newFixture(t)
	f.own()
	body := `{"ssh":{"hosts":[{"id":"build_box","host":"one.example"},` +
		`{"id":"-leading-dash","host":"two.example"},` +
		`{"id":"9numeric","host":"three.example"}]}}`
	f.mustPut("save-1", body, 0)
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, host := range stored.ExecutionHosts {
		if host.Kind == pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH {
			ids = append(ids, host.ExecutionHostId)
		}
	}
	if strings.Join(ids, " ") != "-leading-dash 9numeric build_box" {
		t.Fatalf("projected %q", strings.Join(ids, " "))
	}
}

// A document with no registry at all is ordinary, not an error: a machine that
// only runs things locally has no SSH hosts.
func TestADocumentWithoutASshSectionHasNoHosts(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.mustPut("save-1", `{"theme":"dark"}`, 0)
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.ExecutionHosts) != 1 || stored.ExecutionHosts[0].Kind != pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL {
		t.Fatalf("a local-only machine reported %+v", stored.ExecutionHosts)
	}
}

// envelopeNames renders what a subscriber would have received, in order.
func envelopeNames(events []*pb.EventEnvelope) string {
	parts := make([]string, 0, len(events))
	for _, event := range events {
		if event.Domain != pb.EventDomain_EVENT_DOMAIN_SETTINGS || event.WorkspaceId != "" {
			return "unexpected envelope " + event.String()
		}
		parts = append(parts, event.Kind+":"+event.EntityId)
	}
	return strings.Join(parts, " ")
}
