package sessionhost

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"google.golang.org/protobuf/proto"
)

// peer stands in for the Runtime at the other end of the Worker channel. It
// reads the package the Host wrote, "applies" it by remembering the sessions,
// and answers the half of the handback that actually proves something: its own
// reading of its rows, produced from the rows rather than from the request.
type peer struct {
	sessions map[string]*pb.Session
	runs     map[string][]*pb.SessionRun
	// drop makes the Runtime not report one workspace back, and issue makes it
	// raise one — the two ways a rollback fails that are not a digest
	// mismatch.
	drop, issue string
	// refuseRead is a Runtime too old to report its own sessions, which has to
	// make the handback refuse rather than pass unverified.
	refuseRead bool
	// forget drops one session from what the Worker reports it holds, so the
	// comparison that decides whether a rollback landed can fail on the thing
	// it is meant to catch.
	forget string
}

func newPeer() *peer {
	return &peer{sessions: map[string]*pb.Session{}, runs: map[string][]*pb.SessionRun{}}
}

func (p *peer) SupportsReverseImport() bool { return true }

func (p *peer) ApplyReverseExport(_ context.Context, domain, path string, index []byte, _ uint64, importID string) (*pb.ReverseImportReport, error) {
	if domain != ExportDomain {
		return nil, errors.New("wrong domain")
	}
	raw, err := os.ReadFile(filepath.Join(path, ExportIndexFile))
	if err != nil {
		return nil, err
	}
	parsed := new(exportIndex)
	if err = json.Unmarshal(raw, parsed); err != nil {
		return nil, err
	}
	report := &pb.ReverseImportReport{
		ImportId:    importID,
		Domain:      domain,
		Epoch:       parsed.Epoch,
		IndexSha256: index,
		EntityCount: parsed.EntityCount,
	}
	for _, file := range parsed.Files {
		payload, err := os.ReadFile(filepath.Join(path, file.Name))
		if err != nil {
			return nil, err
		}
		// The entity file is a sequence of four-byte length prefixes and
		// records, so a truncated file is a short read rather than a
		// half-decoded session.
		for offset := 0; offset < len(payload); {
			size := int(binary.BigEndian.Uint32(payload[offset : offset+4]))
			record := new(pb.ReverseExportRecord)
			if err = proto.Unmarshal(payload[offset+4:offset+4+size], record); err != nil {
				return nil, err
			}
			offset += 4 + size
			switch entity := record.GetEntity().(type) {
			case *pb.ReverseExportRecord_Session:
				p.sessions[entity.Session.GetSessionId()] = entity.Session
			case *pb.ReverseExportRecord_SessionRun:
				id := entity.SessionRun.GetSessionId()
				p.runs[id] = append(p.runs[id], entity.SessionRun)
			default:
				return nil, errors.New("a session package carried something else")
			}
		}
		if p.drop == file.WorkspaceID {
			continue
		}
		digest, err := hex.DecodeString(file.ContentSha256)
		if err != nil {
			return nil, err
		}
		report.Reexported = append(report.Reexported, &pb.ReverseExportFile{
			Name:          file.Name,
			WorkspaceId:   file.WorkspaceID,
			ContentSha256: digest,
			EntityCount:   file.EntityCount,
		})
	}
	if p.issue != "" {
		report.Issues = append(report.Issues, &pb.ExportIssue{Code: p.issue, Severity: "error"})
	}
	return report, nil
}

// WorkerSessions is the Worker reading its own rows back. It is what the
// handback is checked against, and it is deliberately built from `p.sessions`
// — what the peer stored — rather than from the request it was sent.
func (p *peer) WorkerSessions(context.Context) (*pb.WorkerSessionStates, error) {
	if p.refuseRead {
		return nil, errors.New("this Worker cannot read its sessions")
	}
	states := &pb.WorkerSessionStates{WorkerInstanceId: "worker-a"}
	for _, id := range sortedKeys(p.sessions) {
		session := p.sessions[id]
		if session.GetDeleted() || id == p.forget {
			continue
		}
		states.Sessions = append(states.Sessions, &pb.WorkerSessionState{
			SessionId:   session.GetSessionId(),
			WorkspaceId: session.GetWorkspaceId(),
			SessionKey:  session.GetSessionKey(),
			OwnerNodeId: session.GetOwnerNodeId(),
			Generation:  session.GetGeneration(),
			Status:      session.GetStatus(),
			Launch:      session.GetLaunch(),
		})
	}
	return states, nil
}

func (f *fixture) release(other ownership.ReverseImporter, exportOnly bool) (*pb.OwnershipReport, error) {
	f.t.Helper()
	return f.service.AsProjector().Release(fixtureContext, ownership.Handback{
		Directory:        filepath.Join(f.t.TempDir(), "package"),
		Epoch:            2,
		Importer:         other,
		AcceptExportOnly: exportOnly,
	})
}

// Adopting projects the staged `terminal_sessions` rows item for item. Nothing
// is invented: a row that cannot be read blocks the switch rather than becoming
// a session with a default in it, because a session with a default in it is a
// terminal node pointed at the wrong directory.
func TestAdoptProjectsEveryStagedRowAndVerifiesIt(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	report, err := f.service.Adopt(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() {
		for _, check := range report.GetChecks() {
			if !check.GetMatched() {
				t.Errorf("check %s: %v", check.GetCheck(), check.GetDifferences())
			}
		}
		t.Fatal("a clean adoption reported differences")
	}
	// §3.3 names each of these as a separate statement, so a failure says which
	// property broke rather than that "something differs".
	checks := map[string]bool{}
	for _, check := range report.GetChecks() {
		checks[check.GetCheck()] = check.GetMatched()
	}
	for _, name := range []string{
		"session.count", "session.ids", "session.keys", "session.node_binding",
		"session.generation", "session.status", "session.launch_sha256", "session.timestamps",
	} {
		if !checks[name] {
			t.Fatalf("check %s did not run or did not match: %v", name, checks)
		}
	}

	agent := f.session("session-agent")
	if agent.Kind != int32(pb.SessionKind_SESSION_KIND_AGENT) || agent.OwnerNodeID != "node-one" {
		t.Fatalf("the agent session did not keep its identity: %+v", agent)
	}
	if agent.Generation != 1 || agent.Status != int32(pb.SessionStatus_SESSION_STATUS_RUNNING) {
		t.Fatalf("the running session did not survive the projection: %+v", agent)
	}
	// A running session gets a run for its current generation. Without one the
	// record would claim a generation nothing accounts for, which is the state
	// a reclaim cannot tell from a stale one.
	runs, err := f.store.SessionRuns(fixtureContext, "session-agent")
	if err != nil || len(runs) != 1 || runs[0].Generation != 1 {
		t.Fatalf("the adopted session has no run for its generation: %v %+v", err, runs)
	}
	// `terminated` becomes EXITED, and the Runtime's own word is kept verbatim
	// so the rollback puts back the value the column had.
	plain := f.session("session-plain")
	if plain.Status != int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		t.Fatalf("a terminated session was not projected as ended: %v", pb.SessionStatus(plain.Status))
	}
	if plain.ReasonCode != "session.termination.process" {
		t.Fatalf("the Runtime's termination word was lost: %q", plain.ReasonCode)
	}
	if plain.Intent != int32(pb.TerminationIntent_TERMINATION_INTENT_USER) {
		t.Fatalf("the termination intent was not projected: %v", pb.TerminationIntent(plain.Intent))
	}
}

// A status word this build does not know is refused. Guessing would record a
// session as running, or as ended, on no evidence at all.
func TestAdoptRefusesAStatusItCannotRead(t *testing.T) {
	f := newFixture(t)
	f.stageSession(stagedRow{
		id: "session-odd", workspace: workspaceID, key: "node-odd", kind: "terminal",
		cwd: "/项目/一", shell: "/bin/zsh", status: "hibernating", backend: "tmux",
		attach: "detached", intent: "none", generation: 1, created: "2026-09-01T10:00:00Z",
	})
	if _, err := f.service.Adopt(fixtureContext, importID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown status was projected anyway: %v", err)
	}
	if _, err := f.service.Session(fixtureContext, "session-odd"); !errors.Is(err, ErrNotFound) {
		t.Fatal("a refused adoption still wrote a session")
	}
}

// Re-adopting after a rollback leaves identical records alone. A second switch
// must not tell every client that every terminal changed.
func TestReadoptingDoesNotRepublishUnchangedSessions(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	before := f.session("session-agent")
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	after := f.session("session-agent")
	if before.Revision != after.Revision {
		t.Fatalf("a second adoption republished an unchanged session: %d -> %d", before.Revision, after.Revision)
	}
}

// A switch ends by asking the execution host what it actually holds. Verifying
// rows and walking away would leave this Host holding sessions it has never
// spoken to, which is indistinguishable from sessions that have died.
func TestAdoptionEndsByReconcilingWithTheExecutionHost(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	report, err := f.service.AsProjector().Adopt(fixtureContext, ownership.Adoption{ImportID: importID})
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() {
		t.Fatal("a clean adoption with a reachable Worker reported differences")
	}
	if f.worker.reclaims != 1 {
		t.Fatalf("the adoption did not ask the execution host: %d", f.worker.reclaims)
	}
	// This Worker holds nothing, and it answered — so the adopted running
	// session is recorded as ended rather than left claiming a process.
	if status := f.session("session-agent").Status; status != int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		t.Fatalf("a session no live Worker holds still claims to run: %v", pb.SessionStatus(status))
	}
}

// A handback is four steps, and the last one is the only one that proves
// anything: the Runtime reads its own rows back and this Host compares them
// with the package it wrote.
func TestHandbackCarriesEverySessionAndItsRuns(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	other := newPeer()
	report, err := f.release(other, false)
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() {
		for _, check := range report.GetChecks() {
			if !check.GetMatched() {
				t.Errorf("check %s: %v", check.GetCheck(), check.GetDifferences())
			}
		}
		t.Fatal("a clean handback reported differences")
	}
	checks := map[string]bool{}
	for _, check := range report.GetChecks() {
		checks[check.GetCheck()] = check.GetMatched()
	}
	for _, name := range []string{"session.export_sessions", "reverse.import", "reverse.sessions", "reverse.unsupported_entity", "session.worker_sessions"} {
		if !checks[name] {
			t.Fatalf("check %s did not run or did not match: %v", name, checks)
		}
	}
	if len(other.sessions) != 2 {
		t.Fatalf("the package did not carry both sessions: %+v", other.sessions)
	}
	// The runs travel with the sessions, because a row restored with a
	// generation nothing accounts for is the one state a reclaim cannot
	// resolve.
	if len(other.runs["session-agent"]) != 1 || other.runs["session-agent"][0].GetGeneration() != 1 {
		t.Fatalf("the package dropped the run behind the session: %+v", other.runs)
	}
	if other.sessions["session-agent"].GetOwnerNodeId() != "node-one" {
		t.Fatalf("the node binding did not survive the package: %+v", other.sessions["session-agent"])
	}
}

// The epoch stays with the Host on every failure below, which is the safe
// direction: the Host still holds every record, so the operator can fix the
// cause and run the same rollback again.
func TestHandbackRefusesWhenTheOtherSideCannotConfirmIt(t *testing.T) {
	for name, prepare := range map[string]func(*peer){
		// A workspace the Runtime never reported back.
		"a missing workspace": func(p *peer) { p.drop = workspaceID },
		// An issue the Runtime raised blocks it whatever the digests say.
		"an unsupported entity": func(p *peer) { p.issue = "reverse.unsupported_entity" },
		// A session the Worker does not hold after the import: the rows and
		// the report can agree while the machine disagrees with both, which is
		// exactly what this check exists to catch.
		"a session the Worker does not hold": func(p *peer) { p.forget = "session-agent" },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.stageBoth()
			if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
				t.Fatal(err)
			}
			f.own()
			other := newPeer()
			prepare(other)
			if _, err := f.release(other, false); !errors.Is(err, ownership.ErrReverseImportFailed) {
				t.Fatalf("the handback was accepted: %v", err)
			}
		})
	}
}

// A Runtime too old to report its own sessions cannot complete a handback.
// Refusing leaves the epoch with the Host, which still holds every record.
func TestHandbackRefusesAWorkerThatCannotReadItsSessions(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	other := newPeer()
	other.refuseRead = true
	if _, err := f.release(other, false); !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("an unverifiable handback was accepted: %v", err)
	}
}

// The export is the whole handover only when an operator says so. It is the one
// path that leaves the Host's changes in a package and nowhere else.
func TestExportOnlyStopsAfterWritingThePackage(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	other := newPeer()
	report, err := f.release(other, true)
	if err != nil || !report.GetMatched() {
		t.Fatalf("the export-only handback failed: %v %+v", err, report)
	}
	if len(other.sessions) != 0 {
		t.Fatalf("an export-only handback applied the package: %+v", other.sessions)
	}
}

// A package directory is written once. A second attempt uses a new directory so
// the first stays intact — it may be the only copy of a domain the Host is
// about to stop owning.
func TestExportRefusesToOverwriteAPackage(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(t.TempDir(), "package")
	if _, err := f.service.Export(fixtureContext, directory, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Export(fixtureContext, directory, 2); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a second export overwrote the first: %v", err)
	}
	// And a relative directory is not a place on this machine.
	if _, err := f.service.Export(fixtureContext, "package", 2); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a relative export directory was accepted: %v", err)
	}
}
