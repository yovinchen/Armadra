package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestV1UpgradePreservesPublishedSQLAndBusinessRecords(t *testing.T) {
	// Digests of the published migrations, independent of the current ledger.
	for version, published := range map[int]string{
		1: "4666c132f859310554606295c668ec0d6de7e7198bac9c774a54515bacac2d9e",
		2: "c0ea936da2aa3e75437f301907fcb5e37b39d182c0f7ee8f997c559e8b8dd02e",
	} {
		sum := sha256.Sum256([]byte(migrations[version-1]))
		if hex.EncodeToString(sum[:]) != published {
			t.Fatalf("published v%d SQL changed; append a migration instead", version)
		}
	}
	digest := sha256.Sum256([]byte(schemaV1))
	dir := t.TempDir()
	path := filepath.Join(dir, "host.db")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := openSQL(path, "rw")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ledgerSQL + ";" + schemaV1); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO schema_migrations VALUES(1,?,0,123)", digest[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO store_meta(singleton,host_id) VALUES(1,?)", testHost); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	oldPayload := payload(t, "existing business bytes 中文")
	if _, err = db.Exec("INSERT INTO entities(workspace_id,kind,entity_id,revision,payload,deleted) VALUES('w','canvas.node','original',7,?,0)", oldPayload); err != nil {
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
	record, err := store.Read(testContext, Key{WorkspaceID: "w", Kind: "canvas.node", ID: "original"})
	if err != nil || record.Revision != 7 || !bytes.Equal(record.Payload, oldPayload) {
		t.Fatalf("upgrade altered existing entity: %v", err)
	}
	var oldChecksum []byte
	var applied int64
	if err = store.db.QueryRow("SELECT checksum,applied_at_ms FROM schema_migrations WHERE version=1").Scan(&oldChecksum, &applied); err != nil || !bytes.Equal(oldChecksum, digest[:]) || applied != 123 {
		t.Fatal("upgrade rewrote historical migration receipt")
	}
	version, err := validateSchema(testContext, store.db, testHost)
	if err != nil || version != SchemaVersion {
		t.Fatalf("v1 -> v%d schema: %d %v", SchemaVersion, version, err)
	}
	events, err := store.GetEvents(testContext, EventQuery{})
	if err != nil || events.HighWatermark != 0 {
		t.Fatal("schema upgrade invented business events")
	}
}

func TestPrivateIdentityTransactionRollbackAndBounds(t *testing.T) {
	store, _ := openTestStore(t)
	injected := errors.New("injected transaction failure")
	err := store.IdentityTransaction(testContext, func(tx *IdentityTx) error {
		if err := tx.CreateOwner(IdentityOwner{PrincipalID: strings.Repeat("a", 32), CreatedAtMS: 1}); err != nil {
			return err
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatal(err)
	}
	err = store.IdentityTransaction(testContext, func(tx *IdentityTx) error {
		if _, err := tx.Owner(); !errors.Is(err, ErrNotFound) {
			t.Fatal("rolled back owner persisted")
		}
		if err := tx.RevokeDevice(strings.Repeat("b", 32), math.MaxUint64, 1); !errors.Is(err, ErrCounterExhausted) {
			t.Fatal("epoch overflow accepted")
		}
		if err := tx.RotateSession(strings.Repeat("c", 32), math.MaxUint64, [32]byte{}, [32]byte{}, [32]byte{}, 1); !errors.Is(err, ErrCounterExhausted) {
			t.Fatal("rotation overflow accepted")
		}
		if err := tx.RenewSessionCSRF(strings.Repeat("c", 32), math.MaxInt64, [32]byte{}); !errors.Is(err, ErrCounterExhausted) {
			t.Fatal("CSRF rotation overflow accepted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = store.IdentityTransaction(testContext, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal("nil callback accepted")
	}
}
