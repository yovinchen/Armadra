package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"slices"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The settings frames of the Worker channel (action/result 25;
// Go Host 业务所有权迁移 §2.9, settings.proto).
//
// One frame carries both directions of the move, because they are the same
// conversation: taking the domain over reads the Runtime's document, handing it
// back writes it. Splitting them into two actions would let a controller export
// with one build and import with another.
//
// Like the ownership frames, this travels the private parent-owned pipe rather
// than an HTTP endpoint: reading or replacing the machine's settings file is a
// maintenance action by the operator's own Host, not something any process on
// the machine may ask for.

// SettingsCapability is what the Worker must advertise before this client will
// move settings through it. It is a separate statement from the ownership
// capability on purpose: a Worker that can record an epoch is not necessarily
// one that can read and rewrite a settings file, and a controller that assumed
// the two came together would plan a switch an older Worker cannot complete.
const SettingsCapability = "settings.worker.v1"

// maxImportIDBytes matches the ownership frames: the identifier namespaces the
// import in the Runtime's own ledger and is not an authorization token.
const maxImportIDBytes = 128

// SupportsSettings reports whether this Worker said it can answer a settings
// frame. It is asked before a switch is planned, so a Worker that never
// advertised the capability is refused rather than sent a request it would
// answer with an error after the plan was made.
func (c *Client) SupportsSettings() bool {
	return c != nil && c.ownershipMode && c.hello != nil &&
		slices.Contains(c.hello.Capabilities, SettingsCapability)
}

// ExportSettings reads the execution host's settings document. It changes
// nothing on the Runtime side, which is what makes it safe to run before the
// operator has decided to go ahead with a switch.
func (c *Client) ExportSettings(ctx context.Context) (*pb.WorkerSettingsSnapshot, error) {
	snapshot, err := c.settingsRequest(ctx, &pb.WorkerSettingsRequest{
		Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_EXPORT,
	})
	if err != nil {
		return nil, err
	}
	// An export that reports a write is describing something other than what
	// was asked for, and the whole point of reading first is that nothing
	// changed while we looked.
	if snapshot.Applied || snapshot.Replayed {
		return nil, &Error{Code: CodeProtocol}
	}
	return snapshot, nil
}

// ImportSettings writes a document into the Runtime's own settings file and
// reports what is stored afterwards.
//
// The answer is compared with the request by the caller, not here: a re-read
// that differs from what was sent is a failed rollback the operator has to see
// as a consistency difference, not a transport error that hides which document
// the Runtime actually holds.
func (c *Client) ImportSettings(ctx context.Context, request *pb.WorkerSettingsRequest) (*pb.WorkerSettingsSnapshot, error) {
	if request == nil || request.Direction != pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT {
		return nil, &Error{Code: CodeInvalid}
	}
	document := request.GetDocument()
	if document == nil || len(document.Document) == 0 || len(document.Document) > MaxFrameBytes {
		return nil, &Error{Code: CodeInvalid}
	}
	if request.ImportId == "" || len(request.ImportId) > maxImportIDBytes {
		return nil, &Error{Code: CodeInvalid}
	}
	snapshot, err := c.settingsRequest(ctx, request)
	if err != nil {
		return nil, err
	}
	// The write either happened in this exchange or had already happened under
	// this identifier. A Worker that reports neither has answered a question
	// nobody asked.
	if !snapshot.Applied && !snapshot.Replayed {
		return nil, &Error{Code: CodeProtocol}
	}
	if snapshot.Document.Scope != document.Scope || snapshot.Document.DeviceId != document.DeviceId {
		return nil, &Error{Code: CodeProtocol}
	}
	return snapshot, nil
}

// settingsRequest is the shared half: the mode gate, the capability gate, and
// the checks that make the answer evidence rather than a restatement.
func (c *Client) settingsRequest(ctx context.Context, request *pb.WorkerSettingsRequest) (*pb.WorkerSettingsSnapshot, error) {
	if c == nil || !c.ownershipMode || !c.SupportsSettings() {
		return nil, &Error{Code: CodeUnsupported}
	}
	if request.Direction == pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_UNSPECIFIED {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Settings{Settings: request}}, "settings")
	if err != nil {
		return nil, err
	}
	snapshot := response.GetSettings()
	if !validSettingsSnapshot(snapshot) {
		return nil, &Error{Code: CodeProtocol}
	}
	return proto.Clone(snapshot).(*pb.WorkerSettingsSnapshot), nil
}

// validSettingsSnapshot checks the snapshot describes itself consistently. The
// digest is the one field the Host can verify without knowing anything about
// settings: it must be over the bytes in the same message, so a Worker cannot
// report a document and a digest of something else.
func validSettingsSnapshot(snapshot *pb.WorkerSettingsSnapshot) bool {
	document := snapshot.GetDocument()
	if document == nil || len(document.Document) == 0 || len(document.Document) > MaxFrameBytes {
		return false
	}
	sum := sha256.Sum256(document.Document)
	if !bytes.Equal(document.Sha256, sum[:]) {
		return false
	}
	if document.Scope == pb.SettingsScope_SETTINGS_SCOPE_UNSPECIFIED {
		return false
	}
	seen := map[string]bool{}
	for _, host := range snapshot.GetExecutionHosts() {
		if host == nil || seen[host.ExecutionHostId] {
			return false
		}
		seen[host.ExecutionHostId] = true
		// The local machine is the empty identifier by convention; every other
		// kind has to name itself, or the caller cannot tell two hosts apart.
		if host.Kind != pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL && host.ExecutionHostId == "" {
			return false
		}
	}
	return true
}
