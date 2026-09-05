package eventstream

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Limits the stream runs under. Each one exists because the alternative is an
// unbounded resource a single client controls.
const (
	// MaxSubscribedWorkspaces bounds one subscription's scope. A device that
	// needs more opens more connections, which are individually accounted.
	MaxSubscribedWorkspaces = 32
	// MaxPageEvents bounds a page by count as well as by bytes, so a burst of
	// tiny events cannot produce a page with a hundred thousand entries.
	MaxPageEvents = 500
	// DefaultQueueBytes is the per-connection budget of page bytes that have
	// been sent but not acknowledged (§2.3: 4 MiB per subscriber).
	DefaultQueueBytes = 4 << 20
	// DefaultPageBytes is the ceiling for one page when the client names none.
	DefaultPageBytes = 256 << 10
	// DefaultHeartbeat is the server-side idle heartbeat. A client that has
	// heard nothing for well over one interval reconnects; the interval is
	// short enough that a dead intermediary is noticed in under a minute.
	DefaultHeartbeat = 25 * time.Second
	// DefaultAckTimeout bounds backpressure. A subscriber at its budget is
	// given this long to acknowledge before the Host stops holding its place.
	DefaultAckTimeout = 30 * time.Second
	// DefaultSweep is the safety net for writes that arrive without a commit
	// notification — a CLI import, or a second process on the same database.
	DefaultSweep = time.Second
	// subscribeTimeout bounds how long an accepted connection may stay silent
	// before it has said what it wants.
	subscribeTimeout = 15 * time.Second
	// CloseTryAgainLater tells a client to reconnect with its cursor rather
	// than to treat the close as a permanent refusal.
	CloseTryAgainLater = 1013
)

var (
	// ErrInvalidSubscription marks a subscribe frame this Host cannot run.
	ErrInvalidSubscription = errors.New("invalid event subscription")
	// ErrSubscriptionDenied marks a scope the session was not granted.
	ErrSubscriptionDenied = errors.New("event subscription is not permitted")
	// ErrUnsupported marks a Host assembled without an event stream.
	ErrUnsupported = errors.New("this Host has no event stream")
)

// Caller is the already-authenticated device. Nothing in the subscribe frame
// supplies identity; it only selects which of the session's own grants are used.
type Caller struct {
	PrincipalID string
	DeviceID    string
	HostID      string
	Scopes      []auth.Scope
}

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && len(c.HostID) == 32 && len(c.Scopes) > 0
}

type Options struct {
	Store  *storage.Store
	HostID string
	// Projectors contribute one domain each. An empty set is a Host that
	// publishes nothing, which is a configuration error rather than a quiet
	// stream that never delivers.
	Projectors []Projector
	// QueueBytes, PageBytes, Heartbeat, AckTimeout and Sweep default to the
	// constants above; tests set them small to reach the boundaries quickly.
	QueueBytes int
	PageBytes  int
	Heartbeat  time.Duration
	AckTimeout time.Duration
	Sweep      time.Duration
	Now        func() time.Time
}

// Hub owns the subscriber set and the wake-up path. It holds no per-connection
// buffer of its own: a page is read from the durable outbox when there is room
// to send it, so a slow subscriber costs a cursor rather than memory.
type Hub struct {
	store      *storage.Store
	hostID     string
	projectors []Projector
	options    Options

	mu          sync.Mutex
	subscribers map[chan struct{}]struct{}
	closed      bool
}

func New(options Options) (*Hub, error) {
	if options.Store == nil || len(options.HostID) != 32 || len(options.Projectors) == 0 {
		return nil, ErrInvalidSubscription
	}
	if options.QueueBytes <= 0 {
		options.QueueBytes = DefaultQueueBytes
	}
	if options.PageBytes <= 0 || options.PageBytes > MaxFrameBytes/2 {
		options.PageBytes = DefaultPageBytes
	}
	if options.Heartbeat <= 0 {
		options.Heartbeat = DefaultHeartbeat
	}
	if options.AckTimeout <= 0 {
		options.AckTimeout = DefaultAckTimeout
	}
	if options.Sweep <= 0 {
		options.Sweep = DefaultSweep
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Hub{
		store:       options.Store,
		hostID:      options.HostID,
		projectors:  options.Projectors,
		options:     options,
		subscribers: make(map[chan struct{}]struct{}),
	}, nil
}

// Notify wakes every subscriber. It is what the storage kernel calls after a
// transaction commits, and it must never block: a write path that waits on a
// reader is a write path a slow client can stall.
func (h *Hub) Notify(uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for wake := range h.subscribers {
		select {
		case wake <- struct{}{}:
		default:
			// A pending wake-up already says "look again"; a second one would
			// add nothing, and dropping it is what keeps this non-blocking.
		}
	}
}

// Close releases every subscriber. Connections end on their own read errors;
// this only stops the hub from handing out new ones.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for wake := range h.subscribers {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}

// Subscribers reports the live connection count. Tests read it; nothing in the
// serving path branches on it.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subscribers)
}

func (h *Hub) register() (chan struct{}, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, false
	}
	wake := make(chan struct{}, 1)
	// A fresh subscriber looks once without waiting: history may already exist.
	wake <- struct{}{}
	h.subscribers[wake] = struct{}{}
	return wake, true
}

func (h *Hub) unregister(wake chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subscribers, wake)
}

// Serve upgrades the request and runs one subscription to completion.
//
// The caller has already authenticated the device and verified the exact
// browser origin. A WebSocket handshake cannot carry a CSRF header, so that
// origin plus the SameSite=Strict session cookie is what stands in for one —
// the same rule the Runtime proxy applies to its streams.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, caller Caller) {
	if h == nil {
		writeUpgradeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no event stream")
		return
	}
	if !caller.valid() || caller.HostID != h.hostID {
		writeUpgradeError(w, http.StatusForbidden, "PERMISSION_DENIED", "The session may not open an event stream")
		return
	}
	if !IsUpgrade(r) || r.Header.Get("Sec-WebSocket-Version") != "13" {
		writeUpgradeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "A WebSocket 13 upgrade is required")
		return
	}
	conn, err := accept(w, r)
	if err != nil {
		writeUpgradeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "The stream handshake was refused")
		return
	}
	h.run(r.Context(), conn, caller)
}

// run owns the connection from the subscribe frame to the close frame.
func (h *Hub) run(ctx context.Context, conn *socket, caller Caller) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	subscription, err := h.subscribe(conn, caller)
	if err != nil {
		switch {
		case errors.Is(err, ErrSubscriptionDenied):
			h.fail(conn, ClosePolicyViolation, "PERMISSION_DENIED", "This session may not subscribe to that scope")
		case errors.Is(err, ErrInvalidSubscription), errors.Is(err, ErrProtocol), errors.Is(err, ErrTooLarge):
			h.fail(conn, CloseProtocolError, "INVALID_ARGUMENT", "The subscription frame was not usable")
		default:
			conn.closeWith(CloseNormal, "")
		}
		return
	}
	wake, ok := h.register()
	if !ok {
		h.fail(conn, CloseTryAgainLater, "DISCONNECTED", "This Host is shutting the stream down")
		return
	}
	defer h.unregister(wake)

	acks := make(chan uint64, 16)
	// The reader runs on its own goroutine so an idle client still has its
	// pings answered and its close frame observed while the writer waits.
	go h.readAcks(conn, acks, cancel)
	h.pump(ctx, conn, subscription, wake, acks)
}

// subscription is the resolved state of one connection.
type subscription struct {
	filter filter
	cursor uint64
}

// subscribe reads and resolves the one subscribe frame this connection carries.
func (h *Hub) subscribe(conn *socket, caller Caller) (*subscription, error) {
	code, payload, err := conn.read(h.options.Now().Add(subscribeTimeout))
	if err != nil {
		return nil, err
	}
	if code != opBinary {
		return nil, ErrProtocol
	}
	frame := &pb.EventStreamFrame{}
	if err = (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(payload, frame); err != nil {
		return nil, ErrInvalidSubscription
	}
	request := frame.GetSubscribe()
	if request == nil {
		return nil, ErrInvalidSubscription
	}
	resolved, err := resolve(caller, request, h.options.PageBytes)
	if err != nil {
		return nil, err
	}
	return &subscription{filter: resolved, cursor: request.GetAfterSequence()}, nil
}

// pump drives catch-up, then push, then heartbeat, on one goroutine.
//
// One goroutine writes, so the budget accounting and the frame order cannot
// interleave with themselves. Acks arrive from the reader and are applied here
// for the same reason.
func (h *Hub) pump(ctx context.Context, conn *socket, sub *subscription, wake <-chan struct{}, acks <-chan uint64) {
	budget := &budget{limit: h.options.QueueBytes}
	heartbeat := time.NewTicker(h.options.Heartbeat)
	defer heartbeat.Stop()
	sweep := time.NewTicker(h.options.Sweep)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			conn.closeWith(CloseNormal, "")
			return
		default:
		}
		page, err := h.page(ctx, sub.cursor, sub.filter)
		if err != nil {
			h.fail(conn, CloseInternalError, "INTERNAL", "The event outbox could not be read")
			return
		}
		if page.Status != pb.EventCursorStatus_EVENT_CURSOR_STATUS_OK {
			// The client has to act before anything else can be sent, and one
			// connection carries one subscription, so this ends the stream.
			_ = h.send(conn, &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Page{Page: page}}, nil)
			conn.closeWith(CloseNormal, "")
			return
		}
		// A page whose events were all filtered out still moves the client
		// forward, and it is sent for exactly that reason: leaving the client's
		// cursor behind the Host's would make every reconnect re-scan the
		// stretch of history this subscription already declined.
		if page.NextCursor > sub.cursor {
			if !budget.reserve(frameSize(page)) {
				if !h.awaitAck(ctx, budget, acks, frameSize(page)) {
					h.fail(conn, CloseTryAgainLater, "RESOURCE_EXHAUSTED", "The subscription queue budget is exhausted")
					return
				}
			}
			if err = h.send(conn, &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Page{Page: page}}, budget); err != nil {
				conn.closeWith(CloseNormal, "")
				return
			}
			sub.cursor = page.NextCursor
			if page.HasMore {
				// Still catching up: read the next page immediately rather than
				// waiting for a commit that may never come.
				continue
			}
		}
		// Caught up. From here the next page is produced by the next commit.
		select {
		case <-ctx.Done():
			conn.closeWith(CloseNormal, "")
			return
		case <-wake:
		case <-sweep.C:
		case through := <-acks:
			budget.release(through)
		case <-heartbeat.C:
			frame := &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Heartbeat{Heartbeat: &pb.EventHeartbeat{
				HighWatermark: page.HighWatermark,
				SentAtUnixMs:  h.options.Now().UnixMilli(),
			}}}
			// A heartbeat is not charged to the page budget: it is how a client
			// tells a quiet stream from a dead one, and withholding it because
			// the client is behind would turn slowness into a disconnect.
			if err = h.send(conn, frame, nil); err != nil {
				conn.closeWith(CloseNormal, "")
				return
			}
			if err = conn.ping(); err != nil {
				conn.closeWith(CloseNormal, "")
				return
			}
		}
	}
}

// awaitAck applies backpressure with an end to it. A subscriber at its budget
// is given AckTimeout to drain; past that the Host stops holding its place and
// says so, and the client reconnects with the cursor it already has.
func (h *Hub) awaitAck(ctx context.Context, budget *budget, acks <-chan uint64, size int) bool {
	deadline := time.NewTimer(h.options.AckTimeout)
	defer deadline.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case through := <-acks:
			budget.release(through)
			if budget.reserve(size) {
				return true
			}
		}
	}
}

// readAcks consumes the client's half of the connection: flow-control acks, and
// the close frame. Anything else on this connection is a protocol error — one
// connection carries one subscription, so a second subscribe frame is a client
// that believes it can change a cursor mid-stream.
func (h *Hub) readAcks(conn *socket, acks chan<- uint64, cancel context.CancelFunc) {
	defer cancel()
	for {
		code, payload, err := conn.read(time.Time{})
		if err != nil {
			return
		}
		if code != opBinary {
			return
		}
		frame := &pb.EventStreamFrame{}
		if err = (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(payload, frame); err != nil {
			return
		}
		ack := frame.GetAck()
		if ack == nil {
			return
		}
		select {
		case acks <- ack.GetReceivedThrough():
		default:
			// The writer is mid-page; the next ack it reads carries a
			// through-sequence at least as high, so nothing is lost.
		}
	}
}

func (h *Hub) send(conn *socket, frame *pb.EventStreamFrame, charged *budget) error {
	wire, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	if err = conn.writeMessage(wire); err != nil {
		return err
	}
	if charged != nil {
		if page := frame.GetPage(); page != nil {
			charged.sent(page.GetNextCursor(), len(wire))
		}
	}
	return nil
}

// fail states the reason on the wire before closing. A client that only saw a
// TCP close would have to guess between "not allowed", "too far behind" and
// "the Host went away", which are three different repairs.
func (h *Hub) fail(conn *socket, closeCode uint16, code, message string) {
	_ = h.send(conn, &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Error{Error: &pb.ErrorResponse{Code: code, Message: message}}}, nil)
	conn.closeWith(closeCode, code)
}

// writeUpgradeError answers a handshake this Host refuses. It is a plain HTTP
// response: the connection was never upgraded, so there is no frame to put a
// reason in.
func writeUpgradeError(w http.ResponseWriter, status int, code, message string) {
	wire, err := proto.Marshal(&pb.ErrorResponse{Code: code, Message: message})
	if err != nil {
		http.Error(w, "Response encoding failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(status)
	_, _ = w.Write(wire)
}

// frameSize estimates what a page will cost on the wire before it is encoded.
// It only has to be close: it decides when to wait for an ack, and the real
// size is charged once the page is actually written.
func frameSize(page *pb.EventPage) int {
	return proto.Size(page) + 16
}

// budget is one connection's allowance of page bytes that have been written but
// not acknowledged (§2.3: 4 MiB per subscriber).
//
// It is deliberately measured in bytes on the wire rather than in pages or
// events: what a slow subscriber actually costs is the socket buffer and the
// kernel memory behind it, and one page of large whiteboard snapshots is worth
// thousands of node moves. The records are kept in send order, which is
// sequence order, so releasing through an acknowledged sequence is a prefix cut
// rather than a search.
type budget struct {
	limit       int
	outstanding int
	pages       []budgetEntry
}

type budgetEntry struct {
	through uint64
	bytes   int
}

// reserve reports whether one more page of this size fits. A page larger than
// the whole limit is admitted when nothing is outstanding: refusing it would
// stall the subscription permanently instead of merely throttling it.
func (b *budget) reserve(size int) bool {
	if b.outstanding == 0 {
		return true
	}
	return b.outstanding+size <= b.limit
}

func (b *budget) sent(through uint64, size int) {
	b.outstanding += size
	b.pages = append(b.pages, budgetEntry{through: through, bytes: size})
}

// release frees every page the client has acknowledged through. An ack for a
// sequence this connection never sent releases nothing beyond what it covers.
func (b *budget) release(through uint64) {
	cut := 0
	for cut < len(b.pages) && b.pages[cut].through <= through {
		b.outstanding -= b.pages[cut].bytes
		cut++
	}
	if cut > 0 {
		b.pages = append(b.pages[:0], b.pages[cut:]...)
	}
	if b.outstanding < 0 || len(b.pages) == 0 {
		b.outstanding = 0
	}
}
