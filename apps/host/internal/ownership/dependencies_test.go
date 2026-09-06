package ownership

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// A domain this Host has no projector for cannot be switched at all, so it
// cannot be waited for either. Counting it as a blocker would make every domain
// after it permanently unmovable — the switch order would enforce itself into a
// deadlock instead of into a sequence, which is the opposite of what it is for.
//
// This is what lets one domain land before the domain in front of it has been
// built. The moment that one's projector exists, it is checked like any other.
func TestSwitchSkipsADependencyThisHostCannotOwn(t *testing.T) {
	// Only canvas and filesystem are built here; settings sits between them in
	// the switch order and has no projector at all.
	h := newHarness(t, storage.OwnershipDomainCanvas, storage.OwnershipDomainFilesystem)
	h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	moved := h.switchTo(t, storage.OwnershipDomainFilesystem, toHost)
	if moved.Ownership.Owner != toHost || moved.Ownership.Epoch != 2 {
		t.Fatalf("the filesystem domain settled as %v", moved.Ownership)
	}
	// The plan reports what was actually verified, so an operator reads one
	// dependency here rather than being told two were checked.
	if len(moved.Plan.Dependencies) != 1 ||
		moved.Plan.Dependencies[0].Domain != pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS {
		t.Fatalf("the plan verified %v", moved.Plan.Dependencies)
	}

	// The domain that *is* built is still a blocker: skipping is about a domain
	// that cannot move, never about one that simply has not moved yet.
	back, err := h.service.Switch(testContext, Request{
		Domain:           storage.OwnershipDomainCanvas,
		Target:           toRuntime,
		Handoff:          h.runtime,
		Importer:         h.runtime,
		ExportDirectory:  t.TempDir(),
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if err == nil || back == nil {
		t.Fatalf("the canvas was handed back under a Host-owned filesystem: %v", err)
	}
}
