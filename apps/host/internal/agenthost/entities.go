// Package agenthost is the Host's agent domain: what each agent node's state
// has been reduced to, which permission questions are open, what nodes have
// said to each other, what was actually delivered, where each handoff stands,
// and which nodes the canvas' edges let read which
// (Go Host 业务所有权迁移 §2.7, §3.1 v9).
//
// It runs no CLI and reads no transcript. The Hook endpoint, the node token,
// the pending-approval file, the transcript and the terminal all stay on the
// machine the CLI runs on, because they *are* that machine — a Host that
// claimed them would be claiming files it cannot see. What this package owns is
// what those things mean: that this node is waiting, that this approval has
// been answered, that this message has not been read, that this handoff was
// delivered once and not twice.
//
// Three decisions run through everything here.
//
// **A provider's body is bytes.** An approval request is one CLI's own JSON and
// a handoff bundle is a snapshot of a conversation. They are stored with their
// digests and handed back unchanged; expanding them into fields would make a
// new CLI a wire change and would put this Host in the business of deciding
// what a provider meant.
//
// **An answer is recorded before it is delivered.** This is the opposite order
// from the session domain, and deliberately so. A session records after the
// Worker acts, because the Worker's answer is the fact. An approval records
// first, under CAS, because the record is what stops a second device answering
// the same question — and only then is the answer written into the file the CLI
// is blocked on. A delivery that fails afterwards leaves a record saying the
// question was answered, which is true: somebody did answer it, and what failed
// is that the machine did not hear.
//
// **Context links are never written by a client.** They are a projection of the
// canvas' own edges. A client that could write them directly could make a node
// read a transcript it is not connected to, which is the one thing the whole
// "context follows the connection" rule exists to prevent.
package agenthost

import (
	"crypto/sha256"
	"errors"
	"regexp"
	"sort"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	// The agent surface is governed by the grants that already govern the
	// Runtime agent routes this Host proxies, for the reason the session and
	// filesystem domains reuse theirs: the same device with the same grants
	// must get the same allow/deny answer before and after the domain moves
	// (§6.3, 权限对照). A new `agent:*` permission would make that table
	// incomparable by construction and would lock out every device paired
	// before it existed, since a device's grants are frozen at pairing.
	//
	// Reading which nodes are waiting is a read. Answering an approval,
	// accepting a handoff and installing a Hook all make a CLI on the machine
	// do something — `scopes.go` already classifies `/api/approvals` and
	// `/api/control` as execution against `terminal:*`, and this is the same
	// authority under a different transport.
	ScopeRead  = "terminal:read"
	ScopeWrite = "terminal:write"

	// MaxPage bounds one listing.
	MaxPage = 500

	// MaxRequestBytes bounds one approval request body. A permission question a
	// CLI asks is a sentence and a command line, not a document.
	MaxRequestBytes = 256 << 10
	// MaxBundleBytes mirrors the storage bound: a handoff bundle is a
	// conversation snapshot, and anything larger belongs in the workspace.
	MaxBundleBytes = storage.MaxBundleBytes
	// MaxBodyChars bounds one mailbox message.
	MaxBodyChars = storage.MaxMailboxBody
)

var (
	ErrInvalid       = errors.New("invalid agent request")
	ErrAuthorization = errors.New("agent permission denied")
	// ErrOwnershipMoved is the stable refusal a write gets when this process is
	// not the settled owner of the agent domain. There is no dual-write mode:
	// while the Runtime owns the domain, or while a switch is open, this Host
	// answers reads and refuses every mutation.
	ErrOwnershipMoved = errors.New("ownership_moved")
	ErrNotFound       = errors.New("no such agent record")
	// ErrNoWorker means this Host has no channel to the execution host. It is
	// not "the answer failed": for an approval the decision is already
	// recorded, and what could not happen is the CLI being told.
	ErrNoWorker = errors.New("no Worker is reachable for this execution host")
	// ErrAlreadyAnswered means somebody has already decided this question. It
	// is distinct from a revision conflict: reloading will not produce a state
	// in which answering again is the right thing to do.
	ErrAlreadyAnswered = errors.New("that approval has already been answered")
	// ErrFrozen is the refusal a change to a prepared bundle gets.
	ErrFrozen = errors.New("a prepared handoff's bundle is immutable")
	// ErrNotDeliverable means the handoff is not in a state a dispatch may act
	// on — already delivered, cancelled, or in an outcome nobody has resolved.
	ErrNotDeliverable = errors.New("that handoff cannot be dispatched from its current state")
)

// Domain is the name this package is registered under in the switch order.
const Domain = storage.OwnershipDomainAgent

// maxDifferences bounds what a failed consistency check reports. An operator
// needs to see which records differ, not every one of them.
const maxDifferences = 32

// Identifiers are the ones the client already uses, so the switch keeps them
// unchanged.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)

func validID(value string) bool { return idPattern.MatchString(value) }

// text screens a free-form value a person or an agent may have written:
// bounded, no NUL. It is not held to the identifier alphabet, because a message
// somebody wrote in Chinese is the normal case rather than an attack.
func text(value string, max int) bool {
	return len(value) <= max && !strings.ContainsRune(value, 0)
}

func digest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

/* ------------------------------------------------------------------ status */

func statusMessage(status storage.AgentStatus) *pb.AgentStatus {
	value := &pb.AgentStatus{
		NodeId:            status.NodeID,
		WorkspaceId:       status.WorkspaceID,
		SessionId:         status.SessionID,
		Generation:        status.Generation,
		AgentId:           status.AgentID,
		Unread:            status.Unread,
		Verified:          status.Verified,
		Restored:          status.Restored,
		TranscriptRef:     status.TranscriptRef,
		State:             pb.AgentState(status.State),
		SessionPhase:      status.SessionPhase,
		ReasonCode:        status.ReasonCode,
		LastEventAtUnixMs: status.LastEventMS,
		UpdatedAtUnixMs:   status.UpdatedAtMS,
		Revision:          status.Revision,
		Deleted:           status.Deleted,
	}
	// The two optional flags are copied rather than dereferenced into values:
	// an absent one has to stay absent all the way to the client, or a node
	// nobody has heard from arrives looking like one that ran cleanly.
	if status.Errored != nil {
		flag := *status.Errored
		value.Errored = &flag
	}
	if status.Interrupted != nil {
		flag := *status.Interrupted
		value.Interrupted = &flag
	}
	return value
}

func statusRecord(value *pb.AgentStatus, updatedAt int64) (storage.AgentStatus, error) {
	if value == nil || !validID(value.GetNodeId()) || !validID(value.GetWorkspaceId()) {
		return storage.AgentStatus{}, ErrInvalid
	}
	if session := value.GetSessionId(); session != "" && !validID(session) {
		return storage.AgentStatus{}, ErrInvalid
	}
	if !text(value.GetAgentId(), 256) || !text(value.GetSessionPhase(), 64) || !text(value.GetReasonCode(), 64) {
		return storage.AgentStatus{}, ErrInvalid
	}
	if len(value.GetTranscriptRef()) > 4096 {
		return storage.AgentStatus{}, ErrInvalid
	}
	if value.GetState() > pb.AgentState_AGENT_STATE_DONE {
		return storage.AgentStatus{}, ErrInvalid
	}
	status := storage.AgentStatus{
		NodeID:        value.GetNodeId(),
		WorkspaceID:   value.GetWorkspaceId(),
		SessionID:     value.GetSessionId(),
		Generation:    value.GetGeneration(),
		AgentID:       value.GetAgentId(),
		Unread:        value.GetUnread(),
		Verified:      value.GetVerified(),
		Restored:      value.GetRestored(),
		TranscriptRef: value.GetTranscriptRef(),
		State:         int32(value.GetState()),
		SessionPhase:  value.GetSessionPhase(),
		ReasonCode:    value.GetReasonCode(),
		LastEventMS:   value.GetLastEventAtUnixMs(),
		UpdatedAtMS:   updatedAt,
		Deleted:       value.GetDeleted(),
	}
	if value.Errored != nil {
		flag := value.GetErrored()
		status.Errored = &flag
	}
	if value.Interrupted != nil {
		flag := value.GetInterrupted()
		status.Interrupted = &flag
	}
	return stampStatus(status)
}

/* --------------------------------------------------------------- approvals */

func approvalMessage(approval storage.Approval) *pb.Approval {
	return &pb.Approval{
		ApprovalId:       approval.ApprovalID,
		NodeId:           approval.NodeID,
		WorkspaceId:      approval.WorkspaceID,
		SessionId:        approval.SessionID,
		Generation:       approval.Generation,
		Request:          approval.Request,
		RequestSha256:    approval.RequestSHA256,
		Decision:         approval.Decision,
		AnsweredBy:       approval.AnsweredBy,
		State:            pb.ApprovalState(approval.State),
		ReasonCode:       approval.ReasonCode,
		CreatedAtUnixMs:  approval.CreatedAtMS,
		AnsweredAtUnixMs: approval.AnsweredAtMS,
		Revision:         approval.Revision,
	}
}

func approvalRecord(value *pb.Approval, createdAt int64) (storage.Approval, error) {
	if value == nil || !validID(value.GetApprovalId()) || !validID(value.GetNodeId()) || !validID(value.GetWorkspaceId()) {
		return storage.Approval{}, ErrInvalid
	}
	if session := value.GetSessionId(); session != "" && !validID(session) {
		return storage.Approval{}, ErrInvalid
	}
	if len(value.GetRequest()) > MaxRequestBytes || !text(value.GetDecision(), 128) ||
		!text(value.GetAnsweredBy(), 256) || !text(value.GetReasonCode(), 64) {
		return storage.Approval{}, ErrInvalid
	}
	if value.GetState() > pb.ApprovalState_APPROVAL_STATE_EXPIRED {
		return storage.Approval{}, ErrInvalid
	}
	// The digest is computed here rather than trusted from the wire. A body
	// that arrived with somebody else's digest is a body this Host would then
	// hand to a person as though it had been checked.
	approval := storage.Approval{
		ApprovalID:    value.GetApprovalId(),
		NodeID:        value.GetNodeId(),
		WorkspaceID:   value.GetWorkspaceId(),
		SessionID:     value.GetSessionId(),
		Generation:    value.GetGeneration(),
		Request:       value.GetRequest(),
		RequestSHA256: digest(value.GetRequest()),
		Decision:      value.GetDecision(),
		AnsweredBy:    value.GetAnsweredBy(),
		State:         int32(value.GetState()),
		ReasonCode:    value.GetReasonCode(),
		CreatedAtMS:   createdAt,
		AnsweredAtMS:  value.GetAnsweredAtUnixMs(),
	}
	if approval.State == int32(pb.ApprovalState_APPROVAL_STATE_UNSPECIFIED) {
		approval.State = int32(pb.ApprovalState_APPROVAL_STATE_PENDING)
	}
	return stampApproval(approval)
}

/* ----------------------------------------------------------------- mailbox */

func mailboxMessage(message storage.MailboxMessage) *pb.MailboxMessage {
	return &pb.MailboxMessage{
		MessageId:            message.MessageID,
		WorkspaceId:          message.WorkspaceID,
		SourceNodeId:         message.SourceNodeID,
		TargetNodeId:         message.TargetNodeID,
		MessageKey:           message.MessageKey,
		Body:                 message.Body,
		Sequence:             message.Sequence,
		CreatedAtUnixMs:      message.CreatedAtMS,
		ExpiresAtUnixMs:      message.ExpiresAtMS,
		AcknowledgedAtUnixMs: message.AckedAtMS,
		Revision:             message.Revision,
		Deleted:              message.Deleted,
	}
}

func deliveryMessage(delivery storage.Delivery) *pb.Delivery {
	return &pb.Delivery{
		TraceId:         delivery.TraceID,
		WorkspaceId:     delivery.WorkspaceID,
		SourceNodeId:    delivery.SourceNodeID,
		TargetNodeId:    delivery.TargetNodeID,
		Receipt:         delivery.Receipt,
		BodyChars:       delivery.BodyChars,
		Outcome:         pb.DeliveryOutcome(delivery.Outcome),
		ReasonCode:      delivery.ReasonCode,
		CreatedAtUnixMs: delivery.CreatedAtMS,
		Revision:        delivery.Revision,
	}
}

/* ---------------------------------------------------------------- handoffs */

func handoffMessage(handoff storage.Handoff) *pb.Handoff {
	return &pb.Handoff{
		HandoffId:        handoff.HandoffID,
		WorkspaceId:      handoff.WorkspaceID,
		SourceNodeId:     handoff.SourceNodeID,
		TargetNodeId:     handoff.TargetNodeID,
		Source:           &pb.SessionAddress{SessionId: handoff.SourceSessionID, Generation: handoff.SourceGen},
		Target:           &pb.SessionAddress{SessionId: handoff.TargetSessionID, Generation: handoff.TargetGen},
		Bundle:           handoff.Bundle,
		BundleSha256:     handoff.BundleSHA256,
		MailboxId:        handoff.MailboxID,
		TraceId:          handoff.TraceID,
		Attempts:         handoff.Attempts,
		State:            pb.HandoffState(handoff.State),
		ErrorCode:        handoff.ErrorCode,
		CreatedAtUnixMs:  handoff.CreatedAtMS,
		AcceptedAtUnixMs: handoff.AcceptedAtMS,
		UpdatedAtUnixMs:  handoff.UpdatedAtMS,
		Revision:         handoff.Revision,
	}
}

/* ----------------------------------------------------------- context links */

func contextLinksMessage(links storage.ContextLinks) (*pb.ContextLinks, error) {
	value := &pb.ContextLinks{
		NodeId:          links.NodeID,
		WorkspaceId:     links.WorkspaceID,
		UpdatedAtUnixMs: links.UpdatedAtMS,
		Revision:        links.Revision,
	}
	if len(links.Links) > 0 {
		stored := new(pb.ContextLinks)
		if err := proto.Unmarshal(links.Links, stored); err != nil {
			return nil, storage.ErrCorrupt
		}
		value.Links = stored.GetLinks()
	}
	return value, nil
}

// encodeLinks stores the list on its own, so the row holds the projection and
// the payload holds the entity. Two encodings of the same thing would be one
// more pair that can drift; keeping the list separate means the row is what the
// comparison reads and the payload is what the stream carries.
func encodeLinks(links []*pb.ContextLink) ([]byte, error) {
	if len(links) == 0 {
		return nil, nil
	}
	return (proto.MarshalOptions{Deterministic: true}).Marshal(&pb.ContextLinks{Links: links})
}

/* ------------------------------------------------------------- publication */

// payload is an entity as it is published on the event stream: the same message
// with the revision cleared, marshalled deterministically so an unchanged
// record produces identical bytes.
func payload(value proto.Message) ([]byte, error) {
	clone := proto.Clone(value)
	switch typed := clone.(type) {
	case *pb.AgentStatus:
		typed.Revision = 0
	case *pb.Approval:
		typed.Revision = 0
	case *pb.MailboxMessage:
		typed.Revision = 0
	case *pb.Delivery:
		typed.Revision = 0
	case *pb.Handoff:
		typed.Revision = 0
	case *pb.ContextLinks:
		typed.Revision = 0
	default:
		return nil, ErrInvalid
	}
	return (proto.MarshalOptions{Deterministic: true}).Marshal(clone)
}

// The stamp functions re-encode a row's published payload after its fields
// changed. Every mutation goes through one of them, so a row and the event that
// announces it can never describe different things.

func stampStatus(status storage.AgentStatus) (storage.AgentStatus, error) {
	encoded, err := payload(statusMessage(status))
	if err != nil {
		return storage.AgentStatus{}, err
	}
	status.Payload = encoded
	return status, nil
}

func stampApproval(approval storage.Approval) (storage.Approval, error) {
	encoded, err := payload(approvalMessage(approval))
	if err != nil {
		return storage.Approval{}, err
	}
	approval.Payload = encoded
	return approval, nil
}

func stampMailbox(message storage.MailboxMessage) (storage.MailboxMessage, error) {
	encoded, err := payload(mailboxMessage(message))
	if err != nil {
		return storage.MailboxMessage{}, err
	}
	message.Payload = encoded
	return message, nil
}

func stampDelivery(delivery storage.Delivery) (storage.Delivery, error) {
	encoded, err := payload(deliveryMessage(delivery))
	if err != nil {
		return storage.Delivery{}, err
	}
	delivery.Payload = encoded
	return delivery, nil
}

func stampHandoff(handoff storage.Handoff) (storage.Handoff, error) {
	encoded, err := payload(handoffMessage(handoff))
	if err != nil {
		return storage.Handoff{}, err
	}
	handoff.Payload = encoded
	return handoff, nil
}

func stampContextLinks(links storage.ContextLinks, value *pb.ContextLinks) (storage.ContextLinks, error) {
	encoded, err := payload(value)
	if err != nil {
		return storage.ContextLinks{}, err
	}
	links.Payload = encoded
	return links, nil
}

// receipt is the operation's outcome in the shared shape. Its `revisions` list
// stays empty for the reason the session and filesystem domains leave it empty:
// that list exists so a caller can find one object's new revision inside a
// batch, and an agent change is always one object, returned in full beside the
// receipt.
func receipt(result storage.ApplyResult) *pb.CanvasOperationReceipt {
	return &pb.CanvasOperationReceipt{
		OperationId:   result.OperationID,
		TransactionId: result.TransactionID,
		FirstSequence: result.FirstSequence,
		LastSequence:  result.LastSequence,
		Replayed:      result.Replayed,
	}
}

type checkBuilder struct{ checks []*pb.ConsistencyCheck }

func (b *checkBuilder) record(name string, expected, actual uint64, differences []string) {
	sort.Strings(differences)
	if len(differences) > maxDifferences {
		differences = differences[:maxDifferences]
	}
	b.checks = append(b.checks, &pb.ConsistencyCheck{
		Check:         name,
		ExpectedCount: expected,
		ActualCount:   actual,
		Matched:       expected == actual && len(differences) == 0,
		Differences:   differences,
	})
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func pageSize(limit uint32) int {
	if limit == 0 {
		return 100
	}
	if limit > MaxPage {
		return MaxPage
	}
	return int(limit)
}
