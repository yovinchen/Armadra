package agenthost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Taking the agent domain over (Go Host 业务所有权迁移 §2.11 steps 3-4,
// §3.3 agent row).
//
// The source is the Runtime's own tables, which the offline bundle already
// carries: `agent_status`, `agent_approvals`, `agent_mailbox`,
// `agent_deliveries`, `agent_handoffs` and `context_links`. Adopting is a
// projection of rows this Host has staged, and it is deliberately not a second
// export: the switch happens with the Runtime stopped, and asking a live
// process for its state during a maintenance window would be asking a side that
// is meant to be frozen.
//
// Nothing is invented, and one thing in particular is not: a row this
// projection cannot read blocks the switch instead of becoming a record with a
// default in it. A default here is an agent shown as idle when it is blocked,
// or an approval shown as answered when nobody answered it.
//
// The two vocabularies meet in three places and each is spelled out below: the
// Runtime's `state` words, its `answer` column, and the merge of
// `agent_handoffs.state` with `agent_handoff_outbox.state`.

const (
	legacyStatus     = "legacy.agent_status"
	legacyApprovals  = "legacy.agent_approvals"
	legacyMailbox    = "legacy.agent_mailbox"
	legacyDeliveries = "legacy.agent_deliveries"
	legacyHandoffs   = "legacy.agent_handoffs"
	legacyOutbox     = "legacy.agent_handoff_outbox"
	legacyLinks      = "legacy.context_links"
)

// staged holds one import's rows, keyed by their own identifiers.
type staged struct {
	statuses   map[string]map[string]string
	approvals  map[string]map[string]string
	messages   map[string]map[string]string
	deliveries map[string]map[string]string
	handoffs   map[string]map[string]string
	outbox     map[string]map[string]string
	links      map[string]map[string]string
}

func column(row *pb.ImportedSqlRow, name string) (string, bool) {
	for _, value := range row.GetColumns() {
		if value.GetName() != name {
			continue
		}
		switch stored := value.GetValue().(type) {
		case *pb.ImportedSqlColumn_NullValue:
			return "", true
		case *pb.ImportedSqlColumn_TextValue:
			return stored.TextValue, true
		case *pb.ImportedSqlColumn_IntegerValue:
			return strconv.FormatInt(stored.IntegerValue, 10), true
		default:
			return "", false
		}
	}
	return "", false
}

// columns flattens one staged row so the projections below read a map rather
// than a repeated scan. The Runtime's tables carry between four and eighteen
// columns each; a per-table struct for every one of them would be six structs
// that say nothing the map does not.
func columns(row *pb.ImportedSqlRow) map[string]string {
	values := map[string]string{}
	for _, value := range row.GetColumns() {
		name := value.GetName()
		if text, ok := column(row, name); ok {
			values[name] = text
		}
	}
	return values
}

// milliseconds converts a stored RFC 3339 timestamp. An unreadable one is
// reported rather than replaced: an approval created in 1970 because a string
// could not be parsed is a silent data change.
func milliseconds(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0, fmt.Errorf("%w: unreadable timestamp", ErrInvalid)
	}
	return parsed.UnixMilli(), nil
}

func integer(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	var parsed int64
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return 0, fmt.Errorf("%w: unreadable number", ErrInvalid)
	}
	return parsed, nil
}

// optionalFlag reads a nullable integer column as the tri-state it is. The
// Runtime stores `errored` and `interrupted` as NULL / 0 / 1, and the NULL is
// the value that matters: it says nobody has reported anything.
func optionalFlag(values map[string]string, name string) (*bool, error) {
	raw, present := values[name]
	if !present || raw == "" {
		return nil, nil
	}
	parsed, err := integer(raw)
	if err != nil {
		return nil, err
	}
	flag := parsed != 0
	return &flag, nil
}

// readStaged reads every agent table one import staged.
func (s *Service) readStaged(ctx context.Context, importID string) (staged, error) {
	result := staged{
		statuses:   map[string]map[string]string{},
		approvals:  map[string]map[string]string{},
		messages:   map[string]map[string]string{},
		deliveries: map[string]map[string]string{},
		handoffs:   map[string]map[string]string{},
		outbox:     map[string]map[string]string{},
		links:      map[string]map[string]string{},
	}
	for kind, into := range map[string]struct {
		table string
		key   string
		rows  map[string]map[string]string
	}{
		legacyStatus:     {"agent_status", "node_id", result.statuses},
		legacyApprovals:  {"agent_approvals", "id", result.approvals},
		legacyMailbox:    {"agent_mailbox", "id", result.messages},
		legacyDeliveries: {"agent_deliveries", "trace_id", result.deliveries},
		legacyHandoffs:   {"agent_handoffs", "id", result.handoffs},
		legacyOutbox:     {"agent_handoff_outbox", "handoff_id", result.outbox},
		legacyLinks:      {"context_links", "node_id", result.links},
	} {
		if err := s.readStagedTable(ctx, importID, kind, into.table, into.key, into.rows); err != nil {
			return staged{}, err
		}
	}
	return result, nil
}

func (s *Service) readStagedTable(ctx context.Context, importID, kind, table, key string, into map[string]map[string]string) error {
	workspaces, err := s.store.WorkspacesOfKind(ctx, kind)
	if err != nil {
		return err
	}
	for _, workspaceID := range workspaces {
		after := ""
		for {
			page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: kind, AfterID: after, Limit: storage.MaxPageSize})
			if err != nil {
				return err
			}
			for _, entity := range page.Entities {
				// Several imports can coexist in one Host; only this one's rows
				// are the source of the projection being verified.
				if !strings.HasPrefix(entity.ID, importID+".") {
					continue
				}
				row := new(pb.ImportedSqlRow)
				if err = proto.Unmarshal(entity.Payload, row); err != nil || row.GetTable() != table {
					return storage.ErrCorrupt
				}
				values := columns(row)
				identifier := values[key]
				if identifier == "" {
					return fmt.Errorf("%w: a staged %s row has no %s", ErrInvalid, table, key)
				}
				into[identifier] = values
			}
			if !page.HasMore || page.NextID == after {
				break
			}
			after = page.NextID
		}
	}
	return nil
}

// projectState maps the Runtime's `agent_status.state` words.
//
// A word this build does not know is refused rather than mapped to a default:
// recording a node as idle on no evidence is how a person comes back to find
// nothing was waiting for them when something was.
func projectState(value string) (pb.AgentState, error) {
	switch value {
	case "", "idle":
		return pb.AgentState_AGENT_STATE_IDLE, nil
	case "working":
		return pb.AgentState_AGENT_STATE_WORKING, nil
	case "waiting":
		return pb.AgentState_AGENT_STATE_WAITING, nil
	case "blocked":
		return pb.AgentState_AGENT_STATE_BLOCKED, nil
	case "done":
		return pb.AgentState_AGENT_STATE_DONE, nil
	default:
		return 0, fmt.Errorf("%w: a staged agent status has an unknown state %q", ErrInvalid, value)
	}
}

// projectHandoffState merges `agent_handoffs.state` with the outbox row's own.
//
// The outbox wins where it says more. A handoff the table calls `prepared`
// whose outbox row says `dispatching` is one somebody started delivering, and a
// client that read only the first would offer to send it again.
func projectHandoffState(handoff, outbox string) (pb.HandoffState, error) {
	merged := handoff
	switch outbox {
	case "dispatching", "delivered", "failed", "unknownOutcome":
		merged = outbox
	case "pending":
		if handoff == "prepared" {
			merged = "queued"
		}
	case "":
	default:
		return 0, fmt.Errorf("%w: a staged handoff outbox has an unknown state %q", ErrInvalid, outbox)
	}
	switch merged {
	case "prepared", "":
		return pb.HandoffState_HANDOFF_STATE_PREPARED, nil
	case "queued", "accepted":
		return pb.HandoffState_HANDOFF_STATE_QUEUED, nil
	case "dispatching":
		return pb.HandoffState_HANDOFF_STATE_DISPATCHING, nil
	case "delivered":
		return pb.HandoffState_HANDOFF_STATE_DELIVERED, nil
	case "acknowledged":
		return pb.HandoffState_HANDOFF_STATE_ACKNOWLEDGED, nil
	case "cancelled":
		return pb.HandoffState_HANDOFF_STATE_CANCELLED, nil
	case "failed":
		return pb.HandoffState_HANDOFF_STATE_FAILED, nil
	case "unknownOutcome":
		return pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME, nil
	default:
		return 0, fmt.Errorf("%w: a staged handoff has an unknown state %q", ErrInvalid, merged)
	}
}

// projectOutcome maps `agent_deliveries.outcome`.
func projectOutcome(value string) (pb.DeliveryOutcome, error) {
	switch value {
	case "submitted", "delivered":
		return pb.DeliveryOutcome_DELIVERY_OUTCOME_SUBMITTED, nil
	case "notWritten", "not_written", "refused":
		return pb.DeliveryOutcome_DELIVERY_OUTCOME_NOT_WRITTEN, nil
	case "", "unknown", "unknownOutcome":
		return pb.DeliveryOutcome_DELIVERY_OUTCOME_UNKNOWN, nil
	default:
		return 0, fmt.Errorf("%w: a staged delivery has an unknown outcome %q", ErrInvalid, value)
	}
}

// Adopt projects every staged agent row and verifies the result item for item.
func (s *Service) Adopt(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	rows, err := s.readStaged(ctx, importID)
	if err != nil {
		return nil, err
	}
	if err = s.adoptStatuses(ctx, importID, rows); err != nil {
		return nil, err
	}
	if err = s.adoptApprovals(ctx, importID, rows); err != nil {
		return nil, err
	}
	if err = s.adoptMailbox(ctx, importID, rows); err != nil {
		return nil, err
	}
	if err = s.adoptDeliveries(ctx, importID, rows); err != nil {
		return nil, err
	}
	if err = s.adoptHandoffs(ctx, importID, rows); err != nil {
		return nil, err
	}
	if err = s.adoptLinks(ctx, importID, rows); err != nil {
		return nil, err
	}
	return s.Verify(ctx, importID)
}

func (s *Service) adoptStatuses(ctx context.Context, importID string, rows staged) error {
	for _, nodeID := range sortedKeys(rows.statuses) {
		next, err := stagedStatus(rows.statuses[nodeID])
		if err != nil {
			return err
		}
		expected, skip, err := s.priorStatus(ctx, nodeID, next)
		if err != nil || skip {
			if err != nil {
				return err
			}
			continue
		}
		if next, err = stampStatus(next); err != nil {
			return err
		}
		if _, err = s.store.PutAgentStatus(ctx, "agent/adopt/"+importID+"/status/"+nodeID, next, expected); err != nil {
			return err
		}
	}
	return nil
}

// priorStatus reports the revision an adoption has to name, and whether the
// record is already exactly what would be written. Re-adopting after a rollback
// leaves an identical record alone rather than republishing it, so a second
// switch does not tell every client that every agent changed.
func (s *Service) priorStatus(ctx context.Context, nodeID string, next storage.AgentStatus) (uint64, bool, error) {
	current, err := s.store.GetAgentStatus(ctx, nodeID)
	switch {
	case errors.Is(err, storage.ErrNotFound):
		return 0, false, nil
	case err != nil:
		return 0, false, err
	}
	if sameAdoptedStatus(current, next) {
		return 0, true, nil
	}
	return current.Revision, false, nil
}

func stagedStatus(values map[string]string) (storage.AgentStatus, error) {
	nodeID, workspaceID := values["node_id"], values["workspace_id"]
	if !validID(nodeID) || !validID(workspaceID) {
		return storage.AgentStatus{}, fmt.Errorf("%w: a staged agent status is unreadable", ErrInvalid)
	}
	state, err := projectState(values["state"])
	if err != nil {
		return storage.AgentStatus{}, err
	}
	unread, err := integer(values["unread"])
	if err != nil || unread < 0 {
		return storage.AgentStatus{}, fmt.Errorf("%w: a staged agent status has an unreadable unread count", ErrInvalid)
	}
	verified, err := integer(values["verified"])
	if err != nil {
		return storage.AgentStatus{}, err
	}
	restored, err := integer(values["restored"])
	if err != nil {
		return storage.AgentStatus{}, err
	}
	errored, err := optionalFlag(values, "errored")
	if err != nil {
		return storage.AgentStatus{}, err
	}
	interrupted, err := optionalFlag(values, "interrupted")
	if err != nil {
		return storage.AgentStatus{}, err
	}
	lastEvent, err := milliseconds(values["last_event_at"])
	if err != nil {
		return storage.AgentStatus{}, err
	}
	updated, err := milliseconds(values["updated_at"])
	if err != nil {
		return storage.AgentStatus{}, err
	}
	if updated <= 0 {
		return storage.AgentStatus{}, fmt.Errorf("%w: a staged agent status has no update time", ErrInvalid)
	}
	return storage.AgentStatus{
		NodeID:      nodeID,
		WorkspaceID: workspaceID,
		SessionID:   values["session_id"],
		AgentID:     values["agent_id"],
		Unread:      uint32(unread),
		Verified:    verified != 0,
		Restored:    restored != 0,
		Errored:     errored,
		Interrupted: interrupted,
		// The Runtime stores a filesystem path. It is carried as an opaque
		// reference rather than as a path, because it names a file on the
		// execution host that this Host has no business opening.
		TranscriptRef: []byte(values["transcript_path"]),
		State:         int32(state),
		SessionPhase:  values["session_phase"],
		LastEventMS:   lastEvent,
		UpdatedAtMS:   updated,
	}, nil
}

func sameAdoptedStatus(current, next storage.AgentStatus) bool {
	if (current.Errored == nil) != (next.Errored == nil) || (current.Interrupted == nil) != (next.Interrupted == nil) {
		return false
	}
	if current.Errored != nil && *current.Errored != *next.Errored {
		return false
	}
	if current.Interrupted != nil && *current.Interrupted != *next.Interrupted {
		return false
	}
	return current.WorkspaceID == next.WorkspaceID && current.SessionID == next.SessionID &&
		current.AgentID == next.AgentID && current.Unread == next.Unread &&
		current.Verified == next.Verified && current.Restored == next.Restored &&
		current.State == next.State && current.SessionPhase == next.SessionPhase &&
		string(current.TranscriptRef) == string(next.TranscriptRef) &&
		current.Deleted == next.Deleted
}

func (s *Service) adoptApprovals(ctx context.Context, importID string, rows staged) error {
	for _, approvalID := range sortedKeys(rows.approvals) {
		values := rows.approvals[approvalID]
		if !validID(approvalID) || !validID(values["node_id"]) || !validID(values["workspace_id"]) {
			return fmt.Errorf("%w: a staged approval is unreadable", ErrInvalid)
		}
		created, err := milliseconds(values["created_at"])
		if err != nil {
			return err
		}
		answered, err := milliseconds(values["answered_at"])
		if err != nil {
			return err
		}
		if created <= 0 {
			return fmt.Errorf("%w: a staged approval has no creation time", ErrInvalid)
		}
		// The Runtime's `answer` column is the CLI's own word and is carried
		// verbatim. An answered row is one that has both a word and a moment;
		// a row with one and not the other is a row nobody can explain.
		decision := values["answer"]
		state := pb.ApprovalState_APPROVAL_STATE_PENDING
		if decision != "" && answered > 0 {
			state = pb.ApprovalState_APPROVAL_STATE_ANSWERED
		} else {
			decision, answered = "", 0
		}
		request := []byte(values["request_json"])
		approval := storage.Approval{
			ApprovalID:    approvalID,
			NodeID:        values["node_id"],
			WorkspaceID:   values["workspace_id"],
			Request:       request,
			RequestSHA256: digest(request),
			Decision:      decision,
			AnsweredBy:    values["answered_by"],
			State:         int32(state),
			CreatedAtMS:   created,
			AnsweredAtMS:  answered,
		}
		current, err := s.store.GetApproval(ctx, approvalID)
		expected := uint64(0)
		switch {
		case err == nil:
			if sameAdoptedApproval(current, approval) {
				continue
			}
			expected = current.Revision
		case errors.Is(err, storage.ErrNotFound):
		default:
			return err
		}
		if approval, err = stampApproval(approval); err != nil {
			return err
		}
		if _, err = s.store.PutApproval(ctx, "agent/adopt/"+importID+"/approval/"+approvalID, approval, expected); err != nil {
			return err
		}
	}
	return nil
}

func sameAdoptedApproval(current, next storage.Approval) bool {
	return current.NodeID == next.NodeID && current.WorkspaceID == next.WorkspaceID &&
		current.Decision == next.Decision && current.AnsweredBy == next.AnsweredBy &&
		current.State == next.State && string(current.RequestSHA256) == string(next.RequestSHA256)
}

func (s *Service) adoptMailbox(ctx context.Context, importID string, rows staged) error {
	for _, messageID := range sortedKeys(rows.messages) {
		values := rows.messages[messageID]
		if !validID(messageID) || !validID(values["workspace_id"]) ||
			!validID(values["source_node_id"]) || !validID(values["target_node_id"]) {
			return fmt.Errorf("%w: a staged mailbox message is unreadable", ErrInvalid)
		}
		// The Runtime's mailbox timestamps are epoch integers, not RFC 3339.
		created, err := integer(values["created_at"])
		if err != nil {
			return err
		}
		expires, err := integer(values["expires_at"])
		if err != nil {
			return err
		}
		acknowledged, err := integer(values["acknowledged_at"])
		if err != nil {
			return err
		}
		sequence, err := integer(values["sequence"])
		if err != nil || sequence <= 0 {
			return fmt.Errorf("%w: a staged mailbox message has no sequence", ErrInvalid)
		}
		if created <= 0 {
			return fmt.Errorf("%w: a staged mailbox message has no creation time", ErrInvalid)
		}
		message := storage.MailboxMessage{
			MessageID:    messageID,
			WorkspaceID:  values["workspace_id"],
			SourceNodeID: values["source_node_id"],
			TargetNodeID: values["target_node_id"],
			MessageKey:   values["message_key"],
			Body:         values["body"],
			Sequence:     uint64(sequence),
			CreatedAtMS:  created,
			ExpiresAtMS:  expires,
			AckedAtMS:    acknowledged,
		}
		current, err := s.store.GetMailboxMessage(ctx, messageID)
		expected := uint64(0)
		switch {
		case err == nil:
			if current.Body == message.Body && current.AckedAtMS == message.AckedAtMS && current.Sequence == message.Sequence {
				continue
			}
			expected = current.Revision
		case errors.Is(err, storage.ErrNotFound):
		default:
			return err
		}
		if message, err = stampMailbox(message); err != nil {
			return err
		}
		if _, err = s.store.PutMailboxMessage(ctx, "agent/adopt/"+importID+"/mailbox/"+messageID, message, expected); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) adoptDeliveries(ctx context.Context, importID string, rows staged) error {
	for _, traceID := range sortedKeys(rows.deliveries) {
		values := rows.deliveries[traceID]
		if !validID(traceID) || !validID(values["workspace_id"]) || !validID(values["target_node_id"]) {
			return fmt.Errorf("%w: a staged delivery is unreadable", ErrInvalid)
		}
		outcome, err := projectOutcome(values["outcome"])
		if err != nil {
			return err
		}
		created, err := milliseconds(values["created_at"])
		if err != nil {
			return err
		}
		if created <= 0 {
			return fmt.Errorf("%w: a staged delivery has no creation time", ErrInvalid)
		}
		chars, err := integer(values["body_chars"])
		if err != nil || chars < 0 {
			return fmt.Errorf("%w: a staged delivery has an unreadable length", ErrInvalid)
		}
		delivery := storage.Delivery{
			TraceID:      traceID,
			WorkspaceID:  values["workspace_id"],
			SourceNodeID: values["source_node_id"],
			TargetNodeID: values["target_node_id"],
			Receipt:      values["receipt"],
			BodyChars:    uint32(chars),
			Outcome:      int32(outcome),
			CreatedAtMS:  created,
		}
		if _, err = s.store.GetDelivery(ctx, traceID); err == nil {
			continue
		} else if !errors.Is(err, storage.ErrNotFound) {
			return err
		}
		if delivery, err = stampDelivery(delivery); err != nil {
			return err
		}
		if _, err = s.store.PutDelivery(ctx, "agent/adopt/"+importID+"/delivery/"+traceID, delivery, 0); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) adoptHandoffs(ctx context.Context, importID string, rows staged) error {
	for _, handoffID := range sortedKeys(rows.handoffs) {
		values := rows.handoffs[handoffID]
		if !validID(handoffID) || !validID(values["workspace_id"]) ||
			!validID(values["source_node_id"]) || !validID(values["target_node_id"]) {
			return fmt.Errorf("%w: a staged handoff is unreadable", ErrInvalid)
		}
		state, err := projectHandoffState(values["state"], rows.outbox[handoffID]["state"])
		if err != nil {
			return err
		}
		created, err := milliseconds(values["created_at"])
		if err != nil {
			return err
		}
		accepted, err := milliseconds(values["accepted_at"])
		if err != nil {
			return err
		}
		updated, err := milliseconds(values["updated_at"])
		if err != nil {
			return err
		}
		if created <= 0 || updated <= 0 {
			return fmt.Errorf("%w: a staged handoff has no timestamps", ErrInvalid)
		}
		sourceGen, err := integer(values["source_generation"])
		if err != nil || sourceGen < 0 {
			return fmt.Errorf("%w: a staged handoff has an unreadable source generation", ErrInvalid)
		}
		targetGen, err := integer(values["target_generation"])
		if err != nil || targetGen < 0 {
			return fmt.Errorf("%w: a staged handoff has an unreadable target generation", ErrInvalid)
		}
		attempts, err := integer(rows.outbox[handoffID]["attempts"])
		if err != nil || attempts < 0 {
			attempts = 0
		}
		bundle := []byte(values["bundle_json"])
		if len(bundle) == 0 {
			return fmt.Errorf("%w: a staged handoff carries no bundle", ErrInvalid)
		}
		handoff := storage.Handoff{
			HandoffID:       handoffID,
			WorkspaceID:     values["workspace_id"],
			SourceNodeID:    values["source_node_id"],
			TargetNodeID:    values["target_node_id"],
			SourceSessionID: values["source_session_id"],
			SourceGen:       uint64(sourceGen),
			TargetSessionID: values["target_session_id"],
			TargetGen:       uint64(targetGen),
			Bundle:          bundle,
			BundleSHA256:    digest(bundle),
			MailboxID:       values["mailbox_id"],
			TraceID:         values["trace_id"],
			Attempts:        uint32(attempts),
			State:           int32(state),
			ErrorCode:       values["error_code"],
			CreatedAtMS:     created,
			AcceptedAtMS:    accepted,
			UpdatedAtMS:     updated,
		}
		current, err := s.store.GetHandoff(ctx, handoffID)
		expected := uint64(0)
		switch {
		case err == nil:
			if current.State == handoff.State && current.Attempts == handoff.Attempts &&
				string(current.BundleSHA256) == string(handoff.BundleSHA256) {
				continue
			}
			expected = current.Revision
		case errors.Is(err, storage.ErrNotFound):
		default:
			return err
		}
		if handoff, err = stampHandoff(handoff); err != nil {
			return err
		}
		if _, err = s.store.PutHandoff(ctx, "agent/adopt/"+importID+"/handoff/"+handoffID, handoff, expected); err != nil {
			return err
		}
	}
	return nil
}

// adoptLinks projects the Runtime's own `context_links` rows.
//
// They are adopted rather than recomputed from the canvas on purpose: the
// switch has to be able to say the two sides hold the same thing, and a
// projection recomputed here would be compared against a table that was written
// by different code at a different time. The recomputation happens afterwards,
// on the first canvas save.
func (s *Service) adoptLinks(ctx context.Context, importID string, rows staged) error {
	for _, nodeID := range sortedKeys(rows.links) {
		values := rows.links[nodeID]
		if !validID(nodeID) || !validID(values["workspace_id"]) {
			return fmt.Errorf("%w: a staged context link row is unreadable", ErrInvalid)
		}
		updated, err := milliseconds(values["updated_at"])
		if err != nil {
			return err
		}
		if updated <= 0 {
			updated = s.now()
		}
		links, err := decodeLegacyLinks(values["links_json"])
		if err != nil {
			return err
		}
		encoded, err := encodeLinks(links)
		if err != nil {
			return err
		}
		record := storage.ContextLinks{
			NodeID:      nodeID,
			WorkspaceID: values["workspace_id"],
			Links:       encoded,
			UpdatedAtMS: updated,
		}
		current, err := s.store.GetContextLinks(ctx, nodeID)
		expected := uint64(0)
		switch {
		case err == nil:
			if string(current.Links) == string(record.Links) {
				continue
			}
			expected = current.Revision
		case errors.Is(err, storage.ErrNotFound):
		default:
			return err
		}
		if record, err = stampContextLinks(record, &pb.ContextLinks{
			NodeId:          nodeID,
			WorkspaceId:     record.WorkspaceID,
			Links:           links,
			UpdatedAtUnixMs: updated,
		}); err != nil {
			return err
		}
		if _, err = s.store.PutContextLinks(ctx, "agent/adopt/"+importID+"/links/"+nodeID, record, expected); err != nil {
			return err
		}
	}
	return nil
}

// legacyLink is one entry of the Runtime's `links_json`.
//
// The Runtime spells the other end's identifier `id`, not `nodeId`: the
// document is a list of *things this node may read*, and a whiteboard shape is
// one of them. `title` and `kind` come along because a link says what it points
// at, and a projection that dropped them would leave a board unable to draw the
// difference between a neighbouring agent and a sticky note.
type legacyLink struct {
	NodeID    string `json:"id"`
	Title     string `json:"title"`
	Direction string `json:"direction"`
	Kind      string `json:"kind"`
}

func decodeLegacyLinks(raw string) ([]*pb.ContextLink, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	entries := []legacyLink{}
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return nil, fmt.Errorf("%w: a staged context link list is unreadable", ErrInvalid)
	}
	links := make([]*pb.ContextLink, 0, len(entries))
	for _, entry := range entries {
		if entry.NodeID == "" {
			continue
		}
		direction := pb.ContextLinkDirection_CONTEXT_LINK_DIRECTION_OUTGOING
		if entry.Direction == "incoming" {
			direction = pb.ContextLinkDirection_CONTEXT_LINK_DIRECTION_INCOMING
		}
		links = append(links, &pb.ContextLink{
			TargetNodeId: entry.NodeID,
			Direction:    direction,
			Kind:         entry.Kind,
			Title:        entry.Title,
		})
	}
	sortLinks(links)
	return links, nil
}
