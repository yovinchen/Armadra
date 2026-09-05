package storage

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"math"
	"strings"
	"testing"
)

func testRoot(t *testing.T, store *Store) CommandRoot {
	t.Helper()
	root, err := store.PutCommandRoot(testContext, CommandRoot{RootID: "root-1", WorkspaceID: "workspace-a", Path: "/项目/仓库", CreatedAtMS: 10})
	if err != nil {
		t.Fatal(err)
	}
	return root
}
func testSession(t *testing.T, store *Store, id string, launch string, generation uint64) CommandSession {
	t.Helper()
	digest := sha256.Sum256([]byte(launch))
	record, err := store.PutCommandSession(testContext, CommandSession{SessionID: id, RootID: "root-1", WorkspaceID: "workspace-a", ExecutionHostID: testHost, Launch: []byte(launch), LaunchSHA256: digest, Generation: generation, State: CommandSessionReady, CreatedAtMS: 11, UpdatedAtMS: 11})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestFrozenCommandDefinitionsSurviveAndRefuseSilentChange(t *testing.T) {
	store, dir := openTestStore(t)
	testRoot(t, store)
	if _, err := store.PutCommandRoot(testContext, CommandRoot{RootID: "root-1", WorkspaceID: "workspace-a", Path: "/项目/仓库", CreatedAtMS: 99}); err != nil {
		t.Fatal("identical rebinding was not idempotent:", err)
	}
	if _, err := store.PutCommandRoot(testContext, CommandRoot{RootID: "root-1", WorkspaceID: "workspace-a", Path: "/另一个", CreatedAtMS: 10}); !errors.Is(err, ErrConflict) {
		t.Fatal("a root path silently moved")
	}
	if _, err := store.PutCommandRoot(testContext, CommandRoot{RootID: "root-1", WorkspaceID: "workspace-b", Path: "/项目/仓库", CreatedAtMS: 10}); !errors.Is(err, ErrConflict) {
		t.Fatal("a root changed workspace owner")
	}
	session := testSession(t, store, "session-1", "launch-a", 1)
	if session.Revision != 1 || session.State != CommandSessionReady {
		t.Fatal("new session is not a ready revision 1")
	}
	if again := testSession(t, store, "session-1", "launch-a", 1); again.Revision != 1 || again.CreatedAtMS != 11 {
		t.Fatal("re-defining an identical session was not idempotent")
	}
	if _, err := store.PutCommandSession(testContext, CommandSession{SessionID: "session-1", RootID: "root-1", WorkspaceID: "workspace-a", ExecutionHostID: testHost, Launch: []byte("launch-b"), LaunchSHA256: sha256.Sum256([]byte("launch-b")), Generation: 1, State: CommandSessionReady, CreatedAtMS: 11, UpdatedAtMS: 11}); !errors.Is(err, ErrConflict) {
		t.Fatal("a frozen launch specification was replaced in place")
	}
	// Reopening the same directory must recover the definitions verbatim: this
	// is what a replaced Worker is rebuilt from.
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	roots, err := reopened.CommandRoots(testContext)
	if err != nil || len(roots) != 1 || roots[0].Path != "/项目/仓库" {
		t.Fatalf("roots did not survive a restart: %v %v", roots, err)
	}
	restored, err := reopened.CommandSession(testContext, "session-1")
	if err != nil || !bytes.Equal(restored.Launch, []byte("launch-a")) || restored.Generation != 1 {
		t.Fatalf("session did not survive a restart: %v", err)
	}
}

func TestUnrebuildableSessionIsRecordedNotSilent(t *testing.T) {
	store, _ := openTestStore(t)
	testRoot(t, store)
	session := testSession(t, store, "session-1", "launch-a", 4)
	updated, err := store.UpdateCommandSession(testContext, "session-1", session.Revision, 4, CommandSessionUnrebuildable, "GENERATION_CHANGED", 20)
	if err != nil || updated.Revision != 2 || updated.State != CommandSessionUnrebuildable || updated.ReasonCode != "GENERATION_CHANGED" {
		t.Fatalf("rebuild failure was not recorded: %+v %v", updated, err)
	}
	if _, err = store.UpdateCommandSession(testContext, "session-1", session.Revision, 4, CommandSessionReady, "", 21); !errors.Is(err, ErrConflict) {
		t.Fatal("a stale revision overwrote the recorded state")
	}
	if _, err = store.UpdateCommandSession(testContext, "session-1", updated.Revision, 4, CommandSessionReady, "STILL_BROKEN", 21); !errors.Is(err, ErrInvalid) {
		t.Fatal("ready state kept a failure reason")
	}
	if _, err = store.UpdateCommandSession(testContext, "session-1", updated.Revision, 0, CommandSessionReady, "", 21); !errors.Is(err, ErrInvalid) {
		t.Fatal("generation zero accepted")
	}
	recovered, err := store.UpdateCommandSession(testContext, "session-1", updated.Revision, 9, CommandSessionReady, "", 22)
	if err != nil || recovered.Generation != 9 || recovered.ReasonCode != "" || recovered.Revision != 3 {
		t.Fatalf("a later successful rebuild did not clear the reason: %+v %v", recovered, err)
	}
	page, err := store.CommandSessions(testContext, "workspace-a", "", 10)
	if err != nil || len(page) != 1 || page[0].Generation != 9 {
		t.Fatalf("workspace listing: %v %v", page, err)
	}
	if page, err = store.CommandSessions(testContext, "workspace-b", "", 10); err != nil || len(page) != 0 {
		t.Fatalf("another workspace read this definition: %v %v", page, err)
	}
	if page, err = store.CommandSessions(testContext, "", "", 10); err != nil || len(page) != 1 {
		t.Fatalf("host-wide rebuild listing: %v %v", page, err)
	}
}

func TestAutomationPayloadsAreImmutableAndScoped(t *testing.T) {
	store, _ := openTestStore(t)
	body := []byte("无人值守执行\n")
	digest := sha256.Sum256(body)
	record := AutomationPayload{WorkspaceID: "workspace-a", Ref: "payload-1", Payload: body, SHA256: digest, CreatedAtMS: 5}
	if err := store.PutAutomationPayload(testContext, record); err != nil {
		t.Fatal(err)
	}
	if err := store.PutAutomationPayload(testContext, record); err != nil {
		t.Fatal("identical payload was not idempotent:", err)
	}
	changed := record
	changed.Payload = []byte("其他内容")
	if err := store.PutAutomationPayload(testContext, changed); !errors.Is(err, ErrConflict) {
		t.Fatal("a frozen payload reference was rewritten")
	}
	stored, err := store.AutomationPayload(testContext, "workspace-a", "payload-1")
	if err != nil || !bytes.Equal(stored.Payload, body) || stored.SHA256 != digest {
		t.Fatalf("payload read: %v", err)
	}
	if _, err = store.AutomationPayload(testContext, "workspace-b", "payload-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("another workspace resolved this payload")
	}
	oversize := AutomationPayload{WorkspaceID: "workspace-a", Ref: "payload-2", Payload: make([]byte, MaxAutomationPayloadBytes+1), CreatedAtMS: 5}
	if err = store.PutAutomationPayload(testContext, oversize); !errors.Is(err, ErrInvalid) {
		t.Fatal("payload budget not enforced")
	}
}

func TestAutomationGrantTracksLiveDeviceState(t *testing.T) {
	store, _ := openTestStore(t)
	owner := strings.Repeat("a", 32)
	device := strings.Repeat("b", 32)
	if err := store.IdentityTransaction(testContext, func(tx *IdentityTx) error {
		if err := tx.CreateOwner(IdentityOwner{PrincipalID: owner, CreatedAtMS: 1}); err != nil {
			return err
		}
		return tx.CreateDevice(IdentityDevice{ID: device, PrincipalID: owner, Name: "手机", Role: "owner", Epoch: 1, CreatedAtMS: 1})
	}); err != nil {
		t.Fatal(err)
	}
	grant := AutomationGrant{AuthorizationID: device, PrincipalID: owner, DeviceID: device, DeviceEpoch: 1, Scopes: []byte(`[{"Permission":"automation:manage"}]`), CreatedAtMS: 2, UpdatedAtMS: 2}
	if err := store.PutAutomationGrant(testContext, grant); err != nil {
		t.Fatal(err)
	}
	stored, epoch, revoked, err := store.AutomationGrant(testContext, device)
	if err != nil || stored.DeviceEpoch != 1 || epoch != 1 || revoked != 0 {
		t.Fatalf("grant read: %+v %d %d %v", stored, epoch, revoked, err)
	}
	// Revoking the device must be visible to a later dispatch check without any
	// browser credential and without rewriting the recorded grant.
	if err = store.IdentityTransaction(testContext, func(tx *IdentityTx) error {
		return tx.RevokeDevice(device, 1, 9)
	}); err != nil {
		t.Fatal(err)
	}
	stored, epoch, revoked, err = store.AutomationGrant(testContext, device)
	if err != nil || stored.DeviceEpoch != 1 || epoch != 2 || revoked != 9 {
		t.Fatalf("revocation invisible to dispatch: %+v %d %d %v", stored, epoch, revoked, err)
	}
	moved := grant
	moved.DeviceID = strings.Repeat("c", 32)
	if err = store.PutAutomationGrant(testContext, moved); !errors.Is(err, ErrConflict) {
		t.Fatal("a grant moved to another device")
	}
	if _, _, _, err = store.AutomationGrant(testContext, strings.Repeat("d", 32)); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown grant resolved")
	}
	overflow := grant
	overflow.DeviceEpoch = math.MaxUint64
	if err = store.PutAutomationGrant(testContext, overflow); !errors.Is(err, ErrCounterExhausted) {
		t.Fatal("epoch overflow accepted")
	}
}
