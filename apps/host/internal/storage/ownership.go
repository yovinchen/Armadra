package storage

import (
	"context"
	"database/sql"
	"errors"
	"slices"
)

// Write ownership of a business domain (host protocol design §4, step 5;
// Go Host 业务所有权迁移 §2.2).
//
// There is one row per domain and six domains. Each record answers a single
// question — which process may write that domain right now, and under which
// epoch — and it answers it explicitly. Nothing here infers ownership from a
// missing row: an absent record is ErrNotFound, never "the Runtime presumably
// still owns it".
//
// The record deliberately lives outside entities/events. It is not business
// content, so it must never be published to a client as a business change and
// must never be replayed out of the event outbox.

const (
	OwnershipDomainCanvas     = "canvas"
	OwnershipDomainSettings   = "settings"
	OwnershipDomainFilesystem = "filesystem"
	OwnershipDomainSession    = "session"
	OwnershipDomainAgent      = "agent"
	OwnershipDomainGit        = "git"

	OwnerRuntime = "runtime"
	OwnerHost    = "host"

	// A settled record is authoritative. The two transitional phases mean a
	// maintenance window is open: both sides refuse writes until the phase is
	// resolved, and a crash mid-switch is therefore visible rather than
	// resolving itself into two processes that both believe they own the data.
	OwnershipSettled     = "settled"
	OwnershipSwitching   = "switching"
	OwnershipRollingBack = "rolling_back"
)

type Ownership struct {
	Domain, Owner, Phase string
	Epoch                uint64
	ImportID, ReasonCode string
	// EventSequence is the Host's event watermark when this record was last
	// settled. A rollback compares it with the current watermark to tell
	// whether the Host published canvas changes a reverse migration would have
	// to carry back, instead of assuming it published none.
	EventSequence            uint64
	Revision                 uint64
	CreatedAtMS, UpdatedAtMS int64
}

// OwnershipDomains lists every domain in switch order, which is also the order
// dependencies are checked in. It is the only place the set is written down.
var OwnershipDomains = []string{
	OwnershipDomainCanvas,
	OwnershipDomainSettings,
	OwnershipDomainFilesystem,
	OwnershipDomainSession,
	OwnershipDomainAgent,
	OwnershipDomainGit,
}

// ValidOwnershipDomain reports whether a name is one of the six. The migration
// constrains the column the same way; refusing here keeps a caller's mistake a
// request error instead of a database one.
func ValidOwnershipDomain(value string) bool {
	return slices.Contains(OwnershipDomains, value)
}

func validOwner(value string) bool { return value == OwnerRuntime || value == OwnerHost }
func validPhase(value string) bool {
	return value == OwnershipSettled || value == OwnershipSwitching || value == OwnershipRollingBack
}

func (o Ownership) validate() error {
	if !ValidOwnershipDomain(o.Domain) || !validOwner(o.Owner) || !validPhase(o.Phase) {
		return ErrInvalid
	}
	if o.Epoch == 0 || !textValid(o.ImportID, 128, true) || !textValid(o.ReasonCode, 64, true) {
		return ErrInvalid
	}
	if o.CreatedAtMS <= 0 || o.UpdatedAtMS <= 0 {
		return ErrInvalid
	}
	if _, err := signed(o.Epoch); err != nil {
		return err
	}
	return nil
}

const ownershipColumns = "SELECT domain,owner,epoch,phase,import_id,reason_code,event_sequence,revision,created_at_ms,updated_at_ms FROM write_ownership WHERE domain=?"

func scanOwnership(row scanner) (Ownership, error) {
	var record Ownership
	var epoch, sequence, revision int64
	err := row.Scan(&record.Domain, &record.Owner, &epoch, &record.Phase, &record.ImportID, &record.ReasonCode, &sequence, &revision, &record.CreatedAtMS, &record.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return Ownership{}, ErrNotFound
	}
	if err != nil {
		return Ownership{}, err
	}
	if epoch < 1 || revision < 1 || sequence < 0 {
		return Ownership{}, ErrCorrupt
	}
	record.Epoch = uint64(epoch)
	record.EventSequence = uint64(sequence)
	record.Revision = uint64(revision)
	if record.validate() != nil {
		return Ownership{}, ErrCorrupt
	}
	return record, nil
}

// Ownership reads one domain's record. ErrNotFound means no switch has ever
// been recorded on this Host for that domain, which the caller reports as such.
func (s *Store) Ownership(ctx context.Context, domain string) (Ownership, error) {
	if !ValidOwnershipDomain(domain) {
		return Ownership{}, ErrInvalid
	}
	return scanOwnership(s.db.QueryRowContext(ctx, ownershipColumns, domain))
}

// PutOwnership writes the record under revision CAS. Expected revision 0 means
// "never recorded". The epoch is monotonic across every transition: a phase may
// move forward and back, but an epoch never decreases, so a stale controller
// cannot re-apply an older handoff after a newer one landed.
func (s *Store) PutOwnership(ctx context.Context, record Ownership, expectedRevision uint64) (Ownership, error) {
	if err := record.validate(); err != nil {
		return Ownership{}, err
	}
	next, err := signed(expectedRevision + 1)
	if err != nil {
		return Ownership{}, err
	}
	epoch, err := signed(record.Epoch)
	if err != nil {
		return Ownership{}, err
	}
	sequence, err := signed(record.EventSequence)
	if err != nil {
		return Ownership{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Ownership{}, err
	}
	defer tx.Rollback()
	existing, err := scanOwnership(tx.QueryRowContext(ctx, ownershipColumns, record.Domain))
	switch {
	case errors.Is(err, ErrNotFound):
		if expectedRevision != 0 {
			return Ownership{}, ErrConflict
		}
		record.Revision = 1
		if _, err = tx.ExecContext(ctx, "INSERT INTO write_ownership(domain,owner,epoch,phase,import_id,reason_code,event_sequence,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,1,?,?)",
			record.Domain, record.Owner, epoch, record.Phase, record.ImportID, record.ReasonCode, sequence, record.CreatedAtMS, record.UpdatedAtMS); err != nil {
			return Ownership{}, err
		}
		return record, tx.Commit()
	case err != nil:
		return Ownership{}, err
	}
	if existing.Revision != expectedRevision {
		return Ownership{}, ErrConflict
	}
	if record.Epoch < existing.Epoch {
		return Ownership{}, ErrConflict
	}
	record.Revision = uint64(next)
	record.CreatedAtMS = existing.CreatedAtMS
	if err = changed(tx.ExecContext(ctx, "UPDATE write_ownership SET owner=?,epoch=?,phase=?,import_id=?,reason_code=?,event_sequence=?,revision=?,updated_at_ms=? WHERE domain=? AND revision=?",
		record.Owner, epoch, record.Phase, record.ImportID, record.ReasonCode, sequence, next, record.UpdatedAtMS, record.Domain, int64(expectedRevision))); err != nil {
		return Ownership{}, err
	}
	return record, tx.Commit()
}

// AllOwnership reads every recorded domain, keyed by domain name. Domains with
// no record are simply absent: this is the store, and inventing a default here
// would make an unrecorded domain indistinguishable from one this Host really
// did take over. The caller decides what "never recorded" means, once.
func (s *Store) AllOwnership(ctx context.Context) (map[string]Ownership, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT domain,owner,epoch,phase,import_id,reason_code,event_sequence,revision,created_at_ms,updated_at_ms FROM write_ownership")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make(map[string]Ownership, len(OwnershipDomains))
	for rows.Next() {
		record, err := scanOwnership(rows)
		if err != nil {
			return nil, err
		}
		records[record.Domain] = record
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}
