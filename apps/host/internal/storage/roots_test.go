package storage

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func root(id, path string) WorkspaceRoot {
	return WorkspaceRoot{
		WorkspaceID:    id,
		CanonicalPath:  path,
		Read:           true,
		Write:          true,
		RegisteredAtMS: 1788560523004,
		UpdatedAtMS:    1788560523004,
		Payload:        []byte("root-" + id),
	}
}

func tombstone(id string) WorkspaceRoot {
	return WorkspaceRoot{
		WorkspaceID:    id,
		Deleted:        true,
		RegisteredAtMS: 1788560523004,
		UpdatedAtMS:    1788560524000,
	}
}

// A registration is CAS'd like every other record here: the caller states the
// revision it read, and a second writer that decided against an older one is
// refused. Two clients pointing one workspace at two directories is exactly
// what that refusal prevents.
func TestWorkspaceRootRevisionCAS(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/register", root("w-1", "/项目/一"), 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("a first registration accepted a revision that cannot exist yet: %v", err)
	}
	first, err := store.PutWorkspaceRoot(ctx, "fs/w-1/register", root("w-1", "/项目/一"), 0)
	if err != nil || len(first.Revisions) != 1 || first.Revisions[0].Revision != 1 {
		t.Fatalf("the first registration did not store revision 1: %v %+v", err, first.Revisions)
	}
	if first.FirstSequence == 0 || first.FirstSequence != first.LastSequence {
		t.Fatalf("one registration did not publish exactly one event: %+v", first)
	}
	// The same request again is the caller's own retry, and answers the
	// receipt the first run produced rather than registering a second time.
	replay, err := store.PutWorkspaceRoot(ctx, "fs/w-1/register", root("w-1", "/项目/一"), 0)
	if err != nil || !replay.Replayed || replay.LastSequence != first.LastSequence {
		t.Fatalf("a replay was not the original receipt: %v %+v", err, replay)
	}
	// A different request under the same identifier is a reuse, not a retry.
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-1/register", root("w-1", "/项目/二"), 0); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("a reused operation id with different content was accepted: %v", err)
	}
	changed := root("w-1", "/项目/一")
	changed.Execute = true
	changed.UpdatedAtMS = 1788560600000
	changed.Payload = []byte("root-w-1-execute")
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-1/grant-stale", changed, 0); !errors.Is(err, ErrConflict) {
		t.Fatalf("a stale revision was accepted: %v", err)
	}
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-1/grant", changed, 1); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetWorkspaceRoot(ctx, "w-1")
	if err != nil || !stored.Execute || stored.Revision != 2 {
		t.Fatalf("the permission change did not land: %v %+v", err, stored)
	}
	// Registration time belongs to the first registration; a permission change
	// is not a new one.
	if stored.RegisteredAtMS != 1788560523004 || stored.UpdatedAtMS != 1788560600000 {
		t.Fatalf("the registration timestamps were rewritten: %+v", stored)
	}
}

// Withdrawing a registration leaves a revisioned tombstone. A row that simply
// vanished would let a delayed request re-register the workspace from zero,
// under a decision about a directory that is no longer the one being
// registered.
func TestWorkspaceRootTombstoneKeepsItsRevision(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/register", root("w-1", "/项目/一"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/unregister", tombstone("w-1"), 1); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetWorkspaceRoot(ctx, "w-1")
	if err != nil || !stored.Deleted || stored.Revision != 2 || stored.CanonicalPath != "" {
		t.Fatalf("the tombstone is not a tombstone: %v %+v", err, stored)
	}
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-1/again", root("w-1", "/项目/二"), 0); !errors.Is(err, ErrConflict) {
		t.Fatalf("a re-registration from zero was accepted over a tombstone: %v", err)
	}
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-1/again", root("w-1", "/项目/二"), 2); err != nil {
		t.Fatal(err)
	}
	// A listing answers which workspaces have a root, so a withdrawn one is
	// absent from it even though its row is still there.
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-2/register", root("w-2", "/项目/三"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-2/unregister", tombstone("w-2"), 1); err != nil {
		t.Fatal(err)
	}
	roots, more, err := store.ListWorkspaceRoots(ctx, "", 0)
	if err != nil || more || len(roots) != 1 || roots[0].WorkspaceID != "w-1" || roots[0].CanonicalPath != "/项目/二" {
		t.Fatalf("the listing did not exclude the withdrawn root: %v %+v", err, roots)
	}
	if _, err = store.GetWorkspaceRoot(ctx, "w-3"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a workspace that was never registered was not reported as such: %v", err)
	}
}

// The registration and the event that announces it are one transaction. A
// permission change that reached the table and not the outbox would leave every
// connected client showing access the Host has already revoked.
func TestWorkspaceRootPublishesOnTheSharedSequence(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	// A canvas entity first, so the filesystem event has to take the *next*
	// number on the same sequence rather than starting a second one.
	if _, err := store.Apply(ctx, "canvas/w-1/1", []Change{{Key: Key{Kind: "canvas.workspace", ID: "w-1", WorkspaceID: "w-1"}, Payload: []byte("canvas")}}); err != nil {
		t.Fatal(err)
	}
	applied, err := store.PutWorkspaceRoot(ctx, "fs/w-1/register", root("w-1", "/项目/一"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if applied.FirstSequence != 2 {
		t.Fatalf("the filesystem event did not continue the shared sequence: %+v", applied)
	}
	page, err := store.GetEvents(ctx, EventQuery{After: 1})
	if err != nil || len(page.Events) != 1 {
		t.Fatalf("the registration was not published: %v %+v", err, page)
	}
	event := page.Events[0]
	if event.Kind != RootKind || event.ID != "w-1" || event.WorkspaceID != "w-1" || event.Revision != 1 ||
		event.Deleted || !bytes.Equal(event.Payload, []byte("root-w-1")) {
		t.Fatalf("the published event does not describe the registration: %+v", event)
	}
	if page.HighWatermark != applied.LastSequence {
		t.Fatalf("the watermark did not advance with the registration: %d vs %d", page.HighWatermark, applied.LastSequence)
	}
	// The tombstone publishes too, and carries no payload: an empty decoded
	// record would read like a cleared registration rather than a removed one.
	if _, err = store.PutWorkspaceRoot(ctx, "fs/w-1/unregister", tombstone("w-1"), 1); err != nil {
		t.Fatal(err)
	}
	page, err = store.GetEvents(ctx, EventQuery{After: applied.LastSequence})
	if err != nil || len(page.Events) != 1 || !page.Events[0].Deleted || len(page.Events[0].Payload) != 0 {
		t.Fatalf("the withdrawal was not published as a tombstone: %v %+v", err, page.Events)
	}
}

// The record refuses shapes that would make it lie: a live registration with no
// directory, and a tombstone that still names one or still grants something.
func TestWorkspaceRootRefusesContradictoryRecords(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	empty := root("w-1", "")
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/empty", empty, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a registration with no directory was accepted: %v", err)
	}
	living := tombstone("w-1")
	living.CanonicalPath = "/项目/一"
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/living", living, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a tombstone that still names a directory was accepted: %v", err)
	}
	granting := tombstone("w-1")
	granting.Read = true
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/granting", granting, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a tombstone that still grants access was accepted: %v", err)
	}
	proof := root("w-1", "/项目/一")
	proof.ProofSHA256 = []byte{1, 2, 3}
	if _, err := store.PutWorkspaceRoot(ctx, "fs/w-1/proof", proof, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a registration proof that is not a sha256 was accepted: %v", err)
	}
}
