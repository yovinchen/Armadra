package ownership

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"armadra.local/host/internal/storage"
)

// The maintenance window (Go Host 业务所有权迁移 §2.11, step 0).
//
// A running Host cannot take the data directory lock the CLI uses, so the
// window an HTTPS switch runs in is made of two things instead: the transitional
// phase both sides enter, and this token. The token is issued over the
// same-user OS control channel — the same channel a pairing ticket comes from,
// and for the same reason. Opening a maintenance window is an action taken at
// the machine. A remote device, however well authenticated, cannot reach that
// channel and therefore can never start a switch.
//
// One token covers one domain, lives two minutes, is spent once, and dies with
// the Host process that issued it.

const (
	// MaintenanceTTL is short on purpose: the token is carried from a terminal
	// to a browser tab by a person who is already at the machine.
	MaintenanceTTL = 2 * time.Minute
	// tokenBytes is the secret's length. It is never stored.
	tokenBytes = 32
)

// MaintenanceToken is what the control channel hands back. The value is
// returned exactly once and only its hash is kept.
type MaintenanceToken struct {
	Token       string
	Domain      string
	ExpiresAtMS int64
}

func digest(token string) []byte {
	sum := sha256.Sum256([]byte("maintenance." + token))
	return sum[:]
}

// IssueMaintenance mints a token for one domain. It refuses a domain this Host
// cannot move at all, so an operator learns that at the machine rather than
// after carrying a useless token to a browser.
func (s *Service) IssueMaintenance(ctx context.Context, domain string) (MaintenanceToken, error) {
	if !storage.ValidOwnershipDomain(domain) {
		return MaintenanceToken{}, ErrInvalid
	}
	if _, ok := s.options.Projectors[domain]; !ok {
		return MaintenanceToken{}, ErrUnsupportedDomain
	}
	secret := make([]byte, tokenBytes)
	if _, err := rand.Read(secret); err != nil {
		return MaintenanceToken{}, err
	}
	token := hex.EncodeToString(secret)
	now := s.now()
	record := storage.MaintenanceToken{
		Hash:        digest(token),
		Domain:      domain,
		InstanceID:  s.options.InstanceID,
		CreatedAtMS: now,
		ExpiresAtMS: now + MaintenanceTTL.Milliseconds(),
	}
	// Rows that can no longer be spent are dropped opportunistically. Nothing
	// depends on it: an expired token is refused whether or not its row is
	// still there.
	_ = s.options.Store.PruneMaintenanceTokens(ctx, now)
	if err := s.options.Store.PutMaintenanceToken(ctx, record); err != nil {
		return MaintenanceToken{}, err
	}
	return MaintenanceToken{Token: token, Domain: domain, ExpiresAtMS: record.ExpiresAtMS}, nil
}

// consumeMaintenance spends a token for exactly one domain. It runs after the
// cheap checks and before anything is written, so a switch that was going to be
// refused anyway does not burn the operator's trip to the machine.
func (s *Service) consumeMaintenance(ctx context.Context, domain, token string) error {
	if token == "" {
		return storage.ErrMaintenanceToken
	}
	return s.options.Store.ConsumeMaintenanceToken(ctx, digest(token), domain, s.options.InstanceID, s.now())
}
