// Package worker controls a parent-owned, read-only Rust Worker over anonymous
// pipes. It opens no HTTP listener, creates no PTY and never invokes a shell.
package worker

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	MaxFrameBytes         = 1 << 20
	MaxFileChunkBytes     = 256 << 10
	MaxTextFileBytes      = 1 << 20
	MaxDiagnosticBytes    = 32 << 10
	DefaultRequestTimeout = 10 * time.Second
	CloseTimeout          = 3 * time.Second
)

type Code string

const (
	CodeInvalid     Code = "invalid_options"
	CodeUnsupported Code = "unsupported"
	CodeStart       Code = "start_failed"
	CodeClosed      Code = "closed"
	CodeTransport   Code = "transport"
	CodeProtocol    Code = "protocol"
	CodeTimeout     Code = "timeout"
	CodeCancelled   Code = "cancelled"
	CodeRemote      Code = "remote"
	CodeCleanup     Code = "cleanup_failed"
)

// Error never embeds executable paths, file names, raw stderr or peer messages.
// No operation is retried automatically, even when only Worker memory changed.
type Error struct {
	Code          Code
	RemoteCode    string
	CleanupFailed bool
}

func (e *Error) Error() string {
	if e.CleanupFailed {
		return "Worker request failed (" + string(e.Code) + "; child cleanup incomplete)"
	}
	return "Worker request failed (" + string(e.Code) + ")"
}
func (e *Error) Is(target error) bool {
	return target == context.Canceled && e.Code == CodeCancelled || target == context.DeadlineExceeded && e.Code == CodeTimeout
}

type Options struct {
	Executable, HostID string
	// StateDir opts into durable NEW non-interactive command sessions. It must already exist and be private.
	StateDir       string
	RequestTimeout time.Duration
}
type Diagnostics struct {
	BufferedBytes int
	Truncated     bool
}
type boundedDiagnostics struct {
	mu        sync.Mutex
	tail      []byte
	truncated bool
}

func (b *boundedDiagnostics) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(data)
	if b.tail == nil {
		b.tail = make([]byte, 0, MaxDiagnosticBytes)
	}
	if n >= MaxDiagnosticBytes {
		b.truncated = b.truncated || len(b.tail) > 0 || n > MaxDiagnosticBytes
		b.tail = append(b.tail[:0], data[n-MaxDiagnosticBytes:]...)
		return n, nil
	}
	if len(b.tail)+n > MaxDiagnosticBytes {
		b.truncated = true
		copy(b.tail, b.tail[len(b.tail)+n-MaxDiagnosticBytes:])
		b.tail = b.tail[:MaxDiagnosticBytes-n]
	}
	b.tail = append(b.tail, data...)
	return n, nil
}
func (b *boundedDiagnostics) summary() Diagnostics {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Diagnostics{BufferedBytes: len(b.tail), Truncated: b.truncated}
}

type Client struct {
	cmd                *exec.Cmd
	input              *os.File
	output             *os.File
	stderr             *os.File
	diagnostic         boundedDiagnostics
	stderrDone         chan struct{}
	stopped            chan struct{}
	reaped             chan struct{}
	stopOnce           sync.Once
	gate               chan struct{}
	hostID, instanceID string
	timeout            time.Duration
	hello              *pb.WorkerHelloResponse
	containment        containment
	commandMode        bool
	cleanupConfirmed   atomic.Bool
	containmentClosed  atomic.Bool
	closeMu            sync.Mutex
	reapMu             sync.Mutex
}

func (*Client) String() string   { return "WorkerClient{redacted}" }
func (*Client) GoString() string { return "WorkerClient{redacted}" }

// nativeExecutable rejects PATH lookups, directories and interpreter scripts.
// Absolute symlinks are resolved once; the caller must select a trusted binary.
// The OS loader remains responsible for architecture/ABI compatibility.
func nativeExecutable(path string) (string, error) {
	if !filepath.IsAbs(path) || strings.IndexByte(path, 0) >= 0 {
		return "", &Error{Code: CodeInvalid}
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", &Error{Code: CodeStart}
	}
	file, err := os.Open(resolved)
	if err != nil {
		return "", &Error{Code: CodeStart}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", &Error{Code: CodeInvalid}
	}
	var magic [4]byte
	if _, err = io.ReadFull(file, magic[:]); err != nil {
		return "", &Error{Code: CodeInvalid}
	}
	valid := false
	switch runtime.GOOS {
	case "darwin":
		switch binary.BigEndian.Uint32(magic[:]) {
		case 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca:
			valid = true
		}
	case "linux":
		valid = magic == [4]byte{0x7f, 'E', 'L', 'F'}
	case "windows":
		valid = magic[0] == 'M' && magic[1] == 'Z' && strings.EqualFold(filepath.Ext(resolved), ".exe")
	default:
		return "", &Error{Code: CodeUnsupported}
	}
	if !valid || (runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0) {
		return "", &Error{Code: CodeInvalid}
	}
	return resolved, nil
}

// Start's context governs only validation/handshake. A successful Client owns
// its child until Close or a failed request; cancelling the startup context
// afterwards cannot kill a Worker serving a different UI request.
func Start(ctx context.Context, options Options) (*Client, error) {
	if !hostIDPattern.MatchString(options.HostID) {
		return nil, &Error{Code: CodeInvalid}
	}
	timeout := options.RequestTimeout
	if timeout == 0 {
		timeout = DefaultRequestTimeout
	}
	if timeout < time.Millisecond || timeout > time.Minute {
		return nil, &Error{Code: CodeInvalid}
	}
	if err := ctx.Err(); err != nil {
		return nil, contextError(err)
	}
	executable, err := nativeExecutable(options.Executable)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, contextError(err)
	}
	if options.StateDir != "" {
		if !filepath.IsAbs(options.StateDir) || storage.ProtectArtifactDirectory(options.StateDir) != nil {
			return nil, &Error{Code: CodeInvalid}
		}
		options.StateDir, err = filepath.EvalSymlinks(options.StateDir)
		if err != nil {
			return nil, &Error{Code: CodeInvalid}
		}
	}
	c := &Client{commandMode: options.StateDir != "", hostID: options.HostID, timeout: timeout, gate: make(chan struct{}, 1), stopped: make(chan struct{}), reaped: make(chan struct{}), stderrDone: make(chan struct{})}
	c.gate <- struct{}{}
	// Own both ends explicitly: Cmd.Wait must not close a stdout reader before
	// the framing reader has consumed buffered bytes. Only child ends are passed.
	inRead, inWrite, err := os.Pipe()
	if err != nil {
		return nil, &Error{Code: CodeStart}
	}
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		inRead.Close()
		inWrite.Close()
		return nil, &Error{Code: CodeStart}
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		inRead.Close()
		inWrite.Close()
		outRead.Close()
		outWrite.Close()
		return nil, &Error{Code: CodeStart}
	}
	c.input, c.output, c.stderr = inWrite, outRead, errRead
	args := []string{"worker", "--stdio"}
	if options.StateDir != "" {
		args = append(args, "--state-dir", options.StateDir)
	}
	c.cmd = exec.Command(executable, args...)
	c.containment, err = newContainment(c.commandMode)
	if err != nil {
		inRead.Close()
		inWrite.Close()
		outRead.Close()
		outWrite.Close()
		errRead.Close()
		errWrite.Close()
		return nil, &Error{Code: CodeStart}
	}
	configureProcess(c.cmd)
	c.cmd.Stdin, c.cmd.Stdout, c.cmd.Stderr = inRead, outWrite, errWrite
	err = c.cmd.Start()
	inRead.Close()
	outWrite.Close()
	errWrite.Close()
	if err != nil {
		if c.containment != nil {
			_ = c.containment.Close()
		}
		c.input.Close()
		c.output.Close()
		c.stderr.Close()
		return nil, &Error{Code: CodeStart}
	}
	if c.containment != nil {
		if err = c.containment.Attach(c.cmd.Process); err != nil {
			_ = c.cmd.Process.Kill()
			_ = c.cmd.Wait()
			_ = c.containment.Close()
			c.input.Close()
			c.output.Close()
			c.stderr.Close()
			return nil, &Error{Code: CodeStart}
		}
	}
	go func() { defer close(c.stderrDone); _, _ = io.Copy(&c.diagnostic, c.stderr) }()
	go func() { _ = c.cmd.Wait(); close(c.reaped); c.stop() }()
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Hello{Hello: &pb.WorkerHelloRequest{Protocol: &pb.ProtocolVersion{Major: 1, Minor: 0}}}}, "hello")
	if err != nil {
		if cleanup := c.Close(); cleanup != nil {
			var failure *Error
			if errors.As(err, &failure) {
				failure.CleanupFailed = true
			} else {
				err = &Error{Code: CodeStart, CleanupFailed: true}
			}
		}
		return nil, err
	}
	hello := response.GetHello()
	if !validHello(hello, options.HostID, response.InstanceId) || (c.commandMode && hello.Commands == nil) || (!c.commandMode && hello.Commands != nil) {
		err = c.fail(&Error{Code: CodeProtocol})
		return nil, err
	}
	c.instanceID = hello.InstanceId
	c.hello = proto.Clone(hello).(*pb.WorkerHelloResponse)
	return c, nil
}
func (c *Client) stop() {
	c.stopOnce.Do(func() {
		close(c.stopped)
		_ = c.input.Close()
		if c.containment != nil {
			_ = c.containment.Stop()
		}
		_ = c.cmd.Process.Kill()
		_ = c.input.Close()
		_ = c.output.Close()
		_ = c.stderr.Close()
	})
}
func (c *Client) Close() error {
	if c == nil {
		return nil
	}
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	if c.commandMode && !c.cleanupConfirmed.Load() {
		select {
		case <-c.stopped:
		default:
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_Shutdown{Shutdown: &pb.ShutdownCommandsRequest{}}})
			cancel()
			if err == nil && response.GetShutdown() != nil && response.GetShutdown().CleanupConfirmed {
				c.cleanupConfirmed.Store(true)
			}
		}
	}
	return c.closeOwned()
}
func (c *Client) closeOwned() error {
	c.reapMu.Lock()
	defer c.reapMu.Unlock()
	c.stop()
	ctx, cancel := context.WithTimeout(context.Background(), CloseTimeout)
	defer cancel()
	select {
	case <-c.reaped:
	case <-ctx.Done():
		return &Error{Code: CodeCleanup}
	}
	if c.containment != nil && !c.containmentClosed.Load() {
		if c.containment.Wait(ctx) != nil {
			return &Error{Code: CodeCleanup}
		}
		_ = c.containment.Close()
		c.containmentClosed.Store(true)
	}
	select {
	case <-c.stderrDone:
	case <-ctx.Done():
		return &Error{Code: CodeCleanup}
	}
	if c.commandMode && !c.cleanupConfirmed.Load() {
		return &Error{Code: CodeCleanup}
	}
	return nil
}
func (c *Client) Done() <-chan struct{}    { return c.stopped }
func (c *Client) Diagnostics() Diagnostics { return c.diagnostic.summary() }
func (c *Client) Hello() *pb.WorkerHelloResponse {
	if c == nil || c.hello == nil {
		return nil
	}
	return proto.Clone(c.hello).(*pb.WorkerHelloResponse)
}
func (c *Client) fail(problem *Error) error {
	if c.closeOwned() != nil {
		problem.CleanupFailed = true
	}
	return problem
}
func contextError(err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: CodeTimeout}
	}
	return &Error{Code: CodeCancelled}
}
