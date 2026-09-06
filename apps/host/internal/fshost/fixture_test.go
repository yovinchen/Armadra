package fshost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	fixtureHost = "0123456789abcdef0123456789abcdef"
	importID    = "abcdef0123456789abcdef0123456789"
	localID     = "workspace-local"
	remoteID    = "workspace-remote"
)

var fixtureContext = context.Background()

type fixture struct {
	t        *testing.T
	store    *storage.Store
	service  *Service
	switches *ownership.Service
	clock    time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dataDir := t.TempDir()
	store, err := storage.Open(dataDir, fixtureHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	clock := time.UnixMilli(1788560523004)
	service, err := New(Options{Store: store, HostID: fixtureHost, Now: func() time.Time { return clock }})
	if err != nil {
		t.Fatal(err)
	}
	switches, err := ownership.New(ownership.Options{
		Store:      store,
		InstanceID: fixtureHost,
		Projectors: map[string]ownership.Projector{Domain: service.AsProjector()},
		Now:        func() time.Time { return clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, store: store, service: service, switches: switches, clock: clock}
}

func (f *fixture) caller(permission string, workspaceID string) Caller {
	return Caller{
		PrincipalID: "principal",
		DeviceID:    "device",
		DeviceEpoch: 1,
		WorkspaceID: workspaceID,
		Scopes: []auth.Scope{
			{Permission: permission, WorkspaceID: workspaceID, ExecutionHostID: fixtureHost},
		},
	}
}

func text(name, value string) *pb.ImportedSqlColumn {
	return &pb.ImportedSqlColumn{Name: name, Value: &pb.ImportedSqlColumn_TextValue{TextValue: value}}
}

// stageWorkspace stores one `workspaces` row exactly as `armadra-host import`
// does: an `ImportedSqlRow` under `legacy.workspaces`, keyed by the import and
// the digest of its primary key.
func (f *fixture) stageWorkspace(id, rootPath, executionHost, permissions string) {
	f.t.Helper()
	row := &pb.ImportedSqlRow{Table: "workspaces", Columns: []*pb.ImportedSqlColumn{
		text("id", id),
		text("name", "工作区"),
		text("root_path", rootPath),
		text("execution_host_id", executionHost),
		text("permissions_json", permissions),
		text("created_at", "2026-09-01T10:00:00Z"),
		text("updated_at", "2026-09-02T10:00:00Z"),
	}}
	encoded, err := proto.Marshal(row)
	if err != nil {
		f.t.Fatal(err)
	}
	key, err := proto.Marshal(&pb.ImportedSqlRow{Table: "workspaces", Columns: []*pb.ImportedSqlColumn{text("id", id)}})
	if err != nil {
		f.t.Fatal(err)
	}
	sum := sha256.Sum256(key)
	if _, err = f.store.Apply(fixtureContext, "migration/"+importID+"/"+id, []storage.Change{{
		Key:     storage.Key{Kind: legacyWorkspaces, ID: importID + "." + hex.EncodeToString(sum[:]), WorkspaceID: id},
		Payload: encoded,
	}}); err != nil {
		f.t.Fatal(err)
	}
}

// stageBoth seeds the two workspaces every test starts from: one on this
// machine, one on an execution host.
func (f *fixture) stageBoth() {
	f.t.Helper()
	f.stageWorkspace(localID, "/项目/一", "", `{"read":true,"write":true,"execute":false}`)
	f.stageWorkspace(remoteID, "/srv/项目", "构建机", `{"read":true,"write":false,"execute":false}`)
}

// own records the domain as settled on this Host, which is what every write
// path checks before it does anything.
func (f *fixture) own() {
	f.t.Helper()
	if _, err := f.store.PutOwnership(fixtureContext, storage.Ownership{
		Domain:      Domain,
		Owner:       storage.OwnerHost,
		Epoch:       2,
		Phase:       storage.OwnershipSettled,
		ReasonCode:  ownership.ReasonVerified,
		CreatedAtMS: f.clock.UnixMilli(),
		UpdatedAtMS: f.clock.UnixMilli(),
	}, 0); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) root(workspaceID string) storage.WorkspaceRoot {
	f.t.Helper()
	root, err := f.service.Root(fixtureContext, workspaceID)
	if err != nil {
		f.t.Fatal(err)
	}
	return root
}
