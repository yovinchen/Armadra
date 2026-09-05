package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const fixtureHost = "11111111111111111111111111111111"

var fixtureContent = []byte("ab中文🙂 'quoted'\nlast line 尾")

// This same native Go test executable is a fake Worker only for the exact argv
// required by Start. The ordinary test runner never interprets this branch.
func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "worker" && os.Args[2] == "--stdio" {
		fixtureWorker()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func fixtureWorker() {
	mode := os.Getenv("ARMADRA_TEST_WORKER_MODE")
	if file := os.Getenv("ARMADRA_TEST_WORKER_PID"); file != "" {
		_ = os.WriteFile(file, []byte(strconv.Itoa(os.Getpid())), 0600)
	}
	instance := fmt.Sprintf("%032x", os.Getpid())
	roots := map[string]string{}
	for {
		wire, err := readFrame(os.Stdin, MaxFrameBytes)
		if err != nil {
			return
		}
		request := new(pb.WorkerRequest)
		if proto.Unmarshal(wire, request) != nil {
			return
		}
		if file := os.Getenv("ARMADRA_TEST_WORKER_CAPTURE"); file != "" {
			data, _ := json.Marshal(struct {
				ID, Host, Instance string
				Deadline           int64
			}{request.RequestId, request.HostId, request.ExpectedInstanceId, request.DeadlineUnixMs})
			log, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err == nil {
				_, _ = log.Write(append(data, '\n'))
				log.Close()
			}
		}
		response := &pb.WorkerResponse{RequestId: request.RequestId, HostId: request.HostId, InstanceId: instance}
		reject := func(code string) {
			response.Result = &pb.WorkerResponse_Error{Error: &pb.ErrorResponse{Code: code, Message: "raw-private-path-and-token=must-not-leak"}}
		}
		hello := request.GetHello() != nil
		if hello {
			if mode == "hello-timeout" {
				time.Sleep(time.Hour)
				return
			}
			platform := runtime.GOOS
			if runtime.GOOS == "darwin" {
				platform = "macos"
			}
			h := &pb.WorkerHelloResponse{Protocol: &pb.ProtocolVersion{Major: 1, Minor: 0}, HostId: request.HostId, InstanceId: instance, Platform: platform, Architecture: "aarch64", Capabilities: []string{"worker.roots.v1", "files.directory-read.v1", "files.text-read.v1"}, MaxFrameBytes: MaxFrameBytes, MaxFileChunkBytes: MaxFileChunkBytes, MaxTextFileBytes: MaxTextFileBytes}
			if runtime.GOARCH == "amd64" {
				h.Architecture = "x86_64"
			}
			switch mode {
			case "hello-host":
				h.HostId = strings.Repeat("f", 32)
			case "hello-instance":
				h.InstanceId = strings.Repeat("f", 32)
			case "hello-version":
				h.Protocol.Major = 2
			case "hello-caps":
				h.Capabilities = []string{"files.write.v1"}
			case "hello-limit":
				h.MaxFrameBytes = MaxFrameBytes + 1
			case "hello-platform":
				h.Platform = "unknown"
			case "stderr":
				_, _ = os.Stderr.Write(bytes.Repeat([]byte("private-diagnostic-secret\n"), 8192))
			}
			response.Result = &pb.WorkerResponse_Hello{Hello: h}
		} else {
			if request.HostId != fixtureHost || request.ExpectedInstanceId != instance {
				reject("STALE_GENERATION")
			} else {
				switch input := request.Action.(type) {
				case *pb.WorkerRequest_RegisterRoot:
					original, exists := roots[input.RegisterRoot.RootId]
					if exists && original != input.RegisterRoot.Path {
						reject("CONFLICT")
					} else {
						roots[input.RegisterRoot.RootId] = input.RegisterRoot.Path
						response.Result = &pb.WorkerResponse_RegisteredRoot{RegisteredRoot: &pb.RegisteredRoot{RootId: input.RegisterRoot.RootId, CanonicalPath: filepath.Clean(input.RegisterRoot.Path)}}
					}
				case *pb.WorkerRequest_ListDirectory:
					directory := input.ListDirectory.Path
					if directory == "" {
						directory = "."
					}
					if directory == "alias" {
						directory = "actual"
					}
					response.Result = &pb.WorkerResponse_Directory{Directory: &pb.WorkerDirectory{RootId: input.ListDirectory.RootId, Path: directory, Entries: []*pb.WorkerFileEntry{{Name: "a 中文' file.txt", Path: path.Join(directory, "a 中文' file.txt"), Kind: "file", Size: uint64(len(fixtureContent))}, {Name: "nested", Path: path.Join(directory, "nested"), Kind: "directory"}}}}
				case *pb.WorkerRequest_ReadFile:
					read := input.ReadFile
					sum := sha256.Sum256(fixtureContent)
					if len(read.ExpectedSha256) > 0 && !bytes.Equal(read.ExpectedSha256, sum[:]) {
						reject("CONFLICT")
						break
					}
					if read.Offset > uint64(len(fixtureContent)) {
						reject("INVALID_ARGUMENT")
						break
					}
					end := min(read.Offset+uint64(read.MaxBytes), uint64(len(fixtureContent)))
					filePath := read.Path
					if filePath == "alias.txt" {
						filePath = "actual.txt"
					}
					response.Result = &pb.WorkerResponse_FileChunk{FileChunk: &pb.WorkerFileChunk{RootId: read.RootId, Path: filePath, MimeType: "text/plain", Sha256: sum[:], TotalBytes: uint64(len(fixtureContent)), Offset: read.Offset, Data: fixtureContent[read.Offset:end], Eof: end == uint64(len(fixtureContent))}}
				default:
					reject("UNSUPPORTED")
				}
			}
			switch mode {
			case "slow":
				time.Sleep(time.Hour)
				return
			case "delay":
				time.Sleep(5 * time.Millisecond)
			case "wrong-id":
				response.RequestId = strings.Repeat("f", 32)
			case "wrong-host":
				response.HostId = strings.Repeat("f", 32)
			case "wrong-instance":
				response.InstanceId = strings.Repeat("f", 32)
			case "wrong-result":
				response.Result = &pb.WorkerResponse_Hello{Hello: &pb.WorkerHelloResponse{}}
			case "remote":
				reject("PERMISSION_DENIED")
			case "remote-timeout":
				reject("TIMEOUT")
			case "exit":
				return
			case "oversized", "zero", "truncated":
				var prefix [4]byte
				length := uint32(MaxFrameBytes + 1)
				if mode == "zero" {
					length = 0
				}
				if mode == "truncated" {
					length = 100
				}
				binary.BigEndian.PutUint32(prefix[:], length)
				_, _ = os.Stdout.Write(prefix[:])
				if mode == "truncated" {
					_, _ = os.Stdout.Write([]byte{1})
					os.Stdout.Close()
				}
				time.Sleep(time.Hour)
				return
			case "wrong-root":
				if v := response.GetDirectory(); v != nil {
					v.RootId = "another"
				}
			case "traversal-entry":
				if v := response.GetDirectory(); v != nil {
					v.Entries[0].Path = "../outside"
				}
			case "duplicate-entry":
				if v := response.GetDirectory(); v != nil {
					v.Entries = append(v.Entries, proto.Clone(v.Entries[0]).(*pb.WorkerFileEntry))
				}
			case "wrong-offset":
				if v := response.GetFileChunk(); v != nil {
					v.Offset++
				}
			case "wrong-hash":
				if v := response.GetFileChunk(); v != nil {
					v.Sha256 = make([]byte, 32)
				}
			case "oversized-chunk":
				if v := response.GetFileChunk(); v != nil {
					v.Data = make([]byte, MaxFileChunkBytes+1)
				}
			case "empty-progress":
				if v := response.GetFileChunk(); v != nil {
					v.Data = nil
					v.Eof = false
				}
			}
		}
		wire, err = proto.Marshal(response)
		if err != nil {
			return
		}
		if !hello && mode == "duplicate-result" {
			extra, _ := proto.Marshal(&pb.ErrorResponse{Code: "INTERNAL"})
			wire = protowire.AppendTag(wire, 14, protowire.BytesType)
			wire = protowire.AppendBytes(wire, extra)
		}
		if !hello && mode == "duplicate-envelope" {
			wire = protowire.AppendTag(wire, 1, protowire.BytesType)
			wire = protowire.AppendString(wire, response.RequestId)
		}
		if !hello && mode == "deep-group" {
			for range 5000 {
				wire = protowire.AppendTag(wire, 100, protowire.StartGroupType)
			}
			for range 5000 {
				wire = protowire.AppendTag(wire, 100, protowire.EndGroupType)
			}
		}
		if writeFrame(os.Stdout, wire, MaxFrameBytes) != nil {
			return
		}
	}
}

func startFixture(t *testing.T, mode string) (*Client, string) {
	t.Helper()
	t.Setenv("ARMADRA_TEST_WORKER_MODE", mode)
	capture := filepath.Join(t.TempDir(), "requests.jsonl")
	t.Setenv("ARMADRA_TEST_WORKER_CAPTURE", capture)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	c, err := Start(context.Background(), Options{Executable: exe, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.Close(); err != nil {
			t.Error(err)
		}
	})
	return c, capture
}
func assertReaped(t *testing.T, c *Client) {
	t.Helper()
	select {
	case <-c.reaped:
	case <-time.After(CloseTimeout):
		t.Fatal("owned child was not reaped")
	}
	select {
	case <-c.stderrDone:
	case <-time.After(time.Second):
		t.Fatal("stderr reader was not released")
	}
	if c.cmd.ProcessState == nil || c.cmd.ProcessState.Pid() != c.cmd.Process.Pid {
		t.Fatal("missing wait result for owned child")
	}
}
func requireCode(t *testing.T, err error, code Code) {
	t.Helper()
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != code || failure.CleanupFailed {
		t.Fatalf("error %v want %s with completed cleanup", err, code)
	}
}

func TestNativePrivatePipesReadChunksAndStartupContextLifetime(t *testing.T) {
	t.Setenv("ARMADRA_TEST_WORKER_MODE", "")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	c, err := Start(ctx, Options{Executable: exe, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	cancel()
	if c.timeout != DefaultRequestTimeout {
		t.Fatal("wrong default request deadline")
	}
	hello := c.Hello()
	if hello.HostId != fixtureHost || hello.InstanceId == "" {
		t.Fatal("handshake identity missing")
	}
	hello.Capabilities[0] = "mutated"
	if c.Hello().Capabilities[0] == "mutated" {
		t.Fatal("caller could mutate stored negotiation")
	}
	directory := filepath.Join(t.TempDir(), "space 中文 '$()'")
	if err = os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := c.RegisterRoot(context.Background(), "workspace", directory)
	if err != nil || root.CanonicalPath != directory {
		t.Fatalf("register literal directory failed: %v", err)
	}
	listed, err := c.ListDirectory(context.Background(), "workspace", "")
	if err != nil || len(listed.Entries) != 2 || listed.Entries[0].Name != "a 中文' file.txt" {
		t.Fatalf("directory response: %v", err)
	}
	var content, sha []byte
	var offset uint64
	for {
		chunk, err := c.ReadFileChunk(context.Background(), ReadOptions{RootID: "workspace", Path: "a 中文' file.txt", Offset: offset, MaxBytes: 3, ExpectedSHA256: sha})
		if err != nil {
			t.Fatal(err)
		}
		if sha == nil {
			sha = append([]byte(nil), chunk.Sha256...)
		}
		content = append(content, chunk.Data...)
		offset += uint64(len(chunk.Data))
		if chunk.Eof {
			break
		}
	}
	if !bytes.Equal(content, fixtureContent) {
		t.Fatal("UTF-8 split chunks changed file bytes")
	}
	sum := sha256.Sum256(content)
	if !bytes.Equal(sum[:], sha) {
		t.Fatal("reassembled hash differs")
	}
	alias, err := c.ListDirectory(context.Background(), "workspace", "alias")
	if err != nil || alias.Path != "actual" {
		t.Fatal("canonical alias directory was rejected")
	}
	file, err := c.ReadFileChunk(context.Background(), ReadOptions{RootID: "workspace", Path: "alias.txt"})
	if err != nil || file.Path != "actual.txt" {
		t.Fatal("canonical alias file was rejected")
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}
	assertReaped(t, c)
}

func TestRequestsAreSerializedAndUseBoundInstanceAndDeadlines(t *testing.T) {
	c, capture := startFixture(t, "delay")
	var group sync.WaitGroup
	for i := range 12 {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			v, err := c.ListDirectory(context.Background(), "root", fmt.Sprintf("dir-%d", index))
			if err != nil {
				t.Error(err)
				return
			}
			if v.Path != fmt.Sprintf("dir-%d", index) {
				t.Error("concurrent response went to another caller")
			}
		}(i)
	}
	group.Wait()
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(data), []byte("\n"))
	if len(lines) != 13 {
		t.Fatalf("expected one hello and 12 requests, got %d", len(lines))
	}
	seen := map[string]bool{}
	for index, line := range lines {
		var v struct {
			ID, Host, Instance string
			Deadline           int64
		}
		if err = json.Unmarshal(line, &v); err != nil {
			t.Fatal(err)
		}
		if seen[v.ID] || v.Host != fixtureHost || v.Deadline <= time.Now().Add(-time.Second).UnixMilli() || v.Deadline > time.Now().Add(time.Minute).UnixMilli() {
			t.Fatal("invalid request envelope")
		}
		seen[v.ID] = true
		if index == 0 && v.Instance != "" || index > 0 && v.Instance != c.Hello().InstanceId {
			t.Fatal("instance binding was not preserved")
		}
	}
}

func TestInvalidLocalRequestsDoNotPoisonConnection(t *testing.T) {
	c, _ := startFixture(t, "")
	for _, relative := range []string{"../outside", "a/../b", "/absolute", "a//b", "a/./b", "a\\b", "bad\x00path"} {
		_, err := c.ListDirectory(context.Background(), "root", relative)
		requireCode(t, err, CodeInvalid)
	}
	for _, options := range []ReadOptions{{RootID: "root", Path: "a", Offset: 1}, {RootID: "root", Path: "a", MaxBytes: MaxFileChunkBytes + 1}, {RootID: "root", Path: "a", ExpectedSHA256: []byte{}}, {RootID: "root", Path: "a", Offset: MaxTextFileBytes + 1, ExpectedSHA256: make([]byte, 32)}} {
		_, err := c.ReadFileChunk(context.Background(), options)
		requireCode(t, err, CodeInvalid)
	}
	_, err := c.RegisterRoot(context.Background(), "root", "relative")
	requireCode(t, err, CodeInvalid)
	_, err = c.ListDirectory(context.Background(), "root", ".")
	if err != nil {
		t.Fatal("local validation closed healthy child")
	}
	_, err = c.ReadFileChunk(context.Background(), ReadOptions{RootID: "root", Path: "a", ExpectedSHA256: make([]byte, 32)})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeRemote || failure.RemoteCode != "CONFLICT" {
		t.Fatal("file version conflict missing")
	}
	if _, err = c.ListDirectory(context.Background(), "root", "."); err != nil {
		t.Fatal("a version conflict poisoned the pipe")
	}
}

func TestMalformedFramesAndPayloadsKillAndReapOwnedChild(t *testing.T) {
	for _, mode := range []string{"wrong-id", "wrong-host", "wrong-instance", "wrong-result", "oversized", "zero", "truncated", "duplicate-result", "duplicate-envelope", "deep-group", "wrong-root", "traversal-entry", "duplicate-entry"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := startFixture(t, mode)
			_, err := c.ListDirectory(context.Background(), "root", ".")
			requireCode(t, err, CodeProtocol)
			assertReaped(t, c)
			_, err = c.ListDirectory(context.Background(), "root", ".")
			requireCode(t, err, CodeClosed)
		})
	}
	for _, mode := range []string{"wrong-offset", "wrong-hash", "oversized-chunk", "empty-progress"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := startFixture(t, mode)
			_, err := c.ReadFileChunk(context.Background(), ReadOptions{RootID: "root", Path: "file.txt"})
			requireCode(t, err, CodeProtocol)
			assertReaped(t, c)
		})
	}
}

func TestCancellationDeadlineAndQueuedCancellationReap(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			c, _ := startFixture(t, "slow")
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
			defer cancel()
			if cancelled {
				cancel()
			}
			_, err := c.ListDirectory(ctx, "root", ".")
			if cancelled {
				requireCode(t, err, CodeCancelled)
				if !errors.Is(err, context.Canceled) {
					t.Fatal("cancellation classification missing")
				}
			} else {
				requireCode(t, err, CodeTimeout)
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("deadline classification missing")
				}
			}
			assertReaped(t, c)
		})
	}
	c, capture := startFixture(t, "slow")
	active := make(chan error, 1)
	go func() { _, err := c.ListDirectory(context.Background(), "root", "."); active <- err }()
	deadline := time.Now().Add(time.Second)
	for {
		data, _ := os.ReadFile(capture)
		if bytes.Count(data, []byte("\n")) >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("active request did not reach helper")
		}
		time.Sleep(time.Millisecond)
	}
	queued, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.ListDirectory(queued, "root", "queued")
	requireCode(t, err, CodeCancelled)
	if err = <-active; err == nil {
		t.Fatal("active operation succeeded after client shutdown")
	}
	assertReaped(t, c)
}

func TestRemoteErrorsAreSanitizedAndStderrRetentionIsBounded(t *testing.T) {
	c, _ := startFixture(t, "remote")
	for range 2 {
		_, err := c.ListDirectory(context.Background(), "root", ".")
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != CodeRemote || failure.RemoteCode != "PERMISSION_DENIED" || strings.Contains(err.Error(), "must-not-leak") {
			t.Fatal("remote error was not stable/sanitized")
		}
	}
	diagnostic, _ := startFixture(t, "stderr")
	deadline := time.Now().Add(time.Second)
	for !diagnostic.Diagnostics().Truncated && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	summary := diagnostic.Diagnostics()
	if !summary.Truncated || summary.BufferedBytes != MaxDiagnosticBytes {
		t.Fatalf("unbounded or missing diagnostic summary: %+v", summary)
	}
	if err := diagnostic.Close(); err != nil {
		t.Fatal(err)
	}
	assertReaped(t, diagnostic)
	diagnostic.diagnostic.mu.Lock()
	capacity := cap(diagnostic.diagnostic.tail)
	diagnostic.diagnostic.mu.Unlock()
	if capacity > MaxDiagnosticBytes {
		t.Fatal("diagnostic buffer allocated beyond its retention budget")
	}
}

func TestRemoteTimeoutAndUnexpectedExitCannotLeaveAReusableClient(t *testing.T) {
	timeout, _ := startFixture(t, "remote-timeout")
	_, err := timeout.ListDirectory(context.Background(), "root", ".")
	requireCode(t, err, CodeTimeout)
	assertReaped(t, timeout)
	exited, _ := startFixture(t, "exit")
	_, err = exited.ListDirectory(context.Background(), "root", ".")
	var failure *Error
	if !errors.As(err, &failure) || (failure.Code != CodeClosed && failure.Code != CodeTransport) {
		t.Fatalf("unexpected child exit classification: %v", err)
	}
	assertReaped(t, exited)
}

func TestCloseOnlyOwnsItsChildAndConcurrentCloseIsIdempotent(t *testing.T) {
	first, _ := startFixture(t, "")
	second, _ := startFixture(t, "")
	if first.cmd.Process.Pid == second.cmd.Process.Pid {
		t.Fatal("test did not create independent children")
	}
	var group sync.WaitGroup
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := first.Close(); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	assertReaped(t, first)
	if _, err := second.ListDirectory(context.Background(), "root", "."); err != nil {
		t.Fatal("closing a client stopped another Worker")
	}
}

func TestInvalidExecutablesNeverInvokeAShell(t *testing.T) {
	path := filepath.Join(t.TempDir(), "script with spaces")
	marker := filepath.Join(t.TempDir(), "should-not-exist")
	if err := os.WriteFile(path, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, exe := range []string{"armadra-runtime", "./armadra-runtime", path, filepath.Dir(path)} {
		if c, err := Start(context.Background(), Options{Executable: exe, HostID: fixtureHost}); err == nil {
			c.Close()
			t.Fatal("non-native executable accepted")
		}
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("interpreter script was executed")
	}
	exe, _ := os.Executable()
	for _, options := range []Options{{Executable: exe, HostID: "wrong"}, {Executable: exe, HostID: fixtureHost, RequestTimeout: -time.Second}, {Executable: exe, HostID: fixtureHost, RequestTimeout: time.Minute + time.Millisecond}} {
		if c, err := Start(context.Background(), options); err == nil {
			c.Close()
			t.Fatal("invalid startup configuration accepted")
		}
	}
}

func TestHandshakeFailuresReapInsteadOfReturningAnUnboundClient(t *testing.T) {
	for _, mode := range []string{"hello-host", "hello-instance", "hello-version", "hello-caps", "hello-limit", "hello-platform", "hello-timeout"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ARMADRA_TEST_WORKER_MODE", mode)
			pidFile := filepath.Join(t.TempDir(), "pid")
			t.Setenv("ARMADRA_TEST_WORKER_PID", pidFile)
			exe, _ := os.Executable()
			timeout := time.Second
			if mode == "hello-timeout" {
				timeout = 200 * time.Millisecond
			}
			c, err := Start(context.Background(), Options{Executable: exe, HostID: fixtureHost, RequestTimeout: timeout})
			if c != nil || err == nil {
				if c != nil {
					c.Close()
				}
				t.Fatal("invalid handshake returned a client")
			}
			if mode == "hello-timeout" {
				requireCode(t, err, CodeTimeout)
			} else {
				requireCode(t, err, CodeProtocol)
			}
			raw, err := os.ReadFile(pidFile)
			if err != nil {
				t.Fatal("helper PID evidence missing")
			}
			pid, err := strconv.Atoi(string(raw))
			if err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" {
				process, err := os.FindProcess(pid)
				if err != nil {
					t.Fatal(err)
				}
				defer process.Release()
				if err = process.Signal(syscall.Signal(0)); err == nil {
					t.Fatal("failed startup left its child alive")
				}
			}
		})
	}
}

func TestExplicitExecutablePathMayContainSpacesAndUnicode(t *testing.T) {
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	target := filepath.Join(t.TempDir(), "worker 中文 space"+suffix)
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.Copy(output, input); err != nil {
		output.Close()
		t.Fatal(err)
	}
	if err = output.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ARMADRA_TEST_WORKER_MODE", "")
	c, err := Start(context.Background(), Options{Executable: target, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err = c.ListDirectory(context.Background(), "root", "."); err != nil {
		t.Fatal(err)
	}
}
