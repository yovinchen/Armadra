package worker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// Cross-language checks of the resident channel against the real Rust Worker.
//
// The Go tests above script a peer, which proves the Host's own logic but not
// that the two builds agree on the wire. These start the actual Runtime binary,
// so the kind-tagged prefix, the handshake record and the socket bearer are all
// exercised by the code that will run in production.
//
// Opt-in: ARMADRA_TEST_REAL_WORKER must name an already built native Runtime.

func realWorker(t *testing.T) string {
	t.Helper()
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	if runtime.GOOS == "windows" {
		t.Skip("the socket bearer assertions are Unix-shaped")
	}
	return executable
}

// privateStateDir is a 0700 directory the Worker will accept for its journal
// and its outbox.
//
// It is deliberately not t.TempDir(): a Unix socket path is limited to about a
// hundred bytes, and Go's per-test temporary directory embeds the test's name,
// which pushes the bearer past that limit. The Worker degrades gracefully in
// that case (stdio only, no published address), so a test that used the long
// path would be asserting the degradation rather than the bearer.
func privateStateDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "armw")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// A Worker with a durable outbox must say so, and must publish an address the
// Host can reattach on. Saying it without publishing one, or publishing one
// outside the configured state directory, are both refused.
func TestRealWorkerPublishesItsChannelInTheHandshake(t *testing.T) {
	executable := realWorker(t)
	state := privateStateDir(t)
	t.Setenv("ARMADRA_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	sink := &recordingSink{}
	c, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, StateDir: state, Upcalls: sink})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	hello := c.Hello()
	if !containsCapability(hello.Capabilities, UpcallCapability) {
		t.Fatalf("the real Worker did not advertise %s: %v", UpcallCapability, hello.Capabilities)
	}
	channel := hello.GetChannel()
	if channel == nil {
		t.Fatal("a Worker that advertised the capability published no channel record")
	}
	if channel.GetWorkerInstanceId() != hello.GetInstanceId() {
		t.Fatalf("the channel names a different instance than the handshake: %q vs %q", channel.GetWorkerInstanceId(), hello.GetInstanceId())
	}
	// A fresh Worker owes nothing, and says so with a present record rather
	// than an absent one: "no channel" and "nothing pending" are different.
	if channel.GetUnacknowledged() != 0 || channel.GetHighestSequence() != 0 {
		t.Fatalf("a fresh Worker claimed a backlog: %+v", channel)
	}
	if channel.GetMaxUnacknowledged() == 0 {
		t.Fatal("the Worker published no backlog bound")
	}
	if channel.GetState() != pb.WorkerChannelState_WORKER_CHANNEL_STATE_READY {
		t.Fatalf("a fresh channel is not ready: %v", channel.GetState())
	}
	address, err := BearerAddress(channel, state)
	if err != nil {
		t.Fatalf("the published bearer was refused: %v (%q)", err, channel.GetSocket())
	}
	if info, err := os.Stat(address); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("the published bearer is not a socket: %v", err)
	}
	// The Host installed its reader pump, and requests still work through it:
	// this is the regression that matters, because the pump replaced the code
	// path every existing operation uses.
	if c.pump == nil {
		t.Fatal("the reader pump was not installed for an upcall-capable Worker")
	}
	if _, err := c.RegisterRoot(context.Background(), "channel-root", state); err != nil {
		t.Fatalf("a request through the reader pump failed: %v", err)
	}
	if instance, through := c.UpcallWindow(); instance != "" || through != 0 {
		t.Fatalf("a Worker with nothing to report advanced the window: %s/%d", instance, through)
	}
	t.Logf("real Rust Worker %s published bearer %s, backlog bound %d", hello.GetInstanceId(), filepath.Base(address), channel.GetMaxUnacknowledged())
}

// The same frames over the other bearer. A Host that lost its pipe must be able
// to reach a Worker it did not start, which is the whole reason the socket
// exists.
func TestRealWorkerAnswersOnItsSocketBearer(t *testing.T) {
	executable := realWorker(t)
	state := privateStateDir(t)
	t.Setenv("ARMADRA_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	c, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, StateDir: state, Upcalls: &recordingSink{}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	address, err := BearerAddress(c.Hello().GetChannel(), state)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := DialBearer(context.Background(), address)
	if err != nil {
		t.Fatalf("the published bearer could not be dialled: %v", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	// A root registered over the bearer, quoting the instance the *stdio*
	// handshake returned. Only the same already-initialized Worker can accept
	// it: a second process would have a different instance id and answer
	// STALE_GENERATION.
	request := &pb.WorkerRequest{
		RequestId:          "h-bearer-1",
		HostId:             fixtureHost,
		ExpectedInstanceId: c.Hello().GetInstanceId(),
		DeadlineUnixMs:     time.Now().Add(10 * time.Second).UnixMilli(),
		Action:             &pb.WorkerRequest_RegisterRoot{RegisterRoot: &pb.RegisterRootRequest{RootId: "bearer-root", Path: state}},
	}
	wire, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeKindFrame(conn, frameKindCall, wire, MaxFrameBytes); err != nil {
		t.Fatal(err)
	}
	kind, answer, err := readKindFrame(conn, MaxFrameBytes)
	if err != nil {
		t.Fatalf("the bearer did not answer: %v", err)
	}
	if kind != frameKindCall {
		t.Fatalf("the bearer answered with kind %d", kind)
	}
	response := new(pb.WorkerResponse)
	if err := proto.Unmarshal(answer, response); err != nil {
		t.Fatal(err)
	}
	if response.RequestId != request.RequestId || response.InstanceId != c.Hello().GetInstanceId() {
		t.Fatalf("the bearer reached a different Worker: %+v", response)
	}
	root := response.GetRegisteredRoot()
	if root == nil || root.RootId != "bearer-root" {
		t.Fatalf("the bearer did not serve the request: %+v", response.Result)
	}
	// The root registered over the socket is visible over stdio, so the two
	// bearers really are two doors into one Worker rather than two Workers.
	if _, err := c.ListDirectory(context.Background(), "bearer-root", "."); err != nil {
		t.Fatalf("stdio did not see the root registered over the bearer: %v", err)
	}
	// And an unknown root is still refused, so stdio is answering, not echoing.
	var failure *Error
	if _, err := c.ListDirectory(context.Background(), "missing-root", "."); !errors.As(err, &failure) || failure.RemoteCode != "NOT_FOUND" {
		t.Fatalf("an unregistered root was not refused: %v", err)
	}
	t.Logf("both bearers reached Worker %s", c.Hello().GetInstanceId())
}

func containsCapability(values []string, want string) bool {
	for _, value := range values {
		if strings.EqualFold(value, want) {
			return true
		}
	}
	return false
}
