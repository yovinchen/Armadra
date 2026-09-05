package storage

import (
	"context"
	"errors"
	"testing"
)

func ownershipStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir(), "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func canvasOwnership(owner, phase string, epoch uint64) Ownership {
	return Ownership{
		Domain: OwnershipDomainCanvas, Owner: owner, Phase: phase, Epoch: epoch,
		ReasonCode: "test", CreatedAtMS: 1788560523004, UpdatedAtMS: 1788560523004,
	}
}

// A Host that never switched has no record at all. Reading one back as
// "the Runtime owns it" is the caller's decision to state, not the store's to
// invent, so the store says NOT_FOUND.
func TestOwnershipIsAbsentUntilItIsRecorded(t *testing.T) {
	store := ownershipStore(t)
	if _, err := store.Ownership(context.Background(), OwnershipDomainCanvas); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unrecorded domain answered with %v", err)
	}
	if _, err := store.Ownership(context.Background(), "terminal"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a domain this version does not own was accepted: %v", err)
	}
}

func TestOwnershipUsesRevisionCAS(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	first, err := store.PutOwnership(ctx, canvasOwnership(OwnerRuntime, OwnershipSettled, 1), 0)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 {
		t.Fatalf("the first record was stored at revision %d", first.Revision)
	}
	// A second "never recorded" write must not silently replace the first.
	if _, err = store.PutOwnership(ctx, canvasOwnership(OwnerHost, OwnershipSettled, 2), 0); !errors.Is(err, ErrConflict) {
		t.Fatalf("a stale create overwrote the record: %v", err)
	}
	if _, err = store.PutOwnership(ctx, canvasOwnership(OwnerHost, OwnershipSettled, 2), 7); !errors.Is(err, ErrConflict) {
		t.Fatalf("a wrong expected revision was accepted: %v", err)
	}
	second, err := store.PutOwnership(ctx, canvasOwnership(OwnerHost, OwnershipSwitching, 2), 1)
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != 2 || second.CreatedAtMS != first.CreatedAtMS {
		t.Fatalf("the update lost its creation time or revision: %v", second)
	}
	stored, err := store.Ownership(ctx, OwnershipDomainCanvas)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Owner != OwnerHost || stored.Phase != OwnershipSwitching || stored.Epoch != 2 {
		t.Fatalf("the stored record differs from what was written: %v", stored)
	}
}

// The epoch never goes backwards. A controller that re-applies an older handoff
// after a newer one landed must be refused, not obeyed.
func TestOwnershipEpochIsMonotonic(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	if _, err := store.PutOwnership(ctx, canvasOwnership(OwnerRuntime, OwnershipSettled, 5), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutOwnership(ctx, canvasOwnership(OwnerHost, OwnershipSettled, 4), 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("an older epoch was accepted: %v", err)
	}
	// The same epoch is allowed: a phase may change without a handoff.
	if _, err := store.PutOwnership(ctx, canvasOwnership(OwnerHost, OwnershipSwitching, 5), 1); err != nil {
		t.Fatalf("a phase change at the same epoch was refused: %v", err)
	}
}

func TestOwnershipRejectsValuesItCannotMean(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	for name, record := range map[string]Ownership{
		"unknown owner":   canvasOwnership("worker", OwnershipSettled, 1),
		"unknown phase":   canvasOwnership(OwnerHost, "paused", 1),
		"zero epoch":      canvasOwnership(OwnerHost, OwnershipSettled, 0),
		"other domain":    {Domain: "terminal", Owner: OwnerHost, Phase: OwnershipSettled, Epoch: 1, CreatedAtMS: 1, UpdatedAtMS: 1},
		"missing clock":   {Domain: OwnershipDomainCanvas, Owner: OwnerHost, Phase: OwnershipSettled, Epoch: 1},
		"unbounded epoch": canvasOwnership(OwnerHost, OwnershipSettled, 1<<63),
	} {
		if _, err := store.PutOwnership(ctx, record, 0); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

// The event watermark travels with the record: a rollback compares it against
// the current watermark to see whether the Host published anything since.
func TestOwnershipRemembersItsEventWatermark(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	record := canvasOwnership(OwnerHost, OwnershipSettled, 2)
	record.EventSequence = 9007199254740993
	if _, err := store.PutOwnership(ctx, record, 0); err != nil {
		t.Fatal(err)
	}
	stored, err := store.Ownership(ctx, OwnershipDomainCanvas)
	if err != nil {
		t.Fatal(err)
	}
	if stored.EventSequence != 9007199254740993 {
		t.Fatalf("the watermark was stored as %d", stored.EventSequence)
	}
}
