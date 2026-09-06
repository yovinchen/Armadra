package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v6 rebuilds write_ownership so it accepts six domains. SQLite cannot widen a
// CHECK, so the table is renamed aside and copied — which is exactly the step
// that could lose an installation's existing switch. It must not: a Host that
// already handed the canvas over keeps its epoch, its phase and the import the
// switch rests on.
func TestV6RebuildKeepsTheRecordedCanvasSwitch(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "host.db")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := openSQL(path, "rw")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ledgerSQL); err != nil {
		t.Fatal(err)
	}
	// Build the database exactly as a v5 Host would have left it.
	for version := 1; version <= 5; version++ {
		digest := sha256.Sum256([]byte(migrations[version-1]))
		if _, err = db.Exec("INSERT INTO schema_migrations VALUES(?,?,0,123)", version, digest[:]); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(migrations[version-1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec("PRAGMA user_version=5"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO store_meta(singleton,host_id) VALUES(1,?)", testHost); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO write_ownership(domain,owner,epoch,phase,import_id,reason_code,event_sequence,revision,created_at_ms,updated_at_ms)
	 VALUES('canvas','host',7,'settled','import-1','ownership.switch.verified',42,3,1788560523004,1788560523900)`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record, err := store.Ownership(ctx, OwnershipDomainCanvas)
	if err != nil {
		t.Fatal(err)
	}
	if record.Owner != OwnerHost || record.Epoch != 7 || record.Phase != OwnershipSettled ||
		record.ImportID != "import-1" || record.EventSequence != 42 || record.Revision != 3 ||
		record.CreatedAtMS != 1788560523004 || record.UpdatedAtMS != 1788560523900 {
		t.Fatalf("the rebuild changed the recorded switch: %+v", record)
	}
	// The five new domains are absent, not invented: this Host has never
	// switched them, and a row would claim a history it does not have.
	all, err := store.AllOwnership(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("the rebuild invented records: %v %d", err, len(all))
	}
	// And the widened CHECK now accepts every domain.
	for _, domain := range OwnershipDomains[1:] {
		stored, err := store.PutOwnership(ctx, Ownership{
			Domain: domain, Owner: OwnerRuntime, Phase: OwnershipSettled, Epoch: 1,
			ReasonCode: "ownership.initial", CreatedAtMS: 1788560523004, UpdatedAtMS: 1788560523004,
		}, 0)
		if err != nil || stored.Revision != 1 {
			t.Fatalf("%s was refused by the rebuilt table: %v", domain, err)
		}
	}
	version, err := validateSchema(ctx, store.db, testHost)
	if err != nil || version != SchemaVersion {
		t.Fatalf("v5 -> v%d schema: %d %v", SchemaVersion, version, err)
	}
}

// The validator folds migrations into the schema they must have produced. It
// has to model every statement form the migrations actually use, and refuse the
// ones it cannot: a statement it silently skipped would leave it blind to
// whatever that statement changed.
func TestExpectedObjectsModelsEveryStatementForm(t *testing.T) {
	objects, err := expectedObjects(len(migrations))
	if err != nil {
		t.Fatal(err)
	}
	// The renamed-aside table is gone and the rebuilt one is the current text.
	if _, ok := objects["write_ownership_v5"]; ok {
		t.Fatal("the intermediate table survived the fold")
	}
	if !strings.Contains(objects["write_ownership"], "domain IN ('canvas','settings'") {
		t.Fatalf("write_ownership is not the rebuilt definition: %s", objects["write_ownership"])
	}
	if _, ok := objects["maintenance_tokens"]; !ok {
		t.Fatal("v6 did not define maintenance_tokens")
	}
	// v9 introduces the two forms the fold had never met: a trigger, whose body
	// holds semicolons that must not split it, and a UNIQUE index, which is a
	// constraint rather than merely a lookup. Both are objects SQLite stores,
	// so both have to be compared like a column — a trigger that vanished would
	// be a bundle freeze silently stopping.
	if !strings.Contains(objects["freeze_agent_handoff_bundle"], "RAISE(ABORT,") {
		t.Fatalf("the handoff freeze trigger did not fold into one object: %q", objects["freeze_agent_handoff_bundle"])
	}
	if !strings.HasPrefix(objects["idx_agent_mailbox_key"], "CREATE UNIQUE INDEX") {
		t.Fatalf("the mailbox key constraint folded as a plain index: %q", objects["idx_agent_mailbox_key"])
	}
	if _, ok := objects["END"]; ok {
		t.Fatal("the trigger body was split into a statement of its own")
	}

	// v1 through v5 fold to exactly what they folded to before v6 existed:
	// the validator change must not move an older database's expectations.
	fifth, err := expectedObjects(5)
	if err != nil {
		t.Fatal(err)
	}
	if len(fifth) != 20 || !strings.Contains(fifth["write_ownership"], "domain = 'canvas'") {
		t.Fatalf("the fold changed for v5: %d objects", len(fifth))
	}

	original := migrations
	t.Cleanup(func() { migrations = original })
	for name, statement := range map[string]string{
		"unknown form":         "TRUNCATE TABLE entities",
		"rename to nothing":    "ALTER TABLE entities RENAME",
		"drop before create":   "DROP TABLE never_created",
		"rename before create": "ALTER TABLE never_created RENAME TO something",
	} {
		migrations = append(append([]string{}, original...), statement)
		if _, err = expectedObjects(len(migrations)); !errors.Is(err, ErrSchema) {
			t.Fatalf("%s was folded silently: %v", name, err)
		}
	}
}

// The published SQL of every earlier version is a checksum in existing
// databases. Changing one would make this build refuse to open them.
func TestPublishedSchemaStringsAreUnchanged(t *testing.T) {
	for version, published := range map[int]string{
		1: "4666c132f859310554606295c668ec0d6de7e7198bac9c774a54515bacac2d9e",
		2: "c0ea936da2aa3e75437f301907fcb5e37b39d182c0f7ee8f997c559e8b8dd02e",
		3: "c009f4186fe33cf654e7d0c05fdee8f0624c1112ad70bccf8660ba4b79f2bf50",
		4: "7ba294cdc1863f0948438971ee1b08c618f253b4dbe07a50fe8f1f913be4e3bd",
		5: "1cbefb5866f923003d42e125089062f3e8b2f8732948a81644e99bc2b0f46c29",
	} {
		sum := sha256.Sum256([]byte(migrations[version-1]))
		if hex.EncodeToString(sum[:]) != published {
			t.Fatalf("published v%d SQL changed; append a migration instead", version)
		}
	}
}
