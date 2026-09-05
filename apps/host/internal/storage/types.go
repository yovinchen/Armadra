// Package storage owns host.db only. Entity payloads are opaque Protobuf bytes;
// this kernel does not migrate canvas.db or activate any business workspace.
// Callers must hold the hoststate directory lock while using a Store.
package storage

import (
	"errors"
	"fmt"
)

var (
	ErrInvalid             = errors.New("invalid storage request")
	ErrSchema              = errors.New("unsupported or damaged host database schema")
	ErrHostMismatch        = errors.New("host database belongs to a different host identity")
	ErrNotFound            = errors.New("storage record not found")
	ErrConflict            = errors.New("storage revision conflict")
	ErrIdempotencyConflict = errors.New("operation id was reused for a different request")
	ErrCounterExhausted    = errors.New("storage counter exceeds SQLite signed 64-bit range")
	ErrOwnership           = errors.New("staging ownership conflict")
	ErrCorrupt             = errors.New("invalid persisted storage data")
)

const (
	SchemaVersion    = 4
	MaxChanges       = 256
	MaxPayloadBytes  = 16 << 20
	MaxBatchBytes    = 32 << 20
	MaxPageSize      = 1000
	DefaultPageBytes = 8 << 20
	MaxPageBytes     = 32 << 20
)

type Key struct{ Kind, ID, WorkspaceID string }

type Entity struct {
	Key
	Revision uint64
	Payload  []byte
	Deleted  bool
}

// ExpectedRevision zero means never created. Deletions retain a revisioned
// tombstone: resurrection requires the tombstone revision, preventing ABA.
type Change struct {
	Key
	ExpectedRevision uint64
	Payload          []byte
	Delete           bool
}

type Revision struct {
	Key
	Revision uint64
	Deleted  bool
}

type ApplyResult struct {
	OperationID   string
	TransactionID uint64
	FirstSequence uint64
	LastSequence  uint64
	Replayed      bool
	Revisions     []Revision
}

type RevisionConflict struct {
	Key
	Expected, Actual uint64
}

func (e *RevisionConflict) Error() string {
	return fmt.Sprintf("%v: %s/%s expected %d, actual %d", ErrConflict, e.Kind, e.ID, e.Expected, e.Actual)
}
func (e *RevisionConflict) Unwrap() error { return ErrConflict }

type ListOptions struct {
	WorkspaceID    string
	Kind           string
	AfterID        string
	Limit          int
	ByteBudget     int
	IncludeDeleted bool
}

type EntityPage struct {
	Entities []Entity
	NextID   string
	HasMore  bool
}

type Event struct {
	Sequence      uint64
	TransactionID uint64
	OperationID   string
	// Zero-based index and total size let a consumer recognize transaction groups.
	TransactionIndex int
	TransactionSize  int
	Entity
}

type CursorStatus string

const (
	CursorOK         CursorStatus = "ok"
	SnapshotRequired CursorStatus = "snapshot_required"
	CursorAhead      CursorStatus = "cursor_ahead"
)

type EventQuery struct {
	After      uint64
	Limit      int
	ByteBudget int
}
type EventPage struct {
	Status        CursorStatus
	Events        []Event
	NextCursor    uint64
	MinCursor     uint64
	HighWatermark uint64
	HasMore       bool
}

// Staging is ownership metadata, not a filesystem action or an activation.
// Active must remain false in this schema; business publication is a separate
// future operation. PutStaging uses explicit owner+revision CAS for transfers.
type Staging struct {
	ID           string
	OwnerID      string
	WorkspaceID  string
	Purpose      string
	RelativePath string
	Revision     uint64
	LeaseUntilMS int64
	Metadata     []byte
	Active       bool
}

type StagingQuery struct {
	OwnerID, AfterID string
	Limit            int
	ByteBudget       int
}
type StagingPage struct {
	Records []Staging
	NextID  string
	HasMore bool
}
