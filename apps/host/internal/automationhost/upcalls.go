package automationhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/proto"
)

// The Host's first subscriber to the resident channel (business migration
// §2.9, §2.10).
//
// This batch delivers the *transport*, not a domain. No domain has moved to the
// Host yet, so there is nothing here that reduces an upcall into agent state:
// doing that now would be writing the agent domain's projection before its
// contract exists, and it would have to be unwritten when B4 arrives. What this
// does instead is durably record that the report arrived, under a key an
// operator and a later batch can both use.
//
// Recording is what makes the delivery real. The Worker retires a frame from
// its outbox on the strength of this Host's acknowledgement, so acknowledging
// something that was only logged would lose it on the next restart.

// UpcallEntityKind is the storage kind every recorded upcall is filed under.
// It is deliberately not an agent-domain kind: nothing reads it as agent state.
const UpcallEntityKind = "workerUpcall"

// upcallRecorder writes one entity, and therefore one event, per accepted
// upcall.
type upcallRecorder struct {
	store *storage.Store
	// hostInstance namespaces the idempotency key, so two Hosts sharing a store
	// cannot collide on one Worker's sequence numbers.
	hostInstance string
}

// Deliver records the frame, and returns only once it is durable: the
// acknowledgement the Host sends next is what lets the Worker forget it.
//
// A frame with no identity or no re-encodable body is refused permanently; a
// store that is merely unavailable is not, so the report stays in the Worker's
// outbox and comes back on the next connection.
func (r upcallRecorder) Deliver(ctx context.Context, upcall worker.Upcall) error {
	frame := upcall.Frame
	if frame == nil || frame.WorkerInstanceId == "" || frame.Sequence == 0 {
		return fmt.Errorf("worker upcall has no identity: %w", worker.ErrUpcallUnacceptable)
	}
	payload, err := proto.Marshal(frame)
	if err != nil {
		return fmt.Errorf("worker upcall could not be encoded: %w", worker.ErrUpcallUnacceptable)
	}
	// The entity id *is* the deduplication key. The Host also deduplicates in
	// memory, but that window dies with the process; this makes a replay after
	// a Host restart land on an existing revision instead of a second event.
	id := frame.WorkerInstanceId + "/" + fmt.Sprint(frame.Sequence)
	digest := sha256.Sum256(payload)
	operation := "worker-upcall/" + r.hostInstance + "/" + id + "/" + hex.EncodeToString(digest[:8])
	_, err = r.store.Apply(ctx, operation, []storage.Change{{
		Key:              storage.Key{Kind: UpcallEntityKind, ID: id, WorkspaceID: workspaceOf(frame)},
		ExpectedRevision: 0,
		Payload:          payload,
	}})
	if err != nil {
		// A revision conflict means this id already exists: the Host restarted
		// and the Worker is replaying. That is a successful outcome — the
		// report is on record — so the frame is acknowledged, not refused.
		var conflict *storage.RevisionConflict
		if errors.As(err, &conflict) {
			slog.Debug("worker upcall was already recorded", "sequence", frame.Sequence, "attempt", upcall.Attempt)
			return nil
		}
		// Anything else is transient (a locked database, a closing store) and
		// is deliberately *not* wrapped as unacceptable, so the frame is left
		// unacknowledged and replayed rather than dropped.
		return fmt.Errorf("worker upcall could not be stored: %w", err)
	}
	slog.Info("recorded a Worker upcall",
		"instance", frame.WorkerInstanceId,
		"sequence", frame.Sequence,
		"attempt", upcall.Attempt,
		"kind", upcallKind(frame))
	return nil
}

// workspaceOf reports the workspace the report belongs to, empty when the
// event is not scoped to one. An empty workspace is a legal storage key.
func workspaceOf(frame *pb.WorkerUpcall) string {
	if agent := frame.GetAgent(); agent != nil {
		return agent.GetWorkspaceId()
	}
	return ""
}

// upcallKind is a log label, not a decision. An event member this build does
// not know is named as such rather than being reported as an agent event.
func upcallKind(frame *pb.WorkerUpcall) string {
	if agent := frame.GetAgent(); agent != nil {
		return "agent:" + agent.GetKind().String()
	}
	return "unknown"
}
