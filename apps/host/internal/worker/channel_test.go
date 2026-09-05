package worker

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

const fixtureInstance = "abcdef0123456789abcdef0123456789"

// recordingSink captures what the pump delivered and can be told to refuse.
type recordingSink struct {
	mu        sync.Mutex
	delivered []Upcall
	refuse    error
}

func (s *recordingSink) Deliver(_ context.Context, upcall Upcall) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refuse != nil {
		return s.refuse
	}
	s.delivered = append(s.delivered, upcall)
	return nil
}

func (s *recordingSink) sequences() []uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uint64, 0, len(s.delivered))
	for _, upcall := range s.delivered {
		out = append(out, upcall.Frame.Sequence)
	}
	return out
}

// A phase-one peer writes a 32-bit length. Any legal frame has a zero high
// byte, so it must arrive as a call with the same length — otherwise upgrading
// the Host breaks every Worker that predates this batch.
func TestPhaseOneLengthPrefixReadsAsACall(t *testing.T) {
	for _, length := range []int{1, 4096, MaxFrameBytes} {
		var prefix [4]byte
		binary.BigEndian.PutUint32(prefix[:], uint32(length))
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			_, _ = writer.Write(prefix[:])
			_, _ = writer.Write(make([]byte, length))
			writer.Close()
		}()
		kind, wire, err := readKindFrame(reader, MaxFrameBytes)
		reader.Close()
		if err != nil || kind != frameKindCall || len(wire) != length {
			t.Fatalf("phase-one prefix for %d bytes changed meaning: kind=%d err=%v", length, kind, err)
		}
	}
}

// Acknowledging a gap would tell the Worker to retire a frame this Host never
// saw. Only the contiguous prefix may be acknowledged.
func TestTheWindowOnlyAcknowledgesAContiguousPrefix(t *testing.T) {
	var state upcallState
	if through, fresh := state.accept(fixtureInstance, 2); through != 0 || !fresh {
		t.Fatalf("an out-of-order frame acknowledged a gap: %d", through)
	}
	if through, fresh := state.accept(fixtureInstance, 3); through != 0 || !fresh {
		t.Fatalf("a second frame above the gap acknowledged it: %d", through)
	}
	// One arrives and three become contiguous at once.
	if through, fresh := state.accept(fixtureInstance, 1); through != 3 || !fresh {
		t.Fatalf("the gap did not close: %d", through)
	}
	// A replay of anything already accepted is a duplicate, not a new frame.
	for _, sequence := range []uint64{1, 2, 3} {
		if through, fresh := state.accept(fixtureInstance, sequence); fresh || through != 3 {
			t.Fatalf("sequence %d was accepted twice", sequence)
		}
	}
	if _, fresh := state.accept(fixtureInstance, 0); fresh {
		t.Fatal("sequence zero was accepted")
	}
}

// A restarted Worker numbers from one again. Keeping the old window would make
// its first report look like a duplicate and drop it.
func TestANewInstanceResetsTheWindow(t *testing.T) {
	var state upcallState
	state.accept(fixtureInstance, 1)
	state.accept(fixtureInstance, 2)
	if instance, through := state.window(); instance != fixtureInstance || through != 2 {
		t.Fatalf("window is %s/%d", instance, through)
	}
	second := strings.Repeat("b", 32)
	if through, fresh := state.accept(second, 1); !fresh || through != 1 {
		t.Fatalf("a new instance did not restart the window: %d", through)
	}
	if instance, _ := state.window(); instance != second {
		t.Fatal("the window kept the previous instance")
	}
}

// A refusal must not leave the window claiming a frame that was not recorded,
// or the next acknowledgement would retire it in the Worker's outbox too.
func TestARefusalIsNotCountedAsAccepted(t *testing.T) {
	var state upcallState
	state.accept(fixtureInstance, 1)
	state.accept(fixtureInstance, 2)
	state.forget(fixtureInstance, 2)
	if _, through := state.window(); through != 1 {
		t.Fatalf("a refused frame stayed in the acknowledged prefix: %d", through)
	}
	if through, fresh := state.accept(fixtureInstance, 2); !fresh || through != 2 {
		t.Fatalf("a refused frame could not be re-delivered: %d", through)
	}
}

// peer drives a client's pipes from the other side, the way a Worker would.
type peer struct {
	t        *testing.T
	client   *Client
	toHost   *os.File
	fromHost *os.File
}

func newPeer(t *testing.T, sink UpcallSink) *peer {
	t.Helper()
	// hostRead/workerWrite carry Worker → Host; workerRead/hostWrite the other way.
	hostRead, workerWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	workerRead, hostWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{
		input:      hostWrite,
		output:     hostRead,
		hostID:     fixtureHost,
		instanceID: fixtureInstance,
		timeout:    2 * time.Second,
		stopped:    make(chan struct{}),
		gate:       make(chan struct{}, 1),
	}
	c.gate <- struct{}{}
	c.startUpcalls(sink)
	p := &peer{t: t, client: c, toHost: workerWrite, fromHost: workerRead}
	t.Cleanup(func() {
		workerWrite.Close()
		workerRead.Close()
		hostRead.Close()
		hostWrite.Close()
	})
	return p
}

func (p *peer) sendUpcall(frame *pb.WorkerUpcall) {
	p.t.Helper()
	wire, err := proto.Marshal(frame)
	if err != nil {
		p.t.Fatal(err)
	}
	if err := writeKindFrame(p.toHost, frameKindUpcall, wire, MaxFrameBytes); err != nil {
		p.t.Fatal(err)
	}
}

func (p *peer) readReply() *pb.WorkerUpcallReply {
	p.t.Helper()
	kind, wire, err := readKindFrame(p.fromHost, MaxFrameBytes)
	if err != nil {
		p.t.Fatal(err)
	}
	if kind != frameKindUpcallReply {
		p.t.Fatalf("expected an upcall reply, got kind %d", kind)
	}
	reply := new(pb.WorkerUpcallReply)
	if err := proto.Unmarshal(wire, reply); err != nil {
		p.t.Fatal(err)
	}
	return reply
}

func upcallFrame(sequence uint64, attempt uint32) *pb.WorkerUpcall {
	return &pb.WorkerUpcall{
		RequestId:        fmt.Sprintf("w-%d", sequence),
		WorkerInstanceId: fixtureInstance,
		Sequence:         sequence,
		Attempt:          attempt,
		Event: &pb.WorkerUpcall_Agent{Agent: &pb.WorkerAgentUpcall{
			NodeId: fmt.Sprintf("node-%d", sequence),
			Kind:   pb.WorkerAgentUpcallKind_WORKER_AGENT_UPCALL_KIND_HOOK_TURN,
		}},
	}
}

// The Worker replays what it has not seen acknowledged, so after a crash the
// Host is handed frames it may already hold. It must record each once and still
// acknowledge the replay, or the Worker keeps it forever.
func TestAReplayedUpcallIsAcknowledgedButRecordedOnce(t *testing.T) {
	sink := &recordingSink{}
	p := newPeer(t, sink)
	p.sendUpcall(upcallFrame(1, 1))
	if reply := p.readReply(); reply.Disposition != pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_ACCEPTED || reply.AckSequence != 1 {
		t.Fatalf("first delivery was not accepted: %v", reply)
	}
	// The same frame again, as a Worker replay after a lost reply.
	p.sendUpcall(upcallFrame(1, 2))
	reply := p.readReply()
	if reply.Disposition != pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_DUPLICATE {
		t.Fatalf("a replay was not reported as a duplicate: %v", reply)
	}
	if reply.AckSequence != 1 {
		t.Fatalf("a duplicate did not carry an acknowledgement: %d", reply.AckSequence)
	}
	if got := sink.sequences(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("the subscriber saw the frame %d times", len(got))
	}
	if _, through := p.client.UpcallWindow(); through != 1 {
		t.Fatalf("window is %d", through)
	}
}

// The attempt count reaches the subscriber unchanged: it is evidence for an
// operator, never a reason to treat the report differently.
func TestTheAttemptCountReachesTheSubscriber(t *testing.T) {
	sink := &recordingSink{}
	p := newPeer(t, sink)
	p.sendUpcall(upcallFrame(1, 4))
	p.readReply()
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.delivered) != 1 || sink.delivered[0].Attempt != 4 {
		t.Fatalf("the attempt count did not survive delivery: %+v", sink.delivered)
	}
}

// A frame attributed to a different Worker would land in the wrong window, and
// one with no sequence cannot be deduplicated at all. Both are refused, and the
// connection survives so later reports still arrive.
func TestAMisattributedOrIdentitylessUpcallIsRejected(t *testing.T) {
	sink := &recordingSink{}
	p := newPeer(t, sink)
	for _, frame := range []*pb.WorkerUpcall{
		{RequestId: "w-1", WorkerInstanceId: strings.Repeat("c", 32), Sequence: 1, Event: upcallFrame(1, 1).Event},
		{RequestId: "w-1", WorkerInstanceId: fixtureInstance, Sequence: 0, Event: upcallFrame(1, 1).Event},
		{RequestId: "w-1", WorkerInstanceId: fixtureInstance, Sequence: 1},
		{RequestId: "h-1", WorkerInstanceId: fixtureInstance, Sequence: 1, Event: upcallFrame(1, 1).Event},
	} {
		p.sendUpcall(frame)
		if reply := p.readReply(); reply.Disposition != pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_REJECTED {
			t.Fatalf("a malformed upcall was not rejected: %v", reply)
		}
	}
	// The connection still works: a good frame after four bad ones is accepted.
	p.sendUpcall(upcallFrame(1, 1))
	if reply := p.readReply(); reply.Disposition != pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_ACCEPTED {
		t.Fatalf("the channel did not survive a rejection: %v", reply)
	}
	if len(sink.sequences()) != 1 {
		t.Fatal("a rejected frame reached the subscriber")
	}
}

// The two failure modes must not look alike. A sink that will never take a
// report says so and the Worker drops it; a sink that merely cannot take it now
// gets no reply, so the Worker keeps it and replays on the next connection.
func TestOnlyAnUnacceptableReportIsRejected(t *testing.T) {
	permanent := &recordingSink{refuse: fmt.Errorf("bad body: %w", ErrUpcallUnacceptable)}
	p := newPeer(t, permanent)
	p.sendUpcall(upcallFrame(1, 1))
	reply := p.readReply()
	if reply.Disposition != pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_REJECTED || reply.ReasonCode != "worker.upcall.refused" {
		t.Fatalf("an unacceptable report was not rejected: %v", reply)
	}

	transient := &recordingSink{refuse: errors.New("the store is busy")}
	q := newPeer(t, transient)
	q.sendUpcall(upcallFrame(1, 1))
	// No reply at all, and the pump ends so the Worker reconnects and replays.
	select {
	case <-q.client.pump.done:
	case <-time.After(2 * time.Second):
		t.Fatal("a transient failure did not end the connection")
	}
	if _, through := q.client.UpcallWindow(); through != 0 {
		t.Fatalf("a frame that was never stored was acknowledged: %d", through)
	}
}

// The bearer address comes from the Worker's own handshake and must name
// something inside the state directory the operator configured; anything else
// would let a Worker point the Host at a different process.
func TestTheBearerAddressMustBeInsideTheStateDirectory(t *testing.T) {
	state := t.TempDir()
	resolved, err := filepath.EvalSymlinks(state)
	if err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(resolved, "worker-upcall.sock")
	address, err := BearerAddress(&pb.WorkerChannelCapability{Socket: good}, state)
	if err != nil || address != good {
		t.Fatalf("a socket inside the state directory was refused: %v", err)
	}
	for _, record := range []*pb.WorkerChannelCapability{
		nil,
		{},
		{Socket: "relative.sock"},
		{Socket: filepath.Join(resolved, "nested", "worker-upcall.sock")},
		{Socket: filepath.Join(filepath.Dir(resolved), "elsewhere.sock")},
		{Pipe: `\\other\pipe\armadra`},
		{Pipe: `\\.\pipe\`},
		{Pipe: `\\.\pipe\a\b`},
	} {
		if _, err := BearerAddress(record, state); !errors.Is(err, ErrNoBearer) {
			t.Fatalf("an out-of-scope bearer was accepted: %v", record)
		}
	}
	// A pipe is namespace-scoped rather than directory-scoped.
	if address, err := BearerAddress(&pb.WorkerChannelCapability{Pipe: `\\.\pipe\armadra-worker-upcall-1`}, state); err != nil || address == "" {
		t.Fatalf("a well-formed pipe name was refused: %v", err)
	}
}
