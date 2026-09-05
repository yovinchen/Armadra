package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const testHost = "0123456789abcdef0123456789abcdef"

var testContext = context.Background()

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store, dir
}
func payload(t *testing.T, value string) []byte {
	t.Helper()
	data, err := proto.Marshal(wrapperspb.String(value))
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func key(id string) Key { return Key{WorkspaceID: "workspace-a", Kind: "canvas.node", ID: id} }
func create(t *testing.T, store *Store, id string) ApplyResult {
	t.Helper()
	result, err := store.Apply(testContext, "principal/workspace-a/create/"+id, []Change{{Key: key(id), Payload: payload(t, id)}})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestFileReopenHostBindingAndUntouchedCanvas(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private host # 中文 ?")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	canvas := filepath.Join(dir, "canvas.db")
	original := []byte("not the host database")
	if err := os.WriteFile(canvas, original, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	if store.HostID() != testHost || filepath.Base(store.Path()) != "host.db" {
		t.Fatal("incorrect host binding")
	}
	content := append(payload(t, "persist 中文"), 0xa0, 0x06, 0x07) // unknown protobuf field 100
	receipt, err := store.Apply(testContext, "principal/workspace-a/create/persist", []Change{{Key: key("persist"), Payload: content}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	entity, err := reopened.Read(testContext, key("persist"))
	if err != nil || entity.Revision != 1 || !bytes.Equal(entity.Payload, content) {
		t.Fatalf("reopen lost exact payload: %+v %v", entity, err)
	}
	events, err := reopened.GetEvents(testContext, EventQuery{})
	if err != nil || len(events.Events) != 1 || events.Events[0].Sequence != receipt.LastSequence {
		t.Fatalf("outbox not persisted: %+v %v", events, err)
	}
	if data, _ := os.ReadFile(canvas); !bytes.Equal(data, original) {
		t.Fatal("canvas.db was modified")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(dir)
		if info.Mode().Perm() != 0700 {
			t.Fatalf("directory mode %o", info.Mode().Perm())
		}
		info, _ = os.Stat(reopened.Path())
		if info.Mode().Perm() != 0600 {
			t.Fatalf("database mode %o", info.Mode().Perm())
		}
	}
	if _, err := Open(dir, "fedcba9876543210fedcba9876543210"); !errors.Is(err, ErrHostMismatch) {
		t.Fatalf("different host accepted: %v", err)
	}
}

func TestAtomicChangesEventsAndReplayReceipt(t *testing.T) {
	store, _ := openTestStore(t)
	changes := []Change{{Key: key("a"), Payload: payload(t, "a")}, {Key: key("b"), Payload: payload(t, "b")}}
	result, err := store.Apply(testContext, "principal/workspace-a/batch/1", changes)
	if err != nil {
		t.Fatal(err)
	}
	if result.FirstSequence != 1 || result.LastSequence != 2 || len(result.Revisions) != 2 || result.TransactionID == 0 || result.Replayed {
		t.Fatalf("bad receipt %+v", result)
	}
	events, err := store.GetEvents(testContext, EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	for index, event := range events.Events {
		if event.TransactionID != result.TransactionID || event.OperationID != result.OperationID || event.TransactionIndex != index || event.TransactionSize != 2 || event.Sequence != uint64(index+1) {
			t.Fatalf("not one ordered transaction: %+v", events)
		}
	}
	_, err = store.Apply(testContext, "principal/workspace-a/update/a", []Change{{Key: key("a"), ExpectedRevision: 1, Payload: payload(t, "newer")}})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := store.Apply(testContext, result.OperationID, changes)
	if err != nil {
		t.Fatal(err)
	}
	comparable := replay
	comparable.Replayed = false
	if !replay.Replayed || !reflect.DeepEqual(result, comparable) {
		t.Fatalf("replay did not return original receipt: %+v", replay)
	}
	changed := append([]Change(nil), changes...)
	changed[0].Payload = payload(t, "different")
	if _, err = store.Apply(testContext, result.OperationID, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("digest mismatch accepted: %v", err)
	}
	latest, err := store.GetEvents(testContext, EventQuery{})
	if err != nil || latest.HighWatermark != 3 || len(latest.Events) != 3 {
		t.Fatalf("replay emitted events: %+v %v", latest, err)
	}
	entity, _ := store.Read(testContext, key("a"))
	if entity.Revision != 2 || !bytes.Equal(entity.Payload, payload(t, "newer")) {
		t.Fatal("old receipt replay overwrote current state")
	}
}

func TestBatchCASFailureRollsBackEntityOutboxAndReceipt(t *testing.T) {
	store, _ := openTestStore(t)
	create(t, store, "existing")
	_, err := store.Apply(testContext, "principal/workspace-a/batch/retry", []Change{
		{Key: key("would-create"), Payload: payload(t, "must roll back")},
		{Key: key("existing"), ExpectedRevision: 0, Payload: payload(t, "wrong revision")},
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected CAS failure: %v", err)
	}
	if _, err := store.Read(testContext, key("would-create")); !errors.Is(err, ErrNotFound) {
		t.Fatal("partial entity survived")
	}
	events, _ := store.GetEvents(testContext, EventQuery{})
	if events.HighWatermark != 1 || len(events.Events) != 1 {
		t.Fatal("partial outbox survived")
	}
	// The failed operation ID was not committed and can be retried with a corrected request.
	retry, err := store.Apply(testContext, "principal/workspace-a/batch/retry", []Change{{Key: key("would-create"), Payload: payload(t, "committed")}, {Key: key("existing"), ExpectedRevision: 1, Payload: payload(t, "updated")}})
	if err != nil || retry.Replayed || retry.FirstSequence != 2 || retry.LastSequence != 3 {
		t.Fatalf("failed receipt persisted: %+v %v", retry, err)
	}
}

func TestConcurrentStoreHandlesCASHasOneWinner(t *testing.T) {
	first, dir := openTestStore(t)
	create(t, first, "shared")
	second, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	ready := make(chan struct{})
	outcomes := make(chan error, 2)
	var wg sync.WaitGroup
	for index, store := range []*Store{first, second} {
		wg.Add(1)
		go func(index int, store *Store) {
			defer wg.Done()
			<-ready
			_, err := store.Apply(testContext, "principal/workspace-a/update/"+string(rune('a'+index)), []Change{{Key: key("shared"), ExpectedRevision: 1, Payload: []byte{0x08, byte(index)}}})
			outcomes <- err
		}(index, store)
	}
	close(ready)
	wg.Wait()
	close(outcomes)
	won, conflicted := 0, 0
	for err := range outcomes {
		if err == nil {
			won++
		} else if errors.Is(err, ErrConflict) {
			conflicted++
		} else {
			t.Fatal(err)
		}
	}
	if won != 1 || conflicted != 1 {
		t.Fatalf("winners %d conflicts %d", won, conflicted)
	}
	entity, _ := first.Read(testContext, key("shared"))
	if entity.Revision != 2 {
		t.Fatalf("revision %d", entity.Revision)
	}
	events, _ := first.GetEvents(testContext, EventQuery{})
	if events.HighWatermark != 2 {
		t.Fatal("losing writer emitted event")
	}
}

func TestTombstonesPreventABAAndListHasBoundaries(t *testing.T) {
	store, _ := openTestStore(t)
	for _, id := range []string{"a", "b", "c"} {
		create(t, store, id)
	}
	_, err := store.Apply(testContext, "principal/workspace-a/delete/b", []Change{{Key: key("b"), ExpectedRevision: 1, Delete: true}})
	if err != nil {
		t.Fatal(err)
	}
	dead, err := store.Read(testContext, key("b"))
	if err != nil || !dead.Deleted || dead.Revision != 2 || len(dead.Payload) != 0 {
		t.Fatalf("missing tombstone: %+v %v", dead, err)
	}
	if _, err = store.Apply(testContext, "principal/workspace-a/recreate/b", []Change{{Key: key("b"), Payload: payload(t, "ABA")}}); !errors.Is(err, ErrConflict) {
		t.Fatal("deleted identity recreated as revision zero")
	}
	page, err := store.List(testContext, ListOptions{WorkspaceID: "workspace-a", Kind: "canvas.node", Limit: 1})
	if err != nil || len(page.Entities) != 1 || page.Entities[0].ID != "a" || !page.HasMore {
		t.Fatalf("first page %+v %v", page, err)
	}
	next, err := store.List(testContext, ListOptions{WorkspaceID: "workspace-a", Kind: "canvas.node", Limit: 1, AfterID: page.NextID})
	if err != nil || len(next.Entities) != 1 || next.Entities[0].ID != "c" || next.HasMore {
		t.Fatalf("next page %+v %v", next, err)
	}
	all, _ := store.List(testContext, ListOptions{WorkspaceID: "workspace-a", Kind: "canvas.node", IncludeDeleted: true})
	if len(all.Entities) != 3 {
		t.Fatal("tombstones omitted when requested")
	}
	_, err = store.Apply(testContext, "principal/workspace-a/resurrect/b", []Change{{Key: key("b"), ExpectedRevision: 2, Payload: payload(t, "restored")}})
	if err != nil {
		t.Fatal(err)
	}
	revived, _ := store.Read(testContext, key("b"))
	if revived.Revision != 3 || revived.Deleted {
		t.Fatal("resurrection lost revision lineage")
	}
}

func TestEventRetentionRequiresSnapshotAndKeepsReplayReceipts(t *testing.T) {
	store, _ := openTestStore(t)
	changes := []Change{{Key: key("a"), Payload: payload(t, "a")}, {Key: key("b"), Payload: payload(t, "b")}}
	receipt, err := store.Apply(testContext, "principal/workspace-a/create/pair", changes)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.PruneEvents(testContext, 1); !errors.Is(err, ErrInvalid) {
		t.Fatal("retention split a transaction")
	}
	if err = store.PruneEvents(testContext, 2); err != nil {
		t.Fatal(err)
	}
	expired, err := store.GetEvents(testContext, EventQuery{After: 0})
	if err != nil || expired.Status != SnapshotRequired || expired.MinCursor != 2 || len(expired.Events) != 0 {
		t.Fatalf("expired cursor not explicit: %+v %v", expired, err)
	}
	valid, _ := store.GetEvents(testContext, EventQuery{After: 2})
	if valid.Status != CursorOK || valid.HighWatermark != 2 {
		t.Fatal("floor boundary should be valid")
	}
	future, _ := store.GetEvents(testContext, EventQuery{After: 3})
	if future.Status != CursorAhead {
		t.Fatal("future cursor accepted")
	}
	replay, err := store.Apply(testContext, receipt.OperationID, changes)
	if err != nil || !replay.Replayed {
		t.Fatal("retention removed receipt")
	}
	create(t, store, "c")
	after, _ := store.GetEvents(testContext, EventQuery{After: 2})
	if len(after.Events) != 1 || after.Events[0].Sequence != 3 {
		t.Fatal("outbox sequence reset after retention")
	}
}

func TestCountersBoundsCancellationAndInvalidRequests(t *testing.T) {
	store, _ := openTestStore(t)
	cases := [][]Change{nil, {{Key: key("x"), ExpectedRevision: math.MaxUint64}}, {{Key: key("x")}, {Key: key("x")}}, {{Key: key("x"), Delete: true}}, {{Key: Key{Kind: "bad\nkind", ID: "x"}}}}
	for index, changes := range cases {
		if _, err := store.Apply(testContext, "principal/scope/invalid/"+string(rune('a'+index)), changes); err == nil {
			t.Fatalf("accepted invalid case %d", index)
		}
	}
	if _, err := store.GetEvents(testContext, EventQuery{After: math.MaxUint64}); !errors.Is(err, ErrCounterExhausted) {
		t.Fatal("wrapped cursor into signed SQLite integer")
	}
	ctx, cancel := context.WithCancel(testContext)
	cancel()
	if _, err := store.Apply(ctx, "principal/scope/cancel/1", []Change{{Key: key("cancel")}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request: %v", err)
	}
	if _, err := store.Read(testContext, key("cancel")); !errors.Is(err, ErrNotFound) {
		t.Fatal("canceled operation wrote data")
	}
	create(t, store, "max")
	if _, err := store.db.Exec("UPDATE entities SET revision=? WHERE entity_id='max'", int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(testContext, "principal/workspace-a/update/max", []Change{{Key: key("max"), ExpectedRevision: math.MaxInt64}}); !errors.Is(err, ErrCounterExhausted) {
		t.Fatalf("overflow revision accepted: %v", err)
	}
}

func TestLargeProtobufPayloadUsesStorageNotNetworkLimits(t *testing.T) {
	store, _ := openTestStore(t)
	large := payload(t, string(bytes.Repeat([]byte("x"), 9<<20)))
	if len(large) <= 8<<20 {
		t.Fatal("fixture must exceed a full whiteboard/network frame")
	}
	_, err := store.Apply(testContext, "principal/workspace-a/import/large", []Change{{Key: key("large"), Payload: large}, {Key: key("small"), Payload: payload(t, "tail")}})
	if err != nil {
		t.Fatal(err)
	}
	page, err := store.GetEvents(testContext, EventQuery{ByteBudget: 1024, Limit: 1000})
	if err != nil || len(page.Events) != 1 || !page.HasMore || !bytes.Equal(page.Events[0].Payload, large) {
		t.Fatalf("large event pagination failed: count=%d, more=%v, err=%v", len(page.Events), page.HasMore, err)
	}
	next, err := store.GetEvents(testContext, EventQuery{After: page.NextCursor, ByteBudget: 1024})
	if err != nil || len(next.Events) != 1 || next.HasMore {
		t.Fatal("large event cursor failed to advance")
	}
	entities, err := store.List(testContext, ListOptions{WorkspaceID: "workspace-a", Kind: "canvas.node", ByteBudget: 1024})
	if err != nil || len(entities.Entities) != 1 || !entities.HasMore {
		t.Fatal("entity list ignored byte budget")
	}
	tooLarge := make([]byte, MaxPayloadBytes+1)
	if _, err := store.Apply(testContext, "principal/workspace-a/import/too-large", []Change{{Key: key("rejected"), Payload: tooLarge}}); !errors.Is(err, ErrInvalid) {
		t.Fatal("entity size limit not enforced")
	}
}

func TestUnknownDirtyChangedAndForeignSchemaArePreserved(t *testing.T) {
	for _, scenario := range []string{"unknown-version", "dirty", "checksum", "extra-table", "altered-table", "foreign-host"} {
		t.Run(scenario, func(t *testing.T) {
			store, dir := openTestStore(t)
			create(t, store, "saved")
			var err error
			switch scenario {
			case "unknown-version":
				_, err = store.db.Exec("INSERT INTO schema_migrations(version,checksum,dirty,applied_at_ms) VALUES(2,?,0,0)", make([]byte, 32))
			case "dirty":
				_, err = store.db.Exec("UPDATE schema_migrations SET dirty=1")
			case "checksum":
				_, err = store.db.Exec("UPDATE schema_migrations SET checksum=?", make([]byte, 32))
			case "extra-table":
				_, err = store.db.Exec("CREATE TABLE sqliteX_unknown(value TEXT)")
			case "altered-table":
				_, err = store.db.Exec("ALTER TABLE entities ADD COLUMN unexpected TEXT")
			case "foreign-host":
				_, err = store.db.Exec("UPDATE store_meta SET host_id='fedcba9876543210fedcba9876543210'")
			}
			if err != nil {
				t.Fatal(err)
			}
			store.Close()
			before, err := os.ReadFile(store.Path())
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(before)
			opened, err := Open(dir, testHost)
			if opened != nil {
				opened.Close()
				t.Fatal("invalid schema accepted")
			}
			want := ErrSchema
			if scenario == "foreign-host" {
				want = ErrHostMismatch
			}
			if !errors.Is(err, want) {
				t.Fatalf("got %v, want %v", err, want)
			}
			after, err := os.ReadFile(store.Path())
			if err != nil || sha256.Sum256(after) != digest {
				t.Fatal("rejected database was modified or replaced")
			}
			// A read-only WAL attachment may create standard WAL/SHM bookkeeping.
			// These are not renamed backups or rebuilt database files.
			entries, _ := os.ReadDir(dir)
			for _, entry := range entries {
				if entry.Name() != "host.db" && entry.Name() != "host.db-wal" && entry.Name() != "host.db-shm" {
					t.Fatalf("unexpected recovery file %s", entry.Name())
				}
			}
		})
	}
}

func TestUnversionedAndCorruptFilesAreNotRebuilt(t *testing.T) {
	for _, kind := range []string{"foreign-sqlite", "random-bytes"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "host.db")
			if err := os.WriteFile(path, []byte{}, 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "random-bytes" {
				os.WriteFile(path, []byte("not a database"), 0600)
			} else {
				db, err := openSQL(path, "rw")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('preserve')"); err != nil {
					t.Fatal(err)
				}
				db.Close()
			}
			before, _ := os.ReadFile(path)
			if store, err := Open(dir, testHost); err == nil {
				store.Close()
				t.Fatal("recreated foreign/corrupt database")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("changed rejected file")
			}
		})
	}
}

func TestStagingOwnershipCASNeverActivates(t *testing.T) {
	store, dir := openTestStore(t)
	stage := Staging{ID: "import-1", OwnerID: "process-a", WorkspaceID: "workspace-a", Purpose: "legacy-import", RelativePath: "staging/import-1", LeaseUntilMS: time.Now().Add(time.Hour).UnixMilli(), Metadata: payload(t, "staged only")}
	first, err := store.PutStaging(testContext, stage, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || first.Active {
		t.Fatal("staging unexpectedly active")
	}
	steal := first
	steal.OwnerID = "process-b"
	if _, err = store.PutStaging(testContext, steal, "process-b", 1); !errors.Is(err, ErrOwnership) {
		t.Fatal("owner silently replaced")
	}
	transferred, err := store.PutStaging(testContext, steal, "process-a", 1)
	if err != nil || transferred.Revision != 2 {
		t.Fatalf("explicit transfer failed: %v", err)
	}
	if err = store.DeleteStaging(testContext, stage.ID, "process-a", 2); !errors.Is(err, ErrOwnership) {
		t.Fatal("old owner released another owner's staging")
	}
	if _, err = store.PutStaging(testContext, steal, "process-b", 1); !errors.Is(err, ErrConflict) {
		t.Fatal("stale revision accepted")
	}
	activation := transferred
	activation.Active = true
	if _, err = store.PutStaging(testContext, activation, "process-b", 2); !errors.Is(err, ErrInvalid) {
		t.Fatal("staging activated through metadata API")
	}
	records, err := store.ListStaging(testContext, StagingQuery{OwnerID: "process-b"})
	if err != nil || len(records.Records) != 1 {
		t.Fatalf("staging list: %+v %v", records, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "staging")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("metadata API created filesystem staging")
	}
	if err = store.DeleteStaging(testContext, stage.ID, "process-b", 2); err != nil {
		t.Fatal(err)
	}
	if _, err = store.GetStaging(testContext, stage.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("released staging remains")
	}
	if _, err = store.PutStaging(testContext, stage, "", 0); !errors.Is(err, ErrConflict) {
		t.Fatal("released staging ID was reused, permitting ownership ABA")
	}

}

func TestConcurrentOperationIdCannotCommitDifferentRequests(t *testing.T) {
	first, dir := openTestStore(t)
	second, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	start := make(chan struct{})
	results := make(chan error, 2)
	for index, store := range []*Store{first, second} {
		go func(index int, store *Store) {
			<-start
			_, err := store.Apply(testContext, "principal/workspace-a/action/same-id", []Change{{Key: key(string(rune('a' + index))), Payload: []byte{0x08, byte(index)}}})
			results <- err
		}(index, store)
	}
	close(start)
	success, rejected := 0, 0
	for count := 0; count < 2; count++ {
		err := <-results
		if err == nil {
			success++
		} else if errors.Is(err, ErrIdempotencyConflict) {
			rejected++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || rejected != 1 {
		t.Fatal("operation ID accepted two different requests")
	}
	events, err := first.GetEvents(testContext, EventQuery{})
	if err != nil || len(events.Events) != 1 {
		t.Fatal("conflicting operation emitted a second event")
	}
}

func TestUnsafeDatabaseAndCompanionsDoNotTouchTargets(t *testing.T) {
	for _, name := range []string{"host.db", "host.db-wal", "host.db-shm", "host.db-journal"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(t.TempDir(), "do-not-touch")
			original := []byte("unchanged target")
			if err := os.WriteFile(target, original, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
				t.Skipf("symlink unavailable: %v", err)
			}
			if store, err := Open(dir, testHost); err == nil {
				store.Close()
				t.Fatal("followed linked SQLite file")
			}
			after, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(after, original) {
				t.Fatal("linked target changed")
			}
		})
	}
	for _, name := range []string{"host.db", "host.db-wal"} {
		t.Run("hardlink-"+name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(t.TempDir(), "do-not-touch")
			original := []byte("unchanged hard-link target")
			if err := os.WriteFile(target, original, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(target, filepath.Join(dir, name)); err != nil {
				t.Skipf("hard link unavailable: %v", err)
			}
			if store, err := Open(dir, testHost); err == nil {
				store.Close()
				t.Fatal("accepted multiply-linked SQLite file")
			}
			after, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(after, original) {
				t.Fatal("hard-link target changed")
			}
		})
	}
}

func TestArtifactDirectoryProtectionRejectsLinksAndFiles(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "artifact")
	if err := os.Mkdir(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := ProtectArtifactDirectory(directory); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(directory)
		if info.Mode().Perm() != 0700 {
			t.Fatal("artifact directory is not private")
		}
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ProtectArtifactDirectory(file); !errors.Is(err, os.ErrPermission) {
		t.Fatal("accepted regular file as artifact directory")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(directory, link); err == nil {
		if err := ProtectArtifactDirectory(link); !errors.Is(err, os.ErrPermission) {
			t.Fatal("followed artifact directory symlink")
		}
	}
}
