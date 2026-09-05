package canvashost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
)

// The canvas view of write ownership (host protocol design §4, step 5).
//
// Moving the domain lives in internal/ownership, which knows the state machine
// and nothing about canvases. What is left here is the canvas projection: the
// record as `CanvasOwnership`, which is what the first phase published and what
// existing clients still read before they save anything.
//
// It is the same row the generic surface reports. Two records would be two
// answers to "who may write the canvas", and the whole point of the record is
// that there is one.

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
			ReasonCode:  ownership.ReasonInitial,
			Revision:    0,
			CreatedAtMS: now,
			UpdatedAtMS: now,
		}, nil
	}
	return record, err
}

func message(record storage.Ownership) *pb.CanvasOwnership {
	return &pb.CanvasOwnership{
		Domain:          record.Domain,
		Owner:           ownership.OwnerEnum(record.Owner),
		Epoch:           record.Epoch,
		Phase:           ownership.PhaseEnum(record.Phase),
		ImportId:        record.ImportID,
		ReasonCode:      record.ReasonCode,
		UpdatedAtUnixMs: record.UpdatedAtMS,
		Revision:        record.Revision,
	}
}

// Status is the read the CLI and every client use. It never contacts the
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
	canvas, err := s.Status(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.CanvasOwnershipResponse{Ownership: canvas}, nil
}
