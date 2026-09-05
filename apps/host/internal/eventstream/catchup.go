package eventstream

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Catching up and pushing are the same read.
//
// A subscription is always "read everything after my cursor". While history
// remains, that read returns a page with `has_more` set and the client is
// catching up; once it returns `has_more` false, the cursor sits at the
// watermark and the connection is in push mode — the next page is produced by
// the next commit rather than by the backlog. There is no separate replay path
// to fall out of sync with, and no moment where the Host has to decide whether
// a client is "caught up enough" to start pushing.
//
// The cursor advances across events this subscription filtered out. That is
// deliberate: a page whose events were all for another workspace still moves
// the client past that stretch of history, and stopping instead would leave a
// narrow subscription re-scanning the same range forever.

// Projector converts one stored event into the cross-domain envelope of the
// domain that owns it. Each business domain contributes one; a projector that
// does not own a stored kind returns nil, so an entity a Host version does not
// publish is skipped rather than delivered with an unspecified domain.
type Projector interface {
	Domain() pb.EventDomain
	Project(storage.Event) (*pb.EventEnvelope, error)
}

// project runs the stored event past every projector, in order, and stamps the
// priority its domain assigns. The first projector that claims the kind wins.
func (h *Hub) project(event storage.Event) (*pb.EventEnvelope, error) {
	for _, projector := range h.projectors {
		envelope, err := projector.Project(event)
		if err != nil {
			return nil, err
		}
		if envelope == nil {
			continue
		}
		if envelope.Domain == pb.EventDomain_EVENT_DOMAIN_UNSPECIFIED {
			envelope.Domain = projector.Domain()
		}
		if envelope.Priority == pb.EventPriority_EVENT_PRIORITY_UNSPECIFIED {
			envelope.Priority = Priority(envelope.Domain, envelope.GetKind())
		}
		return envelope, nil
	}
	return nil, nil
}

// page reads one page after `cursor` and projects it for one subscription.
//
// The three statuses are answers, not shades of the same answer, so each is
// returned as itself with the floor and the watermark attached:
//
//   - OK: apply these events, then continue from `next_cursor`.
//   - SNAPSHOT_REQUIRED: the cursor is below the retained floor. There is no
//     honest page to send; the client must re-seed from a snapshot.
//   - CURSOR_AHEAD: the client holds sequences this Host never issued. Rewinding
//     it to the watermark would silently discard changes it already applied.
func (h *Hub) page(ctx context.Context, cursor uint64, f filter) (*pb.EventPage, error) {
	stored, err := h.store.GetEvents(ctx, storage.EventQuery{After: cursor, Limit: MaxPageEvents, ByteBudget: f.pageBytes})
	if err != nil {
		return nil, err
	}
	result := &pb.EventPage{
		NextCursor:    stored.NextCursor,
		MinCursor:     stored.MinCursor,
		HighWatermark: stored.HighWatermark,
		HasMore:       stored.HasMore,
	}
	switch stored.Status {
	case storage.SnapshotRequired:
		result.Status = pb.EventCursorStatus_EVENT_CURSOR_STATUS_SNAPSHOT_REQUIRED
		result.NextCursor = 0
		result.HasMore = false
		return result, nil
	case storage.CursorAhead:
		result.Status = pb.EventCursorStatus_EVENT_CURSOR_STATUS_CURSOR_AHEAD
		result.NextCursor = 0
		result.HasMore = false
		return result, nil
	}
	result.Status = pb.EventCursorStatus_EVENT_CURSOR_STATUS_OK
	for _, event := range stored.Events {
		envelope, err := h.project(event)
		if err != nil {
			return nil, err
		}
		if !f.admits(envelope) {
			continue
		}
		result.Events = append(result.Events, envelope)
	}
	return result, nil
}
