package canvashost

import (
	"context"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The write-ownership switch (host protocol design §4, step 5).
//
// Moving the canvas domain is an operator action taken inside a maintenance
// window, never something the software decides. The five steps the design
// names are enforced here in order, and the switch refuses at the first one
// that does not hold:
//
//  1. the Runtime produced a consistent offline export (`armadra-runtime export`)
//  2. the Host staged that export (`armadra-host import`)
//  3. the staged rows were projected into canvas entities (Materialize)
//  4. the projection was compared item for item against the export (Verify),
//     and a single difference blocks the switch
//  5. the epoch moves, and only then does either side change who may write
//
// The epoch the Runtime acknowledged is the single source of truth for what
// comes next: the Host reads it before every transition rather than trusting
// its own copy, so an interrupted switch resumes instead of drifting.
//
// A rollback runs the same five steps in the other direction, and its middle
// three are in reverse.go: the Host exports what it holds, the Runtime applies
// that package to its own database, the Runtime re-reads its rows, and the
// digests are compared before the epoch moves.

const (
	ReasonPending  = "ownership.switch.pending"
	ReasonVerified = "ownership.switch.verified"
	ReasonFailed   = "ownership.switch.failed"
	ReasonRollback = "ownership.rollback.exported"
	ReasonStale    = "ownership.runtime.stale"
	ReasonUnknown  = "ownership.switch.unknown"
)

var (
	// ErrSwitchOpen means a maintenance window is already open. Both sides are
	// refusing writes; the operator resolves it by re-running the same switch.
	ErrSwitchOpen = errors.New("a canvas ownership switch is already open")
	// ErrNotVerified means the consistency report found differences. The
	// report is returned alongside so the operator can see which ones.
	ErrNotVerified = errors.New("the staged import does not match the export")
	// ErrUnknownOutcome means the Host could not learn what the Runtime stored.
	// The maintenance window stays open on purpose: guessing would let one side
	// resume writing while the other believes it still owns the domain.
	ErrUnknownOutcome = errors.New("the Runtime's ownership state could not be read")
	// ErrRuntimeStale means the Runtime reports an older epoch than this Host
	// has already seen it acknowledge, which is a restored or foreign database.
	ErrRuntimeStale = errors.New("the Runtime reports an epoch this Host has already passed")
	// ErrExportRequired means a rollback was asked for without the reverse
	// export the Host owes the Runtime.
	ErrExportRequired = errors.New("a rollback requires a Host-side export back to the Runtime")
)

// Handoff is the private channel to the Runtime. The production implementation
// is a short-lived Worker started over the stdio protocol; tests supply their
// own so no Rust binary is needed to exercise the state machine.
type Handoff interface {
	SetWriteOwnership(ctx context.Context, domain string, owner pb.CanvasOwnershipOwner, epoch, expected uint64, reason string) (*pb.WorkerWriteOwnership, error)
	GetWriteOwnership(ctx context.Context, domain string) (*pb.WorkerWriteOwnership, error)
}

func ownerEnum(value string) pb.CanvasOwnershipOwner {
	switch value {
	case storage.OwnerRuntime:
		return pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
	case storage.OwnerHost:
		return pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST
	default:
		return pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_UNSPECIFIED
	}
}

func ownerName(value pb.CanvasOwnershipOwner) string {
	switch value {
	case pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME:
		return storage.OwnerRuntime
	case pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST:
		return storage.OwnerHost
	default:
		return ""
	}
}

func phaseEnum(value string) pb.CanvasOwnershipPhase {
	switch value {
	case storage.OwnershipSettled:
		return pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED
	case storage.OwnershipSwitching:
		return pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SWITCHING
	case storage.OwnershipRollingBack:
		return pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_ROLLING_BACK
	default:
		return pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_UNSPECIFIED
	}
}

func message(record storage.Ownership) *pb.CanvasOwnership {
	return &pb.CanvasOwnership{
		Domain:          record.Domain,
		Owner:           ownerEnum(record.Owner),
		Epoch:           record.Epoch,
		Phase:           phaseEnum(record.Phase),
		ImportId:        record.ImportID,
		ReasonCode:      record.ReasonCode,
		UpdatedAtUnixMs: record.UpdatedAtMS,
		Revision:        record.Revision,
	}
}

// stored reads the record, substituting the state a Host that has never
// switched is in. That default is stated in one place rather than inferred at
// each call site, and it is deliberately "the Runtime owns writes".
func (s *Service) stored(ctx context.Context) (storage.Ownership, error) {
	record, err := s.store.Ownership(ctx, storage.OwnershipDomainCanvas)
	if errors.Is(err, storage.ErrNotFound) {
		now := s.now()
		return storage.Ownership{
			Domain:      storage.OwnershipDomainCanvas,
			Owner:       storage.OwnerRuntime,
			Epoch:       1,
			Phase:       storage.OwnershipSettled,
			ReasonCode:  "ownership.initial",
			Revision:    0,
			CreatedAtMS: now,
			UpdatedAtMS: now,
		}, nil
	}
	return record, err
}

// Status is the read every client and the CLI use. It never contacts the
// Runtime: this is what the Host recorded, and a caller that needs to know
// whether the Runtime agrees runs a switch, which reconciles both.
func (s *Service) Status(ctx context.Context) (*pb.CanvasOwnership, error) {
	record, err := s.stored(ctx)
	if err != nil {
		return nil, err
	}
	return message(record), nil
}

// GetOwnership is the authenticated read of the same record.
func (s *Service) GetOwnership(ctx context.Context, caller Caller) (*pb.CanvasOwnershipResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	ownership, err := s.Status(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.CanvasOwnershipResponse{Ownership: ownership}, nil
}

type SwitchRequest struct {
	Target   pb.CanvasOwnershipOwner
	ImportID string
	Handoff  Handoff
	// ExportDirectory is required when handing the domain back to the Runtime:
	// the Host owes the Runtime its canvas before it stops being the writer.
	ExportDirectory string
	// Importer applies that package to the Runtime's own database and reports
	// what it then holds. A rollback needs one; without it the only remaining
	// path is the explicit AcceptExportOnly below.
	Importer ReverseImporter
	// AcceptExportOnly is a danger switch, not a normal option. It skips the
	// reverse import entirely: the operator states that they accept the Host's
	// canvas existing only inside the export package, and that the Runtime will
	// resume from whatever it held before the switch. Nothing else in a
	// rollback silently drops data, and this is why it takes a flag.
	AcceptExportOnly bool
}

func (s *Service) put(ctx context.Context, record storage.Ownership, expected uint64) (storage.Ownership, error) {
	record.Domain = storage.OwnershipDomainCanvas
	record.UpdatedAtMS = s.now()
	if record.CreatedAtMS == 0 {
		record.CreatedAtMS = record.UpdatedAtMS
	}
	return s.store.PutOwnership(ctx, record, expected)
}

// Switch performs the epoch handover. It is safe to re-run: an already settled
// target returns unchanged, and an interrupted attempt resumes from whatever
// the Runtime actually stored rather than from what this Host assumed.
func (s *Service) Switch(ctx context.Context, request SwitchRequest) (*pb.CanvasOwnershipResponse, error) {
	target := ownerName(request.Target)
	if target == "" || request.Handoff == nil {
		return nil, ErrInvalid
	}
	current, err := s.stored(ctx)
	if err != nil {
		return nil, err
	}
	if current.Phase != storage.OwnershipSettled && current.Owner != target {
		return nil, ErrSwitchOpen
	}
	if current.Owner == target && current.Phase == storage.OwnershipSettled {
		return &pb.CanvasOwnershipResponse{Ownership: message(current)}, nil
	}
	previous := current.Owner
	if current.Phase != storage.OwnershipSettled {
		// Resuming an interrupted attempt: the record already names the target,
		// so the side being moved away from is the other one.
		previous = storage.OwnerRuntime
		if target == storage.OwnerRuntime {
			previous = storage.OwnerHost
		}
	}

	remote, err := request.Handoff.GetWriteOwnership(ctx, storage.OwnershipDomainCanvas)
	if err != nil {
		return nil, errors.Join(ErrUnknownOutcome, err)
	}
	if remote.Epoch < current.Epoch {
		return nil, ErrRuntimeStale
	}
	// The Runtime already holds the target state; the Host only has to record
	// it. This is what makes a re-run after a lost reply converge.
	if ownerName(remote.Owner) == target && remote.Epoch > current.Epoch {
		settled, err := s.settle(ctx, current, target, remote.Epoch, request.ImportID, ReasonVerified)
		if err != nil {
			return nil, err
		}
		return &pb.CanvasOwnershipResponse{Ownership: message(settled)}, nil
	}

	var report *pb.CanvasConsistencyReport
	switch target {
	case storage.OwnerHost:
		if !validImportID(request.ImportID) {
			return nil, ErrInvalid
		}
		if _, err = s.Materialize(ctx, request.ImportID); err != nil {
			return nil, err
		}
		report, err = s.Verify(ctx, request.ImportID)
		if err != nil {
			return nil, err
		}
		if !report.Matched {
			// Nothing has been written to the ownership record yet, so an
			// unverified import leaves the Host exactly as it was.
			return &pb.CanvasOwnershipResponse{Report: report}, ErrNotVerified
		}
	case storage.OwnerRuntime:
		if request.ExportDirectory == "" {
			return nil, ErrExportRequired
		}
		// Asked before the package is written: a rollback that cannot be
		// completed should refuse at the start, not after producing files the
		// operator now has to reason about.
		if !request.AcceptExportOnly && (request.Importer == nil || !request.Importer.SupportsReverseImport()) {
			return nil, ErrReverseImportUnsupported
		}
		export, err := s.Export(ctx, request.ExportDirectory)
		if err != nil {
			return nil, err
		}
		report = export
		if request.AcceptExportOnly {
			// Nothing travels back. The operator accepted that, and this is
			// the one path where the Host's own changes are allowed to stay
			// only in the package.
			break
		}
		if err = s.reverseImport(ctx, request.Importer, request.ExportDirectory, remote.Epoch, report); err != nil {
			// The epoch has not moved and the Host still holds every row, so
			// a failed import is recoverable: fix the cause, use a new export
			// directory, run the same rollback again.
			return &pb.CanvasOwnershipResponse{Report: report}, err
		}
	}

	phase := storage.OwnershipSwitching
	if target == storage.OwnerRuntime {
		phase = storage.OwnershipRollingBack
	}
	// The pending record keeps the acknowledged epoch and only changes the
	// phase and the named target. The epoch advances when the Runtime confirms,
	// so a failure here can restore the previous record without moving it back.
	pending := current
	pending.Owner = target
	pending.Phase = phase
	pending.Epoch = remote.Epoch
	pending.ImportID = request.ImportID
	pending.ReasonCode = ReasonPending
	saved, err := s.put(ctx, pending, current.Revision)
	if err != nil {
		return nil, err
	}

	next := remote.Epoch + 1
	confirmed, setErr := request.Handoff.SetWriteOwnership(ctx, storage.OwnershipDomainCanvas, request.Target, next, remote.Epoch, ReasonVerified)
	if setErr != nil {
		// The reply was lost, not necessarily the write. Ask the Runtime what
		// it stored rather than assuming which side of it the failure fell on.
		recheck, readErr := request.Handoff.GetWriteOwnership(ctx, storage.OwnershipDomainCanvas)
		if readErr != nil {
			stuck := saved
			stuck.ReasonCode = ReasonUnknown
			if _, err = s.put(ctx, stuck, saved.Revision); err != nil {
				return nil, err
			}
			return nil, errors.Join(ErrUnknownOutcome, setErr, readErr)
		}
		if ownerName(recheck.Owner) == target && recheck.Epoch == next {
			confirmed = recheck
		} else {
			restored := saved
			restored.Owner = previous
			restored.Phase = storage.OwnershipSettled
			restored.Epoch = recheck.Epoch
			restored.ReasonCode = ReasonFailed
			if _, err = s.put(ctx, restored, saved.Revision); err != nil {
				return nil, err
			}
			return &pb.CanvasOwnershipResponse{Ownership: message(restored), Report: report}, setErr
		}
	}
	if ownerName(confirmed.Owner) != target || confirmed.Epoch != next {
		return nil, fmt.Errorf("%w: the Runtime acknowledged a different state", ErrUnknownOutcome)
	}
	settled, err := s.settle(ctx, saved, target, next, request.ImportID, ReasonVerified)
	if err != nil {
		return nil, err
	}
	return &pb.CanvasOwnershipResponse{Ownership: message(settled), Report: report}, nil
}

// settle records the acknowledged state and the event watermark it was
// acknowledged at. The watermark is what a later rollback compares against to
// decide whether the Host has changes the Runtime never received.
func (s *Service) settle(ctx context.Context, current storage.Ownership, owner string, epoch uint64, importID, reason string) (storage.Ownership, error) {
	_, watermark, err := s.store.Watermark(ctx)
	if err != nil {
		return storage.Ownership{}, err
	}
	record := current
	record.Owner = owner
	record.Epoch = epoch
	record.Phase = storage.OwnershipSettled
	record.ImportID = importID
	record.ReasonCode = reason
	record.EventSequence = watermark
	return s.put(ctx, record, current.Revision)
}
