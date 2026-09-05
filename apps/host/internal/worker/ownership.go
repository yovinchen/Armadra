package worker

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The write-ownership handoff over the existing Worker stdio protocol
// (host protocol design §4, step 5).
//
// This is the only channel the Host uses to tell the Runtime that the canvas
// domain has moved. It is deliberately the private, parent-owned pipe rather
// than an HTTP endpoint: an ownership change is a maintenance action by the
// operator's own Host, not something any process on the machine may request.
//
// A request states both the new epoch and the epoch the Host believes is
// stored. That makes a repeat harmless — the Runtime recognises its own
// current state and answers with it — and makes a stale controller's request
// a refusal rather than a rollback nobody asked for.

const ownershipCapability = "canvas.ownership.v1"

// OwnershipCapability is what the Worker must advertise before this client
// will move ownership through it.
const OwnershipCapability = ownershipCapability

func (c *Client) ownershipRequest(ctx context.Context, request *pb.WorkerRequest) (*pb.WorkerWriteOwnership, error) {
	if c == nil || !c.ownershipMode {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, request, "ownership")
	if err != nil {
		return nil, err
	}
	result := response.GetWriteOwnership()
	if result == nil || result.Domain == "" {
		return nil, &Error{Code: CodeProtocol}
	}
	return proto.Clone(result).(*pb.WorkerWriteOwnership), nil
}

// SetWriteOwnership hands the canvas domain to `owner` at `epoch`. The reply is
// the Runtime's stored record, which the caller compares with what it asked
// for: an answer that does not match is a protocol failure, never a success.
func (c *Client) SetWriteOwnership(ctx context.Context, domain string, owner pb.CanvasOwnershipOwner, epoch, expected uint64, reason string) (*pb.WorkerWriteOwnership, error) {
	if domain == "" || len(domain) > 64 || epoch == 0 || len(reason) > 64 {
		return nil, &Error{Code: CodeInvalid}
	}
	if owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME && owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.ownershipRequest(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_SetWriteOwnership{SetWriteOwnership: &pb.SetWriteOwnershipRequest{
		Domain:        domain,
		Owner:         owner,
		Epoch:         epoch,
		ExpectedEpoch: expected,
		ReasonCode:    reason,
	}}})
	if err != nil {
		return nil, err
	}
	if result.Domain != domain || result.Owner != owner || result.Epoch != epoch {
		return nil, &Error{Code: CodeProtocol}
	}
	return result, nil
}

// GetWriteOwnership reads what the Runtime currently believes. It is what
// resolves an interrupted handoff: after a failed exchange the Host asks the
// Runtime what it stored instead of guessing which side of the write the
// failure fell on.
func (c *Client) GetWriteOwnership(ctx context.Context, domain string) (*pb.WorkerWriteOwnership, error) {
	if domain == "" || len(domain) > 64 {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.ownershipRequest(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_GetWriteOwnership{GetWriteOwnership: &pb.GetWriteOwnershipRequest{Domain: domain}}})
	if err != nil {
		return nil, err
	}
	if result.Domain != domain {
		return nil, &Error{Code: CodeProtocol}
	}
	return result, nil
}
