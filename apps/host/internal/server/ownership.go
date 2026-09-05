package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
)

const OwnershipPrefix = "/rpc/armadra.v1.OwnershipService/"

// HandoffOpener starts the private channel to the Runtime for exactly one
// switch and hands back the way to close it. It is a factory rather than a
// long-lived client on purpose: the channel is a Worker process started to move
// an epoch, and one that outlived a switch would be a second writer waiting to
// happen. A Host with no Runtime binary or database configured has no opener,
// and its switch methods answer UNSUPPORTED.
type HandoffOpener func(context.Context) (ownership.Handoff, io.Closer, error)

// Who may write which business domain (Go Host 业务所有权迁移 §2.11).
//
// Reads are host-wide: the record covers this machine, not a workspace, so a
// device granted one workspace cannot satisfy the requirement and cannot learn
// how the other domains are placed either.
//
// Moving a domain needs four things at once, and the first is the one that
// matters: a maintenance token issued over the same-user OS control channel.
// An HTTPS session, however well authenticated, belongs to a device that may be
// anywhere; the token is what says a person is at the machine. On top of that,
// the caller needs the host-wide settings:write grant, the owner role, and the
// rotating CSRF header — a switch is the most consequential mutation this Host
// has, and it is not something a page can be tricked into making.
const (
	ScopeOwnershipRead  = "settings:read"
	ScopeOwnershipWrite = "settings:write"
)

func ownershipMethod(path string) bool {
	if !strings.HasPrefix(path, OwnershipPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, OwnershipPrefix) {
	case "Get", "List", "Switch", "Rollback":
		return true
	}
	return false
}

// errOwnershipUnsupported is returned after the caller has been authenticated
// on a Host that assembles no ownership service. Authenticating first keeps the
// answer the same shape as every other surface.
var errOwnershipUnsupported = errors.New("this Host has no ownership service")

func ownershipFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errOwnershipUnsupported), errors.Is(err, ownership.ErrUnsupportedDomain):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host cannot move that domain")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Ownership permission, role or CSRF check failed")
	case errors.Is(err, storage.ErrMaintenanceToken):
		// The one refusal that names its own remedy: ask the machine for a new
		// token. Nothing about which check failed is reported, because that
		// would tell a caller which half of a guess was right.
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", ownership.ReasonMaintenance)
	case errors.Is(err, ownership.ErrDependency):
		writeError(w, http.StatusConflict, "CONFLICT", ownership.ReasonDependency)
	case errors.Is(err, ownership.ErrSwitchOpen):
		writeError(w, http.StatusConflict, "CONFLICT", ownership.ReasonPending)
	case errors.Is(err, ownership.ErrUnknownOutcome):
		// The window is still open and both sides still refuse writes. Re-run
		// the same switch; do not treat this as either outcome.
		writeError(w, http.StatusConflict, "CONFLICT", ownership.ReasonUnknown)
	case errors.Is(err, ownership.ErrNotVerified), errors.Is(err, ownership.ErrUnmigratedChanges),
		errors.Is(err, ownership.ErrRuntimeStale), errors.Is(err, ownership.ErrEpochMismatch),
		errors.Is(err, ownership.ErrExportRequired), errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", ownership.ReasonFailed)
	case errors.Is(err, ownership.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid ownership request")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Ownership operation failed")
	}
}

// ownershipCaller authenticates the device session. The scope in the message
// may name this Host, but it never supplies identity, and it never narrows the
// requirement to a workspace: this record is not workspace-scoped.
func ownershipCaller(r *http.Request, host Identity, service *auth.Service, meta *pb.CommandMeta, permission string, mutating bool) error {
	if scope := meta.GetScope(); scope != nil {
		if scope.HostId != "" && scope.HostId != host.HostID {
			return auth.ErrPermission
		}
		if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
			return auth.ErrPermission
		}
	}
	principal, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         r.Header.Get("Origin"),
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequireCSRF:    mutating,
		RequiredScopes: []auth.Scope{{Permission: permission}},
	})
	if err != nil {
		return err
	}
	if mutating && principal.Role != auth.RoleOwner {
		return auth.ErrPermission
	}
	return nil
}

// ownershipPlan reads the plan out of a request. The domain is an enum, and an
// unspecified one is refused rather than read as the canvas.
func ownershipPlan(plan *pb.OwnershipSwitchPlan) (ownership.Request, error) {
	domain := ownership.DomainName(plan.GetDomain())
	if domain == "" {
		return ownership.Request{}, ownership.ErrInvalid
	}
	return ownership.Request{
		Domain:           domain,
		Target:           plan.GetTargetOwner(),
		ExpectedEpoch:    plan.GetExpectedEpoch(),
		ImportID:         plan.GetImportId(),
		MaintenanceToken: plan.GetMaintenanceToken(),
	}, nil
}

func ownershipRequest(w http.ResponseWriter, r *http.Request, host Identity, identities *auth.Service, service *ownership.Service, open HandoffOpener) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, OwnershipPrefix) {
	case "Get":
		input := new(pb.GetOwnershipRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		if err := ownershipCaller(r, host, identities, input.Meta, ScopeOwnershipRead, false); err != nil {
			ownershipFailure(w, err)
			return
		}
		if service == nil {
			ownershipFailure(w, errOwnershipUnsupported)
			return
		}
		domain := ownership.DomainName(input.GetDomain())
		if domain == "" {
			ownershipFailure(w, ownership.ErrInvalid)
			return
		}
		record, err := service.Record(r.Context(), domain)
		if err != nil {
			ownershipFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, &pb.GetOwnershipResponse{Ownership: ownership.Message(record)})
	case "List":
		input := new(pb.ListOwnershipRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		if err := ownershipCaller(r, host, identities, input.Meta, ScopeOwnershipRead, false); err != nil {
			ownershipFailure(w, err)
			return
		}
		if service == nil {
			ownershipFailure(w, errOwnershipUnsupported)
			return
		}
		records, err := service.Records(r.Context())
		if err != nil {
			ownershipFailure(w, err)
			return
		}
		response := new(pb.ListOwnershipResponse)
		for _, record := range records {
			response.Ownership = append(response.Ownership, ownership.Message(record))
		}
		writeProto(w, http.StatusOK, response)
	case "Switch", "Rollback":
		rollback := strings.HasSuffix(r.URL.Path, "Rollback")
		var meta *pb.CommandMeta
		var plan *pb.OwnershipSwitchPlan
		acceptExportOnly := false
		if rollback {
			input := new(pb.RollbackOwnershipRequest)
			if !decodeAuth(w, r, input) {
				return
			}
			meta, plan, acceptExportOnly = input.Meta, input.Plan, input.AcceptExportOnly
		} else {
			input := new(pb.SwitchOwnershipRequest)
			if !decodeAuth(w, r, input) {
				return
			}
			meta, plan = input.Meta, input.Plan
		}
		if err := ownershipCaller(r, host, identities, meta, ScopeOwnershipWrite, true); err != nil {
			ownershipFailure(w, err)
			return
		}
		if service == nil || open == nil {
			// No channel to the Runtime means no switch. Answering anything
			// else would record a handover the other side never heard of.
			ownershipFailure(w, errOwnershipUnsupported)
			return
		}
		request, err := ownershipPlan(plan)
		if err != nil {
			ownershipFailure(w, err)
			return
		}
		handoff, closer, err := open(r.Context())
		if err != nil {
			// The Runtime could not be reached at all, so nothing was decided.
			// That is not an unknown outcome: no epoch was touched.
			ownershipFailure(w, errOwnershipUnsupported)
			return
		}
		defer closer.Close()
		request.Handoff = handoff
		request.AcceptExportOnly = acceptExportOnly
		var result *pb.OwnershipSwitchResponse
		if rollback {
			result, err = service.Rollback(r.Context(), request)
		} else {
			result, err = service.Switch(r.Context(), request)
		}
		if err != nil {
			ownershipFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
