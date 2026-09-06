package automationhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/agenthost"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/proto"
)

// The Host's subscriber to the resident channel (business migration §2.9,
// §2.10).
//
// Every accepted frame is recorded raw, under a key an operator and a later
// batch can both use, *and* handed to whichever domain owns what it is about.
// Recording is what makes the delivery real: the Worker retires a frame from
// its outbox on the strength of this Host's acknowledgement, so acknowledging
// something that was only logged would lose it on the next restart.
//
// The raw record stays even now that domains project. It is the only place a
// frame this build does not understand survives — a newer Worker's kind, a body
// shape a later batch adds — and dropping it would make forward compatibility
// depend on this file being current.

// UpcallEntityKind is the storage kind every recorded upcall is filed under.
// It is deliberately not an agent-domain kind: nothing reads it as agent state.
const UpcallEntityKind = "workerUpcall"

// HookEventUpcallSchema is the `WorkerAgentUpcall.schema_version` that means
// "the body is an encoded HookEvent". Schema 1 is the scheduled-delivery
// receipt the automation bridge has always sent under the same kind; the number
// is what tells them apart, because Protobuf would happily decode either as the
// other.
const HookEventUpcallSchema = 2

// SessionObserver is the session domain's landing point for a run report
// (business migration §2.6, upcall 140). It is an interface so this package
// keeps knowing nothing about session records beyond "somebody owns them".
type SessionObserver interface {
	ObserveRun(ctx context.Context, report *pb.WorkerSessionUpcall) error
}

// AgentObserver is the agent domain's landing point for a Hook report
// (business migration §2.7, upcall 160). The same event also reaches that
// domain through its own drain, which is why recording is idempotent by event
// id: the two paths converge on one row rather than racing for it.
type AgentObserver interface {
	ObserveHookEvent(ctx context.Context, event *pb.HookEvent) (bool, error)
}

// upcallRecorder writes one entity, and therefore one event, per accepted
// upcall.
type upcallRecorder struct {
	store *storage.Store
	// hostInstance namespaces the idempotency key, so two Hosts sharing a store
	// cannot collide on one Worker's sequence numbers.
	hostInstance string
	// sessions is nil on a Host that assembles no session service. The frame is
	// still recorded; it simply changes no session record.
	sessions SessionObserver
	// agents is nil on the same terms.
	agents AgentObserver
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
	// The domain lands *before* the raw record. The record's id is the
	// deduplication key, so a replay that found it already there returns early
	// below; projecting first is what makes a Host that crashed between the two
	// writes converge rather than drop the report. Every projection is
	// idempotent, so doing it twice costs nothing.
	if err = r.project(ctx, frame); err != nil {
		return err
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

// project hands the frame to whichever domain owns what it is about.
//
// A domain that is not assembled on this Host is not an error: the frame is
// still recorded, and a later batch reading those records loses nothing. A
// domain that *is* assembled and refuses permanently — a report about a session
// no record exists for — is turned into an unacceptable frame, because
// replaying it forever cannot make the record appear. Anything else is left for
// the Worker to replay.
func (r upcallRecorder) project(ctx context.Context, frame *pb.WorkerUpcall) error {
	if report := frame.GetSession(); report != nil && r.sessions != nil {
		err := r.sessions.ObserveRun(ctx, report)
		switch {
		case err == nil:
		case errors.Is(err, sessionhost.ErrUnknownSession), errors.Is(err, sessionhost.ErrInvalid):
			return fmt.Errorf("run report names no session this Host has: %w", worker.ErrUpcallUnacceptable)
		default:
			return fmt.Errorf("run report could not be applied: %w", err)
		}
	}
	if report := frame.GetAgent(); report != nil && r.agents != nil {
		return r.projectAgent(ctx, report)
	}
	return nil
}

// projectAgent decodes the agent frame's opaque body into the normalized event
// it carries and hands it to the agent domain.
//
// The kind alone does not say what the body is. `HOOK_TURN` is also what a
// scheduled prompt delivery reports, carrying a receipt rather than an event,
// and Protobuf would decode one as the other into a plausible-looking record.
// `schema_version` is the discriminator §2.9 provides for exactly this, so a
// body is decoded only when the Worker said which shape it is. Anything else is
// recorded raw and changes no agent record — which is what it did before this
// batch, and is not a regression for a frame nobody claimed.
func (r upcallRecorder) projectAgent(ctx context.Context, report *pb.WorkerAgentUpcall) error {
	if report.GetSchemaVersion() != HookEventUpcallSchema {
		return nil
	}
	switch report.GetKind() {
	case pb.WorkerAgentUpcallKind_WORKER_AGENT_UPCALL_KIND_HOOK_TURN,
		pb.WorkerAgentUpcallKind_WORKER_AGENT_UPCALL_KIND_APPROVAL_REQUESTED:
	default:
		return nil
	}
	event := new(pb.HookEvent)
	if err := proto.Unmarshal(report.GetPayload(), event); err != nil {
		// A body that will not decode cannot be made to by asking again.
		return fmt.Errorf("hook report could not be decoded: %w", worker.ErrUpcallUnacceptable)
	}
	if event.GetEventId() == "" {
		// The frame's own entity id is the fallback: it is what makes a
		// replayed frame the same record rather than a second one (§2.9).
		event.EventId = report.GetEntityId()
	}
	if event.GetNodeId() == "" {
		event.NodeId = report.GetNodeId()
	}
	if event.GetWorkspaceId() == "" {
		event.WorkspaceId = report.GetWorkspaceId()
	}
	if event.GetSessionId() == "" {
		event.SessionId = report.GetSessionId()
	}
	if event.GetObservedAtUnixMs() == 0 {
		event.ObservedAtUnixMs = report.GetObservedAtUnixMs()
	}
	_, err := r.agents.ObserveHookEvent(ctx, event)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, agenthost.ErrInvalid):
		return fmt.Errorf("hook report is not usable: %w", worker.ErrUpcallUnacceptable)
	default:
		return fmt.Errorf("hook report could not be applied: %w", err)
	}
}

// workspaceOf reports the workspace the report belongs to, empty when the
// event is not scoped to one. An empty workspace is a legal storage key.
func workspaceOf(frame *pb.WorkerUpcall) string {
	if agent := frame.GetAgent(); agent != nil {
		return agent.GetWorkspaceId()
	}
	if session := frame.GetSession(); session != nil {
		return session.GetWorkspaceId()
	}
	return ""
}

// upcallKind is a log label, not a decision. An event member this build does
// not know is named as such rather than being reported as an agent event.
func upcallKind(frame *pb.WorkerUpcall) string {
	if agent := frame.GetAgent(); agent != nil {
		return "agent:" + agent.GetKind().String()
	}
	if session := frame.GetSession(); session != nil {
		return "session:" + session.GetKind().String()
	}
	return "unknown"
}
