package settingshost

import (
	"bytes"
	"context"
	"errors"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// Caller is the already-authenticated device. Nothing in a request supplies
// identity, and nothing narrows it to a workspace: the settings document
// belongs to the machine, so its grants are host-wide and a device holding one
// workspace's settings grant cannot read or write it.
type Caller struct {
	PrincipalID string
	DeviceID    string
	DeviceEpoch uint64
	Scopes      []auth.Scope
}

type Options struct {
	Store  *storage.Store
	HostID string
	// Now exists so the switch state machine and its tests share one clock.
	Now func() time.Time
}

type Service struct {
	store   *storage.Store
	options Options
}

func New(options Options) (*Service, error) {
	if options.Store == nil || len(options.HostID) != 32 {
		return nil, ErrInvalid
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{store: options.Store, options: options}, nil
}

func (s *Service) now() int64 { return s.options.Now().UnixMilli() }

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && c.DeviceEpoch > 0 && len(c.Scopes) > 0
}

// authorize checks the verified session's own grants for this Host, host-wide.
// A grant narrowed to a workspace does not satisfy it: the document is not that
// workspace's, and widening it here would hand one project's device the
// machine's SSH registry.
func (s *Service) authorize(caller Caller, permission string) error {
	if s == nil || !caller.valid() {
		return ErrAuthorization
	}
	if !auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, ExecutionHostID: s.options.HostID}}) {
		return ErrAuthorization
	}
	return nil
}

// authorizeWrite additionally refuses when this Host is not the settled owner
// of the settings domain. There is no dual-write mode: while the Runtime owns
// the domain, or while a switch is open, the Host serves reads and refuses
// every mutation with one stable code.
func (s *Service) authorizeWrite(ctx context.Context, caller Caller) error {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return err
	}
	record, err := s.store.Ownership(ctx, storage.OwnershipDomainSettings)
	if errors.Is(err, storage.ErrNotFound) {
		// No switch has ever been recorded, so the Runtime still owns writes.
		return ErrOwnershipMoved
	}
	if err != nil {
		return err
	}
	if record.Owner != storage.OwnerHost || record.Phase != storage.OwnershipSettled {
		return ErrOwnershipMoved
	}
	return nil
}

// document reads one stored document. A tombstone is reported as not found: a
// deleted document is not an empty one, and returning an empty object would be
// read as "every preference was cleared".
func (s *Service) document(ctx context.Context, key storage.Key) (*pb.SettingsDocument, error) {
	entity, err := s.store.Read(ctx, key)
	if err != nil {
		return nil, err
	}
	if entity.Deleted {
		return nil, storage.ErrNotFound
	}
	return decodeDocument(entity)
}

// Get answers with the document, the execution hosts it projects to, and the
// sequence the read happened at.
//
// The sequence is read after the content, so a subscription that continues from
// it can only replay a change the reader may already hold — never skip one.
func (s *Service) Get(ctx context.Context, caller Caller, scope pb.SettingsScope, deviceID string) (*pb.GetSettingsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	key, err := documentKey(scope, deviceID)
	if err != nil {
		return nil, err
	}
	document, err := s.document(ctx, key)
	if err != nil {
		return nil, err
	}
	hosts, err := s.executionHosts(ctx)
	if err != nil {
		return nil, err
	}
	_, watermark, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.GetSettingsResponse{Document: document, ExecutionHosts: hosts, EventSequence: watermark}, nil
}

// executionHosts is the machine's registry as a client reads it: this machine
// first, then the SSH hosts the document names, in id order. The local row is
// assembled here rather than stored, which is why it never appears in a change
// set or in a consistency check.
func (s *Service) executionHosts(ctx context.Context) ([]*pb.ExecutionHost, error) {
	stored, err := s.storedExecutionHosts(ctx)
	if err != nil {
		return nil, err
	}
	return append([]*pb.ExecutionHost{LocalExecutionHost()}, stored...), nil
}

// Put writes the whole document under compare-and-set, together with the
// execution hosts it projects to, in one transaction.
//
// `expected_revision` is the revision the caller read; zero means "this
// document has never been written", so a first write cannot silently replace
// one that already exists.
func (s *Service) Put(ctx context.Context, caller Caller, request *pb.PutSettingsRequest) (*pb.PutSettingsResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if request == nil {
		return nil, ErrInvalid
	}
	if err := validateDocument(request.Document); err != nil {
		return nil, err
	}
	key, err := documentKey(request.Document.Scope, request.Document.DeviceId)
	if err != nil {
		return nil, err
	}
	operation, err := operationKey(caller.PrincipalID, request.OperationId)
	if err != nil {
		return nil, err
	}
	if replayed, done, err := s.replay(ctx, operation, request, key); done || err != nil {
		return replayed, err
	}
	changes, err := s.documentChanges(ctx, key, request)
	if err != nil {
		return nil, err
	}
	if len(changes) > storage.MaxChanges {
		return nil, ErrTooManyChanges
	}
	// A write whose content already matched storage leaves it untouched, and
	// the receipt says so explicitly rather than inventing a transaction id.
	stored := &pb.CanvasOperationReceipt{OperationId: request.OperationId, Replayed: true}
	if len(changes) > 0 {
		result, err := s.store.Apply(ctx, operation, changes)
		if err != nil {
			return nil, err
		}
		stored = receipt(request.OperationId, result)
	}
	saved, err := s.document(ctx, key)
	if err != nil {
		return nil, err
	}
	return &pb.PutSettingsResponse{Document: saved, Receipt: stored}, nil
}

// replay answers a request whose operation id has already been committed.
//
// It has to be asked before the compare-and-set, because a settings write
// derives part of its change set from the rows it is replacing: once the write
// has landed, the same request no longer produces the same changes, so the
// storage kernel's own digest could not recognise it. Comparing the stored
// document with the one being sent is what stands in for that digest — a reused
// id that produced something else is refused, exactly as the kernel would.
func (s *Service) replay(ctx context.Context, operation string, request *pb.PutSettingsRequest, key storage.Key) (*pb.PutSettingsResponse, bool, error) {
	result, found, err := s.store.Receipt(ctx, operation)
	if err != nil || !found {
		return nil, false, err
	}
	stored, err := s.document(ctx, key)
	if err != nil {
		return nil, true, err
	}
	if !bytes.Equal(stored.Document, request.Document.Document) || stored.Scope != request.Document.Scope || stored.DeviceId != request.Document.DeviceId {
		return nil, true, storage.ErrIdempotencyConflict
	}
	result.Replayed = true
	return &pb.PutSettingsResponse{Document: stored, Receipt: receipt(request.OperationId, result)}, true, nil
}

// documentChanges is the whole transaction: the document row, and the execution
// hosts that row implies. They are derived together so an event always names
// the host that changed, and so a host can never be written without the
// document it was read out of.
func (s *Service) documentChanges(ctx context.Context, key storage.Key, request *pb.PutSettingsRequest) ([]storage.Change, error) {
	// The registry is projected out of the global document only. A per-device
	// overlay is the third keybinding layer, not a second machine list; reading
	// one as a registry would let a laptop's overlay delete the execution hosts
	// every other device uses.
	global := request.Document.Scope == pb.SettingsScope_SETTINGS_SCOPE_GLOBAL
	hosts := []*pb.ExecutionHost{}
	if global {
		projected, err := projectExecutionHosts(request.Document.Document)
		if err != nil {
			return nil, err
		}
		hosts = projected
	}
	updatedAt := s.now()
	payload, err := encodeDocument(request.Document, updatedAt)
	if err != nil {
		return nil, err
	}
	changes := []storage.Change{}
	existing, err := s.store.Read(ctx, key)
	switch {
	case errors.Is(err, storage.ErrNotFound):
		if request.ExpectedRevision != 0 {
			return nil, &storage.RevisionConflict{Key: key, Expected: request.ExpectedRevision, Actual: 0}
		}
		changes = append(changes, storage.Change{Key: key, Payload: payload})
	case err != nil:
		return nil, err
	default:
		if existing.Revision != request.ExpectedRevision {
			return nil, &storage.RevisionConflict{Key: key, Expected: request.ExpectedRevision, Actual: existing.Revision}
		}
		current, err := decodeDocument(existing)
		if err != nil {
			return nil, err
		}
		unchanged, err := sameDocument(current, request.Document)
		if err != nil {
			return nil, err
		}
		if existing.Deleted || !unchanged {
			changes = append(changes, storage.Change{Key: key, ExpectedRevision: existing.Revision, Payload: payload})
		}
	}
	if !global {
		return changes, nil
	}
	hostChanges, err := s.executionHostChanges(ctx, hosts, updatedAt)
	if err != nil {
		return nil, err
	}
	return append(changes, hostChanges...), nil
}

func sameDocument(current, next *pb.SettingsDocument) (bool, error) {
	left, err := comparable(current)
	if err != nil {
		return false, err
	}
	right, err := comparable(next)
	if err != nil {
		return false, err
	}
	return bytes.Equal(left, right), nil
}
