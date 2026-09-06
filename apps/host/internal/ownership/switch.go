package ownership

import (
	"context"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Request is one switch or rollback. The direction is `Target`: everything else
// is the same state machine, because a rollback that took a different path
// would be a second implementation of the thing that must not have two.
type Request struct {
	Domain string
	Target pb.CanvasOwnershipOwner
	// ExpectedEpoch is the epoch the caller decided against. Zero means the
	// caller did not state one, which only the CLI does — it is standing at the
	// machine holding the lock and has just read the status.
	ExpectedEpoch uint64
	ImportID      string
	Handoff       Handoff
	// Importer carries the reverse export package to the Runtime when a domain
	// is handed back. A caller holding a Channel passes it as both. Only
	// AcceptExportOnly makes a rollback without one legal.
	Importer ReverseImporter
	// ExportDirectory is required when handing a domain back: the Host owes the
	// Runtime its data before it stops being the writer. An HTTPS rollback
	// leaves it empty and the service names a directory under its export root,
	// because a browser must not choose paths on this machine.
	ExportDirectory string
	// AcceptExportOnly is a danger switch, not a normal option. It skips the
	// reverse import entirely: the operator states that they accept the Host's
	// data existing only inside the export package, and that the Runtime will
	// resume from whatever it held before the switch. Nothing else in a
	// rollback silently drops data, and this is why it takes a flag.
	AcceptExportOnly bool
	// MaintenanceToken is required on a running Host. SwitchOffline is the only
	// entry point that does without one.
	MaintenanceToken string
}

// Switch moves a domain on a running Host. The maintenance token is what makes
// this callable at all: it comes from the same-user control channel, so the
// request is made by someone at the machine even though it arrives over HTTPS.
func (s *Service) Switch(ctx context.Context, request Request) (*pb.OwnershipSwitchResponse, error) {
	if request.MaintenanceToken == "" {
		return nil, fmt.Errorf("%w: %s", ErrInvalid, ReasonMaintenance)
	}
	return s.run(ctx, request, true)
}

// SwitchOffline is the CLI's entry point. Its maintenance window is the data
// directory lock it already holds: no Host is serving, so no client is
// connected to either side while ownership moves.
func (s *Service) SwitchOffline(ctx context.Context, request Request) (*pb.OwnershipSwitchResponse, error) {
	request.MaintenanceToken = ""
	return s.run(ctx, request, false)
}

// run is the state machine. It is safe to re-run: an already settled target
// returns unchanged, and an interrupted attempt resumes from whatever the
// Runtime actually stored rather than from what this Host assumed.
func (s *Service) run(ctx context.Context, request Request, window bool) (*pb.OwnershipSwitchResponse, error) {
	target := OwnerName(request.Target)
	if target == "" || request.Handoff == nil || !storage.ValidOwnershipDomain(request.Domain) {
		return nil, ErrInvalid
	}
	projector, ok := s.options.Projectors[request.Domain]
	if !ok {
		return nil, ErrUnsupportedDomain
	}
	current, err := s.Record(ctx, request.Domain)
	if err != nil {
		return nil, err
	}
	if request.ExpectedEpoch != 0 && request.ExpectedEpoch != current.Epoch {
		return nil, ErrEpochMismatch
	}
	if current.Phase != storage.OwnershipSettled && current.Owner != target {
		return nil, ErrSwitchOpen
	}
	// The dependency order is checked before anything is spent or written, and
	// the records that were read are reported either way.
	verified, dependencyErr := s.checkDependencies(ctx, request.Domain, target)
	plan := &pb.OwnershipSwitchPlan{
		Domain:        DomainEnum(request.Domain),
		TargetOwner:   request.Target,
		ExpectedEpoch: current.Epoch,
		ImportId:      request.ImportID,
	}
	for _, record := range verified {
		plan.Dependencies = append(plan.Dependencies, Message(record))
	}
	if dependencyErr != nil {
		return &pb.OwnershipSwitchResponse{Ownership: Message(current), Plan: plan}, dependencyErr
	}
	if current.Owner == target && current.Phase == storage.OwnershipSettled {
		return &pb.OwnershipSwitchResponse{Ownership: Message(current), Plan: plan}, nil
	}
	// Nothing has been written and nothing has been moved, so this is the last
	// point where the operator's one-time token can still be refused cheaply.
	if window {
		if err = s.consumeMaintenance(ctx, request.Domain, request.MaintenanceToken); err != nil {
			return nil, err
		}
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

	remote, err := request.Handoff.GetWriteOwnership(ctx, request.Domain)
	if err != nil {
		return nil, errors.Join(ErrUnknownOutcome, err)
	}
	if remote.Epoch < current.Epoch {
		return nil, ErrRuntimeStale
	}
	// The Runtime already holds the target state; the Host only has to record
	// it. This is what makes a re-run after a lost reply converge.
	if OwnerName(remote.Owner) == target && remote.Epoch > current.Epoch {
		settled, err := s.settle(ctx, current, target, remote.Epoch, request.ImportID, ReasonVerified, projector)
		if err != nil {
			return nil, err
		}
		return &pb.OwnershipSwitchResponse{Ownership: Message(settled), Plan: plan}, nil
	}

	report, err := s.move(ctx, request, remote.Epoch, projector)
	if err != nil {
		return &pb.OwnershipSwitchResponse{Ownership: Message(current), Report: report, Plan: plan}, err
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
	confirmed, setErr := request.Handoff.SetWriteOwnership(ctx, request.Domain, request.Target, next, remote.Epoch, ReasonVerified)
	if setErr != nil {
		// The reply was lost, not necessarily the write. Ask the Runtime what
		// it stored rather than assuming which side of it the failure fell on.
		recheck, readErr := request.Handoff.GetWriteOwnership(ctx, request.Domain)
		if readErr != nil {
			stuck := saved
			stuck.ReasonCode = ReasonUnknown
			if _, err = s.put(ctx, stuck, saved.Revision); err != nil {
				return nil, err
			}
			return nil, errors.Join(ErrUnknownOutcome, setErr, readErr)
		}
		if OwnerName(recheck.Owner) == target && recheck.Epoch == next {
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
			return &pb.OwnershipSwitchResponse{Ownership: Message(restored), Report: report, Plan: plan}, setErr
		}
	}
	if OwnerName(confirmed.Owner) != target || confirmed.Epoch != next {
		return nil, fmt.Errorf("%w: the Runtime acknowledged a different state", ErrUnknownOutcome)
	}
	settled, err := s.settle(ctx, saved, target, next, request.ImportID, ReasonVerified, projector)
	if err != nil {
		return nil, err
	}
	return &pb.OwnershipSwitchResponse{Ownership: Message(settled), Report: report, Plan: plan}, nil
}

// move is the data half: taking the domain over means adopting a verified
// import, and handing it back means writing the export the Runtime is owed and
// having the Runtime store it. It runs before the ownership record is touched,
// so a refusal here leaves the Host exactly as it was.
//
// `epoch` is the epoch the Runtime just acknowledged. A handback names it in
// the package, so a package written against a different one is refused rather
// than applied to rows it does not describe.
func (s *Service) move(ctx context.Context, request Request, epoch uint64, projector Projector) (*pb.OwnershipReport, error) {
	switch OwnerName(request.Target) {
	case storage.OwnerHost:
		if !validImportID(request.ImportID) {
			return nil, ErrInvalid
		}
		report, err := projector.Adopt(ctx, Adoption{ImportID: request.ImportID, Link: request.Handoff})
		if err != nil {
			return report, err
		}
		if !report.GetMatched() {
			return report, ErrNotVerified
		}
		return report, nil
	default:
		directory := request.ExportDirectory
		if directory == "" {
			return nil, ErrExportRequired
		}
		// Asked before the package is written: a rollback that cannot be
		// completed should refuse at the start, not after producing files the
		// operator now has to reason about.
		if !request.AcceptExportOnly && (request.Importer == nil || !request.Importer.SupportsReverseImport()) {
			return nil, ErrReverseImportUnsupported
		}
		return projector.Release(ctx, Handback{
			Directory:        directory,
			Epoch:            epoch,
			Importer:         request.Importer,
			AcceptExportOnly: request.AcceptExportOnly,
		})
	}
}

func validImportID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, symbol := range value {
		switch {
		case symbol >= 'a' && symbol <= 'z', symbol >= 'A' && symbol <= 'Z',
			symbol >= '0' && symbol <= '9', symbol == '-', symbol == '_':
		default:
			return false
		}
	}
	return true
}
