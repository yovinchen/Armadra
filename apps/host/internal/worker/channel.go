package worker

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The resident bidirectional channel's Host half (Go Host business migration
// §2.9, §2.10).
//
// Phase one wrote one request and read exactly one response, which made the
// reader and the writer the same goroutine. A Worker that reports on its own
// cannot work that way: an upcall may arrive at any moment, including between a
// request being written and its response arriving. So when upcalls are enabled
// this client installs a reader pump that owns the pipe, classifies each frame
// by its kind byte and routes it — responses to the waiting caller, upcalls to
// the subscriber.
//
// The pump is opt-in rather than always-on. A Host that does not want upcalls
// keeps the phase-one code path byte for byte, so enabling this cannot change
// how an existing deployment reads an existing Worker.
//
// # What "deduplicated" means here
//
// The Worker replays anything it has not seen acknowledged, which after a crash
// means replaying frames the Host may already have recorded. Deduplication is
// by (worker_instance_id, sequence) and nothing else: not by content, not by
// arrival order. A new instance id starts a new window, because a sequence is
// only meaningful inside one Worker process.

const (
	// A phase-one request or response.
	frameKindCall byte = 0
	// Worker → Host.
	frameKindUpcall byte = 1
	// Host → Worker.
	frameKindUpcallReply byte = 2

	// The capability a Worker must report before this Host expects anything
	// upward. Absent means the Worker has no durable outbox.
	UpcallCapability = "worker.upcall.v1"

	// Worker→Host request ids carry this prefix, Host→Worker ids carry "h-".
	upcallRequestPrefix = "w-"

	// A frame length must fit in the prefix's low three bytes. MaxFrameBytes is
	// well inside that, so this only guards a corrupt length.
	maxFrameLength = 1<<24 - 1
)

// Upcall is one report from the Worker, together with what the Host decided
// about it. A subscriber sees a frame at most once per (instance, sequence):
// a replay the Host has already recorded is answered DUPLICATE and never
// reaches the subscriber a second time.
type Upcall struct {
	Frame *pb.WorkerUpcall
	// Attempt is the Worker's own send count. Greater than one means this
	// frame has been on the wire before, which is evidence for an operator and
	// nothing more — it never changes how the Host treats the report.
	Attempt uint32
}

// ErrUpcallUnacceptable marks a report the sink will never be able to take —
// a body it cannot decode, an identity it cannot key. Wrapping it tells the
// Worker REJECTED, which retires the frame permanently.
//
// Any other error means "not now": the frame is left unacknowledged and the
// connection ends, so the Worker replays it on the next one. That distinction
// is the whole reliability contract, because the Worker deletes a frame on the
// strength of the Host's reply and nothing else.
var ErrUpcallUnacceptable = errors.New("the Worker upcall can never be accepted")

// UpcallSink receives accepted upcalls. It must have made the report durable
// before it returns nil: the acknowledgement that follows is what lets the
// Worker forget it.
type UpcallSink interface {
	Deliver(ctx context.Context, upcall Upcall) error
}

// upcallState is the Host's deduplication window for one Worker instance.
type upcallState struct {
	mu sync.Mutex
	// instanceID scopes every sequence below it. A different id resets the
	// window, because the Worker restarted and numbers from one again.
	instanceID string
	// through is the highest contiguous sequence accepted for instanceID.
	through uint64
	// ahead holds accepted sequences above `through`, so a frame that arrives
	// out of order is not acknowledged as though everything before it had.
	ahead map[uint64]bool
}

// accept records one sequence and reports the highest contiguous sequence the
// Host can now acknowledge, plus whether this frame is new.
func (s *upcallState) accept(instanceID string, sequence uint64) (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if instanceID != s.instanceID {
		s.instanceID, s.through, s.ahead = instanceID, 0, map[uint64]bool{}
	}
	if sequence == 0 || sequence <= s.through || s.ahead[sequence] {
		return s.through, false
	}
	if s.ahead == nil {
		s.ahead = map[uint64]bool{}
	}
	s.ahead[sequence] = true
	// Collapse everything that is now contiguous. Acknowledging a gap would
	// tell the Worker to retire a frame this Host never saw.
	for s.ahead[s.through+1] {
		delete(s.ahead, s.through+1)
		s.through++
	}
	return s.through, true
}

// window reports the current acknowledged prefix, for tests and diagnostics.
func (s *upcallState) window() (string, uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.instanceID, s.through
}

// writeKindFrame writes one framed message with its kind byte.
func writeKindFrame(writer io.Writer, kind byte, wire []byte, limit uint32) error {
	if len(wire) == 0 || len(wire) > int(limit) || len(wire) > maxFrameLength {
		return &Error{Code: CodeProtocol}
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(wire)))
	prefix[0] = kind
	if err := writeAll(writer, prefix[:]); err != nil {
		return err
	}
	return writeAll(writer, wire)
}

// readKindFrame reads one framed message and reports its kind.
//
// A phase-one peer writes a plain 32-bit length whose high byte is zero for any
// legal frame, so it arrives here as frameKindCall with the same length.
func readKindFrame(reader io.Reader, limit uint32) (byte, []byte, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		return 0, nil, err
	}
	kind := prefix[0]
	length := uint32(prefix[1])<<16 | uint32(prefix[2])<<8 | uint32(prefix[3])
	if length == 0 || length > limit {
		return 0, nil, &Error{Code: CodeProtocol}
	}
	wire := make([]byte, int(length))
	_, err := io.ReadFull(reader, wire)
	if errors.Is(err, io.EOF) {
		err = io.ErrUnexpectedEOF
	}
	return kind, wire, err
}

// received is one response handed from the pump to the waiting caller.
type received struct {
	wire []byte
	err  error
}

// pump owns the Worker's output once upcalls are enabled.
type pump struct {
	responses chan received
	// writeMu serializes the two writers: request frames from exchange and
	// reply frames from the pump itself. Interleaved bytes would corrupt both.
	writeMu sync.Mutex
	state   upcallState
	sink    UpcallSink
	done    chan struct{}
	once    sync.Once
}

// startUpcalls installs the reader pump. It is called once, after a handshake
// that reported the capability, and never for a Worker that did not.
func (c *Client) startUpcalls(sink UpcallSink) {
	if c.pump != nil || sink == nil {
		return
	}
	p := &pump{responses: make(chan received, 1), sink: sink, done: make(chan struct{})}
	c.pump = p
	go p.run(c)
}

// run reads until the pipe ends. Every exit path closes `done`, so a caller
// blocked on a response is released rather than waiting on a dead Worker.
func (p *pump) run(c *Client) {
	defer p.once.Do(func() { close(p.done) })
	limit := uint32(MaxFrameBytes)
	if c.hello != nil {
		limit = c.hello.MaxFrameBytes
	}
	for {
		kind, wire, err := readKindFrame(c.output, limit)
		if err != nil {
			select {
			case p.responses <- received{err: err}:
			default:
			}
			return
		}
		switch kind {
		case frameKindCall:
			select {
			case p.responses <- received{wire: wire}:
			case <-c.stopped:
				return
			}
		case frameKindUpcall:
			if err := p.handleUpcall(c, wire, limit); err != nil {
				select {
				case p.responses <- received{err: err}:
				default:
				}
				return
			}
		default:
			// A kind this build cannot classify is refused rather than
			// skipped: a frame it cannot read may be one it must not ignore.
			select {
			case p.responses <- received{err: &Error{Code: CodeProtocol}}:
			default:
			}
			return
		}
	}
}

// handleUpcall records one frame and answers it.
//
// A malformed frame is rejected and the connection continues: the Worker drops
// it and keeps its channel, which is better than losing every later report to
// one bad one. Only a transport failure ends the connection.
func (p *pump) handleUpcall(c *Client, wire []byte, limit uint32) error {
	frame := new(pb.WorkerUpcall)
	if err := (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(wire, frame); err != nil {
		return p.reply(c, &pb.WorkerUpcallReply{HostId: c.hostID, Disposition: pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_REJECTED, ReasonCode: "worker.upcall.malformed"}, limit)
	}
	reply := &pb.WorkerUpcallReply{
		RequestId:        frame.RequestId,
		HostId:           c.hostID,
		WorkerInstanceId: frame.WorkerInstanceId,
		ReceivedAtUnixMs: time.Now().UnixMilli(),
	}
	// The instance the Worker names must be the one this client handshook
	// with. A frame attributed to a different Worker would land in the wrong
	// deduplication window.
	if frame.WorkerInstanceId == "" || frame.WorkerInstanceId != c.instanceID || frame.Sequence == 0 || frame.Event == nil || len(frame.RequestId) > 128 || (frame.RequestId != "" && !strings.HasPrefix(frame.RequestId, upcallRequestPrefix)) {
		reply.Disposition = pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_REJECTED
		reply.ReasonCode = "worker.upcall.malformed"
		reply.AckSequence = frame.Sequence
		return p.reply(c, reply, limit)
	}
	through, fresh := p.state.accept(frame.WorkerInstanceId, frame.Sequence)
	if !fresh {
		reply.Disposition = pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_DUPLICATE
		reply.ReasonCode = "worker.upcall.duplicate"
		reply.AckSequence = through
		return p.reply(c, reply, limit)
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	err := p.sink.Deliver(ctx, Upcall{Frame: frame, Attempt: frame.Attempt})
	cancel()
	if err != nil {
		p.state.forget(frame.WorkerInstanceId, frame.Sequence)
		if !errors.Is(err, ErrUpcallUnacceptable) {
			// Not now, not never. Ending the connection without a reply leaves
			// the frame in the Worker's outbox, which is exactly where a report
			// this Host could not store belongs.
			return &Error{Code: CodeTransport}
		}
		reply.Disposition = pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_REJECTED
		reply.ReasonCode = "worker.upcall.refused"
		reply.AckSequence = frame.Sequence
		return p.reply(c, reply, limit)
	}
	reply.Disposition = pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_ACCEPTED
	reply.AckSequence = through
	return p.reply(c, reply, limit)
}

// forget undoes an acceptance the sink refused, so the window never claims a
// frame that was not recorded.
func (s *upcallState) forget(instanceID string, sequence uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if instanceID != s.instanceID {
		return
	}
	delete(s.ahead, sequence)
	if sequence <= s.through && sequence > 0 {
		s.through = sequence - 1
	}
}

func (p *pump) reply(c *Client, reply *pb.WorkerUpcallReply, limit uint32) error {
	wire, err := proto.Marshal(reply)
	if err != nil {
		return &Error{Code: CodeInvalid}
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return writeKindFrame(c.input, frameKindUpcallReply, wire, limit)
}

// UpcallWindow reports the Worker instance this client is deduplicating against
// and the highest contiguous sequence it has accepted. Zero and empty mean no
// upcall has been recorded on this connection.
func (c *Client) UpcallWindow() (string, uint64) {
	if c == nil || c.pump == nil {
		return "", 0
	}
	return c.pump.state.window()
}
