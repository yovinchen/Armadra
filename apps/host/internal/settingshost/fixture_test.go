package settingshost

import (
	"context"
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

const fixtureHost = "0123456789abcdef0123456789abcdef"

// A settings document with the two things the tests care about: an ordinary
// preference the Host must carry through untouched, and the SSH registry the
// execution hosts are projected out of.
const baseDocument = `{"theme":"dark","keybindings":{"global":{"toggle":"cmd+k"}},"ssh":{"hosts":[` +
	`{"id":"build-box","name":"构建机","host":"build.example","user":"ci","port":2222,` +
	`"identityFile":"/keys/ci","worker":{"path":"/opt/armadra/worker","stateDir":"/var/lib/armadra"}}]}}`

type fixture struct {
	t       *testing.T
	store   *storage.Store
	service *Service
	caller  Caller
	clock   time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	store, err := storage.Open(t.TempDir(), fixtureHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	f := &fixture{t: t, store: store, clock: time.UnixMilli(1788560523004)}
	f.service, err = New(Options{Store: store, HostID: fixtureHost, Now: func() time.Time { return f.clock }})
	if err != nil {
		t.Fatal(err)
	}
	f.caller = Caller{
		PrincipalID: "owner-1",
		DeviceID:    "device-1",
		DeviceEpoch: 1,
		Scopes: []auth.Scope{
			{Permission: ScopeRead, ExecutionHostID: fixtureHost},
			{Permission: ScopeWrite, ExecutionHostID: fixtureHost},
		},
	}
	return f
}

// own records this Host as the settled owner of the settings domain, which is
// what a write needs. Without it every mutation answers ownership_moved, which
// is the state a Host that has never switched is really in.
func (f *fixture) own() {
	f.t.Helper()
	now := f.clock.UnixMilli()
	_, err := f.store.PutOwnership(f.t.Context(), storage.Ownership{
		Domain:      storage.OwnershipDomainSettings,
		Owner:       storage.OwnerHost,
		Phase:       storage.OwnershipSettled,
		Epoch:       2,
		ReasonCode:  "ownership.switch.verified",
		CreatedAtMS: now,
		UpdatedAtMS: now,
	}, 0)
	if err != nil {
		f.t.Fatal(err)
	}
}

// document builds a well-formed request document: the bytes, and a digest over
// exactly those bytes.
func document(body string) *pb.SettingsDocument {
	return &pb.SettingsDocument{
		Scope:         pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
		Document:      []byte(body),
		Sha256:        digest([]byte(body)),
		SchemaVersion: DocumentSchemaVersion,
	}
}

func (f *fixture) put(operationID, body string, expected uint64) (*pb.PutSettingsResponse, error) {
	f.t.Helper()
	return f.service.Put(f.t.Context(), f.caller, &pb.PutSettingsRequest{
		OperationId:      operationID,
		ExpectedRevision: expected,
		Document:         document(body),
	})
}

func (f *fixture) mustPut(operationID, body string, expected uint64) *pb.PutSettingsResponse {
	f.t.Helper()
	result, err := f.put(operationID, body, expected)
	if err != nil {
		f.t.Fatalf("put %q refused: %v", operationID, err)
	}
	return result
}

func (f *fixture) get() (*pb.GetSettingsResponse, error) {
	f.t.Helper()
	return f.service.Get(f.t.Context(), f.caller, pb.SettingsScope_SETTINGS_SCOPE_GLOBAL, "")
}

// events reads every stored event, projected the way the shared stream would
// project it. The tests assert on what a subscriber would actually receive
// rather than on the change set the service built.
func (f *fixture) events(after uint64) []*pb.EventEnvelope {
	f.t.Helper()
	page, err := f.store.GetEvents(f.t.Context(), storage.EventQuery{After: after, Limit: storage.MaxPageSize})
	if err != nil {
		f.t.Fatal(err)
	}
	result := []*pb.EventEnvelope{}
	for _, event := range page.Events {
		envelope, err := (EventProjector{}).Project(event)
		if err != nil {
			f.t.Fatal(err)
		}
		if envelope != nil {
			result = append(result, envelope)
		}
	}
	return result
}

func (f *fixture) watermark() uint64 {
	f.t.Helper()
	_, watermark, err := f.store.Watermark(f.t.Context())
	if err != nil {
		f.t.Fatal(err)
	}
	return watermark
}

// fakeChannel is the Runtime side of the settings frames. The tests supply two
// functions rather than a process, which is the whole reason Channel is narrow.
type fakeChannel struct {
	exported  *pb.WorkerSettingsSnapshot
	exportErr error
	imported  []*pb.WorkerSettingsRequest
	// reread is what ImportSettings reports back. Nil means "what it was sent",
	// which is the honest Runtime; a value here is a Runtime that stored
	// something else, and the comparison has to notice.
	reread    *pb.WorkerSettingsSnapshot
	importErr error
}

func snapshotOf(body string, hosts ...*pb.ExecutionHost) *pb.WorkerSettingsSnapshot {
	return &pb.WorkerSettingsSnapshot{
		Document:       document(body),
		Local:          &pb.WorkerLocalSettings{TerminalBackend: "pty"},
		ExecutionHosts: append([]*pb.ExecutionHost{{Kind: pb.ExecutionHostKind_EXECUTION_HOST_KIND_LOCAL}}, hosts...),
	}
}

// buildBox is the SSH entry baseDocument names, as the Worker would derive it.
func buildBox() *pb.ExecutionHost {
	return &pb.ExecutionHost{
		ExecutionHostId: "build-box",
		Name:            "构建机",
		Kind:            pb.ExecutionHostKind_EXECUTION_HOST_KIND_SSH,
		Ssh: &pb.SshExecutionHost{
			Host:         "build.example",
			Port:         2222,
			User:         "ci",
			IdentityFile: "/keys/ci",
			WorkerPath:   "/opt/armadra/worker",
			StateDir:     "/var/lib/armadra",
		},
	}
}

func (c *fakeChannel) ExportSettings(context.Context) (*pb.WorkerSettingsSnapshot, error) {
	if c.exportErr != nil {
		return nil, c.exportErr
	}
	return c.exported, nil
}

func (c *fakeChannel) ImportSettings(_ context.Context, request *pb.WorkerSettingsRequest) (*pb.WorkerSettingsSnapshot, error) {
	c.imported = append(c.imported, request)
	if c.importErr != nil {
		return nil, c.importErr
	}
	if c.reread != nil {
		return c.reread, nil
	}
	hosts, err := projectExecutionHosts(request.Document.Document)
	if err != nil {
		return nil, err
	}
	snapshot := snapshotOf(string(request.Document.Document), hosts...)
	snapshot.Applied = true
	return snapshot, nil
}

// SetWriteOwnership and GetWriteOwnership make the fake channel a full
// ownership.Handoff, so it can be handed to Adopt as the live link.
func (c *fakeChannel) SetWriteOwnership(context.Context, string, pb.CanvasOwnershipOwner, uint64, uint64, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("the settings projector never moves an epoch")
}

func (c *fakeChannel) GetWriteOwnership(context.Context, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("the settings projector never reads an epoch")
}

func (c *fakeChannel) SupportsReverseImport() bool { return true }

func (c *fakeChannel) ApplyReverseExport(context.Context, string, string, []byte, uint64, string) (*pb.ReverseImportReport, error) {
	return nil, errors.New("settings hand back through their own frame")
}

// epochOnlyLink is a Runtime that can move an epoch and nothing else: the state
// a Worker built before the settings frames existed is really in.
type epochOnlyLink struct{}

func (epochOnlyLink) SetWriteOwnership(context.Context, string, pb.CanvasOwnershipOwner, uint64, uint64, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("not used")
}

func (epochOnlyLink) GetWriteOwnership(context.Context, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("not used")
}

func (epochOnlyLink) SupportsReverseImport() bool { return true }

func (epochOnlyLink) ApplyReverseExport(context.Context, string, string, []byte, uint64, string) (*pb.ReverseImportReport, error) {
	return nil, errors.New("not used")
}

func checkNamed(report *pb.OwnershipReport, name string) *pb.ConsistencyCheck {
	for _, check := range report.GetChecks() {
		if check.Check == name {
			return check
		}
	}
	return nil
}
