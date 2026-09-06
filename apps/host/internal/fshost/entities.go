// Package fshost is the Host's filesystem domain: where each workspace's files
// are, and who may touch them (Go Host 业务所有权迁移 §2.5, §3.1 v7).
//
// It owns no bytes and no execution. Reading, writing, watching, searching and
// every Git command keep running on the execution host whichever side owns this
// record — a Host that "owned the filesystem" in the sense of holding files
// would be a second copy of the project, which is the one thing a workspace
// root must never be.
//
// What it does own is the decision. Once the domain has moved, the Runtime
// refuses to register a root or change a workspace's permissions, this package
// records both, and the Host's own proxy narrows a forwarded file request by
// reading the record here rather than the Runtime's row. That is the whole
// switch: one writer for "where and whether", the same executor for "how".
package fshost

import (
	"errors"
	"regexp"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	// The filesystem surface is governed by the grants that already govern the
	// Runtime's file routes, not by a new pair of its own.
	//
	// This is deliberate and it is the point of the switch: the same device
	// with the same grants must get the same allow/deny answer before and after
	// the domain moves (§6.3, "权限对照"). A separate `filesystem:*` permission
	// would make that table incomparable by construction, and would also lock
	// out every device paired before it existed, since a device's grants are
	// frozen at pairing.
	ScopeRead  = "files:read"
	ScopeWrite = "files:write"

	// MaxPage bounds one listing. Roots are one row per workspace, so this is a
	// ceiling rather than a number anyone reaches.
	MaxPage = 500

	// MaxPathBytes bounds a canonical root path. It is generous enough for any
	// real project and short enough that a path can never be a payload.
	MaxPathBytes = 4096
)

var (
	ErrInvalid       = errors.New("invalid filesystem request")
	ErrAuthorization = errors.New("filesystem permission denied")
	// ErrOwnershipMoved is the stable refusal a write gets when this process is
	// not the settled owner of the filesystem domain. There is no dual-write
	// mode: while the Runtime owns the domain, or while a switch is open, this
	// Host answers reads and refuses every mutation.
	ErrOwnershipMoved = errors.New("ownership_moved")
	// ErrNotRegistered means the workspace has no root here. It is distinct
	// from a withdrawn registration, which still has a revision a caller has to
	// name before registering again.
	ErrNotRegistered = errors.New("this workspace has no registered root")
)

// Domain is the name this package is registered under in the switch order.
const Domain = storage.OwnershipDomainFilesystem

// Identifiers are the ones the client already uses, so the switch keeps them
// unchanged.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)

func validID(value string) bool { return idPattern.MatchString(value) }

// validPath is what this Host will freeze as a root. It is checked rather than
// resolved: for a remote workspace the path is on another machine and this Host
// has no business resolving it, and for a local one the Worker has already
// canonicalized it. What is refused is a shape that could not be a canonical
// absolute path anywhere — a relative path, a traversal, an embedded NUL.
func validPath(value string) bool {
	if value == "" || len(value) > MaxPathBytes || strings.ContainsRune(value, 0) {
		return false
	}
	if !strings.HasPrefix(value, "/") && !windowsAbsolute(value) {
		return false
	}
	for _, segment := range strings.Split(strings.ReplaceAll(value, "\\", "/"), "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// windowsAbsolute recognises `C:\dir` and `\\server\share`. A Host on Linux
// still stores roots for Windows execution hosts, so the shape is accepted by
// spelling rather than by the Host's own operating system.
func windowsAbsolute(value string) bool {
	if strings.HasPrefix(value, `\\`) {
		return true
	}
	return len(value) >= 3 && value[1] == ':' && (value[2] == '\\' || value[2] == '/') &&
		((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))
}

// message is the stored row as the contract sees it. The revision comes from
// the row, never from the payload: keeping a second copy inside the bytes would
// let the two drift, and the row is the one the CAS is checked against.
func message(root storage.WorkspaceRoot) *pb.WorkspaceRoot {
	value := &pb.WorkspaceRoot{
		WorkspaceId:        root.WorkspaceID,
		ExecutionHostId:    root.ExecutionHostID,
		CanonicalPath:      root.CanonicalPath,
		ProofSha256:        append([]byte(nil), root.ProofSHA256...),
		RegisteredAtUnixMs: root.RegisteredAtMS,
		UpdatedAtUnixMs:    root.UpdatedAtMS,
		Revision:           root.Revision,
		Deleted:            root.Deleted,
	}
	// A tombstone carries no permissions at all, not permissions set to false:
	// "this registration is gone" and "this workspace may not be read" are
	// different statements and a client acts differently on each.
	if !root.Deleted {
		value.Permissions = &pb.CanvasWorkspacePermissions{Read: root.Read, Write: root.Write, Execute: root.Execute}
	}
	return value
}

// payload is the entity as it is published on the event stream: the same
// message with the revision cleared, marshalled deterministically so an
// unchanged registration produces identical bytes.
func payload(value *pb.WorkspaceRoot) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.WorkspaceRoot)
	clone.Revision = 0
	return (proto.MarshalOptions{Deterministic: true}).Marshal(clone)
}

// record turns a validated request into the row to store. It refuses anything
// it cannot store faithfully rather than storing an approximation: a root whose
// path was silently truncated would point somewhere else.
func record(value *pb.WorkspaceRoot, registeredAt, updatedAt int64) (storage.WorkspaceRoot, error) {
	if value == nil || !validID(value.GetWorkspaceId()) || !validPath(value.GetCanonicalPath()) {
		return storage.WorkspaceRoot{}, ErrInvalid
	}
	// An execution host identifier is a `settings.ssh.hosts[].id`, which a
	// person names — it is not an entity key, so it is bounded and screened for
	// control characters rather than held to the key alphabet. Rejecting a
	// host someone called 构建机 would make the domain unusable in exactly the
	// installations it was built for.
	if host := value.GetExecutionHostId(); len(host) > 256 || strings.ContainsRune(host, 0) {
		return storage.WorkspaceRoot{}, ErrInvalid
	}
	proof := value.GetProofSha256()
	if len(proof) != 0 && len(proof) != 32 {
		return storage.WorkspaceRoot{}, ErrInvalid
	}
	// A remote root is proven by the host that holds it. Registering one
	// without that proof would record a path this Host has never had any way to
	// check, on a machine it cannot reach.
	if value.GetExecutionHostId() != "" && len(proof) != 32 {
		return storage.WorkspaceRoot{}, ErrInvalid
	}
	permissions := value.GetPermissions()
	if permissions == nil {
		return storage.WorkspaceRoot{}, ErrInvalid
	}
	root := storage.WorkspaceRoot{
		WorkspaceID:     value.GetWorkspaceId(),
		ExecutionHostID: value.GetExecutionHostId(),
		CanonicalPath:   value.GetCanonicalPath(),
		ProofSHA256:     append([]byte(nil), proof...),
		Read:            permissions.GetRead(),
		Write:           permissions.GetWrite(),
		Execute:         permissions.GetExecute(),
		RegisteredAtMS:  registeredAt,
		UpdatedAtMS:     updatedAt,
	}
	encoded, err := payload(message(root))
	if err != nil {
		return storage.WorkspaceRoot{}, err
	}
	root.Payload = encoded
	return root, nil
}

// sameRegistration reports whether two rows say the same thing about a
// workspace. Timestamps and the revision are excluded: they are how the record
// was reached, not what it says, and re-publishing an identical registration
// would tell every connected client that something changed when nothing did.
func sameRegistration(left, right storage.WorkspaceRoot) bool {
	return left.ExecutionHostID == right.ExecutionHostID &&
		left.CanonicalPath == right.CanonicalPath &&
		string(left.ProofSHA256) == string(right.ProofSHA256) &&
		left.Read == right.Read && left.Write == right.Write &&
		left.Execute == right.Execute && left.Deleted == right.Deleted
}

// receipt is the operation's outcome in the shared shape. Its `revisions` list
// stays empty on purpose: that list exists so a caller can find one object's
// new revision inside a batch, and a root change is always exactly one object —
// which is returned in full, revision and all, next to the receipt. Filling the
// list with a canvas entity kind that does not describe a root would be worse
// than leaving it out.
func receipt(result storage.ApplyResult) *pb.CanvasOperationReceipt {
	return &pb.CanvasOperationReceipt{
		OperationId:   result.OperationID,
		TransactionId: result.TransactionID,
		FirstSequence: result.FirstSequence,
		LastSequence:  result.LastSequence,
		Replayed:      result.Replayed,
	}
}
