package eventstream

import (
	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
)

// What a subscription is allowed to see, and what it asked to see.
//
// The two are resolved once, at subscribe time, and never widened afterwards.
// Narrowing later would be the same bug as widening: a client that was told its
// cursor advanced past a sequence must not receive that sequence on a second
// page under different rules.
type filter struct {
	workspaces map[string]struct{}
	domains    map[pb.EventDomain]struct{}
	// hostWide is the subset of `domains` the session may read without naming a
	// workspace. It is what admits a host-wide envelope: the settings document
	// belongs to every workspace the session follows, so attributing it to one
	// of them would hide the change from the others, and it carries no
	// workspace at all. A session whose grant is narrowed to a workspace has
	// not been given the machine's document and does not appear here.
	hostWide    map[pb.EventDomain]struct{}
	minPriority pb.EventPriority
	pageBytes   int
}

// domainRead maps a domain onto the grant that governs reading it. The mapping
// follows the Runtime route authorization already in `server/scopes.go`, so a
// device does not gain through the stream what it cannot read over HTTPS.
var domainRead = map[pb.EventDomain]string{
	pb.EventDomain_EVENT_DOMAIN_CANVAS:     "canvas:read",
	pb.EventDomain_EVENT_DOMAIN_SETTINGS:   "settings:read",
	pb.EventDomain_EVENT_DOMAIN_FILESYSTEM: "files:read",
	pb.EventDomain_EVENT_DOMAIN_SESSION:    "terminal:read",
	// Agent state lives in the canvas area, the same place its HTTP routes do.
	pb.EventDomain_EVENT_DOMAIN_AGENT: "canvas:read",
	pb.EventDomain_EVENT_DOMAIN_GIT:   "git:read",
}

// publishedDomains is the order domains are considered in, so a narrowed
// subscription and its error messages are deterministic.
var publishedDomains = []pb.EventDomain{
	pb.EventDomain_EVENT_DOMAIN_CANVAS,
	pb.EventDomain_EVENT_DOMAIN_SETTINGS,
	pb.EventDomain_EVENT_DOMAIN_FILESYSTEM,
	pb.EventDomain_EVENT_DOMAIN_SESSION,
	pb.EventDomain_EVENT_DOMAIN_AGENT,
	pb.EventDomain_EVENT_DOMAIN_GIT,
}

// permits reports whether the session may read one domain of one workspace.
func permits(caller Caller, domain pb.EventDomain, workspaceID string) bool {
	permission, known := domainRead[domain]
	if !known {
		return false
	}
	return auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, WorkspaceID: workspaceID, ExecutionHostID: caller.HostID}})
}

// resolve turns a subscription request into the filter the connection runs
// under, or the reason it cannot run at all.
//
// Workspaces are explicit and every one of them must be readable: dropping an
// unauthorized workspace from the list silently would leave the client
// believing it is following a workspace it is not. Domains are the opposite:
// an empty list means "whatever I may read", so a device with only canvas
// grants gets a canvas stream instead of a refusal, while a device that names
// a domain it may not read is refused — it asked for something specific.
func resolve(caller Caller, request *pb.SubscribeEventsRequest, maxPageBytes int) (filter, error) {
	if request == nil {
		return filter{}, ErrInvalidSubscription
	}
	if len(request.GetWorkspaceIds()) == 0 || len(request.GetWorkspaceIds()) > MaxSubscribedWorkspaces {
		return filter{}, ErrInvalidSubscription
	}
	result := filter{
		workspaces:  make(map[string]struct{}, len(request.GetWorkspaceIds())),
		domains:     make(map[pb.EventDomain]struct{}),
		hostWide:    make(map[pb.EventDomain]struct{}),
		minPriority: request.GetMinPriority(),
		pageBytes:   maxPageBytes,
	}
	if size := int(request.GetPageBytes()); size > 0 && size < maxPageBytes {
		result.pageBytes = size
	}
	switch result.minPriority {
	case pb.EventPriority_EVENT_PRIORITY_UNSPECIFIED, pb.EventPriority_EVENT_PRIORITY_NORMAL, pb.EventPriority_EVENT_PRIORITY_HIGH:
	default:
		// An unknown priority is not "the lowest one": a client asking for a
		// level this Host does not implement must not be handed everything.
		return filter{}, ErrInvalidSubscription
	}
	for _, workspace := range request.GetWorkspaceIds() {
		if workspace == "" || len(workspace) > 120 {
			return filter{}, ErrInvalidSubscription
		}
		if _, duplicate := result.workspaces[workspace]; duplicate {
			return filter{}, ErrInvalidSubscription
		}
		result.workspaces[workspace] = struct{}{}
	}
	// A workspace the session cannot read at all is refused outright rather
	// than dropped from the list: a client told its subscription started would
	// otherwise believe it is following a workspace nobody is sending it.
	for workspace := range result.workspaces {
		readable := false
		for _, domain := range publishedDomains {
			if permits(caller, domain, workspace) {
				readable = true
				break
			}
		}
		if !readable {
			return filter{}, ErrSubscriptionDenied
		}
	}
	if requested := request.GetDomains(); len(requested) > 0 {
		for _, domain := range requested {
			if _, known := domainRead[domain]; !known {
				return filter{}, ErrInvalidSubscription
			}
			for workspace := range result.workspaces {
				// It was named explicitly, so narrowing it away would be a lie.
				if !permits(caller, domain, workspace) {
					return filter{}, ErrSubscriptionDenied
				}
			}
			result.domains[domain] = struct{}{}
		}
	} else {
		for _, domain := range publishedDomains {
			readable := true
			for workspace := range result.workspaces {
				if !permits(caller, domain, workspace) {
					readable = false
					break
				}
			}
			if readable {
				result.domains[domain] = struct{}{}
			}
		}
	}
	if len(result.domains) == 0 {
		return filter{}, ErrSubscriptionDenied
	}
	// A domain the session may read without naming a workspace is the only one
	// whose host-wide events it may receive. This is asked once, here, for the
	// same reason everything else about the filter is: a grant re-checked later
	// could answer differently for a page the client was already told about.
	for domain := range result.domains {
		if permitsHostWide(caller, domain) {
			result.hostWide[domain] = struct{}{}
		}
	}
	return result, nil
}

// permitsHostWide reports whether the session holds a domain's grant over the
// whole machine rather than over one workspace of it.
func permitsHostWide(caller Caller, domain pb.EventDomain) bool {
	permission, known := domainRead[domain]
	if !known {
		return false
	}
	return auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, ExecutionHostID: caller.HostID}})
}

// admits reports whether one projected envelope belongs on this subscription.
// An envelope that does not is not an error: the cursor still advances past it,
// exactly as the HTTPS page does, so a filtered subscription still converges.
func (f filter) admits(envelope *pb.EventEnvelope) bool {
	if envelope == nil {
		return false
	}
	if _, ok := f.domains[envelope.GetDomain()]; !ok {
		return false
	}
	if workspace := envelope.GetWorkspaceId(); workspace == "" {
		// A host-wide change — the settings document and the execution hosts it
		// projects to — belongs to every workspace this subscription follows.
		// It is delivered on the machine-wide grant, because pinning it to one
		// of the named workspaces would hide it from the others.
		if _, ok := f.hostWide[envelope.GetDomain()]; !ok {
			return false
		}
	} else if _, ok := f.workspaces[workspace]; !ok {
		return false
	}
	return envelope.GetPriority() >= f.minPriority
}

// Priority classifies one stored event. A question a human is blocked on — an
// approval, a control confirmation — is delivered on its own subscription so it
// never waits behind a backlog of canvas moves that a slow client has not
// drained. Nothing the canvas publishes is urgent in that sense.
//
// Domains that have not switched yet publish nothing, so their entries here are
// the contract their batch will fill rather than dead code paths.
func Priority(domain pb.EventDomain, kind string) pb.EventPriority {
	switch domain {
	case pb.EventDomain_EVENT_DOMAIN_AGENT:
		if kind == "approval" || kind == "control" {
			return pb.EventPriority_EVENT_PRIORITY_HIGH
		}
	case pb.EventDomain_EVENT_DOMAIN_SESSION:
		if kind == "run" {
			return pb.EventPriority_EVENT_PRIORITY_HIGH
		}
	}
	return pb.EventPriority_EVENT_PRIORITY_NORMAL
}
