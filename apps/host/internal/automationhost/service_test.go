package automationhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	testHost   = "0123456789abcdef0123456789abcdef"
	testOwner  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testDevice = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

var testContext = context.Background()

func testStore(t *testing.T) *storage.Store {
	t.Helper()
	store, err := storage.Open(t.TempDir(), testHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// offline builds the Host-owned half of the service without an execution
// Worker: exactly the state a stopped or crashed Worker leaves behind.
func offline(t *testing.T, store *storage.Store) *Service {
	t.Helper()
	return &Service{options: Options{HostID: testHost, Store: store}, store: store, clock: time.Now, reason: "WORKER_NOT_STARTED"}
}

func storedSession(t *testing.T, store *storage.Store, id string, generation uint64) storage.CommandSession {
	t.Helper()
	if _, err := store.PutCommandRoot(testContext, storage.CommandRoot{RootID: "root-1", WorkspaceID: "workspace", Path: "/tmp", CreatedAtMS: 1}); err != nil {
		t.Fatal(err)
	}
	launch, err := (proto.MarshalOptions{Deterministic: true}).Marshal(&pb.CommandLaunchSpec{Executable: "/bin/echo", WorkingDirectory: ".", AccountId: "default", TimeoutMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.PutCommandSession(testContext, storage.CommandSession{SessionID: id, RootID: "root-1", WorkspaceID: "workspace", ExecutionHostID: testHost, Launch: launch, LaunchSHA256: sha256.Sum256(launch), Generation: generation, State: storage.CommandSessionReady, CreatedAtMS: 1, UpdatedAtMS: 1})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func target(session string, generation uint64) *pb.AutomationTarget {
	return &pb.AutomationTarget{ExecutionHostId: testHost, SessionId: session, Generation: generation}
}

func TestTargetSupportAnswersFromStoredDefinitions(t *testing.T) {
	store := testStore(t)
	service := offline(t, store)
	record := storedSession(t, store, "session-1", 3)
	for name, check := range map[string]struct {
		target *pb.AutomationTarget
		state  automation.TargetState
	}{
		"another execution host": {target: &pb.AutomationTarget{ExecutionHostId: "1111111111111111ffffffffffffffff", SessionId: "session-1", Generation: 3}, state: automation.TargetUnsupported},
		"unknown session":        {target: target("missing", 1), state: automation.TargetUnsupported},
		"stale generation":       {target: target("session-1", 2), state: automation.TargetUnsupported},
		"missing target":         {target: nil, state: automation.TargetUnsupported},
	} {
		status, err := service.Supports(testContext, check.target)
		if err != nil || status.State != check.state {
			t.Fatalf("%s: %v %v", name, status.State, err)
		}
	}
	// A matching definition with no live Worker is unknown, never ready: an
	// offline executor must not look like an idle one.
	status, err := service.Supports(testContext, target("session-1", 3))
	if status.State != automation.TargetUnknown || !errors.Is(err, ErrUnsupported) {
		t.Fatalf("offline Worker reported %v %v", status.State, err)
	}
	if _, err = service.Dispatch(testContext, &pb.AutomationRun{}); !errors.Is(err, ErrUnsupported) {
		t.Fatal("dispatch reached an absent Worker:", err)
	}
	if _, err = service.Lookup(testContext, "operation"); !errors.Is(err, ErrUnsupported) {
		t.Fatal("lookup invented a receipt:", err)
	}
	// A definition the Host could not rebuild is explicitly unsupported, so a
	// plan is refused rather than left waiting on a target that cannot run.
	if _, err = store.UpdateCommandSession(testContext, "session-1", record.Revision, record.Generation, storage.CommandSessionUnrebuildable, "REBUILD_FAILED", 9); err != nil {
		t.Fatal(err)
	}
	if status, err = service.Supports(testContext, target("session-1", 3)); err != nil || status.State != automation.TargetUnsupported {
		t.Fatalf("unrebuildable target: %v %v", status.State, err)
	}
}

func grantScopes(permissions ...string) []auth.Scope {
	scopes := make([]auth.Scope, 0, len(permissions))
	for _, permission := range permissions {
		scopes = append(scopes, auth.Scope{Permission: permission, WorkspaceID: "workspace", ExecutionHostID: testHost})
	}
	return scopes
}

func pairDevice(t *testing.T, store *storage.Store) {
	t.Helper()
	if err := store.IdentityTransaction(testContext, func(tx *storage.IdentityTx) error {
		if err := tx.CreateOwner(storage.IdentityOwner{PrincipalID: testOwner, CreatedAtMS: 1}); err != nil {
			return err
		}
		return tx.CreateDevice(storage.IdentityDevice{ID: testDevice, PrincipalID: testOwner, Name: "手机", Role: "owner", Epoch: 1, CreatedAtMS: 1})
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchAuthorizationIsRecheckedAgainstLiveDeviceState(t *testing.T) {
	store := testStore(t)
	service := offline(t, store)
	pairDevice(t, store)
	caller := Caller{PrincipalID: testOwner, DeviceID: testDevice, DeviceEpoch: 1, WorkspaceID: "workspace", Scopes: grantScopes(ScopeManage, ScopeRead)}
	if err := service.recordGrant(testContext, caller); err != nil {
		t.Fatal(err)
	}
	authorization := automation.Authorization{PrincipalID: testOwner, AuthorizationID: testDevice}
	config := &pb.AutomationPlanConfig{WorkspaceId: "workspace", Target: target("session-1", 1)}
	if err := service.Verify(testContext, authorization, config); err != nil {
		t.Fatal("a live owner grant was refused:", err)
	}
	other := proto.Clone(config).(*pb.AutomationPlanConfig)
	other.WorkspaceId = "another-workspace"
	if err := service.Verify(testContext, authorization, other); err == nil {
		t.Fatal("a workspace-scoped grant authorized another workspace")
	}
	remote := proto.Clone(config).(*pb.AutomationPlanConfig)
	remote.Target.ExecutionHostId = "1111111111111111ffffffffffffffff"
	if err := service.Verify(testContext, authorization, remote); err == nil {
		t.Fatal("a host-scoped grant authorized another execution host")
	}
	if err := service.Verify(testContext, automation.Authorization{PrincipalID: "someone", AuthorizationID: testDevice}, config); err == nil {
		t.Fatal("another principal reused this device grant")
	}
	// Revoking the device stops new dispatches without touching the plan.
	if err := store.IdentityTransaction(testContext, func(tx *storage.IdentityTx) error {
		return tx.RevokeDevice(testDevice, 1, 5)
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.Verify(testContext, authorization, config); !errors.Is(err, automation.ErrAuthorization) {
		t.Fatal("a revoked device kept dispatching:", err)
	}
}

func TestReadAndManageScopesAreCheckedSeparately(t *testing.T) {
	store := testStore(t)
	service := offline(t, store)
	reader := Caller{PrincipalID: testOwner, DeviceID: testDevice, DeviceEpoch: 1, WorkspaceID: "workspace", Scopes: grantScopes(ScopeRead)}
	if err := service.authorize(reader, ScopeRead); err != nil {
		t.Fatal(err)
	}
	if err := service.authorize(reader, ScopeManage); !errors.Is(err, automation.ErrAuthorization) {
		t.Fatal("a read-only session managed plans:", err)
	}
	elsewhere := reader
	elsewhere.WorkspaceID = "another-workspace"
	if err := service.authorize(elsewhere, ScopeRead); !errors.Is(err, automation.ErrAuthorization) {
		t.Fatal("a workspace grant read another workspace:", err)
	}
	empty := reader
	empty.Scopes = nil
	if err := service.authorize(empty, ScopeRead); !errors.Is(err, automation.ErrAuthorization) {
		t.Fatal("an empty grant list authorized a read:", err)
	}
	var absent *Service
	if err := absent.authorize(reader, ScopeRead); !errors.Is(err, ErrUnsupported) {
		t.Fatal("an unconfigured Host answered a request:", err)
	}
	if absent.Unavailable() != "AUTOMATION_NOT_CONFIGURED" {
		t.Fatal("an unconfigured Host did not say so")
	}
	if err := absent.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPayloadResolutionRequiresItsOwnDigest(t *testing.T) {
	store := testStore(t)
	body := []byte("无人值守执行\n")
	digest := sha256.Sum256(body)
	reference := hex.EncodeToString(digest[:])
	if err := store.PutAutomationPayload(testContext, storage.AutomationPayload{WorkspaceID: "workspace", Ref: reference, Payload: body, SHA256: digest, CreatedAtMS: 1}); err != nil {
		t.Fatal(err)
	}
	resolver := payloads{store}
	value, err := resolver.Resolve(testContext, "workspace", reference)
	if err != nil || string(value) != string(body) {
		t.Fatalf("payload resolution: %v", err)
	}
	if _, err = resolver.Resolve(testContext, "another-workspace", reference); !errors.Is(err, storage.ErrNotFound) {
		t.Fatal("a payload crossed workspaces:", err)
	}
	// A reference that is not its own content digest must never resolve.
	mismatched := strings.Repeat("0", 64)
	if err = store.PutAutomationPayload(testContext, storage.AutomationPayload{WorkspaceID: "workspace", Ref: mismatched, Payload: body, SHA256: digest, CreatedAtMS: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err = resolver.Resolve(testContext, "workspace", mismatched); !errors.Is(err, storage.ErrCorrupt) {
		t.Fatal("a mislabelled payload resolved:", err)
	}
}

func TestRestartBackoffIsBoundedAndGrows(t *testing.T) {
	previous := time.Duration(0)
	for attempt := range 12 {
		delay := backoff(attempt, time.Second, defaultRestartCap)
		if delay < previous || delay > defaultRestartCap {
			t.Fatalf("attempt %d produced %v after %v", attempt, delay, previous)
		}
		previous = delay
	}
	if backoff(0, time.Second, defaultRestartCap) != time.Second {
		t.Fatal("first restart did not use the configured base delay")
	}
	if backoff(20, time.Second, defaultRestartCap) != defaultRestartCap {
		t.Fatal("restart delay is unbounded")
	}
}

func TestUnconfiguredHostRefusesInsteadOfPretending(t *testing.T) {
	store := testStore(t)
	if Configured(Options{}) {
		t.Fatal("an empty configuration enabled automation")
	}
	if !Configured(Options{Executable: "/bin/true"}) {
		t.Fatal("a half configuration was ignored instead of reported")
	}
	if _, err := New(testContext, Options{Store: store, HostID: testHost}); !errors.Is(err, ErrUnsupported) {
		t.Fatal("automation started without an executable:", err)
	}
	if _, err := New(testContext, Options{Store: store, HostID: testHost, Executable: "relative", StateDir: "/tmp"}); err == nil {
		t.Fatal("a relative Worker path was accepted")
	}
}
