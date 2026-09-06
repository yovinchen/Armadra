// Package ownership moves write ownership of one business domain between the
// Runtime and this Host (host protocol design §4, step 5;
// Go Host 业务所有权迁移 §2.11).
//
// It is the only implementation of the switch. The CLI takes the data
// directory lock and calls it offline; the HTTPS surface calls it on a running
// Host with a maintenance token. Both walk the same state machine, because two
// implementations of "who may write" is exactly the bug this record exists to
// prevent.
//
// The five steps the design names are enforced in order, and the switch refuses
// at the first one that does not hold:
//
//  1. the domain's dependencies are settled on the side it is moving to
//  2. the losing side produced a consistent export, and the winning side
//     staged and projected it
//  3. the projection was compared item for item against the export, and a
//     single difference blocks the switch — on the way back that comparison is
//     against the Runtime's own re-read of the package it applied (rollback.go)
//  4. the epoch moves, and only then does either side change who may write
//  5. the acknowledged epoch — read back from the Runtime, never assumed — is
//     what the next transition is decided against
//
// Nothing here happens on its own. A switch is an operator action taken inside
// a maintenance window, and every failure leaves the window open rather than
// guessing which side now owns the domain.
package ownership

import (
	"context"
	"errors"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

const (
	ReasonPending  = "ownership.switch.pending"
	ReasonVerified = "ownership.switch.verified"
	ReasonFailed   = "ownership.switch.failed"
	ReasonRollback = "ownership.rollback.exported"
	ReasonStale    = "ownership.runtime.stale"
	ReasonUnknown  = "ownership.switch.unknown"
	ReasonInitial  = "ownership.initial"

	// Reason keys a refusal is reported with. They are stable and localizable,
	// and they are what a client renders instead of a sentence.
	ReasonDependency  = "ownership.dependency.unsettled"
	ReasonMaintenance = "ownership.maintenance.required"
)

var (
	// ErrInvalid is a malformed request: an unknown domain, no target, no
	// channel to the Runtime.
	ErrInvalid = errors.New("the ownership request is not valid")
	// ErrUnsupportedDomain means this Host has no projection for the domain.
	// Recording ownership of data it cannot move would be a switch on paper.
	ErrUnsupportedDomain = errors.New("this Host cannot yet own that domain")
	// ErrSwitchOpen means a maintenance window is already open for the domain.
	// Both sides are refusing writes; the operator resolves it by re-running
	// the same switch.
	ErrSwitchOpen = errors.New("an ownership switch is already open for this domain")
	// ErrEpochMismatch means the caller decided against an epoch that is no
	// longer current, so its decision was made about a different state.
	ErrEpochMismatch = errors.New("the ownership epoch is not the one the caller expected")
	// ErrDependency means a domain earlier in the switch order has not settled
	// on the side this one is moving to (§1.2).
	ErrDependency = errors.New("a domain this one depends on has not settled")
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
// is a Worker over the stdio protocol; tests supply their own so no Rust binary
// is needed to exercise the state machine.
type Handoff interface {
	SetWriteOwnership(ctx context.Context, domain string, owner pb.CanvasOwnershipOwner, epoch, expected uint64, reason string) (*pb.WorkerWriteOwnership, error)
	GetWriteOwnership(ctx context.Context, domain string) (*pb.WorkerWriteOwnership, error)
}

// Adoption is what a domain is told when it is taken over.
type Adoption struct {
	ImportID string
	// Link is the live channel to the Runtime, the same one the epoch moves
	// on. Canvas ignores it. A domain with no offline bundle reads its export
	// across this link, and a domain that needs a capability the link does not
	// have refuses before anything is written.
	//
	// It is offered to every domain rather than withheld from the ones that do
	// not need it: the state machine cannot know which domain reads its data
	// from a staged bundle and which reads it over the wire, and a domain that
	// discovered mid-adoption that it had no link would already have written.
	Link Handoff
}

// Projector is one domain's half of the move: how its data is taken over, how
// it is handed back, and what the Host's event watermark is for it. A domain
// with no projector cannot be switched at all, which is how a half-built domain
// stays honestly unavailable instead of switching into nothing.
type Projector interface {
	// Adopt stages, projects and verifies an import. A report that did not
	// match is returned with ErrNotVerified rather than silently accepted.
	Adopt(ctx context.Context, adoption Adoption) (*pb.OwnershipReport, error)
	// Release hands the domain back: it writes the reverse export into an empty
	// directory, has the Runtime apply it, and compares the Runtime's re-read
	// with what the package described. A report that did not match is returned
	// with ErrReverseImportFailed, and the epoch does not move.
	Release(ctx context.Context, handback Handback) (*pb.OwnershipReport, error)
	// Watermark is the Host's event sequence right now. It is recorded with
	// every settled switch, so an operator can see how far the Host's own
	// stream had run when the domain moved.
	Watermark(ctx context.Context) (uint64, error)
}

type Options struct {
	Store *storage.Store
	// InstanceID binds maintenance tokens to this Host process. A token issued
	// before a restart is dead, which is the case where the operator's intent
	// no longer clearly applies.
	InstanceID string
	// Projectors are the domains this Host can actually move, by domain name.
	Projectors map[string]Projector
	// ExportRoot is where an HTTPS rollback writes its reverse export. Empty
	// means only the CLI, which names a directory, may roll back.
	ExportRoot string
	// Now exists so the state machine and its tests share one clock.
	Now func() time.Time
}

type Service struct {
	options Options
}

func New(options Options) (*Service, error) {
	if options.Store == nil || options.InstanceID == "" {
		return nil, ErrInvalid
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	for domain := range options.Projectors {
		if !storage.ValidOwnershipDomain(domain) {
			return nil, ErrInvalid
		}
	}
	return &Service{options: options}, nil
}

func (s *Service) now() int64 { return s.options.Now().UnixMilli() }

// Record reads one domain, substituting the state a Host that has never
// switched is in. That default is stated in one place rather than inferred at
// each call site, and it is deliberately "the Runtime owns writes".
func (s *Service) Record(ctx context.Context, domain string) (storage.Ownership, error) {
	if !storage.ValidOwnershipDomain(domain) {
		return storage.Ownership{}, ErrInvalid
	}
	record, err := s.options.Store.Ownership(ctx, domain)
	if errors.Is(err, storage.ErrNotFound) {
		return s.initial(domain), nil
	}
	return record, err
}

func (s *Service) initial(domain string) storage.Ownership {
	now := s.now()
	return storage.Ownership{
		Domain:      domain,
		Owner:       storage.OwnerRuntime,
		Epoch:       1,
		Phase:       storage.OwnershipSettled,
		ReasonCode:  ReasonInitial,
		Revision:    0,
		CreatedAtMS: now,
		UpdatedAtMS: now,
	}
}

// Records reads every domain in switch order. Unrecorded domains are filled in
// with the same explicit default, so a client always sees six answers and never
// has to read a missing one as "that domain does not exist here".
func (s *Service) Records(ctx context.Context) ([]storage.Ownership, error) {
	stored, err := s.options.Store.AllOwnership(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]storage.Ownership, 0, len(storage.OwnershipDomains))
	for _, domain := range storage.OwnershipDomains {
		if record, ok := stored[domain]; ok {
			records = append(records, record)
			continue
		}
		records = append(records, s.initial(domain))
	}
	return records, nil
}

// Message is the record on the wire.
func Message(record storage.Ownership) *pb.WriteOwnership {
	return &pb.WriteOwnership{
		Domain:          DomainEnum(record.Domain),
		Owner:           OwnerEnum(record.Owner),
		Epoch:           record.Epoch,
		Phase:           PhaseEnum(record.Phase),
		ImportId:        record.ImportID,
		EventSequence:   record.EventSequence,
		ReasonCode:      record.ReasonCode,
		UpdatedAtUnixMs: record.UpdatedAtMS,
		Revision:        record.Revision,
	}
}

// DomainEnum maps a stored domain name onto the contract. An unknown name maps
// to UNSPECIFIED rather than to a domain it resembles.
func DomainEnum(value string) pb.WriteOwnershipDomain {
	switch value {
	case storage.OwnershipDomainCanvas:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS
	case storage.OwnershipDomainSettings:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SETTINGS
	case storage.OwnershipDomainFilesystem:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_FILESYSTEM
	case storage.OwnershipDomainSession:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SESSION
	case storage.OwnershipDomainAgent:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT
	case storage.OwnershipDomainGit:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_GIT
	default:
		return pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_UNSPECIFIED
	}
}

// DomainName is the reverse, and an unspecified or unknown enum value gets an
// empty name rather than the first domain in the list.
func DomainName(value pb.WriteOwnershipDomain) string {
	switch value {
	case pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS:
		return storage.OwnershipDomainCanvas
	case pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SETTINGS:
		return storage.OwnershipDomainSettings
	case pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_FILESYSTEM:
		return storage.OwnershipDomainFilesystem
	case pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SESSION:
		return storage.OwnershipDomainSession
	case pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT:
		return storage.OwnershipDomainAgent
	case pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_GIT:
		return storage.OwnershipDomainGit
	default:
		return ""
	}
}

func OwnerEnum(value string) pb.CanvasOwnershipOwner {
	switch value {
	case storage.OwnerRuntime:
		return pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
	case storage.OwnerHost:
		return pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST
	default:
		return pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_UNSPECIFIED
	}
}

func OwnerName(value pb.CanvasOwnershipOwner) string {
	switch value {
	case pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME:
		return storage.OwnerRuntime
	case pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST:
		return storage.OwnerHost
	default:
		return ""
	}
}

func PhaseEnum(value string) pb.CanvasOwnershipPhase {
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

// put writes the record under revision CAS, filling in the timestamps that are
// this service's to set.
func (s *Service) put(ctx context.Context, record storage.Ownership, expected uint64) (storage.Ownership, error) {
	record.UpdatedAtMS = s.now()
	if record.CreatedAtMS == 0 {
		record.CreatedAtMS = record.UpdatedAtMS
	}
	return s.options.Store.PutOwnership(ctx, record, expected)
}

// settle records the acknowledged state and the event watermark it was
// acknowledged at. The watermark is what a later rollback compares against to
// decide whether the Host has changes the Runtime never received.
func (s *Service) settle(ctx context.Context, current storage.Ownership, owner string, epoch uint64, importID, reason string, projector Projector) (storage.Ownership, error) {
	watermark, err := projector.Watermark(ctx)
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
