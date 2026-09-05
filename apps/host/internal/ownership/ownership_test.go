package ownership

import (
	"context"
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

const (
	testHost     = "0123456789abcdef0123456789abcdef"
	testInstance = "abcdef0123456789abcdef0123456789"
	toHost       = pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST
	toRuntime    = pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
)

var testContext = context.Background()

// fakeProjector stands in for a domain's data. The state machine only asks it
// three questions, so a domain that answers them is enough to exercise every
// path — including the domains that have no real projector yet.
type fakeProjector struct {
	matched   bool
	watermark uint64
	adopted   int
	released  int
	handback  Handback
	failWith  error
}

func (p *fakeProjector) Adopt(context.Context, string) (*pb.OwnershipReport, error) {
	p.adopted++
	if p.failWith != nil {
		return nil, p.failWith
	}
	return &pb.OwnershipReport{Matched: p.matched, Checks: []*pb.ConsistencyCheck{{Check: "test.rows", Matched: p.matched}}}, nil
}

// Release records what the state machine handed it. Comparing the Runtime's
// re-read with the package is each domain's own business, and is exercised
// against the canvas projector and a real Runtime; what matters here is that a
// domain is never asked to hand data back without a way to deliver it, or
// against an epoch nobody confirmed.
func (p *fakeProjector) Release(_ context.Context, handback Handback) (*pb.OwnershipReport, error) {
	p.released++
	p.handback = handback
	if p.failWith != nil {
		return nil, p.failWith
	}
	if !handback.AcceptExportOnly && (handback.Importer == nil || !handback.Importer.SupportsReverseImport()) {
		return nil, ErrReverseImportUnsupported
	}
	return &pb.OwnershipReport{Matched: true}, nil
}

func (p *fakeProjector) Watermark(context.Context) (uint64, error) { return p.watermark, nil }

// fakeRuntime is the other side of the handoff: it stores an epoch and refuses
// the same things the real Runtime refuses.
type fakeRuntime struct {
	epochs   map[string]uint64
	owners   map[string]pb.CanvasOwnershipOwner
	setCalls int
	setErr   error
	getErr   error
	getCalls int
	// The reverse import half of the same channel. `noImport` is a Runtime too
	// old to apply a package at all.
	noImport     bool
	importCalls  int
	importDomain string
	importEpoch  uint64
}

func newFakeRuntime() *fakeRuntime {
	return &fakeRuntime{epochs: map[string]uint64{}, owners: map[string]pb.CanvasOwnershipOwner{}}
}

func (r *fakeRuntime) record(domain string) *pb.WorkerWriteOwnership {
	epoch, ok := r.epochs[domain]
	if !ok {
		epoch = 1
	}
	owner, ok := r.owners[domain]
	if !ok {
		owner = toRuntime
	}
	return &pb.WorkerWriteOwnership{Domain: domain, Owner: owner, Epoch: epoch}
}

func (r *fakeRuntime) GetWriteOwnership(_ context.Context, domain string) (*pb.WorkerWriteOwnership, error) {
	r.getCalls++
	if r.getErr != nil {
		return nil, r.getErr
	}
	return r.record(domain), nil
}

func (r *fakeRuntime) SetWriteOwnership(_ context.Context, domain string, owner pb.CanvasOwnershipOwner, epoch, expected uint64, _ string) (*pb.WorkerWriteOwnership, error) {
	r.setCalls++
	if r.setErr != nil {
		return nil, r.setErr
	}
	if current := r.record(domain); current.Epoch != expected {
		return nil, errors.New("stale epoch")
	}
	r.epochs[domain] = epoch
	r.owners[domain] = owner
	return r.record(domain), nil
}

func (r *fakeRuntime) SupportsReverseImport() bool { return !r.noImport }

func (r *fakeRuntime) ApplyReverseExport(_ context.Context, domain, _ string, _ []byte, epoch uint64, _ string) (*pb.ReverseImportReport, error) {
	r.importCalls++
	r.importDomain, r.importEpoch = domain, epoch
	return &pb.ReverseImportReport{Domain: domain, Epoch: epoch}, nil
}

type harness struct {
	service    *Service
	store      *storage.Store
	projectors map[string]*fakeProjector
	runtime    *fakeRuntime
	clock      time.Time
}

// newHarness registers a projector for every domain, so the state machine can
// be driven through the whole switch order without waiting for the domains to
// be built.
func newHarness(t *testing.T, domains ...string) *harness {
	t.Helper()
	store, err := storage.Open(t.TempDir(), testHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if len(domains) == 0 {
		domains = storage.OwnershipDomains
	}
	result := &harness{store: store, projectors: map[string]*fakeProjector{}, runtime: newFakeRuntime(), clock: time.UnixMilli(1788560523004)}
	registered := map[string]Projector{}
	for _, domain := range domains {
		projector := &fakeProjector{matched: true}
		result.projectors[domain] = projector
		registered[domain] = projector
	}
	service, err := New(Options{
		Store:      store,
		InstanceID: testInstance,
		Projectors: registered,
		ExportRoot: t.TempDir(),
		Now:        func() time.Time { return result.clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	result.service = service
	return result
}

func (h *harness) token(t *testing.T, domain string) string {
	t.Helper()
	issued, err := h.service.IssueMaintenance(testContext, domain)
	if err != nil {
		t.Fatal(err)
	}
	return issued.Token
}

func (h *harness) switchTo(t *testing.T, domain string, target pb.CanvasOwnershipOwner) *pb.OwnershipSwitchResponse {
	t.Helper()
	result, err := h.service.Switch(testContext, Request{
		Domain:           domain,
		Target:           target,
		ImportID:         "import-1",
		Handoff:          h.runtime,
		Importer:         h.runtime,
		ExportDirectory:  t.TempDir(),
		MaintenanceToken: h.token(t, domain),
	})
	if err != nil {
		t.Fatalf("%s did not move: %v", domain, err)
	}
	return result
}

// A Host that has never switched reports every domain as the Runtime's, in
// switch order, with no rows written to say so.
func TestRecordsDefaultToTheRuntimeForEveryDomain(t *testing.T) {
	h := newHarness(t)
	records, err := h.service.Records(testContext)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != len(storage.OwnershipDomains) {
		t.Fatalf("expected %d domains, got %d", len(storage.OwnershipDomains), len(records))
	}
	for index, record := range records {
		if record.Domain != storage.OwnershipDomains[index] {
			t.Fatalf("domain %d is %s", index, record.Domain)
		}
		if record.Owner != storage.OwnerRuntime || record.Phase != storage.OwnershipSettled || record.Epoch != 1 || record.Revision != 0 {
			t.Fatalf("%s defaulted to %+v", record.Domain, record)
		}
	}
}

// The switch order is a dependency order: a domain may only move to the Host
// once every domain before it has settled there.
func TestSwitchRefusesADomainWhoseDependenciesAreUnsettled(t *testing.T) {
	h := newHarness(t)
	result, err := h.service.Switch(testContext, Request{
		Domain:           storage.OwnershipDomainSession,
		Target:           toHost,
		ImportID:         "import-1",
		Handoff:          h.runtime,
		MaintenanceToken: h.token(t, storage.OwnershipDomainSession),
	})
	if !errors.Is(err, ErrDependency) {
		t.Fatalf("a domain moved ahead of its dependencies: %v", err)
	}
	// The refusal names what it checked, so an operator can see where the
	// order actually stands rather than being told only "no".
	if result == nil || len(result.Plan.GetDependencies()) == 0 {
		t.Fatal("the refusal did not report the dependencies it read")
	}
	if result.Plan.Dependencies[0].Domain != pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS {
		t.Fatalf("the first dependency is %v", result.Plan.Dependencies[0].Domain)
	}
	if h.runtime.setCalls != 0 || h.projectors[storage.OwnershipDomainSession].adopted != 0 {
		t.Fatal("a refused switch still moved data")
	}

	// With the earlier domains settled on the Host, the same switch is allowed.
	for _, domain := range []string{storage.OwnershipDomainCanvas, storage.OwnershipDomainSettings, storage.OwnershipDomainFilesystem} {
		h.switchTo(t, domain, toHost)
	}
	moved := h.switchTo(t, storage.OwnershipDomainSession, toHost)
	if moved.Ownership.Owner != toHost || moved.Ownership.Epoch != 2 {
		t.Fatalf("the session domain settled as %v", moved.Ownership)
	}
	if len(moved.Plan.Dependencies) != 3 {
		t.Fatalf("the plan verified %d dependencies", len(moved.Plan.Dependencies))
	}
}

// Rolling back runs the order backwards: a domain cannot be handed back while a
// domain that depends on it is still on the Host.
func TestRollbackRefusesWhileALaterDomainIsStillOnTheHost(t *testing.T) {
	h := newHarness(t)
	for _, domain := range []string{storage.OwnershipDomainCanvas, storage.OwnershipDomainSettings} {
		h.switchTo(t, domain, toHost)
	}
	_, err := h.service.Switch(testContext, Request{
		Domain:           storage.OwnershipDomainCanvas,
		Target:           toRuntime,
		Handoff:          h.runtime,
		Importer:         h.runtime,
		ExportDirectory:  t.TempDir(),
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if !errors.Is(err, ErrDependency) {
		t.Fatalf("the canvas was handed back under a Host-owned settings domain: %v", err)
	}
	// Give settings back first, and the canvas may follow.
	h.switchTo(t, storage.OwnershipDomainSettings, toRuntime)
	rolled := h.switchTo(t, storage.OwnershipDomainCanvas, toRuntime)
	if rolled.Ownership.Owner != toRuntime {
		t.Fatalf("the canvas did not return to the Runtime: %v", rolled.Ownership)
	}
}

// Each domain has its own epoch. Moving one must not move, or renumber, another.
func TestDomainsMoveOnTheirOwnEpochs(t *testing.T) {
	h := newHarness(t)
	h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	records, err := h.service.Records(testContext)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if record.Domain == storage.OwnershipDomainCanvas {
			if record.Owner != storage.OwnerHost || record.Epoch != 2 {
				t.Fatalf("the canvas is %+v", record)
			}
			continue
		}
		if record.Owner != storage.OwnerRuntime || record.Epoch != 1 {
			t.Fatalf("%s moved with the canvas: %+v", record.Domain, record)
		}
	}
}

// A domain with no projector cannot be switched. Recording ownership of data
// this Host cannot move would be a switch on paper.
func TestSwitchRefusesADomainThisHostCannotMove(t *testing.T) {
	h := newHarness(t, storage.OwnershipDomainCanvas)
	_, err := h.service.IssueMaintenance(testContext, storage.OwnershipDomainAgent)
	if !errors.Is(err, ErrUnsupportedDomain) {
		t.Fatalf("a token was issued for a domain this Host cannot move: %v", err)
	}
	_, err = h.service.Switch(testContext, Request{
		Domain:           storage.OwnershipDomainAgent,
		Target:           toHost,
		ImportID:         "import-1",
		Handoff:          h.runtime,
		MaintenanceToken: "irrelevant",
	})
	if !errors.Is(err, ErrUnsupportedDomain) {
		t.Fatalf("an unsupported domain was switched: %v", err)
	}
	// And a name that is not a domain at all is refused before anything else.
	_, err = h.service.Switch(testContext, Request{Domain: "terminal", Target: toHost, Handoff: h.runtime, MaintenanceToken: "irrelevant"})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown domain was accepted: %v", err)
	}
}

func TestMaintenanceTokenIsRequiredSingleUseAndShortLived(t *testing.T) {
	h := newHarness(t)
	request := Request{
		Domain:   storage.OwnershipDomainCanvas,
		Target:   toHost,
		ImportID: "import-1",
		Handoff:  h.runtime,
	}
	if _, err := h.service.Switch(testContext, request); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a switch without a maintenance window was accepted: %v", err)
	}

	// A token issued for another domain does not open this one.
	other := h.token(t, storage.OwnershipDomainSettings)
	request.MaintenanceToken = other
	if _, err := h.service.Switch(testContext, request); !errors.Is(err, storage.ErrMaintenanceToken) {
		t.Fatalf("a token for another domain opened the canvas: %v", err)
	}

	// An expired token is refused: the window is two minutes because someone is
	// carrying it from a terminal to a browser tab, not storing it.
	expired := h.token(t, storage.OwnershipDomainCanvas)
	h.clock = h.clock.Add(MaintenanceTTL + time.Second)
	request.MaintenanceToken = expired
	if _, err := h.service.Switch(testContext, request); !errors.Is(err, storage.ErrMaintenanceToken) {
		t.Fatalf("an expired token opened a window: %v", err)
	}

	// A fresh one works exactly once.
	fresh := h.token(t, storage.OwnershipDomainCanvas)
	request.MaintenanceToken = fresh
	if _, err := h.service.Switch(testContext, request); err != nil {
		t.Fatal(err)
	}
	// Roll back so the same request is not a no-op, then replay the token.
	h.switchTo(t, storage.OwnershipDomainCanvas, toRuntime)
	if _, err := h.service.Switch(testContext, request); !errors.Is(err, storage.ErrMaintenanceToken) {
		t.Fatalf("a spent token opened a second window: %v", err)
	}
	if h.runtime.owners[storage.OwnershipDomainCanvas] != toRuntime {
		t.Fatal("the replayed token moved the domain")
	}
}

// A refusal that happens before the window opens must not burn the token: the
// operator would otherwise have to walk back to the machine for a mistake the
// Host caught for free.
func TestARefusedPreconditionKeepsTheTokenSpendable(t *testing.T) {
	h := newHarness(t)
	token := h.token(t, storage.OwnershipDomainSession)
	_, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainSession, Target: toHost, ImportID: "import-1",
		Handoff: h.runtime, MaintenanceToken: token,
	})
	if !errors.Is(err, ErrDependency) {
		t.Fatalf("expected a dependency refusal: %v", err)
	}
	for _, domain := range []string{storage.OwnershipDomainCanvas, storage.OwnershipDomainSettings, storage.OwnershipDomainFilesystem} {
		h.switchTo(t, domain, toHost)
	}
	if _, err = h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainSession, Target: toHost, ImportID: "import-1",
		Handoff: h.runtime, MaintenanceToken: token,
	}); err != nil {
		t.Fatalf("the token was spent on a refusal: %v", err)
	}
}

// The caller states the epoch it decided against. A stale one is a conflict,
// because the decision was made about a state that no longer exists.
func TestSwitchRefusesAnEpochTheCallerDidNotSee(t *testing.T) {
	h := newHarness(t)
	h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	_, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toRuntime, ExpectedEpoch: 1,
		Handoff: h.runtime, Importer: h.runtime, ExportDirectory: t.TempDir(),
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if !errors.Is(err, ErrEpochMismatch) {
		t.Fatalf("a stale expected epoch was accepted: %v", err)
	}
}

// When the Host cannot learn what the Runtime stored, the window stays open on
// purpose: guessing would let one side resume writing while the other still
// believes it owns the domain.
func TestAnUnknownOutcomeLeavesTheWindowOpen(t *testing.T) {
	h := newHarness(t)
	h.runtime.setErr = errors.New("pipe closed")
	failing := &failingSecondGet{fakeRuntime: h.runtime}
	_, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toHost, ImportID: "import-1",
		Handoff: failing, MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if !errors.Is(err, ErrUnknownOutcome) {
		t.Fatalf("an unreadable Runtime was treated as a definite answer: %v", err)
	}
	record, err := h.service.Record(testContext, storage.OwnershipDomainCanvas)
	if err != nil {
		t.Fatal(err)
	}
	if record.Phase != storage.OwnershipSwitching || record.ReasonCode != ReasonUnknown {
		t.Fatalf("the window was closed without an answer: %+v", record)
	}
	// Re-running the same switch converges once the Runtime answers again.
	h.runtime.setErr = nil
	resumed := h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	if resumed.Ownership.Owner != toHost || resumed.Ownership.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
		t.Fatalf("the resumed switch settled on %v", resumed.Ownership)
	}
}

type failingSecondGet struct {
	*fakeRuntime
	calls int
}

func (f *failingSecondGet) GetWriteOwnership(ctx context.Context, domain string) (*pb.WorkerWriteOwnership, error) {
	f.calls++
	if f.calls > 1 {
		return nil, errors.New("pipe closed")
	}
	return f.fakeRuntime.GetWriteOwnership(ctx, domain)
}

// An import whose verification did not match never reaches the Runtime, and the
// report that refused it is returned.
func TestAnUnverifiedProjectionNeverMovesTheEpoch(t *testing.T) {
	h := newHarness(t)
	h.projectors[storage.OwnershipDomainCanvas].matched = false
	result, err := h.service.Switch(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toHost, ImportID: "import-1",
		Handoff: h.runtime, MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if !errors.Is(err, ErrNotVerified) {
		t.Fatalf("an unverified projection switched: %v", err)
	}
	if result.GetReport().GetMatched() || len(result.GetReport().GetChecks()) == 0 {
		t.Fatal("the refusal did not carry the report that caused it")
	}
	if h.runtime.setCalls != 0 {
		t.Fatal("the Runtime was told about a switch that never verified")
	}
}

// An HTTPS rollback allocates its own export directory: a browser must not name
// paths on this machine.
func TestHttpsRollbackAllocatesItsOwnExportDirectory(t *testing.T) {
	h := newHarness(t)
	h.switchTo(t, storage.OwnershipDomainCanvas, toHost)
	if _, err := h.service.Rollback(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, ExportDirectory: "/tmp/anywhere",
		Handoff: h.runtime, Importer: h.runtime, MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	}); !errors.Is(err, ErrInvalid) {
		t.Fatal("an HTTPS caller named an export path")
	}
	result, err := h.service.Rollback(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Handoff: h.runtime, Importer: h.runtime,
		MaintenanceToken: h.token(t, storage.OwnershipDomainCanvas),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Ownership.Owner != toRuntime || h.projectors[storage.OwnershipDomainCanvas].released != 1 {
		t.Fatalf("the rollback did not export before handing back: %v", result.Ownership)
	}
}

// The offline entry point is the CLI's, and it is the only one that runs
// without a token: its window is the data directory lock it already holds.
func TestOfflineSwitchNeedsNoToken(t *testing.T) {
	h := newHarness(t)
	result, err := h.service.SwitchOffline(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toHost, ImportID: "import-1", Handoff: h.runtime,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Ownership.Owner != toHost {
		t.Fatalf("the offline switch settled on %v", result.Ownership)
	}
	// Repeating it is a no-op rather than a second move.
	again, err := h.service.SwitchOffline(testContext, Request{
		Domain: storage.OwnershipDomainCanvas, Target: toHost, ImportID: "import-1", Handoff: h.runtime,
	})
	if err != nil || again.Ownership.Epoch != result.Ownership.Epoch {
		t.Fatalf("a repeated offline switch moved the epoch: %v %v", err, again.Ownership)
	}
	if h.runtime.setCalls != 1 {
		t.Fatalf("a repeated switch told the Runtime %d times", h.runtime.setCalls)
	}
}
