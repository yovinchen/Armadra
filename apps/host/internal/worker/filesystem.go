package worker

import (
	"context"
	"slices"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The filesystem domain over the private Worker channel
// (Go Host 业务所有权迁移 §2.9, action 26).
//
// The Host never asks the Worker to *store* a root: once the domain has moved,
// the record is the Host's. What it asks for is the Worker's own reading of its
// database, and it asks for exactly one reason — a handback has to be checked
// against rows the Runtime read back for itself, not against the request that
// asked it to store them.

// FilesystemCapability is what a Worker must advertise before this client will
// ask it about roots. A Worker that never opened the Runtime's database cannot
// answer, and saying so is what stops a rollback from being "verified" against
// an empty list.
const FilesystemCapability = "filesystem.worker.v1"

// SupportsFilesystem reports whether this Worker said it can read its roots.
func (c *Client) SupportsFilesystem() bool {
	return c != nil && c.ownershipMode && c.hello != nil &&
		slices.Contains(c.hello.Capabilities, FilesystemCapability)
}

// WorkspaceRoots reads the Worker's own `workspaces` rows as registrations.
//
// The reply is the Runtime's reading of its database, so an empty list from a
// Worker that has rows is a protocol failure rather than "no workspaces": the
// caller compares it against a package it wrote, and a silently empty answer
// would make every comparison trivially pass.
func (c *Client) WorkspaceRoots(ctx context.Context) ([]*pb.WorkspaceRoot, error) {
	if c == nil || !c.ownershipMode {
		return nil, &Error{Code: CodeUnsupported}
	}
	if !c.SupportsFilesystem() {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Filesystem{Filesystem: &pb.FilesystemWorkerRequest{
		Action: &pb.FilesystemWorkerRequest_ListRoots{ListRoots: &pb.ListWorkerRootsRequest{}},
	}}}, "filesystem")
	if err != nil {
		return nil, err
	}
	roots := response.GetFilesystem().GetRoots()
	if roots == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	result := make([]*pb.WorkspaceRoot, 0, len(roots.GetRoots()))
	for _, root := range roots.GetRoots() {
		// A root with no workspace identifier cannot be compared with anything,
		// and letting it through would make a handback pass on a row nobody can
		// name.
		if root.GetWorkspaceId() == "" {
			return nil, &Error{Code: CodeProtocol}
		}
		result = append(result, proto.Clone(root).(*pb.WorkspaceRoot))
	}
	return result, nil
}
