package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/agenthost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const AgentPrefix = "/rpc/armadra.v1.AgentService/"

// What each agent node is doing, and the decisions somebody takes about it
// (Go Host 业务所有权迁移 §2.7).
//
// The surface is workspace-scoped and permission-scoped end to end, and it is
// governed by the same `terminal:read` / `terminal:write` grants that govern
// the Runtime approval and control routes this Host proxies. That is what makes
// the permission table comparable across the switch: the same device with the
// same grants gets the same allow/deny answer before and after the domain
// moves.
//
// The Hook endpoint is deliberately absent. A CLI reports to the machine it
// runs on, over that machine's own private endpoint, and it keeps doing so
// whichever side owns these records.
func agentMethod(path string) bool {
	if !strings.HasPrefix(path, AgentPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, AgentPrefix) {
	case "ListStatus", "MarkRead", "ListApprovals", "AnswerApproval", "ListDeliveries",
		"ListMailbox", "PrepareHandoff", "AcceptHandoff", "CancelHandoff", "ListHandoffs",
		"GetHandoff", "ListContextLinks", "InstallHooks", "UninstallHooks":
		return true
	}
	return false
}

// errAgentUnsupported is returned after the caller has been authenticated on a
// Host that assembles no agent service. Authenticating first keeps the answer
// the same shape as every other surface: the device learns the surface is
// unavailable here, never that its workspace has no agents.
var errAgentUnsupported = errors.New("this Host has no agent service")

func agentFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAgentUnsupported):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no agent service")
	case errors.Is(err, agenthost.ErrOwnershipMoved):
		// One stable code both services use, so a client can act on it without
		// having to tell "the Host will not write" from "the Runtime will not".
		writeError(w, http.StatusConflict, "CONFLICT", "ownership_moved")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, agenthost.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Agent permission or CSRF check failed")
	case errors.Is(err, agenthost.ErrNotFound), errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No such agent record")
	case errors.Is(err, agenthost.ErrAlreadyAnswered):
		// Reloading will not produce a state in which answering again is right,
		// so this is its own conflict rather than a stale revision.
		writeError(w, http.StatusConflict, "CONFLICT", "That approval has already been answered")
	case errors.Is(err, agenthost.ErrFrozen), errors.Is(err, storage.ErrHandoffFrozen):
		writeError(w, http.StatusConflict, "CONFLICT", "A prepared handoff's bundle cannot be changed")
	case errors.Is(err, agenthost.ErrNotDeliverable):
		writeError(w, http.StatusConflict, "CONFLICT", "That handoff cannot be dispatched from its current state")
	case errors.Is(err, agenthost.ErrNoWorker):
		// For an approval the decision is already recorded; what could not
		// happen is the CLI hearing it. A client draws this as "the machine is
		// not reachable", never as a decision that failed to be taken.
		writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "No Worker is reachable for this execution host")
	case errors.Is(err, agenthost.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid agent request")
	case errors.Is(err, storage.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "This operation id was already used for a different request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "The record changed; reload its current revision")
	case errors.Is(err, storage.ErrCounterExhausted):
		writeError(w, http.StatusInsufficientStorage, "RESOURCE_EXHAUSTED", "Agent revision space is exhausted")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Agent operation failed")
	}
}

// agentCaller derives the caller from the authenticated session. The scope in
// the request selects the workspace being asked about; a host or execution host
// that is not this Host is refused rather than reinterpreted as local.
func agentCaller(r *http.Request, host Identity, service *auth.Service, agents *agenthost.Service, meta *pb.CommandMeta, permission string, mutating bool) (agenthost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return agenthost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return agenthost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return agenthost.Caller{}, auth.ErrPermission
	}
	principal, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         r.Header.Get("Origin"),
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequireCSRF:    mutating,
		RequiredScopes: []auth.Scope{{Permission: permission, WorkspaceID: scope.WorkspaceId, ExecutionHostID: host.HostID}},
	})
	if err != nil {
		return agenthost.Caller{}, err
	}
	if agents == nil {
		return agenthost.Caller{}, errAgentUnsupported
	}
	return agenthost.Caller{
		PrincipalID: principal.PrincipalID,
		DeviceID:    principal.DeviceID,
		DeviceEpoch: principal.DeviceEpoch,
		WorkspaceID: scope.WorkspaceId,
		Scopes:      principal.Scopes,
	}, nil
}

// agentCall is one method's whole shape: decode, authenticate, act, answer. The
// fourteen methods below differ only in those four things, so they are written
// as four values rather than as fourteen copies of the same block — which is
// what keeps a new method from quietly acquiring the wrong permission.
type agentCall[Request any, Response any] struct {
	permission string
	mutating   bool
	meta       func(*Request) *pb.CommandMeta
	act        func(agenthost.Caller, *Request) (*Response, error)
}

func serveAgent[Request any, Response any](w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, agents *agenthost.Service, call agentCall[Request, Response], input *Request) {
	if !decodeAuth(w, r, any(input).(proto.Message)) {
		return
	}
	caller, err := agentCaller(r, host, service, agents, call.meta(input), call.permission, call.mutating)
	if err != nil {
		agentFailure(w, err)
		return
	}
	result, err := call.act(caller, input)
	if err != nil {
		agentFailure(w, err)
		return
	}
	writeProto(w, http.StatusOK, any(result).(proto.Message))
}

func agentRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, agents *agenthost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	ctx := r.Context()
	switch strings.TrimPrefix(r.URL.Path, AgentPrefix) {
	case "ListStatus":
		serveAgent(w, r, host, service, agents, agentCall[pb.ListAgentStatusRequest, pb.ListAgentStatusResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.ListAgentStatusRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.ListAgentStatusRequest) (*pb.ListAgentStatusResponse, error) {
				return agents.ListStatus(ctx, caller, in)
			},
		}, new(pb.ListAgentStatusRequest))
	case "MarkRead":
		serveAgent(w, r, host, service, agents, agentCall[pb.MarkAgentReadRequest, pb.MarkAgentReadResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.MarkAgentReadRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.MarkAgentReadRequest) (*pb.MarkAgentReadResponse, error) {
				return agents.MarkRead(ctx, caller, in)
			},
		}, new(pb.MarkAgentReadRequest))
	case "ListApprovals":
		serveAgent(w, r, host, service, agents, agentCall[pb.ListApprovalsRequest, pb.ListApprovalsResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.ListApprovalsRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.ListApprovalsRequest) (*pb.ListApprovalsResponse, error) {
				return agents.ListApprovals(ctx, caller, in)
			},
		}, new(pb.ListApprovalsRequest))
	case "AnswerApproval":
		serveAgent(w, r, host, service, agents, agentCall[pb.AnswerApprovalRequest, pb.AnswerApprovalResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.AnswerApprovalRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.AnswerApprovalRequest) (*pb.AnswerApprovalResponse, error) {
				return agents.AnswerApproval(ctx, caller, in)
			},
		}, new(pb.AnswerApprovalRequest))
	case "ListDeliveries":
		serveAgent(w, r, host, service, agents, agentCall[pb.ListDeliveriesRequest, pb.ListDeliveriesResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.ListDeliveriesRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.ListDeliveriesRequest) (*pb.ListDeliveriesResponse, error) {
				return agents.ListDeliveries(ctx, caller, in)
			},
		}, new(pb.ListDeliveriesRequest))
	case "ListMailbox":
		serveAgent(w, r, host, service, agents, agentCall[pb.ListMailboxRequest, pb.ListMailboxResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.ListMailboxRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.ListMailboxRequest) (*pb.ListMailboxResponse, error) {
				return agents.ListMailbox(ctx, caller, in)
			},
		}, new(pb.ListMailboxRequest))
	case "PrepareHandoff":
		serveAgent(w, r, host, service, agents, agentCall[pb.PrepareHandoffRequest, pb.PrepareHandoffResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.PrepareHandoffRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.PrepareHandoffRequest) (*pb.PrepareHandoffResponse, error) {
				return agents.PrepareHandoff(ctx, caller, in)
			},
		}, new(pb.PrepareHandoffRequest))
	case "AcceptHandoff":
		serveAgent(w, r, host, service, agents, agentCall[pb.AcceptHandoffRequest, pb.AcceptHandoffResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.AcceptHandoffRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.AcceptHandoffRequest) (*pb.AcceptHandoffResponse, error) {
				return agents.AcceptHandoff(ctx, caller, in)
			},
		}, new(pb.AcceptHandoffRequest))
	case "CancelHandoff":
		serveAgent(w, r, host, service, agents, agentCall[pb.CancelHandoffRequest, pb.CancelHandoffResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.CancelHandoffRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.CancelHandoffRequest) (*pb.CancelHandoffResponse, error) {
				return agents.CancelHandoff(ctx, caller, in)
			},
		}, new(pb.CancelHandoffRequest))
	case "ListHandoffs":
		serveAgent(w, r, host, service, agents, agentCall[pb.ListHandoffsRequest, pb.ListHandoffsResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.ListHandoffsRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.ListHandoffsRequest) (*pb.ListHandoffsResponse, error) {
				return agents.ListHandoffs(ctx, caller, in)
			},
		}, new(pb.ListHandoffsRequest))
	case "GetHandoff":
		serveAgent(w, r, host, service, agents, agentCall[pb.GetHandoffRequest, pb.GetHandoffResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.GetHandoffRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.GetHandoffRequest) (*pb.GetHandoffResponse, error) {
				return agents.GetHandoff(ctx, caller, in)
			},
		}, new(pb.GetHandoffRequest))
	case "ListContextLinks":
		serveAgent(w, r, host, service, agents, agentCall[pb.ListContextLinksRequest, pb.ListContextLinksResponse]{
			permission: agenthost.ScopeRead,
			meta:       func(in *pb.ListContextLinksRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.ListContextLinksRequest) (*pb.ListContextLinksResponse, error) {
				return agents.ListContextLinks(ctx, caller, in)
			},
		}, new(pb.ListContextLinksRequest))
	// Installing a Hook makes a CLI on the machine call back into the Runtime.
	// It is execution, and it is checked as execution even though this Host
	// stores nothing about it.
	case "InstallHooks":
		serveAgent(w, r, host, service, agents, agentCall[pb.InstallHooksRequest, pb.InstallHooksResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.InstallHooksRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.InstallHooksRequest) (*pb.InstallHooksResponse, error) {
				return agents.InstallHooks(ctx, caller, in)
			},
		}, new(pb.InstallHooksRequest))
	case "UninstallHooks":
		serveAgent(w, r, host, service, agents, agentCall[pb.UninstallHooksRequest, pb.UninstallHooksResponse]{
			permission: agenthost.ScopeWrite, mutating: true,
			meta: func(in *pb.UninstallHooksRequest) *pb.CommandMeta { return in.GetMeta() },
			act: func(caller agenthost.Caller, in *pb.UninstallHooksRequest) (*pb.UninstallHooksResponse, error) {
				return agents.UninstallHooks(ctx, caller, in)
			},
		}, new(pb.UninstallHooksRequest))
	}
}
