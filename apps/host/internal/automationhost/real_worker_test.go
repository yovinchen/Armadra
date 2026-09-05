package automationhost

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"armadra.local/host/internal/storage"
)

// killWorker terminates the owned Worker the way a crash would: no shutdown
// handshake, no cleanup confirmation. The Host must notice and rebuild.
func killWorker(t *testing.T, stateDir string) int {
	t.Helper()
	// The child receives the symlink-resolved directory, so match on that.
	resolved, err := filepath.EvalSymlinks(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("pgrep", "-f", resolved).Output()
	if err != nil {
		t.Fatal("no Worker process matched the state directory:", err)
	}
	killed := 0
	for _, line := range strings.Fields(string(output)) {
		pid, convert := strconv.Atoi(line)
		if convert != nil || pid <= 1 || pid == os.Getpid() {
			continue
		}
		if syscall.Kill(pid, syscall.SIGKILL) == nil {
			killed++
		}
	}
	if killed == 0 {
		t.Fatal("no Worker process was terminated")
	}
	return killed
}

func realWorkerService(t *testing.T) (*Service, *storage.Store, string, string) {
	t.Helper()
	binary := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if binary == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to the built Rust Runtime binary")
	}
	if runtime.GOOS == "windows" {
		t.Skip("Unix command fixture")
	}
	store := testStore(t)
	pairDevice(t, store)
	state := t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	service, err := New(context.Background(), Options{Executable: binary, StateDir: state, HostID: testHost, InstanceID: strings.Repeat("c", 32), Store: store, PollInterval: 20 * time.Millisecond, RestartBackoff: 20 * time.Millisecond, HealthyAfter: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	return service, store, state, root
}

func testCaller() Caller {
	return Caller{PrincipalID: testOwner, DeviceID: testDevice, DeviceEpoch: 1, WorkspaceID: "workspace", Scopes: grantScopes(ScopeManage, ScopeRead)}
}

func TestRealWorkerSchedulesWithNoClientAndRebuildsAfterACrash(t *testing.T) {
	service, store, state, root := realWorkerService(t)
	ctx := context.Background()
	caller := testCaller()
	session, err := service.DefineCommandSession(ctx, caller, "command", root, &pb.CommandLaunchSpec{Executable: "/bin/cat", WorkingDirectory: ".", AccountId: "default", TimeoutMs: 10000})
	if err != nil {
		t.Fatal(err)
	}
	if session.State != pb.AutomationCommandSessionState_AUTOMATION_COMMAND_SESSION_STATE_READY || session.Generation == 0 {
		t.Fatalf("session definition: %+v", session)
	}
	payload := []byte("无人值守执行\n")
	config := &pb.AutomationPlanConfig{
		WorkspaceId: "workspace",
		Title:       "无客户端计划",
		Target:      &pb.AutomationTarget{ExecutionHostId: testHost, SessionId: "command", Generation: session.Generation},
		Schedule:    &pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Once{Once: &pb.AutomationOnce{AtUnixMs: time.Now().Add(150 * time.Millisecond).UnixMilli()}}},
		MaxRuns:     1,
	}
	plan, err := service.Define(ctx, caller, "plan", config, payload, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Plan.Config.PayloadRef == "" || len(plan.ConfigSha256) != 32 {
		t.Fatal("Host did not own the payload reference")
	}
	if _, err = service.Activate(ctx, caller, "plan", plan.Revision, plan.Plan.ConfigVersion, plan.ConfigSha256); err != nil {
		t.Fatal(err)
	}
	loop, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- service.Run(loop) }()
	run := awaitRun(t, service, caller, "plan", automation.Succeeded, 15*time.Second)
	receipt, err := service.Lookup(ctx, run.Run)
	if err != nil || receipt.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED {
		t.Fatalf("Worker receipt: %+v %v", receipt, err)
	}

	// The Worker dies without a handshake. Supervision must replace it and
	// re-apply the frozen definition with the same generation.
	before, _, _ := service.current()
	killWorker(t, state)
	deadline := time.Now().Add(20 * time.Second)
	replaced := false
	for time.Now().Before(deadline) && !replaced {
		client, inner, _ := service.current()
		replaced = client != nil && inner != nil && client != before
		if !replaced {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if !replaced {
		t.Fatal("Worker was not restarted:", service.Unavailable())
	}
	rebuilt, err := store.CommandSession(ctx, "command")
	if err != nil || rebuilt.State != storage.CommandSessionReady || rebuilt.Generation != session.Generation {
		t.Fatalf("definition was not rebuilt: %+v %v", rebuilt, err)
	}
	status, err := service.Supports(ctx, &pb.AutomationTarget{ExecutionHostId: testHost, SessionId: "command", Generation: session.Generation})
	if err != nil || status.State != automation.TargetReady {
		t.Fatalf("rebuilt target is not ready: %v %v", status.State, err)
	}

	// The completed one-shot plan must not run a second time on the new Worker.
	runs, err := service.ListRuns(ctx, caller, "plan", "", 50)
	if err != nil || len(runs.Runs) != 1 || runs.Runs[0].Run.State != automation.Succeeded {
		t.Fatalf("a restart replayed a delivered run: %+v %v", runs.Runs, err)
	}
	cancel()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if err = service.Close(); err != nil {
		t.Fatal("Worker cleanup was not confirmed:", err)
	}
}

func awaitRun(t *testing.T, service *Service, caller Caller, plan string, state pb.AutomationRunState, budget time.Duration) *pb.AutomationRunSnapshot {
	t.Helper()
	deadline := time.Now().Add(budget)
	var last *pb.ListAutomationRunsResponse
	for time.Now().Before(deadline) {
		page, err := service.ListRuns(context.Background(), caller, plan, "", 50)
		if err != nil {
			t.Fatal(err)
		}
		last = page
		for _, run := range page.Runs {
			if run.Run.State == state {
				return run
			}
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatalf("no run reached %v: %+v", state, last)
	return nil
}

// A replaced Worker keeps nothing of its own: the Host must rebuild its stored
// definitions on it, and record an explicit failure when it cannot.
func TestRealWorkerRebuildsDefinitionsOnReplacedWorkerState(t *testing.T) {
	service, store, state, root := realWorkerService(t)
	ctx := context.Background()
	caller := testCaller()
	binary := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	session, err := service.DefineCommandSession(ctx, caller, "command", root, &pb.CommandLaunchSpec{Executable: "/bin/cat", WorkingDirectory: ".", AccountId: "default", TimeoutMs: 10000})
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if err = os.RemoveAll(filepath.Join(state, entry.Name())); err != nil {
			t.Fatal(err)
		}
	}
	options := Options{Executable: binary, StateDir: state, HostID: testHost, InstanceID: strings.Repeat("c", 32), Store: store, PollInterval: 20 * time.Millisecond, RestartBackoff: 20 * time.Millisecond, HealthyAfter: time.Hour}
	rebuilt, err := New(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	status, err := rebuilt.Supports(ctx, &pb.AutomationTarget{ExecutionHostId: testHost, SessionId: "command", Generation: session.Generation})
	if err != nil || status.State != automation.TargetReady {
		t.Fatalf("definition was not rebuilt on the replaced Worker: %v %v", status.State, err)
	}
	record, err := store.CommandSession(ctx, "command")
	if err != nil || record.State != storage.CommandSessionReady || record.Generation != session.Generation {
		t.Fatalf("stored definition after rebuild: %+v %v", record, err)
	}
	if err = rebuilt.Close(); err != nil {
		t.Fatal(err)
	}

	// Removing the root makes the definition impossible to rebuild. The Host
	// must say so instead of leaving plans waiting on a dead target.
	if err = os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	if entries, err = os.ReadDir(state); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if err = os.RemoveAll(filepath.Join(state, entry.Name())); err != nil {
			t.Fatal(err)
		}
	}
	broken, err := New(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer broken.Close()
	if record, err = store.CommandSession(ctx, "command"); err != nil || record.State != storage.CommandSessionUnrebuildable || record.ReasonCode == "" {
		t.Fatalf("a failed rebuild stayed silent: %+v %v", record, err)
	}
	if status, err = broken.Supports(ctx, &pb.AutomationTarget{ExecutionHostId: testHost, SessionId: "command", Generation: session.Generation}); err != nil || status.State != automation.TargetUnsupported {
		t.Fatalf("an unrebuildable target is not refused: %v %v", status.State, err)
	}
}

func TestRealWorkerRefusesAPlanWhoseDefinitionCannotBeRebuilt(t *testing.T) {
	service, store, _, root := realWorkerService(t)
	ctx := context.Background()
	caller := testCaller()
	session, err := service.DefineCommandSession(ctx, caller, "command", root, &pb.CommandLaunchSpec{Executable: "/bin/cat", WorkingDirectory: ".", AccountId: "default", TimeoutMs: 10000})
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.CommandSession(ctx, "command")
	if err != nil {
		t.Fatal(err)
	}
	// Record the outcome a failed rebuild produces, then confirm a plan is
	// refused outright instead of waiting on a target that cannot run.
	if _, err = store.UpdateCommandSession(ctx, "command", record.Revision, record.Generation, storage.CommandSessionUnrebuildable, "REBUILD_FAILED", time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	config := &pb.AutomationPlanConfig{
		WorkspaceId: "workspace",
		Title:       "不可执行",
		Target:      &pb.AutomationTarget{ExecutionHostId: testHost, SessionId: "command", Generation: session.Generation},
		Schedule:    &pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Once{Once: &pb.AutomationOnce{AtUnixMs: time.Now().Add(time.Hour).UnixMilli()}}},
	}
	if _, err = service.Define(ctx, caller, "plan", config, []byte("x"), 0); !errors.Is(err, ErrUnsupported) {
		t.Fatal("an unrebuildable target accepted a new plan:", err)
	}
	listed, err := service.ListCommandSessions(ctx, caller, "", 10)
	if err != nil || len(listed.Sessions) != 1 || listed.Sessions[0].ReasonCode != "REBUILD_FAILED" {
		t.Fatalf("the failure reason is not visible: %+v %v", listed, err)
	}
}
