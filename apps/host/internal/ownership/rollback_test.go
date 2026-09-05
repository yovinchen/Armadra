package ownership

import (
	"errors"
	"testing"

	"armadra.local/host/internal/storage"
)

// Handing a domain back goes through the Runtime, not around it
// (Go Host 业务所有权迁移 §2.12).
//
// The state machine does not compare digests — that is the domain's work — but
// it decides two things no domain should have to: whether the package can be
// delivered at all, and which epoch it belongs to. Both are settled before a
// single file is written.

// A Runtime that cannot apply a package is refused at the start, so the
// operator is never left holding an export they now have to reason about. The
// only way past it is the flag that says so out loud.
func TestARollbackNeedsARuntimeThatCanImport(t *testing.T) {
	h := newHarness(t)
	h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	projector := h.projectors[storage.OwnershipDomainCanvas]
	released := projector.released

	h.runtime.noImport = true
	_, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toRuntime,
		Handoff: h.runtime, Importer: h.runtime, ExportDirectory: t.TempDir(),
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if !errors.Is(err, ErrReverseImportUnsupported) {
		t.Fatalf("a rollback was planned against a Runtime that cannot finish it: %v", err)
	}
	// A caller that simply forgot the importer is the same refusal: a rollback
	// with no way to deliver the package is not a rollback.
	if _, err = h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toRuntime,
		Handoff: h.runtime, ExportDirectory: t.TempDir(),
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	}); !errors.Is(err, ErrReverseImportUnsupported) {
		t.Fatalf("a rollback with no importer was accepted: %v", err)
	}
	if projector.released != released {
		t.Fatal("a refused rollback still asked the domain to write its package")
	}

	// The escape hatch stays available and stays explicit.
	result, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toRuntime,
		Handoff: h.runtime, Importer: h.runtime, ExportDirectory: t.TempDir(),
		AcceptExportOnly: true,
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if err != nil {
		t.Fatalf("the acknowledged export-only rollback failed: %v", err)
	}
	if result.Ownership.Owner != toRuntime || result.Ownership.Epoch != 3 {
		t.Fatalf("the export-only rollback settled on %v", result.Ownership)
	}
	if !projector.handback.AcceptExportOnly || h.runtime.importCalls != 0 {
		t.Fatalf("an export-only rollback still imported: %d call(s)", h.runtime.importCalls)
	}
}

// The package names the epoch the Runtime just acknowledged, never the one the
// Host assumed: applying a package to rows it does not describe is the failure
// the whole comparison exists to prevent.
func TestAHandbackCarriesTheAcknowledgedEpochAndTheChannel(t *testing.T) {
	h := newHarness(t)
	h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	directory := t.TempDir()
	if _, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toRuntime,
		Handoff: h.runtime, Importer: h.runtime, ExportDirectory: directory,
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	}); err != nil {
		t.Fatalf("the rollback failed: %v", err)
	}
	handback := h.projectors[storage.OwnershipDomainCanvas].handback
	if handback.Directory != directory || handback.AcceptExportOnly {
		t.Fatalf("the domain was handed %+v", handback)
	}
	if handback.Epoch != 2 {
		t.Fatalf("the package was written against epoch %d, not the acknowledged 2", handback.Epoch)
	}
	if handback.Importer == nil || !handback.Importer.SupportsReverseImport() {
		t.Fatal("the domain was given no way to deliver the package")
	}
}
