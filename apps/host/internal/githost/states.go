package githost

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The repository snapshot cache (Git 设计 §2).
//
// "Git 仓库/索引/文件系统是代码状态真相，Host 里的状态是缓存。" So this file
// stores a reading with the time it was taken, and never anything else. It
// answers from the cache by default because a panel repainting should not run
// `git status` on every render, and it re-observes on request because a person
// who pressed reload is asking for the repository rather than for the picture.
//
// What it must never do is let the cache decide anything. Every write states
// its own preconditions and the execution host re-reads them; the snapshot is
// what the *UI* renders between observations, and its `observed_at` is how a
// person tells "a second ago" from "now".

// newOperationID mints a time-ordered identifier. The prefix is the millisecond
// the entry was created, big-endian, so the entity table's own ordering by id
// is the queue's ordering — which is what lets the queue be read back after a
// restart without a column to sort on.
func newOperationID() string {
	var buffer [16]byte
	binary.BigEndian.PutUint64(buffer[:8], uint64(time.Now().UnixMilli()))
	if _, err := rand.Read(buffer[8:]); err != nil {
		// A machine that cannot produce eight random bytes cannot mint an
		// identifier that will not collide, and a colliding operation id would
		// make one decision replay as another.
		panic("githost: the system random source is unavailable")
	}
	return hex.EncodeToString(buffer[:])
}

func (s *Service) repositoryKeyOf(workspaceID, path string) storage.Key {
	return storage.Key{Kind: RepositoryKind, ID: repositoryKey(path), WorkspaceID: workspaceID}
}

// cachedState reads the stored snapshot. A workspace with no snapshot is not an
// error: it is a repository nobody has observed yet, which is a different thing
// from one whose state is all zeroes.
func (s *Service) cachedState(ctx context.Context, workspaceID, path string) (*pb.RepositoryState, error) {
	entity, err := s.store.Read(ctx, s.repositoryKeyOf(workspaceID, path))
	if errors.Is(err, storage.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if entity.Deleted {
		return nil, ErrNotFound
	}
	return decodeRepository(entity)
}

// storeState writes a snapshot the execution host produced. It is stored under
// CAS like everything else, but a losing race is not an error worth reporting:
// two observations of one repository are both true readings, and the one that
// lost is simply older.
func (s *Service) storeState(ctx context.Context, workspaceID string, state *pb.RepositoryState) (*pb.RepositoryState, error) {
	path := state.GetScope().GetRepositoryPath()
	key := s.repositoryKeyOf(workspaceID, path)
	var expected uint64
	current, err := s.cachedState(ctx, workspaceID, path)
	switch {
	case err == nil:
		expected = current.GetRevision()
		// An observation that says exactly what the stored one says is not
		// republished: telling every connected client that something changed
		// when nothing did is worse than a slightly older `observed_at`.
		if sameState(current, state) {
			return current, nil
		}
	case errors.Is(err, ErrNotFound):
	default:
		return nil, err
	}
	encoded, err := repositoryPayload(state)
	if err != nil {
		return nil, err
	}
	operationID := "githost/" + workspaceID + "/state/" + key.ID + "/" + hex.EncodeToString(digest(encoded)[:8])
	if _, err = s.store.Apply(ctx, operationID, []storage.Change{{Key: key, ExpectedRevision: expected, Payload: encoded}}); err != nil {
		if errors.Is(err, storage.ErrConflict) || errors.Is(err, storage.ErrIdempotencyConflict) {
			// Somebody else observed the same repository first. Their reading
			// is as true as this one.
			return s.cachedState(ctx, workspaceID, path)
		}
		return nil, err
	}
	return s.cachedState(ctx, workspaceID, path)
}

// sameState compares two readings by what they say about the repository. The
// observation time and the revision are excluded: they are how the reading was
// reached, not what it says.
func sameState(left, right *pb.RepositoryState) bool {
	a, _ := proto.Clone(left).(*pb.RepositoryState)
	b, _ := proto.Clone(right).(*pb.RepositoryState)
	for _, value := range []*pb.RepositoryState{a, b} {
		value.ObservedAtUnixMs = 0
		value.Revision = 0
	}
	return proto.Equal(a, b)
}

// refresh re-observes a checkout after this Host changed it. A failure is not
// propagated: the write already happened, and an unavailable execution host
// means the cache is stale, which is a state the snapshot's own `observed_at`
// already expresses.
func (s *Service) refresh(ctx context.Context, workspaceID string, scope *pb.RepositoryScope, root string) {
	if s.executor == nil || scope == nil {
		return
	}
	state, err := s.executor.ObserveRepository(ctx, scope, root)
	if err != nil || state == nil {
		return
	}
	state.Scope = proto.Clone(scope).(*pb.RepositoryScope)
	_, _ = s.storeState(ctx, workspaceID, state)
}

// RepositoryState answers the cached snapshot, re-observing first when the
// caller asked for it.
//
// Observing is a read of the repository, so it needs the read grant and not the
// execute one: `git status` changes nothing. What it does need is a registered
// root, because a path that arrived in the request would be the caller choosing
// which directory this Host reads.
func (s *Service) RepositoryState(ctx context.Context, caller Caller, request *pb.GetRepositoryStateRequest) (*pb.GetRepositoryStateResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	scope := request.GetScope()
	if err := validScope(scope, caller.WorkspaceID); err != nil {
		return nil, err
	}
	if request.GetRefresh() {
		if s.executor == nil {
			return nil, ErrUnsupported
		}
		root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
		if err != nil {
			return nil, err
		}
		state, err := s.executor.ObserveRepository(ctx, scope, root)
		if err != nil {
			return nil, err
		}
		if state == nil {
			return nil, ErrNotFound
		}
		state.Scope = proto.Clone(scope).(*pb.RepositoryScope)
		stored, err := s.storeState(ctx, caller.WorkspaceID, state)
		if err != nil {
			return nil, err
		}
		return &pb.GetRepositoryStateResponse{State: stored}, nil
	}
	state, err := s.cachedState(ctx, caller.WorkspaceID, scope.GetRepositoryPath())
	if err != nil {
		return nil, err
	}
	return &pb.GetRepositoryStateResponse{State: state}, nil
}

// Observe records a snapshot the execution host reported on its own, without a
// client having asked. It is the Worker upcall's landing point.
func (s *Service) Observe(ctx context.Context, workspaceID string, state *pb.RepositoryState) error {
	if !validID(workspaceID) || state == nil {
		return ErrInvalid
	}
	if err := validScope(state.GetScope(), workspaceID); err != nil {
		return err
	}
	owned, err := s.Owned(ctx)
	if err != nil {
		return err
	}
	if !owned {
		// While the Runtime owns the domain the Host records nothing: a cache
		// written under somebody else's ownership would outlive the switch and
		// be read as this Host's own observation.
		return ErrOwnershipMoved
	}
	_, err = s.storeState(ctx, workspaceID, state)
	return err
}
