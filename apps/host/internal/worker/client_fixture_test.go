// The fake Runtime the worker client tests talk to: its in-process protocol
// replies, the helpers that start and reap it, and the state it keeps on disk.

package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
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
		fixtureWorker("", "")
		os.Exit(0)
	}
	// The ownership handoff mode, which the real Runtime enters with the same
	// flags: the ownership row lives in the database, the settings document in
	// the file beside it, and one process answers both.
	if len(os.Args) == 7 && os.Args[1] == "worker" && os.Args[2] == "--stdio" &&
		os.Args[3] == "--canvas-database" && os.Args[5] == "--settings-file" {
		fixtureWorker(os.Args[4], os.Args[6])
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func fixtureWorker(canvasDatabase, settingsFile string) {
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
			if canvasDatabase != "" && mode != "ownership-silent" {
				h.Capabilities = append(h.Capabilities, ownershipCapability)
			}
			// The settings frames are advertised separately from the ownership
			// row, so a Worker that can move an epoch but not read a settings
			// file is a state the tests can actually produce.
			if canvasDatabase != "" && mode != "ownership-silent" && mode != "settings-silent" {
				h.Capabilities = append(h.Capabilities, SettingsCapability)
			}
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
				case *pb.WorkerRequest_GetWriteOwnership:
					if canvasDatabase == "" {
						reject("UNSUPPORTED")
						break
					}
					record := readFixtureOwnership(canvasDatabase)
					record.Domain = input.GetWriteOwnership.Domain
					response.Result = &pb.WorkerResponse_WriteOwnership{WriteOwnership: record}
				case *pb.WorkerRequest_SetWriteOwnership:
					if canvasDatabase == "" {
						reject("UNSUPPORTED")
						break
					}
					set := input.SetWriteOwnership
					record := readFixtureOwnership(canvasDatabase)
					switch {
					case set.Owner == record.Owner && set.Epoch == record.Epoch:
						// An exact repeat is the stored state, not a new write.
					case set.ExpectedEpoch != record.Epoch || set.Epoch <= record.Epoch:
						reject("CONFLICT")
					default:
						record = &pb.WorkerWriteOwnership{Domain: set.Domain, Owner: set.Owner, Epoch: set.Epoch, ReasonCode: set.ReasonCode, UpdatedAtUnixMs: 1788560523004}
						writeFixtureOwnership(canvasDatabase, record)
					}
					if response.Result == nil {
						record.Domain = set.Domain
						response.Result = &pb.WorkerResponse_WriteOwnership{WriteOwnership: record}
					}
				case *pb.WorkerRequest_Settings:
					if settingsFile == "" {
						reject("UNSUPPORTED")
						break
					}
					snapshot, code := fixtureSettings(settingsFile, input.Settings, mode)
					if code != "" {
						reject(code)
						break
					}
					response.Result = &pb.WorkerResponse_Settings{Settings: snapshot}
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

// The fake Runtime's stored ownership row. A file rather than memory, because
// the handoff is only meaningful if it survives the process that wrote it.
func readFixtureOwnership(path string) *pb.WorkerWriteOwnership {
	record := &pb.WorkerWriteOwnership{Domain: "canvas", Owner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME, Epoch: 1, ReasonCode: "ownership.initial"}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return record
	}
	stored := new(pb.WorkerWriteOwnership)
	if proto.Unmarshal(data, stored) != nil {
		return record
	}
	return stored
}

func writeFixtureOwnership(path string, record *pb.WorkerWriteOwnership) {
	data, err := proto.Marshal(record)
	if err == nil {
		_ = os.WriteFile(path, data, 0600)
	}
}

// The fake Runtime's settings file. It holds the document as bytes, exactly as
// the real one does, so an import writes what it was sent and an export reports
// what is on disk rather than what was last asked for.
const fixtureSettingsJSON = `{"theme":"dark","ssh":{"hosts":[` +
	`{"id":"build-box","name":"Build","host":"build.example","user":"ci","identityFile":"/keys/ci",` +
	`"worker":{"path":"/opt/armadra/worker","stateDir":"/var/lib/armadra"}}]}}`

func readFixtureSettings(path string) *pb.SettingsDocument {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		data = []byte(fixtureSettingsJSON)
	}
	sum := sha256.Sum256(data)
	return &pb.SettingsDocument{
		Scope:           pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
		Document:        data,
		Sha256:          sum[:],
		SchemaVersion:   1,
		UpdatedAtUnixMs: 1788560523004,
	}
}

// fixtureExecutionHosts is the Worker's own derivation of the registry: the
// machine it runs on, then the SSH entries the document names. The Host derives
// the same set independently, which is what makes comparing them worth doing.
func fixtureExecutionHosts(document []byte) []*pb.ExecutionHost {
	var envelope struct {
		SSH struct {
			Hosts []struct {
				ID           string `json:"id"`
				Name         string `json:"name"`
				Host         string `json:"host"`
				User         string `json:"user"`
				Port         uint32 `json:"port"`
				IdentityFile string `json:"identityFile"`
				Worker       *struct {
					Path     string `json:"path"`
					StateDir string `json:"stateDir"`
				} `json:"worker"`
			} `json:"hosts"`
		} `json:"ssh"`
	}
	hosts := []*pb.ExecutionHost{{Kind: pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL}}
	if json.Unmarshal(document, &envelope) != nil {
		return hosts
	}
	for _, entry := range envelope.SSH.Hosts {
		ssh := &pb.SshExecutionHost{Host: entry.Host, Port: entry.Port, User: entry.User, IdentityFile: entry.IdentityFile}
		if entry.Worker != nil {
			ssh.WorkerPath, ssh.StateDir = entry.Worker.Path, entry.Worker.StateDir
		}
		hosts = append(hosts, &pb.ExecutionHost{
			ExecutionHostId: entry.ID,
			Name:            entry.Name,
			Ssh:             ssh,
			Kind:            pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH,
		})
	}
	return hosts
}

func fixtureSettings(path string, request *pb.WorkerSettingsRequest, mode string) (*pb.WorkerSettingsSnapshot, string) {
	switch request.GetDirection() {
	case pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_EXPORT:
		document := readFixtureSettings(path)
		snapshot := &pb.WorkerSettingsSnapshot{
			Document:       document,
			Local:          &pb.WorkerLocalSettings{TerminalBackend: "pty", BrowserAvailable: true},
			ExecutionHosts: fixtureExecutionHosts(document.Document),
		}
		switch mode {
		case "settings-wrong-digest":
			snapshot.Document.Sha256 = make([]byte, 32)
		case "settings-claims-write":
			snapshot.Applied = true
		}
		return snapshot, ""
	case pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT:
		document := request.GetDocument()
		if document == nil || len(document.Document) == 0 {
			return nil, "INVALID_ARGUMENT"
		}
		if mode != "settings-import-drops" {
			if err := os.WriteFile(path, document.Document, 0600); err != nil {
				return nil, "INTERNAL"
			}
		}
		// Read back from the file, never echoed from the request, so the digest
		// the controller compares is evidence rather than a restatement.
		stored := readFixtureSettings(path)
		snapshot := &pb.WorkerSettingsSnapshot{
			Document:       stored,
			Local:          &pb.WorkerLocalSettings{TerminalBackend: "pty"},
			ExecutionHosts: fixtureExecutionHosts(stored.Document),
			Applied:        true,
		}
		if mode == "settings-silent-write" {
			snapshot.Applied = false
		}
		return snapshot, ""
	}
	return nil, "INVALID_ARGUMENT"
}
