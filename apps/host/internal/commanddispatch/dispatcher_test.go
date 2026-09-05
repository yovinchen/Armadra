package commanddispatch

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
)

type testPayload []byte

func (p testPayload) Resolve(_ context.Context, workspace, reference string) ([]byte, error) {
	if workspace != "workspace" || reference != "payload" {
		return nil, errors.New("scope mismatch")
	}
	return append([]byte(nil), p...), nil
}

type testAuth struct{}

func (testAuth) Verify(_ context.Context, a automation.Authorization, _ *pb.AutomationPlanConfig) error {
	if a.PrincipalID != "owner" {
		return errors.New("unauthorized")
	}
	return nil
}
func TestUncertainDispatchNeverBecomesSafeRetry(t *testing.T) {
	for _, phase := range []pb.CommandPhase{pb.CommandPhase_COMMAND_PHASE_PREPARED, pb.CommandPhase_COMMAND_PHASE_STARTING, pb.CommandPhase_COMMAND_PHASE_UNKNOWN, pb.CommandPhase_COMMAND_PHASE_CANCEL_REQUESTED} {
		r := mapReceipt(&pb.CommandReceipt{Phase: phase})
		if r.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_UNKNOWN {
			t.Fatal("uncertain phase granted retry", phase)
		}
	}
	if mapReceipt(&pb.CommandReceipt{Phase: pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED, NoEffectProven: true}).Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_UNKNOWN {
		t.Fatal("unconfirmed cleanup granted retry")
	}
}
func TestRealZeroUIEngineRunToRustCommandReceipt(t *testing.T) {
	binary := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if binary == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to built Rust binary")
	}
	if runtime.GOOS == "windows" {
		t.Skip("Unix real command fixture")
	}
	host := strings.Repeat("d", 32)
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	root := t.TempDir()
	ctx := context.Background()
	client, err := worker.Start(ctx, worker.Options{Executable: binary, HostID: host, StateDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err = client.BindCommandRoot(ctx, &pb.BindCommandRootRequest{RootId: "root", WorkspaceId: "workspace", Path: root}); err != nil {
		t.Fatal(err)
	}
	if _, err = client.CreateCommandSession(ctx, &pb.CreateCommandSessionRequest{SessionId: "command", RootId: "root", WorkspaceId: "workspace", Kind: pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND, Launch: &pb.CommandLaunchSpec{Executable: "/bin/cat", WorkingDirectory: ".", AccountId: "default", TimeoutMs: 10000}}); err != nil {
		t.Fatal(err)
	}
	payload := testPayload("无人值守执行\n")
	dispatcher, err := New(client, payload)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	engine, err := automation.New(db, dispatcher, testAuth{}, automation.Options{PollInterval: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	config := &pb.AutomationPlanConfig{WorkspaceId: "workspace", Title: "No UI command", Target: &pb.AutomationTarget{ExecutionHostId: host, SessionId: "command", Generation: 1}, Schedule: &pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Once{Once: &pb.AutomationOnce{AtUnixMs: time.Now().Add(100 * time.Millisecond).UnixMilli()}}}, PayloadRef: "payload", PayloadSha256: digest[:], MaxRuns: 1}
	auth := automation.Authorization{PrincipalID: "owner", AuthorizationID: "grant-1"}
	plan, err := engine.Define(ctx, auth, "plan", config, 0)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := automation.ConfigurationHash(plan.Plan.Config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = engine.Activate(ctx, auth, "workspace", "plan", plan.Revision, plan.Plan.ConfigVersion, hash); err != nil {
		t.Fatal(err)
	}
	loopCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- engine.Run(loopCtx) }()
	var completed *pb.AutomationRun
	until := time.Now().Add(12 * time.Second)
	for time.Now().Before(until) {
		page, e := engine.ListRuns(ctx, "workspace", "plan", "", 10)
		if e != nil {
			t.Fatal(e)
		}
		if len(page.Runs) == 1 && page.Runs[0].Run.State == automation.Succeeded {
			completed = page.Runs[0].Run
			break
		}
		select {
		case e := <-done:
			t.Fatalf("loop failed: %v", e)
		default:
		}
		time.Sleep(30 * time.Millisecond)
	}
	cancel()
	if completed == nil {
		page, _ := engine.ListRuns(ctx, "workspace", "plan", "", 10)
		t.Fatalf("no successful receipt: %+v", page.Runs)
	}
	if err = <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	receipt, err := client.LookupCommand(ctx, completed.OperationId)
	if err != nil || string(receipt.GetStdout()) != string(payload) || !receipt.GetCleanupConfirmed() {
		t.Fatalf("Rust receipt mismatch: %v", err)
	}
	if err = engine.Observe(ctx, mapReceipt(receipt)); err != nil {
		t.Fatal(err)
	}
	page, _ := engine.ListRuns(ctx, "workspace", "plan", "", 10)
	if len(page.Runs) != 1 {
		t.Fatal("duplicate completion repeated execution")
	}
	if err = client.Close(); err != nil {
		t.Fatal(err)
	}
}
