package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

func realCommandClient(t *testing.T, dir string) *Client {
	t.Helper()
	binary := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if binary == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to built Rust Worker")
	}
	c, err := Start(context.Background(), Options{Executable: binary, HostID: strings.Repeat("c", 32), StateDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func commandFixture(t *testing.T, c *Client, root, session string, args []string, executable string) {
	t.Helper()
	ctx := context.Background()
	if _, err := c.BindCommandRoot(ctx, &pb.BindCommandRootRequest{RootId: "root", WorkspaceId: "workspace", Path: root}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateCommandSession(ctx, &pb.CreateCommandSessionRequest{SessionId: session, RootId: "root", WorkspaceId: "workspace", Kind: pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND, Launch: &pb.CommandLaunchSpec{Executable: executable, Args: args, WorkingDirectory: ".", AccountId: "default", TimeoutMs: 30000}}); err != nil {
		t.Fatal(err)
	}
}
func awaitCommand(t *testing.T, c *Client, id string) *pb.CommandReceipt {
	t.Helper()
	until := time.Now().Add(12 * time.Second)
	for time.Now().Before(until) {
		r, e := c.LookupCommand(context.Background(), id)
		if e != nil {
			t.Fatal(e)
		}
		if r.Phase >= pb.CommandPhase_COMMAND_PHASE_SUCCEEDED && r.Phase != pb.CommandPhase_COMMAND_PHASE_CANCEL_REQUESTED {
			return r
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("command did not settle")
	return nil
}
func runInput(id, session string, input []byte) *pb.RunCommandRequest {
	digest := sha256.Sum256(input)
	return &pb.RunCommandRequest{OperationId: id, RequestSha256: digest[:], SessionId: session, ExpectedGeneration: 1, Stdin: input}
}
func TestRealCommandJournalReplayRestartAndSeparatedStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix command fixture; Windows requires separate real runner")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	root := t.TempDir()
	c := realCommandClient(t, dir)
	defer c.Close()
	commandFixture(t, c, root, "cat", nil, "/bin/cat")
	input := []byte("中文 input ; $(echo never-run)\n")
	request := runInput("owner/workspace/run/one", "cat", input)
	if _, e := c.RunCommand(context.Background(), request); e != nil {
		t.Fatal(e)
	}
	r := awaitCommand(t, c, request.OperationId)
	if r.Phase != pb.CommandPhase_COMMAND_PHASE_SUCCEEDED || !r.CleanupConfirmed || !bytes.Equal(r.Stdout, input) {
		t.Fatalf("unexpected result: phase=%v reason=%s cleanup=%v stdout=%q", r.Phase, r.ReasonCode, r.CleanupConfirmed, r.Stdout)
	}
	replay, e := c.RunCommand(context.Background(), request)
	if e != nil || replay.Sequence != r.Sequence {
		t.Fatalf("idempotent replay failed: %v", e)
	}
	changed := runInput(request.OperationId, "cat", []byte("changed"))
	if _, e = c.RunCommand(context.Background(), changed); e == nil {
		t.Fatal("operation key reuse accepted")
	}
	if e = c.Close(); e != nil {
		t.Fatal(e)
	}
	if e = c.Close(); e != nil {
		t.Fatal("close was not idempotent", e)
	}
	c = realCommandClient(t, dir)
	defer c.Close()
	reopened, e := c.LookupCommand(context.Background(), request.OperationId)
	if e != nil || reopened.Sequence != r.Sequence || !bytes.Equal(reopened.Stdout, input) {
		t.Fatalf("journal restart lost receipt: %v", e)
	}
	if _, e = os.Stat(filepath.Join(dir, "canvas.db")); !os.IsNotExist(e) {
		t.Fatal("legacy DB created")
	}
}
func TestRealCommandCancelCleansOrdinaryDescendant(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix fixture")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	root := t.TempDir()
	c := realCommandClient(t, dir)
	defer c.Close()
	commandFixture(t, c, root, "tree", []string{"-c", "sleep 30 & echo $! > child.pid; wait"}, "/bin/sh")
	request := runInput("owner/workspace/run/tree", "tree", nil)
	if _, e := c.RunCommand(context.Background(), request); e != nil {
		t.Fatal(e)
	}
	var pid int
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		data, e := os.ReadFile(filepath.Join(root, "child.pid"))
		if e == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("descendant did not start")
	}
	if _, e := c.CancelCommand(context.Background(), &pb.CancelCommandRequest{OperationId: request.OperationId, SessionId: "tree", ExpectedGeneration: 1}); e != nil {
		t.Fatal(e)
	}
	r := awaitCommand(t, c, request.OperationId)
	assertNoLiveCommandPID(t, pid)
	if r.Phase != pb.CommandPhase_COMMAND_PHASE_CANCELLED || !r.CleanupConfirmed {
		t.Fatalf("cancel not confirmed: %v %s", r.Phase, r.ReasonCode)
	}
}

func TestRealCommandWorkerDeathLeavesGuardianToCleanAndNeverReplays(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix guardian fixture")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	root := t.TempDir()
	c := realCommandClient(t, dir)
	commandFixture(t, c, root, "tree", []string{"-c", "echo started >> effects; sleep 30 & echo $! > child.pid; wait"}, "/bin/sh")
	request := runInput("owner/workspace/run/death", "tree", nil)
	if _, err := c.RunCommand(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(root, "child.pid")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command not started")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := c.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err == nil {
		t.Fatal("lost connection falsely claimed confirmed cleanup")
	}
	var restarted *Client
	deadline = time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		restarted, err = Start(context.Background(), Options{Executable: os.Getenv("ARMADRA_TEST_REAL_WORKER"), HostID: strings.Repeat("c", 32), StateDir: dir})
		if err == nil {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if restarted == nil {
		t.Fatal("guardian never released state ownership")
	}
	defer restarted.Close()
	receipt, err := restarted.LookupCommand(context.Background(), request.OperationId)
	if err != nil {
		t.Fatal(err)
	}
	data, pidErr := os.ReadFile(filepath.Join(root, "child.pid"))
	if pidErr != nil {
		t.Fatal(pidErr)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	assertNoLiveCommandPID(t, pid)
	if receipt.Phase != pb.CommandPhase_COMMAND_PHASE_CANCELLED || !receipt.CleanupConfirmed {
		t.Fatalf("guardian failed cleanup: %v %s", receipt.Phase, receipt.ReasonCode)
	}
	repeated, err := restarted.RunCommand(context.Background(), request)
	if err != nil || repeated.Sequence != receipt.Sequence {
		t.Fatal("restart replay changed receipt", err)
	}
	effects, err := os.ReadFile(filepath.Join(root, "effects"))
	if err != nil || string(effects) != "started\n" {
		t.Fatal("execution repeated after Worker death", err)
	}
	if err = restarted.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertNoLiveCommandPID(t *testing.T, pid int) {
	t.Helper()
	if pid <= 1 {
		t.Fatal("invalid fixture PID")
	}
	output, err := exec.Command("/bin/ps", "-p", strconv.Itoa(pid), "-o", "stat=").Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
			t.Fatal("cannot independently verify fixture child", err)
		}
	}
	state := strings.TrimSpace(string(output))
	if state != "" && !strings.HasPrefix(state, "Z") {
		t.Fatalf("fixture descendant remains live: %s", state)
	}
}

func TestRealCommandSafeRetryRequiresExplicitReceiptCAS(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix command fixture")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	root := t.TempDir()
	c := realCommandClient(t, dir)
	defer c.Close()
	commandFixture(t, c, root, "retry", []string{"-c", `read value; if [ "$value" = block ]; then sleep 30; else printf '%s' "$value"; fi`}, "/bin/sh")
	first := runInput("owner/workspace/run/block", "retry", []byte("block\n"))
	if _, err := c.RunCommand(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	second := runInput("owner/workspace/run/retry", "retry", []byte("done\n"))
	proof, err := c.RunCommand(context.Background(), second)
	if err != nil || proof.Phase != pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED || !proof.NoEffectProven || !proof.CleanupConfirmed {
		t.Fatalf("busy target lacked proof: %v %v", proof, err)
	}
	if _, err = c.CancelCommand(context.Background(), &pb.CancelCommandRequest{OperationId: first.OperationId, SessionId: "retry", ExpectedGeneration: 1}); err != nil {
		t.Fatal(err)
	}
	awaitCommand(t, c, first.OperationId)
	replay, err := c.RunCommand(context.Background(), second)
	if err != nil || replay.Sequence != proof.Sequence {
		t.Fatal("default replay unexpectedly retried", err)
	}
	second.ExpectedNotDispatchedSequence = proof.Sequence
	started, err := c.RunCommand(context.Background(), second)
	if err != nil || started.Sequence <= proof.Sequence {
		t.Fatal("explicit safe retry rejected", err)
	}
	receipt := awaitCommand(t, c, second.OperationId)
	if receipt.Phase != pb.CommandPhase_COMMAND_PHASE_SUCCEEDED || string(receipt.Stdout) != "done" {
		t.Fatalf("safe retry failed: %v %s", receipt.Phase, receipt.ReasonCode)
	}
	duplicate, err := c.RunCommand(context.Background(), second)
	if err != nil || duplicate.Sequence != receipt.Sequence {
		t.Fatal("retry request replay executed again", err)
	}
	second.ExpectedNotDispatchedSequence = receipt.Sequence
	if _, err = c.RunCommand(context.Background(), second); err == nil {
		t.Fatal("success receipt incorrectly granted retry")
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}
}
func TestRealCommandInputFailureCannotSucceedAndOutputIsBounded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix command fixture")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	root := t.TempDir()
	c := realCommandClient(t, dir)
	defer c.Close()
	commandFixture(t, c, root, "reject-input", []string{"-c", "exec 0<&-; sleep 0.05; exit 0"}, "/bin/sh")
	input := runInput("owner/workspace/run/input", "reject-input", bytes.Repeat([]byte("x"), 256<<10))
	if _, err := c.RunCommand(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	receipt := awaitCommand(t, c, input.OperationId)
	if receipt.Phase != pb.CommandPhase_COMMAND_PHASE_FAILED || receipt.GetExitCode() != 0 || !receipt.CleanupConfirmed {
		t.Fatalf("I/O failure reported success or uncertainty: %v %s", receipt.Phase, receipt.ReasonCode)
	}
	commandFixture(t, c, root, "large-output", []string{"-c", "head -c 700000 /dev/zero"}, "/bin/sh")
	request := runInput("owner/workspace/run/output", "large-output", nil)
	if _, err := c.RunCommand(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	receipt = awaitCommand(t, c, request.OperationId)
	if receipt.Phase != pb.CommandPhase_COMMAND_PHASE_SUCCEEDED || len(receipt.Stdout) != 256<<10 || receipt.StdoutTotalBytes != 700000 || !receipt.StdoutTruncated {
		t.Fatalf("output capture not bounded: phase=%v length=%d total=%d", receipt.Phase, len(receipt.Stdout), receipt.StdoutTotalBytes)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
}
