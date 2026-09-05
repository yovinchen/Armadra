package worker

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"regexp"
	"runtime"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

var hostIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var rootIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
var knownRemote = map[string]bool{"INVALID_ARGUMENT": true, "PERMISSION_DENIED": true, "NOT_FOUND": true, "CONFLICT": true, "UNSUPPORTED": true, "INTERNAL": true, "TIMEOUT": true, "STALE_GENERATION": true, "RESOURCE_EXHAUSTED": true}

func validHello(hello *pb.WorkerHelloResponse, host, instance string) bool {
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	} // Rust std::env::consts::OS.
	if hello == nil || hello.Protocol == nil || hello.Protocol.Major != 1 || hello.Protocol.Minor != 0 || hello.HostId != host || hello.InstanceId != instance || !hostIDPattern.MatchString(instance) || hello.Platform != platform || (hello.Architecture != "x86_64" && hello.Architecture != "aarch64") || hello.MaxFrameBytes < 1024 || hello.MaxFrameBytes > MaxFrameBytes || hello.MaxFileChunkBytes == 0 || hello.MaxFileChunkBytes > MaxFileChunkBytes || hello.MaxFileChunkBytes+1024 > hello.MaxFrameBytes || hello.MaxTextFileBytes < hello.MaxFileChunkBytes || hello.MaxTextFileBytes > MaxTextFileBytes || len(hello.Capabilities) > 32 {
		return false
	}
	if commands := hello.Commands; commands != nil {
		expected := "unix-guardian-process-group"
		if runtime.GOOS == "windows" {
			expected = "windows-job"
		}
		if commands.Containment != expected {
			return false
		}
		if commands.MaxStdinBytes == 0 || commands.MaxStdinBytes > 256<<10 || commands.MaxOutputBytesPerStream == 0 || commands.MaxOutputBytesPerStream > 256<<10 || commands.MaxParallelOperations == 0 || commands.MaxParallelOperations > 64 || commands.MaxTimeoutMs == 0 || commands.MaxTimeoutMs > 86400000 || (commands.Containment != "unix-guardian-process-group" && commands.Containment != "windows-job") {
			return false
		}
	}
	caps := map[string]bool{}
	for _, capability := range hello.Capabilities {
		if len(capability) == 0 || len(capability) > 128 || caps[capability] {
			return false
		}
		caps[capability] = true
	}
	return caps["worker.roots.v1"] && caps["files.directory-read.v1"] && caps["files.text-read.v1"]
}
func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
func writeFrame(writer io.Writer, wire []byte, limit uint32) error {
	if len(wire) == 0 || len(wire) > int(limit) {
		return &Error{Code: CodeProtocol}
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(wire)))
	if err := writeAll(writer, prefix[:]); err != nil {
		return err
	}
	return writeAll(writer, wire)
}
func readFrame(reader io.Reader, limit uint32) ([]byte, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(prefix[:])
	if length == 0 || length > limit {
		return nil, &Error{Code: CodeProtocol}
	}
	wire := make([]byte, int(length))
	_, err := io.ReadFull(reader, wire)
	if errors.Is(err, io.EOF) {
		err = io.ErrUnexpectedEOF
	}
	return wire, err
}

// The generated decoder is authoritative for values. A narrow wire guard
// rejects groups (whose unknown-field decoder has a separate depth limit) and
// ambiguous response envelopes before decoding. Unknown ordinary fields remain
// forward-compatible, but a response must contain exactly one known result.
func validateWire(wire []byte, descriptor protoreflect.MessageDescriptor, depth int, envelope bool) error {
	if depth <= 0 {
		return &Error{Code: CodeProtocol}
	}
	resultCount := 0
	oneofs := map[protoreflect.FullName]bool{}
	seen := map[protowire.Number]bool{}
	for len(wire) > 0 {
		number, kind, n := protowire.ConsumeTag(wire)
		if n < 0 || !number.IsValid() || kind == protowire.StartGroupType || kind == protowire.EndGroupType {
			return &Error{Code: CodeProtocol}
		}
		wire = wire[n:]
		field := descriptor.Fields().ByNumber(number)
		if field != nil && field.ContainingOneof() != nil && !field.ContainingOneof().IsSynthetic() {
			name := field.ContainingOneof().FullName()
			if oneofs[name] {
				return &Error{Code: CodeProtocol}
			}
			oneofs[name] = true
		}
		// Envelope identity (1–3) and the result oneof: the file/hello members
		// (10–14), the command result (20), the agent result (21) and the write-ownership
		// answer (22). A number
		// outside this set leaves resultCount at zero and the frame is refused,
		// which is the point — a Worker cannot answer with a shape this build
		// has never been taught to check.
		if envelope && (number <= 3 || (number >= 10 && number <= 14) || number == 20 || number == 21 || number == 22) {
			if seen[number] || kind != protowire.BytesType {
				return &Error{Code: CodeProtocol}
			}
			seen[number] = true
			if number >= 10 {
				resultCount++
			}
		}
		if field != nil && field.Kind() == protoreflect.MessageKind && kind != protowire.BytesType {
			return &Error{Code: CodeProtocol}
		}
		if kind == protowire.BytesType {
			value, count := protowire.ConsumeBytes(wire)
			if count < 0 {
				return &Error{Code: CodeProtocol}
			}
			if field != nil && field.Kind() == protoreflect.MessageKind {
				if err := validateWire(value, field.Message(), depth-1, false); err != nil {
					return err
				}
			}
			wire = wire[count:]
		} else {
			count := protowire.ConsumeFieldValue(number, kind, wire)
			if count < 0 {
				return &Error{Code: CodeProtocol}
			}
			wire = wire[count:]
		}
	}
	if envelope && (resultCount != 1 || !seen[1] || !seen[2] || !seen[3]) {
		return &Error{Code: CodeProtocol}
	}
	return nil
}
func decodeResponse(wire []byte) (*pb.WorkerResponse, error) {
	response := new(pb.WorkerResponse)
	if err := validateWire(wire, response.ProtoReflect().Descriptor(), 32, true); err != nil {
		return nil, err
	}
	if err := (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(wire, response); err != nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return response, nil
}
func resultMatches(response *pb.WorkerResponse, kind string) bool {
	if response.GetError() != nil {
		return true
	}
	switch kind {
	case "command":
		return response.GetCommand() != nil
	case "agent":
		return response.GetAgent() != nil
	case "hello":
		return response.GetHello() != nil
	case "root":
		return response.GetRegisteredRoot() != nil
	case "directory":
		return response.GetDirectory() != nil
	case "chunk":
		return response.GetFileChunk() != nil
	case "ownership":
		return response.GetWriteOwnership() != nil
	}
	return false
}

// The gate's wait counts toward the request deadline. Cancelling any request
// conservatively closes this client's stream, including a queued request, so
// no caller can accidentally reuse an uncertain Worker incarnation.
func (c *Client) exchange(parent context.Context, request *pb.WorkerRequest, kind string) (*pb.WorkerResponse, error) {
	ctx, cancel := context.WithTimeout(parent, c.timeout)
	defer cancel()
	select {
	case <-ctx.Done():
		return nil, c.fail(contextError(ctx.Err()))
	case <-c.stopped:
		return nil, &Error{Code: CodeClosed}
	case <-c.gate:
	}
	defer func() { c.gate <- struct{}{} }()
	if err := ctx.Err(); err != nil {
		return nil, c.fail(contextError(err))
	}
	select {
	case <-c.stopped:
		return nil, &Error{Code: CodeClosed}
	default:
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, c.fail(&Error{Code: CodeTransport})
	}
	request.RequestId = hex.EncodeToString(random[:])
	request.HostId = c.hostID
	request.ExpectedInstanceId = c.instanceID
	deadline, _ := ctx.Deadline()
	request.DeadlineUnixMs = deadline.UnixMilli()
	wire, err := proto.Marshal(request)
	if err != nil {
		return nil, &Error{Code: CodeInvalid}
	}
	limit := uint32(MaxFrameBytes)
	if c.hello != nil {
		limit = c.hello.MaxFrameBytes
	}
	if len(wire) > int(limit) {
		return nil, &Error{Code: CodeInvalid}
	}
	// `received` is declared in channel.go, so the reader pump and this
	// goroutine hand back the same shape and either can answer a caller.
	result := make(chan received, 1)
	// With upcalls enabled the pipe is owned by the reader pump, because an
	// unsolicited frame may arrive between this write and its answer. Without
	// them this goroutine reads its own reply, exactly as it did before the
	// resident channel existed.
	if c.pump != nil {
		go func() {
			c.pump.writeMu.Lock()
			err := writeKindFrame(c.input, frameKindCall, wire, limit)
			c.pump.writeMu.Unlock()
			if err != nil {
				result <- received{err: err}
			}
		}()
	} else {
		go func() {
			if err := writeFrame(c.input, wire, limit); err != nil {
				result <- received{err: err}
				return
			}
			value, err := readFrame(c.output, limit)
			result <- received{wire: value, err: err}
		}()
	}
	var incoming received
	if c.pump != nil {
		// `result` carries only a write failure here; the answer comes from the
		// pump. `done` covers the case where the pump died with its error slot
		// already full, so a caller is never left waiting on a dead reader.
		select {
		case <-ctx.Done():
			return nil, c.fail(contextError(ctx.Err()))
		case <-c.stopped:
			return nil, &Error{Code: CodeClosed}
		case incoming = <-result:
		case incoming = <-c.pump.responses:
		case <-c.pump.done:
			return nil, c.fail(&Error{Code: CodeTransport})
		}
	} else {
		select {
		case <-ctx.Done():
			return nil, c.fail(contextError(ctx.Err()))
		case <-c.stopped:
			return nil, &Error{Code: CodeClosed}
		case incoming = <-result:
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, c.fail(contextError(err))
	}
	if incoming.err != nil {
		var protocol *Error
		if errors.As(incoming.err, &protocol) {
			return nil, c.fail(protocol)
		}
		if errors.Is(incoming.err, io.ErrUnexpectedEOF) {
			return nil, c.fail(&Error{Code: CodeProtocol})
		}
		return nil, c.fail(&Error{Code: CodeTransport})
	}
	response, err := decodeResponse(incoming.wire)
	if err != nil {
		return nil, c.fail(&Error{Code: CodeProtocol})
	}
	if response.RequestId != request.RequestId || response.HostId != c.hostID || !hostIDPattern.MatchString(response.InstanceId) || (c.instanceID != "" && response.InstanceId != c.instanceID) || !resultMatches(response, kind) {
		return nil, c.fail(&Error{Code: CodeProtocol})
	}
	if remote := response.GetError(); remote != nil {
		if remote.Code == "" {
			return nil, c.fail(&Error{Code: CodeProtocol})
		}
		code := remote.Code
		if !knownRemote[code] {
			code = "UNKNOWN"
		}
		if code == "TIMEOUT" {
			return nil, c.fail(&Error{Code: CodeTimeout, RemoteCode: code})
		}
		return nil, &Error{Code: CodeRemote, RemoteCode: code}
	}
	// Validate the complete payload before releasing the serialization gate.
	// A queued operation must never be dispatched after a malformed reply.
	if !c.validResult(request, response) {
		return nil, c.fail(&Error{Code: CodeProtocol})
	}
	return response, nil
}
