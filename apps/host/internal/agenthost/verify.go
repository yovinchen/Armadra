package agenthost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Checking that the projection is the rows it came from (§3.3 agent row).
//
// The checks are the ones §3.3 names, each one a separate statement so a
// failure says which property broke rather than that "something differs". Two
// of them are the reason the list is not simply a row count:
//
//   - `agent.approvals.unanswered` compares the *set* of open questions. A
//     switch that lost one would leave a CLI blocked on a question no client
//     shows, and a count alone would not notice if it had also gained one.
//   - `agent.mailbox.unacked` compares both the set and its order. A message's
//     `sequence` is its place in an inbox; two messages restored in the wrong
//     order are two messages somebody reads in the wrong order.
//
// Verify writes nothing and grants nothing. The switch refuses on an unmatched
// report.

func (s *Service) Verify(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	rows, err := s.readStaged(ctx, importID)
	if err != nil {
		return nil, err
	}
	builder := new(checkBuilder)
	stored, err := s.verifyStatuses(ctx, rows, builder)
	if err != nil {
		return nil, err
	}
	if err = s.verifyApprovals(ctx, rows, builder); err != nil {
		return nil, err
	}
	if err = s.verifyMailbox(ctx, rows, builder); err != nil {
		return nil, err
	}
	if err = s.verifyDeliveries(ctx, rows, builder); err != nil {
		return nil, err
	}
	if err = s.verifyHandoffs(ctx, rows, builder); err != nil {
		return nil, err
	}
	if err = s.verifyLinks(ctx, rows, builder); err != nil {
		return nil, err
	}
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT,
		ImportId:         importID,
		Checks:           builder.checks,
		EntityCount:      stored,
		VerifiedAtUnixMs: s.now(),
		Matched:          true,
	}
	for _, check := range builder.checks {
		if !check.Matched {
			report.Matched = false
		}
	}
	return report, nil
}

func (s *Service) verifyStatuses(ctx context.Context, rows staged, builder *checkBuilder) (uint64, error) {
	var missing, states, unread []string
	found := uint64(0)
	for _, nodeID := range sortedKeys(rows.statuses) {
		expected, err := stagedStatus(rows.statuses[nodeID])
		if err != nil {
			return 0, err
		}
		current, err := s.store.GetAgentStatus(ctx, nodeID)
		if errors.Is(err, storage.ErrNotFound) {
			missing = append(missing, nodeID)
			continue
		}
		if err != nil {
			return 0, err
		}
		found++
		if current.Deleted || current.WorkspaceID != expected.WorkspaceID {
			missing = append(missing, nodeID)
		}
		if current.State != expected.State || current.SessionPhase != expected.SessionPhase {
			states = append(states, nodeID)
		}
		if current.Unread != expected.Unread {
			unread = append(unread, nodeID)
		}
	}
	total := uint64(len(rows.statuses))
	builder.record("agent.status.count", total, found, nil)
	builder.record("agent.status.ids", total, found, missing)
	builder.record("agent.status.state", total, found, states)
	builder.record("agent.status.unread", total, found, unread)
	return found, nil
}

func (s *Service) verifyApprovals(ctx context.Context, rows staged, builder *checkBuilder) error {
	var missing []string
	stagedOpen := map[string]bool{}
	found := uint64(0)
	for _, approvalID := range sortedKeys(rows.approvals) {
		values := rows.approvals[approvalID]
		answered, err := milliseconds(values["answered_at"])
		if err != nil {
			return err
		}
		if values["answer"] == "" || answered <= 0 {
			stagedOpen[approvalID] = true
		}
		current, err := s.store.GetApproval(ctx, approvalID)
		if errors.Is(err, storage.ErrNotFound) {
			missing = append(missing, approvalID)
			continue
		}
		if err != nil {
			return err
		}
		found++
		if current.NodeID != values["node_id"] {
			missing = append(missing, approvalID)
		}
	}
	// The set of open questions, both ways. A switch that dropped one would
	// leave a CLI blocked on something nobody shows; one that invented one
	// would show a question no CLI is waiting on.
	all, err := s.store.AllApprovals(ctx)
	if err != nil {
		return err
	}
	differences := []string{}
	hostOpen := map[string]bool{}
	for _, approval := range all {
		if approval.State == int32(pb.ApprovalState_APPROVAL_STATE_PENDING) {
			hostOpen[approval.ApprovalID] = true
		}
	}
	for approvalID := range stagedOpen {
		if !hostOpen[approvalID] {
			differences = append(differences, approvalID)
		}
	}
	for approvalID := range hostOpen {
		if !stagedOpen[approvalID] {
			differences = append(differences, approvalID)
		}
	}
	total := uint64(len(rows.approvals))
	builder.record("agent.approvals.count", total, found, missing)
	builder.record("agent.approvals.unanswered", uint64(len(stagedOpen)), uint64(len(hostOpen)), differences)
	return nil
}

func (s *Service) verifyMailbox(ctx context.Context, rows staged, builder *checkBuilder) error {
	var missing []string
	found := uint64(0)
	stagedUnacked := []string{}
	for _, messageID := range sortedKeys(rows.messages) {
		values := rows.messages[messageID]
		acknowledged, err := integer(values["acknowledged_at"])
		if err != nil {
			return err
		}
		if acknowledged == 0 {
			stagedUnacked = append(stagedUnacked, messageID)
		}
		current, err := s.store.GetMailboxMessage(ctx, messageID)
		if errors.Is(err, storage.ErrNotFound) {
			missing = append(missing, messageID)
			continue
		}
		if err != nil {
			return err
		}
		found++
		if current.TargetNodeID != values["target_node_id"] || current.Body != values["body"] {
			missing = append(missing, messageID)
		}
	}
	// Order as well as membership: `sequence` is a message's place in an inbox,
	// and two messages restored in the wrong order are two messages somebody
	// reads in the wrong order.
	all, err := s.store.AllMailbox(ctx)
	if err != nil {
		return err
	}
	hostUnacked := []string{}
	for _, message := range all {
		if message.AckedAtMS == 0 && !message.Deleted {
			hostUnacked = append(hostUnacked, message.MessageID)
		}
	}
	differences := []string{}
	if len(hostUnacked) != len(stagedUnacked) {
		differences = append(differences, "count")
	} else {
		for index := range stagedUnacked {
			if stagedUnacked[index] != hostUnacked[index] {
				differences = append(differences, hostUnacked[index])
			}
		}
	}
	total := uint64(len(rows.messages))
	builder.record("agent.mailbox.count", total, found, missing)
	builder.record("agent.mailbox.unacked", uint64(len(stagedUnacked)), uint64(len(hostUnacked)), differences)
	return nil
}

func (s *Service) verifyDeliveries(ctx context.Context, rows staged, builder *checkBuilder) error {
	var missing, outcomes []string
	found := uint64(0)
	for _, traceID := range sortedKeys(rows.deliveries) {
		values := rows.deliveries[traceID]
		expected, err := projectOutcome(values["outcome"])
		if err != nil {
			return err
		}
		current, err := s.store.GetDelivery(ctx, traceID)
		if errors.Is(err, storage.ErrNotFound) {
			missing = append(missing, traceID)
			continue
		}
		if err != nil {
			return err
		}
		found++
		if current.Outcome != int32(expected) {
			outcomes = append(outcomes, traceID)
		}
	}
	total := uint64(len(rows.deliveries))
	builder.record("agent.deliveries.count", total, found, missing)
	builder.record("agent.deliveries.outcome", total, found, outcomes)
	return nil
}

func (s *Service) verifyHandoffs(ctx context.Context, rows staged, builder *checkBuilder) error {
	var missing, bundles, states, attempts []string
	found := uint64(0)
	for _, handoffID := range sortedKeys(rows.handoffs) {
		values := rows.handoffs[handoffID]
		expectedState, err := projectHandoffState(values["state"], rows.outbox[handoffID]["state"])
		if err != nil {
			return err
		}
		current, err := s.store.GetHandoff(ctx, handoffID)
		if errors.Is(err, storage.ErrNotFound) {
			missing = append(missing, handoffID)
			continue
		}
		if err != nil {
			return err
		}
		found++
		if string(current.BundleSHA256) != string(digest([]byte(values["bundle_json"]))) {
			bundles = append(bundles, handoffID)
		}
		if current.State != int32(expectedState) {
			states = append(states, handoffID)
		}
		expectedAttempts, err := integer(rows.outbox[handoffID]["attempts"])
		if err != nil || expectedAttempts < 0 {
			expectedAttempts = 0
		}
		if int64(current.Attempts) != expectedAttempts {
			attempts = append(attempts, handoffID)
		}
	}
	total := uint64(len(rows.handoffs))
	builder.record("agent.handoffs.count", total, found, missing)
	builder.record("agent.handoffs.bundle_sha256", total, found, bundles)
	builder.record("agent.handoffs.state", total, found, states)
	builder.record("agent.outbox.attempts", total, found, attempts)
	return nil
}

func (s *Service) verifyLinks(ctx context.Context, rows staged, builder *checkBuilder) error {
	var differences []string
	found := uint64(0)
	for _, nodeID := range sortedKeys(rows.links) {
		values := rows.links[nodeID]
		expected, err := decodeLegacyLinks(values["links_json"])
		if err != nil {
			return err
		}
		encoded, err := encodeLinks(expected)
		if err != nil {
			return err
		}
		current, err := s.store.GetContextLinks(ctx, nodeID)
		if errors.Is(err, storage.ErrNotFound) {
			differences = append(differences, nodeID)
			continue
		}
		if err != nil {
			return err
		}
		found++
		if string(current.Links) != string(encoded) {
			differences = append(differences, nodeID)
		}
	}
	builder.record("agent.context_links.links", uint64(len(rows.links)), found, differences)
	return nil
}
