package daemon

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/localipc"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/types/descriptorpb"
)

func testStatus() *pb.HostStatus {
	return &pb.HostStatus{HostId: "host-identity", HostInstanceId: "process-instance", HttpEndpoint: "http://127.0.0.1:43121", StartedAtUnixMs: 1780000000000}
}

// Short directory names also exercise real Unix sockets on macOS, whose socket
// paths have a smaller limit than Linux paths.
func testDir(t *testing.T) string {
	t.Helper()
	base := os.TempDir()
	if _, err := os.Stat("/tmp"); err == nil {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "armadra-daemon-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

type testServer struct {
	dir    string
	cancel context.CancelFunc
	done   chan struct{}
	stops  atomic.Int32
}

func startServer(t *testing.T, status *pb.HostStatus) *testServer {
	t.Helper()
	s := &testServer{dir: testDir(t), done: make(chan struct{})}
	listener, err := localipc.Listen(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	var serveErr error
	go func() {
		serveErr = Serve(ctx, listener, status, func() { s.stops.Add(1); cancel() })
		close(s.done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-s.done:
			if serveErr != nil {
				t.Errorf("Serve: %v", serveErr)
			}
		case <-time.After(time.Second):
			t.Error("Serve did not release local connections on cancellation")
		}
	})
	return s
}

func connect(t *testing.T, dir string) net.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := localipc.Dial(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func rawRequest(t *testing.T, dir string, request *pb.HostControlRequest) *pb.HostControlResponse {
	t.Helper()
	conn := connect(t, dir)
	defer conn.Close()
	if err := writeFrame(conn, request); err != nil {
		t.Fatal(err)
	}
	wire, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	response := &pb.HostControlResponse{}
	if err := proto.Unmarshal(wire, response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestLocalStatusAndImmutableSnapshot(t *testing.T) {
	initial := testStatus()
	s := startServer(t, initial)
	first, err := Status(context.Background(), s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(first, initial) {
		t.Fatalf("unexpected status: %v", first)
	}
	initial.HostId = "caller-mutated"
	first.HostId = "response-mutated"
	second, err := Status(context.Background(), s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if second.HostId != "host-identity" {
		t.Fatal("status shares mutable caller or response state")
	}
	if s.stops.Load() != 0 {
		t.Fatal("read-only status triggered shutdown")
	}
}

func TestStaleStopRejectedAndMatchingStopAcknowledged(t *testing.T) {
	s := startServer(t, testStatus())
	err := Stop(context.Background(), s.dir, "previous-instance")
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeStaleInstance || failure.OutcomeUnknown {
		t.Fatalf("expected explicit stale-instance rejection, got %v", err)
	}
	if s.stops.Load() != 0 {
		t.Fatal("stale stop invoked shutdown")
	}
	if _, err := Status(context.Background(), s.dir); err != nil {
		t.Fatal("stale stop stopped service", err)
	}
	if err := Stop(context.Background(), s.dir, testStatus().HostInstanceId); err != nil {
		t.Fatal("complete stop acknowledgement not received", err)
	}
	select {
	case <-s.done:
	case <-time.After(time.Second):
		t.Fatal("accepted stop did not stop server")
	}
	if s.stops.Load() != 1 {
		t.Fatal("shutdown callback count differs from one")
	}
}

func TestInvalidRequestEnvelopes(t *testing.T) {
	s := startServer(t, testStatus())
	unknown := &pb.HostControlRequest{RequestId: "unknown"}
	unknown.ProtoReflect().SetUnknown(protowire.AppendBytes(protowire.AppendTag(nil, 99, protowire.BytesType), []byte("future")))
	for name, request := range map[string]*pb.HostControlRequest{
		"unknown action":    unknown,
		"empty action":      {RequestId: "empty"},
		"missing id":        {Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}},
		"whitespace id":     {RequestId: "  ", Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}},
		"oversized id":      {RequestId: strings.Repeat("x", 257), Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}},
		"empty stop target": {RequestId: "stop", Action: &pb.HostControlRequest_Stop{Stop: &pb.HostStopRequest{}}},
	} {
		t.Run(name, func(t *testing.T) {
			response := rawRequest(t, s.dir, request)
			if response.GetError() == nil {
				t.Fatal("invalid request accepted")
			}
		})
	}
	if s.stops.Load() != 0 {
		t.Fatal("invalid envelope stopped service")
	}
	if err := Stop(context.Background(), s.dir, " "); err == nil {
		t.Fatal("client accepted empty stop instance")
	}
}

func TestOversizedMalformedAndTruncatedFrames(t *testing.T) {
	s := startServer(t, testStatus())
	for name, payload := range map[string][]byte{
		"oversized":          {0, 16, 0, 1},
		"malformed protobuf": {0, 0, 0, 2, 10, 255},
		"empty frame":        {0, 0, 0, 0},
	} {
		t.Run(name, func(t *testing.T) {
			conn := connect(t, s.dir)
			if _, err := conn.Write(payload); err != nil {
				t.Fatal(err)
			}
			wire, err := readFrame(conn)
			if err != nil {
				t.Fatal(err)
			}
			response := &pb.HostControlResponse{}
			if err := proto.Unmarshal(wire, response); err != nil || response.GetError() == nil {
				t.Fatal("bad frame not rejected", err)
			}
			_ = conn.Close()
		})
	}
	for _, partial := range [][]byte{{0, 0}, {0, 0, 0, 9, 10}} {
		conn := connect(t, s.dir)
		_, _ = conn.Write(partial)
		_ = conn.Close()
	}
	if _, err := Status(context.Background(), s.dir); err != nil {
		t.Fatal("service unhealthy after partial requests", err)
	}
}

func TestSingleRequestPerConnection(t *testing.T) {
	s := startServer(t, testStatus())
	conn := connect(t, s.dir)
	request := &pb.HostControlRequest{RequestId: "one", Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}}
	if err := writeFrame(conn, request); err != nil {
		t.Fatal(err)
	}
	if _, err := readFrame(conn); err != nil {
		t.Fatal(err)
	}
	var byte [1]byte
	if _, err := conn.Read(byte[:]); !errors.Is(err, io.EOF) {
		t.Fatalf("connection kept alive after its response: %v", err)
	}
}

func TestCancellationReleasesSlowClientsAtCapacity(t *testing.T) {
	s := startServer(t, testStatus())
	for i := 0; i < MaxConnections; i++ {
		conn := connect(t, s.dir)
		if _, err := conn.Write([]byte{0}); err != nil {
			t.Fatal(err)
		}
	}
	s.cancel()
	select {
	case <-s.done:
	case <-time.After(time.Second):
		t.Fatal("Serve blocked on partial clients or capacity semaphore")
	}
}

func TestSlowClientReadDeadline(t *testing.T) {
	s := startServer(t, testStatus())
	conn := connect(t, s.dir)
	if err := conn.SetDeadline(time.Now().Add(RequestTimeout + time.Second)); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := conn.Write([]byte{0}); err != nil {
		t.Fatal(err)
	}
	var buffer [1]byte
	if _, err := conn.Read(buffer[:]); !errors.Is(err, io.EOF) {
		t.Fatalf("expected server to release idle client before client deadline: %v", err)
	}
	if time.Since(started) > RequestTimeout+time.Second {
		t.Fatal("server read deadline was not enforced")
	}
	if _, err := Status(context.Background(), s.dir); err != nil {
		t.Fatal("idle client made service unhealthy", err)
	}
}

func TestErrorClassification(t *testing.T) {
	if _, err := Status(context.Background(), testDir(t)); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("absent endpoint should be not running: %v", err)
	}
	for _, test := range []struct {
		err  error
		code ErrorCode
	}{
		{os.ErrPermission, CodePermission},
		{context.DeadlineExceeded, CodeTimeout},
		{context.Canceled, CodeCancelled},
		{io.ErrUnexpectedEOF, CodeTransport},
		{errors.New("unknown transport failure"), CodeTransport},
	} {
		failure := classify(context.Background(), test.err)
		if failure.Code != test.code || errors.Is(failure, ErrNotRunning) {
			t.Fatalf("misclassified %v as %v", test.err, failure)
		}
	}
}

// fakePeer uses real localipc sockets and substitutes only the peer's protocol
// behavior, so client tests still exercise OS transport, deadlines, and framing.
func fakePeer(t *testing.T, respond func(net.Conn, *pb.HostControlRequest)) string {
	t.Helper()
	dir := testDir(t)
	listener, err := localipc.Listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		wire, err := readFrame(conn)
		if err != nil {
			return
		}
		request := &pb.HostControlRequest{}
		if proto.Unmarshal(wire, request) != nil {
			return
		}
		respond(conn, request)
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("fake peer did not exit")
		}
	})
	return dir
}

func TestClientRejectsWrongIDsVariantsAndMissingFields(t *testing.T) {
	for name, response := range map[string]*pb.HostControlResponse{
		"wrong id":           {RequestId: "another-request", Result: &pb.HostControlResponse_Status{Status: testStatus()}},
		"wrong variant":      {Result: &pb.HostControlResponse_Stopped{Stopped: &pb.HostStopResponse{Accepted: true}}},
		"empty result":       {},
		"empty status":       {Result: &pb.HostControlResponse_Status{Status: &pb.HostStatus{}}},
		"missing error code": {Result: &pb.HostControlResponse_Error{Error: &pb.ErrorResponse{Message: "secret"}}},
	} {
		t.Run(name, func(t *testing.T) {
			dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
				if response.RequestId == "" {
					response.RequestId = request.RequestId
				}
				_ = writeFrame(conn, response)
			})
			_, err := Status(context.Background(), dir)
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != CodeMalformed {
				t.Fatalf("invalid response not rejected: %v", err)
			}
		})
	}
}

func TestClientRejectsOversizedAndTruncatedResponses(t *testing.T) {
	for name, wire := range map[string][]byte{
		"oversized":        {0, 16, 0, 1},
		"partial length":   {0, 0},
		"partial body":     {0, 0, 0, 9, 10},
		"invalid protobuf": {0, 0, 0, 2, 10, 255},
	} {
		t.Run(name, func(t *testing.T) {
			dir := fakePeer(t, func(conn net.Conn, _ *pb.HostControlRequest) { _, _ = conn.Write(wire) })
			_, err := Status(context.Background(), dir)
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != CodeMalformed || errors.Is(err, ErrNotRunning) {
				t.Fatalf("unexpected malformed response classification: %v", err)
			}
		})
	}
}

func TestResponseEOFClassification(t *testing.T) {
	for _, test := range []struct {
		name string
		wire []byte
		code ErrorCode
	}{
		{name: "no prefix bytes", code: CodeTransport},
		{name: "partial prefix", wire: []byte{0, 0}, code: CodeMalformed},
		{name: "full prefix without body", wire: []byte{0, 0, 0, 9}, code: CodeMalformed},
	} {
		for _, stop := range []bool{false, true} {
			operation := "status"
			if stop {
				operation = "stop"
			}
			t.Run(test.name+"/"+operation, func(t *testing.T) {
				dir := fakePeer(t, func(conn net.Conn, _ *pb.HostControlRequest) {
					if len(test.wire) > 0 {
						_, _ = conn.Write(test.wire)
					}
				})
				var err error
				if stop {
					err = Stop(context.Background(), dir, "instance")
				} else {
					_, err = Status(context.Background(), dir)
				}
				var failure *Error
				if !errors.As(err, &failure) || failure.Code != test.code || failure.OutcomeUnknown != stop || errors.Is(err, ErrNotRunning) {
					t.Fatalf("incorrect EOF classification: %v", err)
				}
			})
		}
	}
}

func TestClientDeadlineAndCancellationInterruptRead(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			received := make(chan struct{})
			dir := fakePeer(t, func(conn net.Conn, _ *pb.HostControlRequest) {
				close(received)
				var buf [1]byte
				_, _ = conn.Read(buf[:])
			})
			ctx, cancel := context.WithCancel(context.Background())
			if deadline {
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			}
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := Status(ctx, dir); result <- err }()
			select {
			case <-received:
			case <-time.After(time.Second):
				t.Fatal("client never reached local peer")
			}
			if !deadline {
				cancel()
			}
			select {
			case err := <-result:
				want := context.Canceled
				if deadline {
					want = context.DeadlineExceeded
				}
				if !errors.Is(err, want) || errors.Is(err, ErrNotRunning) {
					t.Fatalf("wrong context failure: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("client read did not stop")
			}
		})
	}
}

func TestStopRequiresAcceptedVariantAndNeverRetries(t *testing.T) {
	for name, payload := range map[string]interface{}{
		"not accepted":   &pb.HostControlResponse_Stopped{Stopped: &pb.HostStopResponse{}},
		"status instead": &pb.HostControlResponse_Status{Status: testStatus()},
	} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
				calls.Add(1)
				response := &pb.HostControlResponse{RequestId: request.RequestId}
				switch value := payload.(type) {
				case *pb.HostControlResponse_Stopped:
					response.Result = value
				case *pb.HostControlResponse_Status:
					response.Result = value
				}
				_ = writeFrame(conn, response)
			})
			err := Stop(context.Background(), dir, "instance")
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != CodeMalformed || !failure.OutcomeUnknown || calls.Load() != 1 {
				t.Fatalf("unexpected stop result: %v (%d calls)", err, calls.Load())
			}
		})
	}
}

func TestRemoteErrorDoesNotExposePeerText(t *testing.T) {
	dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
		_ = writeFrame(conn, &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Error{Error: &pb.ErrorResponse{Code: "token-secret", Message: "peer-secret"}}})
	})
	_, err := Status(context.Background(), dir)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeRemote || failure.RemoteCode != "UNKNOWN" || strings.Contains(err.Error(), "secret") || errors.Is(err, ErrNotRunning) {
		t.Fatalf("remote error not sanitized: %v", err)
	}
}

func nestedUnknownGroups(depth int) []byte {
	var wire []byte
	for range depth {
		wire = protowire.AppendTag(wire, 99, protowire.StartGroupType)
	}
	for range depth {
		wire = protowire.AppendTag(wire, 99, protowire.EndGroupType)
	}
	return wire
}

func TestDeepUnknownGroupRequestRejected(t *testing.T) {
	s := startServer(t, testStatus())
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "root", true: "known message"}[nested], func(t *testing.T) {
			request := &pb.HostControlRequest{RequestId: "nested", Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}}
			if nested {
				request.GetStatus().ProtoReflect().SetUnknown(nestedUnknownGroups(64))
			} else {
				request.ProtoReflect().SetUnknown(nestedUnknownGroups(64))
			}
			if proto.Size(request) > MaxFrameBytes {
				t.Fatal("depth test exceeds the frame budget")
			}
			response := rawRequest(t, s.dir, request)
			if response.GetError() == nil {
				t.Fatal("unknown groups nested beyond 32 accepted")
			}
		})
	}
}

func TestDeepUnknownGroupResponseRejected(t *testing.T) {
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "root", true: "known message"}[nested], func(t *testing.T) {
			dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
				response := &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Status{Status: testStatus()}}
				if nested {
					response.GetStatus().ProtoReflect().SetUnknown(nestedUnknownGroups(64))
				} else {
					response.ProtoReflect().SetUnknown(nestedUnknownGroups(64))
				}
				_ = writeFrame(conn, response)
			})
			_, err := Status(context.Background(), dir)
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != CodeMalformed {
				t.Fatalf("deep unknown response groups not rejected: %v", err)
			}
		})
	}
}

func TestUnknownBytesWithGroupLikeContentsRemainOpaque(t *testing.T) {
	opaque := protowire.AppendBytes(protowire.AppendTag(nil, 99, protowire.BytesType), nestedUnknownGroups(64))
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "root", true: "known message"}[nested], func(t *testing.T) {
			s := startServer(t, testStatus())
			request := &pb.HostControlRequest{RequestId: "opaque", Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}}
			if nested {
				request.GetStatus().ProtoReflect().SetUnknown(opaque)
			} else {
				request.ProtoReflect().SetUnknown(opaque)
			}
			if response := rawRequest(t, s.dir, request); response.GetStatus() == nil {
				t.Fatal("opaque unknown request bytes rejected")
			}
			dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
				response := &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Status{Status: testStatus()}}
				if nested {
					response.GetStatus().ProtoReflect().SetUnknown(opaque)
				} else {
					response.ProtoReflect().SetUnknown(opaque)
				}
				_ = writeFrame(conn, response)
			})
			status, err := Status(context.Background(), dir)
			if err != nil {
				t.Fatal("opaque unknown response bytes rejected", err)
			}
			if nested && !bytes.Equal(status.ProtoReflect().GetUnknown(), opaque) {
				t.Fatal("unknown bytes were changed")
			}
		})
	}
}

func TestKnownMessagePreflightDepthLimit(t *testing.T) {
	// The present control schema is acyclic. A recursive descriptor fixture
	// verifies the depth budget without adding a production protocol message.
	file, err := protodesc.NewFile(&descriptorpb.FileDescriptorProto{
		Name: proto.String("depth_test.proto"), Package: proto.String("depth"), Syntax: proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{{Name: proto.String("Node"), Field: []*descriptorpb.FieldDescriptorProto{{
			Name: proto.String("child"), Number: proto.Int32(1), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(), Type: descriptorpb.FieldDescriptorProto_TYPE_MESSAGE.Enum(), TypeName: proto.String(".depth.Node"),
		}}}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := file.Messages().Get(0)
	var wire []byte
	for range 31 {
		wire = protowire.AppendBytes(protowire.AppendTag(nil, 1, protowire.BytesType), wire)
	}
	if err := validateControlWire(wire, descriptor, 32); err != nil {
		t.Fatal("valid 32-message depth rejected", err)
	}
	wire = protowire.AppendBytes(protowire.AppendTag(nil, 1, protowire.BytesType), wire)
	if err := validateControlWire(wire, descriptor, 32); err == nil {
		t.Fatal("known message nesting exceeded the depth budget")
	}
}

func TestClientValidatesEachStatusField(t *testing.T) {
	for name, mutate := range map[string]func(*pb.HostStatus){
		"host ID":              func(status *pb.HostStatus) { status.HostId = "" },
		"instance ID":          func(status *pb.HostStatus) { status.HostInstanceId = " " },
		"endpoint scheme":      func(status *pb.HostStatus) { status.HttpEndpoint = "ftp://127.0.0.1" },
		"endpoint host":        func(status *pb.HostStatus) { status.HttpEndpoint = "http://" },
		"endpoint credentials": func(status *pb.HostStatus) { status.HttpEndpoint = "http://user:secret@127.0.0.1" },
		"endpoint query":       func(status *pb.HostStatus) { status.HttpEndpoint = "http://127.0.0.1?token=secret" },
		"start time":           func(status *pb.HostStatus) { status.StartedAtUnixMs = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			status := testStatus()
			mutate(status)
			dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
				_ = writeFrame(conn, &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Status{Status: status}})
			})
			_, err := Status(context.Background(), dir)
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != CodeMalformed {
				t.Fatalf("invalid field accepted: %v", err)
			}
		})
	}
}

// A Host with no --listen address has no HTTP surface to report. The empty
// endpoint is the one way to say that, and it must survive the status round
// trip rather than being rejected as malformed or filled in with a default.
func TestAControlOnlyHostReportsAnEmptyEndpoint(t *testing.T) {
	status := testStatus()
	status.HttpEndpoint = ""
	dir := fakePeer(t, func(conn net.Conn, request *pb.HostControlRequest) {
		_ = writeFrame(conn, &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Status{Status: status}})
	})
	reported, err := Status(context.Background(), dir)
	if err != nil {
		t.Fatalf("a control-only Host was rejected: %v", err)
	}
	if reported.HttpEndpoint != "" {
		t.Fatalf("http endpoint = %q, want empty", reported.HttpEndpoint)
	}
	if reported.HostId != status.HostId || reported.HostInstanceId != status.HostInstanceId {
		t.Fatalf("identity was not carried through: %+v", reported)
	}
}

func TestStopLostAckIsUnknownOutcome(t *testing.T) {
	dir := fakePeer(t, func(conn net.Conn, _ *pb.HostControlRequest) { _ = conn.Close() })
	err := Stop(context.Background(), dir, "instance")
	var failure *Error
	if !errors.As(err, &failure) || !failure.OutcomeUnknown || errors.Is(err, ErrNotRunning) {
		t.Fatalf("lost acknowledgement misreported: %v", err)
	}
}

func TestShutdownNotCalledWhenAckWriteFails(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	var calls atomic.Int32
	done := make(chan struct{})
	go func() { handle(server, testStatus(), func() { calls.Add(1) }); close(done) }()
	if err := writeFrame(client, &pb.HostControlRequest{RequestId: "stop", Action: &pb.HostControlRequest_Stop{Stop: &pb.HostStopRequest{ExpectedInstanceId: testStatus().HostInstanceId}}}); err != nil {
		t.Fatal(err)
	}
	// No reader consumes the ack on net.Pipe, so this close guarantees its write
	// fails rather than merely racing a buffered socket acknowledgement.
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("failed ack write did not exit")
	}
	if calls.Load() != 0 {
		t.Fatal("shutdown called despite failed acknowledgement")
	}
}

func TestFrameBoundaryAndShortWrites(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	message := &pb.ErrorResponse{Message: strings.Repeat("a", MaxFrameBytes-4)}
	wire, _ := proto.Marshal(message)
	if len(wire) != MaxFrameBytes {
		t.Fatal("test fixture is not at frame limit")
	}
	done := make(chan error, 1)
	go func() { done <- writeFrame(left, message) }()
	got, err := readFrame(right)
	if err != nil || !bytes.Equal(got, wire) {
		t.Fatal("exact frame limit rejected", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	message.Message += "a"
	if err := writeFrame(left, message); err == nil {
		t.Fatal("outbound frame limit not enforced")
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], MaxFrameBytes+1)
	go func() { _, _ = left.Write(prefix[:]) }()
	if _, err := readFrame(right); err == nil {
		t.Fatal("inbound frame limit not enforced")
	}
	shortMessage := &pb.ErrorResponse{Code: "INVALID_ARGUMENT", Message: "test"}
	go func() { done <- writeFrame(shortWriter{left}, shortMessage) }()
	shortWire, err := readFrame(right)
	if err != nil {
		t.Fatal(err)
	}
	expected, _ := proto.Marshal(shortMessage)
	if !bytes.Equal(shortWire, expected) {
		t.Fatal("short write lost frame bytes")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type shortWriter struct{ net.Conn }

func (writer shortWriter) Write(data []byte) (int, error) {
	if len(data) > 3 {
		data = data[:3]
	}
	return writer.Conn.Write(data)
}
