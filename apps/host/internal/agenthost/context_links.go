package agenthost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Which nodes may read which (Go Host 业务所有权迁移 §2.7 `ContextLinks`).
//
// This is a projection of the canvas' own edges and never a client write. That
// is the whole security property of "context follows the connection": an agent
// reads a neighbour's transcript because somebody drew a line between them on a
// board, and a client that could write this table directly could grant itself
// that read without drawing anything.
//
// So the only way a link changes here is that an edge changed there, and the
// only input is the canvas entities this Host already stores.
//
// **Deviation from §2.7.** The design has the Host write this projection inside
// the canvas transaction. It is written just after instead, from a hook the
// canvas service calls once a save has committed. Doing it inside would mean
// the canvas package producing agent-domain changes — a dependency in the wrong
// direction, from the domain that was migrated first to the one migrated last.
// The consequence is a window of one write in which a link is stale; a reader
// in that window sees the previous connection, never one that was never drawn.

// RefreshContextLinks recomputes one workspace's projection from its edges.
//
// It is idempotent and quiet: a node whose links are unchanged is not rewritten,
// so a canvas save that moved a sticky does not republish every agent's
// connections. It returns how many projections actually changed.
func (s *Service) RefreshContextLinks(ctx context.Context, workspaceID string) (int, error) {
	if s == nil {
		return 0, nil
	}
	if !validID(workspaceID) {
		return 0, ErrInvalid
	}
	owned, err := s.Owned(ctx)
	if err != nil || !owned {
		// While the Runtime owns the domain its `context_links` table is the
		// record. Writing here as well would be the dual-write this migration
		// exists to avoid.
		return 0, err
	}
	kinds, err := s.nodeTypes(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	wanted, err := s.linksFromEdges(ctx, workspaceID, kinds)
	if err != nil {
		return 0, err
	}
	stored, err := s.store.ListContextLinks(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	current := map[string]storage.ContextLinks{}
	for _, record := range stored {
		current[record.NodeID] = record
	}
	changed := 0
	for _, nodeID := range sortedKeys(wanted) {
		next, err := encodeLinks(wanted[nodeID])
		if err != nil {
			return changed, err
		}
		existing, seen := current[nodeID]
		if seen && string(existing.Links) == string(next) {
			continue
		}
		record := storage.ContextLinks{
			NodeID:      nodeID,
			WorkspaceID: workspaceID,
			Links:       next,
			UpdatedAtMS: s.now(),
		}
		if record, err = stampContextLinks(record, &pb.ContextLinks{
			NodeId:          nodeID,
			WorkspaceId:     workspaceID,
			Links:           wanted[nodeID],
			UpdatedAtUnixMs: record.UpdatedAtMS,
		}); err != nil {
			return changed, err
		}
		expected := uint64(0)
		if seen {
			expected = existing.Revision
		}
		if _, err = s.store.PutContextLinks(ctx, "agent/links/"+nodeID+"/"+revisionKey(expected), record, expected); err != nil {
			return changed, err
		}
		changed++
	}
	// A node that lost its last edge keeps a row with an empty list. "This node
	// is connected to nothing" and "nobody has looked" are different answers,
	// and only the first can be drawn.
	for nodeID, record := range current {
		if _, still := wanted[nodeID]; still || len(record.Links) == 0 {
			continue
		}
		cleared := record
		cleared.Links = nil
		cleared.UpdatedAtMS = s.now()
		stamped, err := stampContextLinks(cleared, &pb.ContextLinks{
			NodeId:          nodeID,
			WorkspaceId:     workspaceID,
			UpdatedAtUnixMs: cleared.UpdatedAtMS,
		})
		if err != nil {
			return changed, err
		}
		if _, err = s.store.PutContextLinks(ctx, "agent/links/"+nodeID+"/clear/"+revisionKey(record.Revision), stamped, record.Revision); err != nil {
			return changed, err
		}
		changed++
	}
	return changed, nil
}

func revisionKey(revision uint64) string {
	if revision == 0 {
		return "new"
	}
	return "r" + itoa(revision)
}

func itoa(value uint64) string {
	if value == 0 {
		return "0"
	}
	digits := [20]byte{}
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

// nodeTypes reads what each node in a workspace is, so a link can say what it
// points at without a second read per edge.
func (s *Service) nodeTypes(ctx context.Context, workspaceID string) (map[string]string, error) {
	kinds := map[string]string{}
	after := ""
	for {
		page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: "canvas.node", AfterID: after, Limit: storage.MaxPageSize})
		if err != nil {
			return nil, err
		}
		for _, entity := range page.Entities {
			node := new(pb.CanvasNode)
			if proto.Unmarshal(entity.Payload, node) != nil {
				return nil, storage.ErrCorrupt
			}
			kinds[node.GetNodeId()] = node.GetType()
		}
		if !page.HasMore || page.NextID == after {
			return kinds, nil
		}
		after = page.NextID
	}
}

// linksFromEdges turns the workspace's edges into one list per node.
//
// Every edge appears twice — once outgoing from its source, once incoming to
// its target — because both ends need to know. A node that only saw its
// outgoing links could not tell that somebody had connected to it, and the
// direction is what decides which of the two may read the other.
func (s *Service) linksFromEdges(ctx context.Context, workspaceID string, kinds map[string]string) (map[string][]*pb.ContextLink, error) {
	links := map[string][]*pb.ContextLink{}
	after := ""
	for {
		page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: "canvas.edge", AfterID: after, Limit: storage.MaxPageSize})
		if err != nil {
			return nil, err
		}
		for _, entity := range page.Entities {
			edge := new(pb.CanvasEdge)
			if proto.Unmarshal(entity.Payload, edge) != nil {
				return nil, storage.ErrCorrupt
			}
			source, target := edge.GetSourceNodeId(), edge.GetTargetNodeId()
			if source == "" || target == "" || source == target {
				continue
			}
			links[source] = append(links[source], &pb.ContextLink{
				TargetNodeId: target,
				Direction:    pb.ContextLinkDirection_CONTEXT_LINK_DIRECTION_OUTGOING,
				Kind:         kinds[target],
			})
			links[target] = append(links[target], &pb.ContextLink{
				TargetNodeId: source,
				Direction:    pb.ContextLinkDirection_CONTEXT_LINK_DIRECTION_INCOMING,
				Kind:         kinds[source],
			})
		}
		if !page.HasMore || page.NextID == after {
			break
		}
		after = page.NextID
	}
	// One order, always. Two projections of the same board have to produce the
	// same bytes, or the digest a rollback compares would differ because a
	// listing came back in another order.
	for nodeID := range links {
		sortLinks(links[nodeID])
	}
	return links, nil
}

func sortLinks(links []*pb.ContextLink) {
	for outer := 1; outer < len(links); outer++ {
		for inner := outer; inner > 0 && lessLink(links[inner], links[inner-1]); inner-- {
			links[inner], links[inner-1] = links[inner-1], links[inner]
		}
	}
}

func lessLink(left, right *pb.ContextLink) bool {
	if left.GetTargetNodeId() != right.GetTargetNodeId() {
		return left.GetTargetNodeId() < right.GetTargetNodeId()
	}
	return left.GetDirection() < right.GetDirection()
}

// ListContextLinks answers the projection for one node, or for the caller's
// whole workspace when no node is named.
func (s *Service) ListContextLinks(ctx context.Context, caller Caller, request *pb.ListContextLinksRequest) (*pb.ListContextLinksResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	result := &pb.ListContextLinksResponse{}
	if nodeID := request.GetNodeId(); nodeID != "" {
		if !validID(nodeID) {
			return nil, ErrInvalid
		}
		record, err := s.store.GetContextLinks(ctx, nodeID)
		if errors.Is(err, storage.ErrNotFound) {
			return result, nil
		}
		if err != nil {
			return nil, err
		}
		if record.WorkspaceID != caller.WorkspaceID {
			return nil, ErrAuthorization
		}
		value, err := contextLinksMessage(record)
		if err != nil {
			return nil, err
		}
		result.Links = append(result.Links, value)
		return result, nil
	}
	records, err := s.store.ListContextLinks(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		value, err := contextLinksMessage(record)
		if err != nil {
			return nil, err
		}
		result.Links = append(result.Links, value)
	}
	return result, nil
}
