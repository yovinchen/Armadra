package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"
)

func tokenHash(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

// A token opens one window, on one domain, once. Every other outcome is the
// same refusal on purpose: distinguishing "expired" from "wrong domain" would
// tell a caller which half of a guess was right.
func TestMaintenanceTokenIsSingleUseAndBound(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	hash := tokenHash("window-1")
	if err := store.PutMaintenanceToken(ctx, MaintenanceToken{Hash: hash, Domain: OwnershipDomainCanvas, InstanceID: "instance-1", CreatedAtMS: 1000, ExpiresAtMS: 121000}); err != nil {
		t.Fatal(err)
	}
	// The same secret cannot be re-issued: that would silently extend an
	// expiry the operator is entitled to watch run out.
	if err := store.PutMaintenanceToken(ctx, MaintenanceToken{Hash: hash, Domain: OwnershipDomainCanvas, InstanceID: "instance-1", CreatedAtMS: 2000, ExpiresAtMS: 122000}); !errors.Is(err, ErrConflict) {
		t.Fatalf("a re-issued token was accepted: %v", err)
	}
	for name, attempt := range map[string]func() error{
		"unknown token":  func() error { return store.ConsumeMaintenanceToken(ctx, tokenHash("other"), OwnershipDomainCanvas, "instance-1", 2000) },
		"another domain": func() error { return store.ConsumeMaintenanceToken(ctx, hash, OwnershipDomainSession, "instance-1", 2000) },
		"another Host":   func() error { return store.ConsumeMaintenanceToken(ctx, hash, OwnershipDomainCanvas, "instance-2", 2000) },
		"after expiry":   func() error { return store.ConsumeMaintenanceToken(ctx, hash, OwnershipDomainCanvas, "instance-1", 121000) },
	} {
		if err := attempt(); !errors.Is(err, ErrMaintenanceToken) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if err := store.ConsumeMaintenanceToken(ctx, hash, OwnershipDomainCanvas, "instance-1", 2000); err != nil {
		t.Fatal(err)
	}
	// Spending it again is refused, which is what makes a replayed switch
	// request need a fresh trip to the machine.
	if err := store.ConsumeMaintenanceToken(ctx, hash, OwnershipDomainCanvas, "instance-1", 3000); !errors.Is(err, ErrMaintenanceToken) {
		t.Fatalf("a spent token was accepted again: %v", err)
	}
}

func TestMaintenanceTokenRejectsMalformedRecords(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	valid := MaintenanceToken{Hash: tokenHash("window-2"), Domain: OwnershipDomainAgent, InstanceID: "instance-1", CreatedAtMS: 1000, ExpiresAtMS: 121000}
	for name, token := range map[string]MaintenanceToken{
		"short hash":     {Hash: []byte{1}, Domain: valid.Domain, InstanceID: valid.InstanceID, CreatedAtMS: 1, ExpiresAtMS: 2},
		"unknown domain": {Hash: valid.Hash, Domain: "terminal", InstanceID: valid.InstanceID, CreatedAtMS: 1, ExpiresAtMS: 2},
		"no instance":    {Hash: valid.Hash, Domain: valid.Domain, CreatedAtMS: 1, ExpiresAtMS: 2},
		"expiry first":   {Hash: valid.Hash, Domain: valid.Domain, InstanceID: valid.InstanceID, CreatedAtMS: 5, ExpiresAtMS: 5},
	} {
		if err := store.PutMaintenanceToken(ctx, token); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if err := store.ConsumeMaintenanceToken(ctx, valid.Hash, "terminal", "instance-1", 1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown domain was consumed: %v", err)
	}
	if err := store.PutMaintenanceToken(ctx, valid); err != nil {
		t.Fatal(err)
	}
	// Pruning removes what can no longer be spent and nothing else.
	if err := store.PruneMaintenanceTokens(ctx, 2000); err != nil {
		t.Fatal(err)
	}
	if err := store.ConsumeMaintenanceToken(ctx, valid.Hash, OwnershipDomainAgent, "instance-1", 2000); err != nil {
		t.Fatalf("pruning dropped a live token: %v", err)
	}
	if err := store.PruneMaintenanceTokens(ctx, 3000); err != nil {
		t.Fatal(err)
	}
	if err := store.ConsumeMaintenanceToken(ctx, valid.Hash, OwnershipDomainAgent, "instance-1", 3000); !errors.Is(err, ErrMaintenanceToken) {
		t.Fatalf("a pruned token was still spendable: %v", err)
	}
}

// The secret itself is never stored. What is written is the hash the caller
// computed, and nothing in the row can be turned back into a usable token.
func TestMaintenanceTokenStoresOnlyTheHash(t *testing.T) {
	ctx := context.Background()
	store := ownershipStore(t)
	secret := "not-a-real-secret-value"
	hash := tokenHash(secret)
	if err := store.PutMaintenanceToken(ctx, MaintenanceToken{Hash: hash, Domain: OwnershipDomainCanvas, InstanceID: "instance-1", CreatedAtMS: 1, ExpiresAtMS: 121000}); err != nil {
		t.Fatal(err)
	}
	rows, err := store.db.QueryContext(ctx, "SELECT token_hash,domain,instance_id FROM maintenance_tokens")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var stored []byte
		var domain, instance string
		if err = rows.Scan(&stored, &domain, &instance); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(stored, hash) || bytes.Contains(stored, []byte(secret)) {
			t.Fatal("the stored row is not the hash of the token")
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
}
