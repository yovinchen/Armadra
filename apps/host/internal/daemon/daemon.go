// Package daemon implements one-request local control connections. It is never
// registered on the HTTP/CORS surface; localipc owns the OS access boundary.
package daemon

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/localipc"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	MaxFrameBytes  = 1 << 20
	RequestTimeout = 3 * time.Second
	MaxConnections = 32
)

type ErrorCode string

const (
	CodeNotRunning      ErrorCode = "not_running"
	CodePermission      ErrorCode = "permission"
	CodeTimeout         ErrorCode = "timeout"
	CodeCancelled       ErrorCode = "cancelled"
	CodeMalformed       ErrorCode = "malformed"
	CodeTransport       ErrorCode = "transport"
	CodeRemote          ErrorCode = "remote"
	CodeStaleInstance   ErrorCode = "stale_instance"
	CodeInvalidArgument ErrorCode = "invalid_argument"
)

var ErrNotRunning = errors.New("host is not running")

// Error retains stable metadata, never the peer's free-form error text. A stop
// with OutcomeUnknown may already have executed and MUST NOT be retried blindly.
type Error struct {
	Code           ErrorCode
	RemoteCode     string
	OutcomeUnknown bool
}

func (e *Error) Error() string {
	if e.OutcomeUnknown {
		return "local host control: " + string(e.Code) + " (stop outcome unknown)"
	}
	return "local host control: " + string(e.Code)
}

func (e *Error) Is(target error) bool {
	return (target == ErrNotRunning && e.Code == CodeNotRunning) ||
		(target == context.Canceled && e.Code == CodeCancelled) ||
		(target == context.DeadlineExceeded && e.Code == CodeTimeout) ||
		(target == os.ErrPermission && e.Code == CodePermission)
}

func classify(ctx context.Context, err error) *Error {
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	if errors.Is(err, context.Canceled) {
		return &Error{Code: CodeCancelled}
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return &Error{Code: CodeTimeout}
	}
	if errors.Is(err, os.ErrPermission) {
		return &Error{Code: CodePermission}
	}
	if errors.Is(err, localipc.ErrNotRunning) {
		return &Error{Code: CodeNotRunning}
	}
	return &Error{Code: CodeTransport}
}

func readFrame(conn net.Conn) ([]byte, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(conn, prefix[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(prefix[:])
	if length > MaxFrameBytes {
		return nil, &Error{Code: CodeMalformed}
	}
	wire := make([]byte, int(length))
	_, err := io.ReadFull(conn, wire)
	// Once a length prefix was received, even zero payload bytes constitute a
	// truncated frame. Only EOF before any prefix byte is a clean transport close.
	if errors.Is(err, io.EOF) {
		err = io.ErrUnexpectedEOF
	}
	return wire, err
}

func writeFrame(conn net.Conn, message proto.Message) error {
	wire, err := proto.Marshal(message)
	if err != nil {
		return err
	}
	if len(wire) > MaxFrameBytes {
		return &Error{Code: CodeMalformed}
	}
	frame := make([]byte, 4+len(wire))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(wire)))
	copy(frame[4:], wire)
	for len(frame) > 0 {
		n, err := conn.Write(frame)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}

// The pinned Go decoder's RecursionLimit does not cover unknown wire groups:
// its unknown-field path instead uses protowire's fixed 10,000-level limit.
// This proto3 control contract has no groups, so reject them before decoding,
// including inside known messages. Unknown bytes remain opaque for compatibility.
// Scalars are consumed by the official wire helpers; no message is constructed
// here and the generated decoder remains authoritative for message semantics.
func validateControlWire(wire []byte, descriptor protoreflect.MessageDescriptor, depth int) error {
	if depth <= 0 {
		return &Error{Code: CodeMalformed}
	}
	for len(wire) > 0 {
		number, kind, tagBytes := protowire.ConsumeTag(wire)
		if tagBytes < 0 || !number.IsValid() || kind == protowire.StartGroupType || kind == protowire.EndGroupType {
			return &Error{Code: CodeMalformed}
		}
		wire = wire[tagBytes:]
		if kind == protowire.BytesType {
			value, count := protowire.ConsumeBytes(wire)
			if count < 0 {
				return &Error{Code: CodeMalformed}
			}
			field := descriptor.Fields().ByNumber(number)
			if field != nil && field.Kind() == protoreflect.MessageKind {
				if err := validateControlWire(value, field.Message(), depth-1); err != nil {
					return err
				}
			}
			wire = wire[count:]
		} else {
			count := protowire.ConsumeFieldValue(number, kind, wire)
			if count < 0 {
				return &Error{Code: CodeMalformed}
			}
			wire = wire[count:]
		}
	}
	return nil
}

func unmarshalControl(wire []byte, message proto.Message) error {
	if err := validateControlWire(wire, message.ProtoReflect().Descriptor(), 32); err != nil {
		return err
	}
	return (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(wire, message)
}

func validStatus(status *pb.HostStatus) bool {
	if status == nil || strings.TrimSpace(status.HostId) == "" || len(status.HostId) > 256 || strings.TrimSpace(status.HostInstanceId) == "" || len(status.HostInstanceId) > 256 || status.StartedAtUnixMs <= 0 {
		return false
	}
	endpoint, err := url.Parse(status.HttpEndpoint)
	return err == nil && (endpoint.Scheme == "http" || endpoint.Scheme == "https") && endpoint.Hostname() != "" && endpoint.User == nil && !endpoint.ForceQuery && endpoint.RawQuery == "" && endpoint.Fragment == ""
}

func errorResponse(id, code string) *pb.HostControlResponse {
	return &pb.HostControlResponse{RequestId: id, Result: &pb.HostControlResponse_Error{Error: &pb.ErrorResponse{Code: code, Message: "Local control request rejected."}}}
}

func handle(conn net.Conn, status *pb.HostStatus, shutdown func()) {
	handleWithBootstrap(context.Background(), conn, status, shutdown, nil)
}

// BootstrapHandler runs only after localipc has authenticated the OS peer.
// The callback must bind both expected Host identities and the exact origin.
type BootstrapHandler func(context.Context, *pb.BootstrapTicketRequest) (*pb.BootstrapTicketResponse, error)

func handleWithBootstrap(parent context.Context, conn net.Conn, status *pb.HostStatus, shutdown func(), bootstrap BootstrapHandler) {
	ctx, cancel := context.WithTimeout(parent, RequestTimeout)
	defer cancel()
	if err := conn.SetDeadline(time.Now().Add(RequestTimeout)); err != nil {
		return
	}
	wire, err := readFrame(conn)
	if err != nil {
		_ = writeFrame(conn, errorResponse("", "INVALID_ARGUMENT"))
		return
	}
	request := &pb.HostControlRequest{}
	if err := unmarshalControl(wire, request); err != nil {
		_ = writeFrame(conn, errorResponse("", "INVALID_ARGUMENT"))
		return
	}
	if strings.TrimSpace(request.RequestId) == "" || len(request.RequestId) > 256 {
		_ = writeFrame(conn, errorResponse("", "INVALID_ARGUMENT"))
		return
	}
	var response *pb.HostControlResponse
	stop := false
	switch action := request.Action.(type) {
	case *pb.HostControlRequest_Status:
		if action.Status == nil {
			response = errorResponse(request.RequestId, "INVALID_ARGUMENT")
			break
		}
		response = &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Status{Status: proto.Clone(status).(*pb.HostStatus)}}
	case *pb.HostControlRequest_Stop:
		if action.Stop == nil || strings.TrimSpace(action.Stop.ExpectedInstanceId) == "" {
			response = errorResponse(request.RequestId, "INVALID_ARGUMENT")
		} else if action.Stop.ExpectedInstanceId != status.HostInstanceId {
			response = errorResponse(request.RequestId, "CONFLICT")
		} else {
			response = &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Stopped{Stopped: &pb.HostStopResponse{Accepted: true}}}
			stop = true
		}
	case *pb.HostControlRequest_Bootstrap:
		if bootstrap == nil {
			response = errorResponse(request.RequestId, "UNSUPPORTED")
		} else if action.Bootstrap == nil || action.Bootstrap.ExpectedHostId != status.HostId || action.Bootstrap.ExpectedInstanceId != status.HostInstanceId {
			response = errorResponse(request.RequestId, "CONFLICT")
		} else {
			issued, issueErr := bootstrap(ctx, action.Bootstrap)
			if issueErr != nil || issued == nil {
				response = errorResponse(request.RequestId, "PERMISSION_DENIED")
			} else {
				response = &pb.HostControlResponse{RequestId: request.RequestId, Result: &pb.HostControlResponse_Bootstrap{Bootstrap: issued}}
			}
		}
	default:
		response = errorResponse(request.RequestId, "UNSUPPORTED")
	}
	// Queue the complete acknowledgement before requesting shutdown. This proves
	// acceptance, not completion of the host's other shutdown/drain operations.
	if err := writeFrame(conn, response); err == nil && stop {
		shutdown()
	}
}

// Serve owns listener and accepted connections until it returns. Cancellation
// closes both and waits for all handlers. shutdown must be non-blocking (e.g. a
// context.CancelFunc); it is invoked at most once, after a successful stop ACK.
// The caller must not mutate status while Serve is taking its initial snapshot.
func Serve(ctx context.Context, listener net.Listener, status *pb.HostStatus, shutdown func()) error {
	return ServeWithBootstrap(ctx, listener, status, shutdown, nil)
}

func ServeWithBootstrap(ctx context.Context, listener net.Listener, status *pb.HostStatus, shutdown func(), bootstrap BootstrapHandler) error {
	if !validStatus(status) || listener == nil || shutdown == nil {
		if listener != nil {
			_ = listener.Close()
		}
		return &Error{Code: CodeInvalidArgument}
	}
	snapshot := proto.Clone(status).(*pb.HostStatus)
	ctx, cancel := context.WithCancel(ctx)
	var mu sync.Mutex
	active := make(map[net.Conn]struct{})
	var handlers sync.WaitGroup
	var shutdownOnce sync.Once
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		<-ctx.Done()
		_ = listener.Close()
		mu.Lock()
		connections := make([]net.Conn, 0, len(active))
		for conn := range active {
			connections = append(connections, conn)
		}
		mu.Unlock()
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()
	defer func() { cancel(); <-closed; handlers.Wait() }()
	capacity := make(chan struct{}, MaxConnections)
	for {
		// Acquire before Accept to bound both goroutines and accepted connections.
		select {
		case capacity <- struct{}{}:
		case <-ctx.Done():
			return nil
		}
		conn, err := listener.Accept()
		if err != nil {
			<-capacity
			if ctx.Err() != nil {
				return nil
			}
			return classify(ctx, err)
		}
		mu.Lock()
		if ctx.Err() != nil {
			mu.Unlock()
			_ = conn.Close()
			<-capacity
			return nil
		}
		active[conn] = struct{}{}
		mu.Unlock()
		handlers.Add(1)
		go func() {
			defer handlers.Done()
			defer func() { _ = conn.Close(); mu.Lock(); delete(active, conn); mu.Unlock(); <-capacity }()
			handleWithBootstrap(ctx, conn, snapshot, func() { shutdownOnce.Do(shutdown) }, bootstrap)
		}()
	}
}

func exchange(ctx context.Context, dataDir string, action any, sideEffect bool) (*pb.HostControlResponse, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, &Error{Code: CodeTransport}
	}
	request := &pb.HostControlRequest{RequestId: hex.EncodeToString(random[:])}
	switch value := action.(type) {
	case *pb.HostStatusRequest:
		request.Action = &pb.HostControlRequest_Status{Status: value}
	case *pb.HostStopRequest:
		request.Action = &pb.HostControlRequest_Stop{Stop: value}
	case *pb.BootstrapTicketRequest:
		request.Action = &pb.HostControlRequest_Bootstrap{Bootstrap: value}
	default:
		return nil, &Error{Code: CodeInvalidArgument}
	}
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	conn, err := localipc.Dial(ctx, dataDir)
	if err != nil {
		return nil, classify(ctx, err)
	}
	defer conn.Close()
	// Cancel must interrupt blocking reads even when a caller has no deadline.
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancel()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, classify(ctx, err)
	}
	if ctx.Err() != nil {
		return nil, classify(ctx, ctx.Err())
	}
	if err := writeFrame(conn, request); err != nil {
		failure := classify(ctx, err)
		failure.OutcomeUnknown = sideEffect
		return nil, failure
	}
	wire, err := readFrame(conn)
	if err != nil {
		var failure *Error
		if errors.As(err, &failure) || errors.Is(err, io.ErrUnexpectedEOF) {
			failure = &Error{Code: CodeMalformed}
		} else {
			failure = classify(ctx, err)
		}
		if ctx.Err() != nil {
			failure = classify(ctx, ctx.Err())
		}
		failure.OutcomeUnknown = sideEffect
		return nil, failure
	}
	response := &pb.HostControlResponse{}
	if err := unmarshalControl(wire, response); err != nil || response.RequestId != request.RequestId {
		return nil, &Error{Code: CodeMalformed, OutcomeUnknown: sideEffect}
	}
	if remote := response.GetError(); remote != nil {
		if strings.TrimSpace(remote.Code) == "" {
			return nil, &Error{Code: CodeMalformed, OutcomeUnknown: sideEffect}
		}
		code := remote.Code
		switch code {
		case "INVALID_ARGUMENT", "CONFLICT", "UNSUPPORTED", "RESOURCE_EXHAUSTED", "PERMISSION_DENIED", "UNAUTHENTICATED", "INTERNAL":
		default:
			code = "UNKNOWN"
		}
		failure := &Error{Code: CodeRemote, RemoteCode: code}
		if sideEffect && code == "CONFLICT" {
			failure.Code = CodeStaleInstance
		}
		return nil, failure
	}
	return response, nil
}

// Bootstrap requests a short-lived ticket for exactly the observed Host and
// client origin. It never retries an uncertain request and never logs secrets.
func Bootstrap(ctx context.Context, dataDir string, request *pb.BootstrapTicketRequest) (*pb.BootstrapTicketResponse, error) {
	if request == nil || request.ExpectedHostId == "" || request.ExpectedInstanceId == "" || request.Origin == "" || request.DeviceName == "" {
		return nil, &Error{Code: CodeInvalidArgument}
	}
	response, err := exchange(ctx, dataDir, request, true)
	if err != nil {
		return nil, err
	}
	ticket := response.GetBootstrap()
	if ticket == nil || ticket.HostId != request.ExpectedHostId || ticket.HostInstanceId != request.ExpectedInstanceId || ticket.Origin != request.Origin || ticket.Ticket == "" || ticket.ExpiresAtUnixMs <= time.Now().UnixMilli() {
		return nil, &Error{Code: CodeMalformed, OutcomeUnknown: true}
	}
	return proto.Clone(ticket).(*pb.BootstrapTicketResponse), nil
}

// Status performs one local, read-only exchange and never retries.
func Status(ctx context.Context, dataDir string) (*pb.HostStatus, error) {
	response, err := exchange(ctx, dataDir, &pb.HostStatusRequest{}, false)
	if err != nil {
		return nil, err
	}
	status := response.GetStatus()
	if !validStatus(status) {
		return nil, &Error{Code: CodeMalformed}
	}
	return proto.Clone(status).(*pb.HostStatus), nil
}

// Stop requests shutdown of exactly the observed process instance. It never
// retries, including when a missing acknowledgement makes the outcome unknown.
func Stop(ctx context.Context, dataDir, expectedInstanceID string) error {
	if strings.TrimSpace(expectedInstanceID) == "" || len(expectedInstanceID) > 256 {
		return &Error{Code: CodeInvalidArgument}
	}
	response, err := exchange(ctx, dataDir, &pb.HostStopRequest{ExpectedInstanceId: expectedInstanceID}, true)
	if err != nil {
		return err
	}
	if stopped := response.GetStopped(); stopped == nil || !stopped.Accepted {
		return &Error{Code: CodeMalformed, OutcomeUnknown: true}
	}
	return nil
}
