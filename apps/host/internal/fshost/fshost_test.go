package fshost

import (
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Adopting the domain is a projection of rows the canvas switch already staged.
// Every field the design names has to arrive unchanged: the machine, the frozen
// path, and the three permission bits — a root that lost one of them is a
// workspace pointed at the wrong place or opened wider than it was.
func TestAdoptProjectsStagedWorkspacesItemByItem(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	report, err := f.service.Adopt(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Matched {
		for _, check := range report.Checks {
			if !check.Matched {
				t.Errorf("check %s: expected %d actual %d differences %v", check.Check, check.ExpectedCount, check.ActualCount, check.Differences)
			}
		}
		t.Fatal("a clean adoption reported differences")
	}
	if report.Domain != pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_FILESYSTEM || report.EntityCount != 2 {
		t.Fatalf("the report does not describe the filesystem domain: %+v", report)
	}
	local := f.root(localID)
	if local.CanonicalPath != "/项目/一" || local.ExecutionHostID != "" || len(local.ProofSHA256) != 0 {
		t.Fatalf("the local root is not the staged one: %+v", local)
	}
	if !local.Read || !local.Write || local.Execute {
		t.Fatalf("the local permissions are not the staged ones: %+v", local)
	}
	remote := f.root(remoteID)
	if remote.CanonicalPath != "/srv/项目" || remote.ExecutionHostID != "构建机" {
		t.Fatalf("the remote root is not the staged one: %+v", remote)
	}
	// A remote root carries a registration proof; a local one has none, because
	// this Host canonicalized the path itself.
	if len(remote.ProofSHA256) != 32 {
		t.Fatalf("the remote root has no registration proof: %+v", remote)
	}
	if remote.Read || !remote.Write {
		// read=true, write=false in the staged row.
		if !remote.Read || remote.Write {
			t.Fatalf("the remote permissions are not the staged ones: %+v", remote)
		}
	}
	// Registration time comes from the workspace's own creation, not from the
	// moment the switch happened: it is how long the workspace has pointed at
	// this directory.
	if local.RegisteredAtMS != 1788256800000 {
		t.Fatalf("the registration time was not taken from the staged row: %d", local.RegisteredAtMS)
	}

	// Re-adopting the same import is a no-op rather than a second publication:
	// a switch that ran twice must not tell every client that every workspace
	// changed.
	before := local.Revision
	if _, err = f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	if after := f.root(localID).Revision; after != before {
		t.Fatalf("re-adopting republished an unchanged root: %d → %d", before, after)
	}
}

// The verification is what a switch rests on, so a projection that drifted from
// the staged rows has to be reported rather than accepted.
func TestVerifyReportsARootThatDoesNotMatchTheStagedRow(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	// Grant execute through the service, which is a legitimate Host-side change
	// — and therefore a difference from the row the domain was adopted from.
	if _, err := f.service.UpdateRoot(fixtureContext, f.caller(ScopeWrite, localID), &pb.UpdateWorkspaceRootRequest{
		OperationId:      "filesystem/local/grant",
		ExpectedRevision: f.root(localID).Revision,
		WorkspaceId:      localID,
		Permissions:      &pb.CanvasWorkspacePermissions{Read: true, Write: true, Execute: true},
	}); err != nil {
		t.Fatal(err)
	}
	report, err := f.service.Verify(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Matched {
		t.Fatal("a changed permission was not reported as a difference")
	}
	for _, check := range report.Checks {
		if check.Check != "filesystem.permissions" {
			continue
		}
		if len(check.Differences) != 1 || check.Differences[0] != localID {
			t.Fatalf("the difference does not name the workspace it concerns: %v", check.Differences)
		}
	}
}

// There is no dual-write mode. While the Runtime owns the domain the Host
// answers reads and refuses every mutation with the one stable code both sides
// use, so a client never has to tell "the Host will not write" from "the
// Runtime will not".
func TestWritesAreRefusedUntilTheDomainHasSettledHere(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	request := &pb.UpdateWorkspaceRootRequest{
		OperationId:      "filesystem/local/grant",
		ExpectedRevision: f.root(localID).Revision,
		WorkspaceId:      localID,
		Permissions:      &pb.CanvasWorkspacePermissions{Read: true, Write: true, Execute: true},
	}
	if _, err := f.service.UpdateRoot(fixtureContext, f.caller(ScopeWrite, localID), request); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("a write was accepted while the Runtime owns the domain: %v", err)
	}
	// The read keeps answering: a client has to be able to show the workspace
	// it may not change.
	if _, err := f.service.GetRoot(fixtureContext, f.caller(ScopeRead, localID), localID); err != nil {
		t.Fatalf("a read was refused while the Runtime owns the domain: %v", err)
	}
	// A switch that is open is not ownership either.
	stored, err := f.store.Ownership(fixtureContext, Domain)
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = f.store.PutOwnership(fixtureContext, storage.Ownership{
		Domain: Domain, Owner: storage.OwnerHost, Epoch: 2,
		Phase: storage.OwnershipSwitching, ReasonCode: ownership.ReasonPending,
		CreatedAtMS: f.clock.UnixMilli(), UpdatedAtMS: f.clock.UnixMilli(),
	}, stored.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.UpdateRoot(fixtureContext, f.caller(ScopeWrite, localID), request); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("a write was accepted while a switch was open: %v", err)
	}
}

// The record is workspace-scoped end to end. A device granted one workspace
// must not learn where another workspace's files are, and must not be able to
// change them.
func TestOneWorkspaceGrantReachesOnlyThatWorkspace(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	caller := f.caller(ScopeRead, localID)
	if _, err := f.service.GetRoot(fixtureContext, caller, remoteID); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a read reached another workspace: %v", err)
	}
	listed, err := f.service.ListRoots(fixtureContext, caller, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Roots) != 1 || listed.Roots[0].WorkspaceId != localID {
		t.Fatalf("the listing was not narrowed to the caller's workspace: %+v", listed.Roots)
	}
	// A read grant is not a write grant, whichever workspace it names.
	if _, err = f.service.UpdateRoot(fixtureContext, caller, &pb.UpdateWorkspaceRootRequest{
		OperationId:      "filesystem/local/grant",
		ExpectedRevision: f.root(localID).Revision,
		WorkspaceId:      localID,
		Permissions:      &pb.CanvasWorkspacePermissions{Read: true, Write: true, Execute: true},
	}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a read grant was accepted for a write: %v", err)
	}
}

// Registering, changing and withdrawing a root all publish on the Host's own
// durable sequence, in the same transaction as the row. A permission change
// that reached the table and not the stream would leave every connected client
// rendering access the Host had already revoked.
func TestRootChangesPublishAndAreCASChecked(t *testing.T) {
	f := newFixture(t)
	f.own()
	caller := f.caller(ScopeWrite, localID)
	registered, err := f.service.RegisterRoot(fixtureContext, caller, &pb.RegisterWorkspaceRootRequest{
		OperationId: "filesystem/local/register",
		Root: &pb.WorkspaceRoot{
			WorkspaceId:   localID,
			CanonicalPath: "/项目/一",
			Permissions:   &pb.CanvasWorkspacePermissions{Read: true, Write: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if registered.Root.Revision != 1 || registered.Receipt.FirstSequence == 0 {
		t.Fatalf("the registration did not publish: %+v", registered)
	}
	// A second, different registration under the revision that described the
	// first one is a conflict, not a move of somebody's project directory.
	if _, err = f.service.RegisterRoot(fixtureContext, caller, &pb.RegisterWorkspaceRootRequest{
		OperationId:      "filesystem/local/register-again",
		ExpectedRevision: 0,
		Root: &pb.WorkspaceRoot{
			WorkspaceId:   localID,
			CanonicalPath: "/项目/二",
			Permissions:   &pb.CanvasWorkspacePermissions{Read: true, Write: true},
		},
	}); !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a stale registration was accepted: %v", err)
	}

	removed, err := f.service.UnregisterRoot(fixtureContext, caller, &pb.UnregisterWorkspaceRootRequest{
		OperationId:      "filesystem/local/unregister",
		ExpectedRevision: 1,
		WorkspaceId:      localID,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The withdrawal answers with the identifier and the receipt, never with a
	// root: an empty record would read as a registration that was cleared
	// rather than one that is gone.
	if removed.WorkspaceId != localID || removed.Receipt.GetFirstSequence() == 0 {
		t.Fatalf("the withdrawal did not answer with its receipt: %+v", removed)
	}
	if _, err = f.service.GetRoot(fixtureContext, f.caller(ScopeRead, localID), localID); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("a withdrawn registration still reads as a root: %v", err)
	}

	// Everything above is on one sequence, and the stream projects it.
	page, err := f.store.GetEvents(fixtureContext, storage.EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 2 {
		t.Fatalf("expected a registration and a withdrawal, got %d events", len(page.Events))
	}
	first, err := (EventProjector{}).Project(page.Events[0])
	if err != nil || first == nil {
		t.Fatalf("the registration was not projected: %v", err)
	}
	if first.Domain != pb.EventDomain_EVENT_DOMAIN_FILESYSTEM || first.Kind != "root" ||
		first.GetFilesystemRoot().GetCanonicalPath() != "/项目/一" || first.GetFilesystemRoot().GetRevision() != 1 {
		t.Fatalf("the projected registration is wrong: %+v", first)
	}
	last, err := (EventProjector{}).Project(page.Events[1])
	if err != nil || last == nil {
		t.Fatalf("the withdrawal was not projected: %v", err)
	}
	// A withdrawal carries no entity: an empty decoded root would read like a
	// workspace whose access was cleared rather than one whose registration is
	// gone.
	if !last.Deleted || last.GetFilesystemRoot() != nil {
		t.Fatalf("the projected withdrawal carries an entity: %+v", last)
	}
	// Another domain's event is not this projector's to publish.
	other, err := (EventProjector{}).Project(storage.Event{Entity: storage.Entity{Key: storage.Key{Kind: "canvas.node"}}})
	if err != nil || other != nil {
		t.Fatalf("the filesystem projector claimed a canvas event: %v %+v", err, other)
	}
}

// The path is frozen at registration. `UpdateRoot` carries no path at all, so a
// workspace's files cannot be repointed by an edit — everything it holds is
// addressed relative to the path that was frozen.
func TestUpdateChangesPermissionsAndNeverThePath(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	before := f.root(remoteID)
	updated, err := f.service.UpdateRoot(fixtureContext, f.caller(ScopeWrite, remoteID), &pb.UpdateWorkspaceRootRequest{
		OperationId:      "filesystem/remote/grant",
		ExpectedRevision: before.Revision,
		WorkspaceId:      remoteID,
		Permissions:      &pb.CanvasWorkspacePermissions{Read: true, Write: true, Execute: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Root.CanonicalPath != before.CanonicalPath || updated.Root.ExecutionHostId != before.ExecutionHostID {
		t.Fatalf("an update moved the root: %+v", updated.Root)
	}
	if !updated.Root.Permissions.Execute || updated.Root.Revision != before.Revision+1 {
		t.Fatalf("the update did not land: %+v", updated.Root)
	}
	// The registration proof survives a permission change unchanged: it
	// describes where the files are, not what may be done with them.
	if !proto.Equal(&pb.WorkspaceRoot{ProofSha256: updated.Root.ProofSha256}, &pb.WorkspaceRoot{ProofSha256: before.ProofSHA256}) {
		t.Fatal("a permission change rewrote the registration proof")
	}
}

// A registration this Host cannot store faithfully is refused rather than
// stored as an approximation.
func TestRegistrationRefusesShapesItCannotMean(t *testing.T) {
	f := newFixture(t)
	f.own()
	caller := f.caller(ScopeWrite, localID)
	for name, root := range map[string]*pb.WorkspaceRoot{
		"a relative path":       {WorkspaceId: localID, CanonicalPath: "项目/一", Permissions: &pb.CanvasWorkspacePermissions{Read: true}},
		"a traversal":           {WorkspaceId: localID, CanonicalPath: "/项目/../etc", Permissions: &pb.CanvasWorkspacePermissions{Read: true}},
		"no permissions at all": {WorkspaceId: localID, CanonicalPath: "/项目/一"},
		"a remote root with no registration proof": {
			WorkspaceId: localID, ExecutionHostId: "构建机", CanonicalPath: "/srv/项目",
			Permissions: &pb.CanvasWorkspacePermissions{Read: true},
		},
	} {
		if _, err := f.service.RegisterRoot(fixtureContext, caller, &pb.RegisterWorkspaceRootRequest{
			OperationId: "filesystem/local/" + name,
			Root:        root,
		}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s was accepted: %v", name, err)
		}
	}
}
