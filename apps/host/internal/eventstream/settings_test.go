package eventstream

import (
	"net/http"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// settingsProjector publishes the two host-wide kinds the settings domain
// stores. Their envelopes carry no workspace, which is the whole point: the
// document belongs to the machine, not to one project on it.
type settingsProjector struct{}

func (settingsProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_SETTINGS }

func (settingsProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	kind := ""
	switch event.Kind {
	case "settings.document":
		kind = "document"
	case "settings.executionHost":
		kind = "executionHost"
	default:
		return nil, nil
	}
	return &pb.EventEnvelope{
		Sequence:    event.Sequence,
		WorkspaceId: event.WorkspaceID,
		Domain:      pb.EventDomain_EVENT_DOMAIN_SETTINGS,
		Kind:        kind,
		EntityId:    event.ID,
		Revision:    event.Revision,
	}, nil
}

func settingsScopes(hostWide bool, workspaces ...string) []auth.Scope {
	scopes := canvasScopes(workspaces...)
	if hostWide {
		return append(scopes, auth.Scope{Permission: "settings:read", ExecutionHostID: testHost})
	}
	for _, workspace := range workspaces {
		scopes = append(scopes, auth.Scope{Permission: "settings:read", WorkspaceID: workspace, ExecutionHostID: testHost})
	}
	return scopes
}

// A settings change reaches a subscription however many workspaces it named.
// Attributing the document to one of them would hide the change from the
// others, so it carries no workspace and is admitted on the machine-wide grant.
func TestHostWideSettingsReachASubscriptionThatNamedWorkspaces(t *testing.T) {
	h := newHarness(t, Options{Projectors: []Projector{testProjector{}, settingsProjector{}}}, settingsScopes(true, workspaceA, workspaceB))
	c, response := dial(t, h.server, nil)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal("handshake refused")
	}
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA, workspaceB}})

	h.write(workspaceA, "canvas.node", "node-1", 64)
	document := h.write("", "settings.document", "global", 128)
	host := h.write("", "settings.executionHost", "build-box", 64)

	delivered := collect(t, c, host, 10*time.Second)
	kinds := map[string]bool{}
	for _, event := range delivered {
		kinds[event.Kind] = true
	}
	if !kinds["document"] || !kinds["executionHost"] {
		t.Fatalf("the host-wide change never arrived: %+v", delivered)
	}
	for _, event := range delivered {
		if event.Domain == pb.EventDomain_EVENT_DOMAIN_SETTINGS && event.WorkspaceId != "" {
			t.Fatalf("a settings envelope was attributed to %q", event.WorkspaceId)
		}
	}
	if document == 0 {
		t.Fatal("nothing was written")
	}
}

// A grant narrowed to a workspace is not the machine's settings grant. Such a
// session keeps its canvas stream and never receives the document.
func TestAWorkspaceNarrowedGrantNeverReceivesTheDocument(t *testing.T) {
	h := newHarness(t, Options{Projectors: []Projector{testProjector{}, settingsProjector{}}}, settingsScopes(false, workspaceA))
	c, response := dial(t, h.server, nil)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal("handshake refused")
	}
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})

	h.write("", "settings.document", "global", 128)
	last := h.write(workspaceA, "canvas.node", "node-1", 64)

	delivered := collect(t, c, last, 10*time.Second)
	for _, event := range delivered {
		if event.Domain == pb.EventDomain_EVENT_DOMAIN_SETTINGS {
			t.Fatalf("a workspace-narrowed session received %+v", event)
		}
	}
	if len(delivered) != 1 || delivered[0].EntityId != "node-1" {
		t.Fatalf("the canvas stream was disturbed: %+v", delivered)
	}
}
