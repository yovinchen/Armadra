package eventstream

import (
	"net/http"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
)

const (
	workspaceA = "workspace-a"
	workspaceB = "workspace-b"
)

func canvasScopes(workspaces ...string) []auth.Scope {
	scopes := make([]auth.Scope, 0, len(workspaces))
	for _, workspace := range workspaces {
		scopes = append(scopes, auth.Scope{Permission: "canvas:read", WorkspaceID: workspace, ExecutionHostID: testHost})
	}
	return scopes
}

// collect drains pages until the cursor reaches `through`, returning every
// event delivered. It acknowledges as it goes, which is what a real client does
// and what keeps the budget from being the thing under test here.
func collect(t *testing.T, c *client, through uint64, within time.Duration) []*pb.EventEnvelope {
	t.Helper()
	deadline := time.Now().Add(within)
	var events []*pb.EventEnvelope
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("stream stopped short of sequence %d after %d events", through, len(events))
		}
		page, failure, closeCode := c.nextPage(t, remaining)
		if page == nil {
			t.Fatalf("stream ended before sequence %d (error %v, close %d)", through, failure, closeCode)
		}
		if page.Status != pb.EventCursorStatus_EVENT_CURSOR_STATUS_OK {
			t.Fatalf("unexpected cursor status %v", page.Status)
		}
		events = append(events, page.Events...)
		c.ack(t, page.NextCursor)
		if page.NextCursor >= through {
			return events
		}
	}
}

// The whole point of the stream: a client that connects behind is caught up
// from the stored outbox and then pushed to, on one connection, with one
// cursor. The switch between the two is not a mode a client has to ask about —
// it is `has_more` going false.
func TestCatchUpThenPushOnOneCursor(t *testing.T) {
	h := newHarness(t, Options{PageBytes: 4 << 10}, canvasScopes(workspaceA))
	var history uint64
	for index := range 12 {
		history = h.write(workspaceA, "canvas.node", string(rune('a'+index)), 512)
	}
	c, response := dial(t, h.server, nil)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal("handshake refused")
	}
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})

	caughtUp := collect(t, c, history, 10*time.Second)
	if len(caughtUp) != 12 {
		t.Fatalf("catch-up delivered %d of 12 events", len(caughtUp))
	}
	for index, event := range caughtUp {
		if index > 0 && event.Sequence <= caughtUp[index-1].Sequence {
			t.Fatal("catch-up was not delivered in sequence order")
		}
		if event.Domain != pb.EventDomain_EVENT_DOMAIN_CANVAS || event.Kind != "node" {
			t.Fatalf("unexpected envelope %v/%s", event.Domain, event.Kind)
		}
	}

	// Now the same connection is pushed to. The commit notification is the
	// wake-up, so this must not take a poll interval.
	started := time.Now()
	pushed := h.write(workspaceA, "canvas.node", "pushed", 64)
	live := collect(t, c, pushed, 5*time.Second)
	if len(live) != 1 || live[0].Sequence != pushed || live[0].EntityId != "pushed" {
		t.Fatalf("push delivered %+v", live)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("a committed change took %s to reach a subscriber", elapsed)
	}
}

// Reconnecting is the ordinary case, not the exceptional one: a laptop sleeps,
// a proxy times out. Resuming from the cursor must deliver every event that
// happened while the client was gone and none it already applied.
func TestReconnectResumesWithoutGapOrDuplicate(t *testing.T) {
	h := newHarness(t, Options{}, canvasScopes(workspaceA))
	first := h.write(workspaceA, "canvas.node", "one", 64)
	c, _ := dial(t, h.server, nil)
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
	seen := collect(t, c, first, 5*time.Second)
	if len(seen) != 1 {
		t.Fatalf("first connection saw %d events", len(seen))
	}
	cursor := seen[0].Sequence
	c.conn.Close()

	// Written while nobody is listening; the outbox is what makes them
	// recoverable rather than lost.
	h.write(workspaceA, "canvas.node", "two", 64)
	last := h.write(workspaceA, "canvas.node", "three", 64)

	again, _ := dial(t, h.server, nil)
	again.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}, AfterSequence: cursor})
	resumed := collect(t, again, last, 5*time.Second)
	if len(resumed) != 2 {
		t.Fatalf("resume delivered %d events, expected exactly the two missed", len(resumed))
	}
	if resumed[0].EntityId != "two" || resumed[1].EntityId != "three" {
		t.Fatalf("resume delivered the wrong events: %s, %s", resumed[0].EntityId, resumed[1].EntityId)
	}
}

// A cursor the Host cannot serve is a stated answer, and each answer demands a
// different repair. Returning an empty page for either would leave the client
// believing it is up to date.
func TestUnservableCursorsAreNamedAndEndTheStream(t *testing.T) {
	t.Run("below the retained floor", func(t *testing.T) {
		h := newHarness(t, Options{}, canvasScopes(workspaceA))
		h.write(workspaceA, "canvas.node", "one", 64)
		floor := h.write(workspaceA, "canvas.node", "two", 64)
		if err := h.store.PruneEvents(t.Context(), floor); err != nil {
			t.Fatal(err)
		}
		h.write(workspaceA, "canvas.node", "three", 64)
		c, _ := dial(t, h.server, nil)
		c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
		page, _, _ := c.nextPage(t, 5*time.Second)
		if page == nil || page.Status != pb.EventCursorStatus_EVENT_CURSOR_STATUS_SNAPSHOT_REQUIRED {
			t.Fatalf("an expired cursor was not answered with SNAPSHOT_REQUIRED: %+v", page)
		}
		if page.MinCursor != floor || len(page.Events) != 0 {
			t.Fatalf("the refusal did not carry a usable floor: %+v", page)
		}
		if _, _, closeCode := c.nextPage(t, 5*time.Second); closeCode == 0 {
			t.Fatal("the stream continued after SNAPSHOT_REQUIRED")
		}
	})
	t.Run("beyond the watermark", func(t *testing.T) {
		h := newHarness(t, Options{}, canvasScopes(workspaceA))
		h.write(workspaceA, "canvas.node", "one", 64)
		c, _ := dial(t, h.server, nil)
		c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}, AfterSequence: 5000})
		page, _, _ := c.nextPage(t, 5*time.Second)
		if page == nil || page.Status != pb.EventCursorStatus_EVENT_CURSOR_STATUS_CURSOR_AHEAD {
			t.Fatalf("a cursor past the watermark was not named: %+v", page)
		}
		if page.HighWatermark != 1 {
			t.Fatalf("the refusal did not carry the watermark: %+v", page)
		}
	})
}

// The budget is what stops one subscriber that never drains from costing the
// Host unbounded memory. Exceeding it is a stated refusal the client recovers
// from with its cursor, not a silent stall and not a dropped event.
func TestAQueueBudgetThatIsNeverDrainedEndsTheStream(t *testing.T) {
	h := newHarness(t, Options{QueueBytes: 4 << 10, PageBytes: 512, AckTimeout: 200 * time.Millisecond}, canvasScopes(workspaceA))
	for index := range 200 {
		h.write(workspaceA, "canvas.node", string(rune('a'+index%26))+string(rune('a'+index/26)), 512)
	}
	c, _ := dial(t, h.server, nil)
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
	deadline := time.Now().Add(15 * time.Second)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatal("a subscriber that never acknowledged was served indefinitely")
		}
		// Deliberately never acknowledging.
		page, failure, closeCode := c.nextPage(t, remaining)
		if failure != nil {
			if failure.Code != "RESOURCE_EXHAUSTED" {
				t.Fatalf("the overflow was reported as %q", failure.Code)
			}
			if _, _, closeCode = c.nextPage(t, 5*time.Second); closeCode != CloseTryAgainLater {
				t.Fatalf("the overflow closed with %d, not a retryable code", closeCode)
			}
			return
		}
		if page == nil {
			t.Fatalf("the stream closed with %d before naming a reason", closeCode)
		}
	}
}

// Acknowledging releases the budget, so a client that keeps up is never cut
// off no matter how much history it is replaying.
func TestAnAcknowledgingSubscriberIsNeverCutOff(t *testing.T) {
	h := newHarness(t, Options{QueueBytes: 4 << 10, PageBytes: 512, AckTimeout: 2 * time.Second}, canvasScopes(workspaceA))
	var last uint64
	for index := range 120 {
		last = h.write(workspaceA, "canvas.node", string(rune('a'+index%26))+string(rune('a'+index/26)), 512)
	}
	c, _ := dial(t, h.server, nil)
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
	if events := collect(t, c, last, 20*time.Second); len(events) != 120 {
		t.Fatalf("a draining subscriber received %d of 120 events", len(events))
	}
}

// The urgent lane is a separate subscription, and that is the point: a client
// keeps its approvals on a connection that carries nothing else, so a canvas
// backlog on the other connection cannot delay a question a human is waiting
// on. This test wedges the ordinary subscriber at its budget and then checks
// the urgent one still arrives.
func TestAHighPrioritySubscriptionIsNotBlockedBySlowOne(t *testing.T) {
	scopes := append(canvasScopes(workspaceA), auth.Scope{Permission: "canvas:read", WorkspaceID: workspaceA, ExecutionHostID: testHost})
	h := newHarness(t, Options{QueueBytes: 2 << 10, PageBytes: 512, AckTimeout: 30 * time.Second}, scopes)

	urgent, _ := dial(t, h.server, nil)
	urgent.subscribe(t, &pb.SubscribeEventsRequest{
		WorkspaceIds: []string{workspaceA},
		Domains:      []pb.EventDomain{pb.EventDomain_EVENT_DOMAIN_AGENT},
		MinPriority:  pb.EventPriority_EVENT_PRIORITY_HIGH,
	})
	slow, _ := dial(t, h.server, nil)
	slow.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})

	// Fill the slow subscriber past its budget; it never acknowledges.
	for index := range 40 {
		h.write(workspaceA, "canvas.node", string(rune('a'+index%26))+string(rune('a'+index/26)), 512)
	}
	started := time.Now()
	approval := h.write(workspaceA, "agent.approval", "pending-1", 64)

	deadline := time.Now().Add(10 * time.Second)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatal("the urgent subscription never received the approval")
		}
		page, failure, closeCode := urgent.nextPage(t, remaining)
		if page == nil {
			t.Fatalf("the urgent stream ended (error %v, close %d)", failure, closeCode)
		}
		urgent.ack(t, page.NextCursor)
		for _, event := range page.Events {
			if event.Sequence != approval {
				t.Fatalf("the urgent subscription received %s, which is not urgent", event.Kind)
			}
			if event.Priority != pb.EventPriority_EVENT_PRIORITY_HIGH || event.Kind != "approval" {
				t.Fatalf("the approval arrived as %v/%s", event.Priority, event.Kind)
			}
			if elapsed := time.Since(started); elapsed > 5*time.Second {
				t.Fatalf("the approval waited %s behind the slow subscriber", elapsed)
			}
			return
		}
	}
}

// Every workspace and every named domain is checked against the session's own
// grants. Narrowing a request silently would leave a client believing it is
// following something nobody is sending it.
func TestSubscriptionScopeIsNarrowedToTheSessionsGrants(t *testing.T) {
	t.Run("an ungranted workspace is refused", func(t *testing.T) {
		h := newHarness(t, Options{}, canvasScopes(workspaceA))
		c, _ := dial(t, h.server, nil)
		c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA, workspaceB}})
		_, failure, _ := c.nextPage(t, 5*time.Second)
		if failure == nil || failure.Code != "PERMISSION_DENIED" {
			t.Fatalf("an ungranted workspace was not refused: %v", failure)
		}
	})
	t.Run("a named domain the session cannot read is refused", func(t *testing.T) {
		h := newHarness(t, Options{}, canvasScopes(workspaceA))
		c, _ := dial(t, h.server, nil)
		c.subscribe(t, &pb.SubscribeEventsRequest{
			WorkspaceIds: []string{workspaceA},
			Domains:      []pb.EventDomain{pb.EventDomain_EVENT_DOMAIN_GIT},
		})
		_, failure, _ := c.nextPage(t, 5*time.Second)
		if failure == nil || failure.Code != "PERMISSION_DENIED" {
			t.Fatalf("an ungranted domain was not refused: %v", failure)
		}
	})
	t.Run("an unnamed domain set is narrowed rather than refused", func(t *testing.T) {
		h := newHarness(t, Options{}, canvasScopes(workspaceA))
		last := h.write(workspaceA, "canvas.node", "one", 64)
		c, _ := dial(t, h.server, nil)
		c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
		if events := collect(t, c, last, 5*time.Second); len(events) != 1 {
			t.Fatalf("a canvas-only session did not receive its canvas events: %d", len(events))
		}
	})
	t.Run("another workspace's events never appear", func(t *testing.T) {
		h := newHarness(t, Options{}, canvasScopes(workspaceA))
		h.write(workspaceB, "canvas.node", "hidden", 64)
		mine := h.write(workspaceA, "canvas.node", "mine", 64)
		c, _ := dial(t, h.server, nil)
		c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
		events := collect(t, c, mine, 5*time.Second)
		if len(events) != 1 || events[0].EntityId != "mine" {
			t.Fatalf("a foreign workspace leaked into the stream: %+v", events)
		}
	})
}

// A session with no usable identity must not reach the upgrade at all: a
// stream is a long-lived grant, and getting one wrong is worse than a single
// request going to the wrong place.
func TestServeRefusesAnInvalidCaller(t *testing.T) {
	h := newHarness(t, Options{}, canvasScopes(workspaceA))
	for name, caller := range map[string]Caller{
		"no principal": {DeviceID: "device-1", HostID: testHost, Scopes: canvasScopes(workspaceA)},
		"no scopes":    {PrincipalID: "owner-1", DeviceID: "device-1", HostID: testHost},
		"another host": {PrincipalID: "owner-1", DeviceID: "device-1", HostID: "ffffffffffffffffffffffffffffffff", Scopes: canvasScopes(workspaceA)},
	} {
		t.Run(name, func(t *testing.T) {
			server := newServerFor(t, h.hub, caller)
			_, response := dial(t, server, nil)
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("an invalid caller was answered %d", response.StatusCode)
			}
		})
	}
}

// A malformed or over-broad subscription is refused before anything is read
// from the outbox, so an invalid request never costs a database page.
func TestSubscriptionValidation(t *testing.T) {
	h := newHarness(t, Options{}, canvasScopes(workspaceA))
	for name, request := range map[string]*pb.SubscribeEventsRequest{
		"no workspace":       {},
		"duplicate":          {WorkspaceIds: []string{workspaceA, workspaceA}},
		"empty id":           {WorkspaceIds: []string{""}},
		"unknown domain":     {WorkspaceIds: []string{workspaceA}, Domains: []pb.EventDomain{pb.EventDomain(99)}},
		"unknown priority":   {WorkspaceIds: []string{workspaceA}, MinPriority: pb.EventPriority(42)},
		"too many workspace": {WorkspaceIds: manyWorkspaces(MaxSubscribedWorkspaces + 1)},
	} {
		t.Run(name, func(t *testing.T) {
			c, _ := dial(t, h.server, nil)
			c.subscribe(t, request)
			_, failure, closeCode := c.nextPage(t, 5*time.Second)
			if failure == nil {
				t.Fatalf("an invalid subscription was accepted (close %d)", closeCode)
			}
			if failure.Code != "INVALID_ARGUMENT" && failure.Code != "PERMISSION_DENIED" {
				t.Fatalf("an invalid subscription was reported as %q", failure.Code)
			}
		})
	}
}

// The first frame is the subscription. Anything else means the client and this
// Host disagree about the protocol, which is not a state to continue from.
func TestTheFirstFrameMustBeASubscription(t *testing.T) {
	h := newHarness(t, Options{}, canvasScopes(workspaceA))
	c, _ := dial(t, h.server, nil)
	c.ack(t, 7)
	_, failure, _ := c.nextPage(t, 5*time.Second)
	if failure == nil || failure.Code != "INVALID_ARGUMENT" {
		t.Fatalf("a stream that never subscribed was not refused: %v", failure)
	}
}

// A closed hub stops handing out subscriptions rather than leaving a client
// connected to a Host that is shutting down.
func TestAClosedHubRefusesNewSubscriptions(t *testing.T) {
	h := newHarness(t, Options{}, canvasScopes(workspaceA))
	h.hub.Close()
	c, _ := dial(t, h.server, nil)
	c.subscribe(t, &pb.SubscribeEventsRequest{WorkspaceIds: []string{workspaceA}})
	_, failure, _ := c.nextPage(t, 5*time.Second)
	if failure == nil || failure.Code != "DISCONNECTED" {
		t.Fatalf("a closed hub accepted a subscription: %v", failure)
	}
	if h.hub.Subscribers() != 0 {
		t.Fatal("a closed hub retained a subscriber")
	}
}

// The budget releases in send order, which is sequence order, so an ack is a
// prefix cut. An ack for something never sent must not free anything beyond it.
func TestBudgetReleasesOnlyWhatWasAcknowledged(t *testing.T) {
	b := &budget{limit: 1000}
	b.sent(10, 400)
	b.sent(20, 400)
	if b.reserve(400) {
		t.Fatal("the budget admitted a page past its limit")
	}
	b.release(10)
	if !b.reserve(400) {
		t.Fatal("acknowledging the first page did not free its bytes")
	}
	if b.outstanding != 400 {
		t.Fatalf("release freed %d bytes too many", 800-b.outstanding)
	}
	b.release(5)
	if b.outstanding != 400 {
		t.Fatal("an ack below the sent range freed bytes")
	}
	b.release(20)
	if b.outstanding != 0 {
		t.Fatal("acknowledging everything left bytes outstanding")
	}
	// Nothing outstanding always admits the next page: refusing a page larger
	// than the whole budget would stall the subscription instead of throttling.
	if !b.reserve(10_000) {
		t.Fatal("an empty budget refused a large page")
	}
}

func manyWorkspaces(count int) []string {
	result := make([]string, 0, count)
	for index := range count {
		result = append(result, "workspace-"+string(rune('a'+index%26))+string(rune('a'+index/26)))
	}
	return result
}
