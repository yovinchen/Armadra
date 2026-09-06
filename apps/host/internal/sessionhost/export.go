package sessionhost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The reverse export a rollback owes the Runtime (Go Host 业务所有权迁移 §2.12).
//
// The package format is the one `canvashost/export.go` and `fshost/export.go`
// write and the Runtime's single reader applies: format version 2, a JSON
// `export.json` naming the domain, the epoch and one file per workspace, each
// file a length-prefixed sequence of `ReverseExportRecord`. Three writers of one
// format is more than anyone wants; what keeps them honest is that there is
// exactly one reader, in the Runtime, and it refuses anything it cannot
// describe.
//
// What differs is only the content. A session package carries, per workspace,
// each session followed by the runs that back it — the runs are in the package
// because a `terminal_sessions` row restored with a generation that nothing
// accounts for is precisely the state a reclaim cannot resolve.
//
// The canonical digest clears everything the Runtime has nowhere to store: the
// Host's revision, the run's revision, and the reason codes this Host added on
// its own. Including them would make the comparison that decides whether a
// rollback landed permanently false.

const (
	// ExportFormatVersion is the package's own contract version.
	ExportFormatVersion = 2
	// ExportDomain is written into the index so a reader refuses a package
	// meant for another domain instead of applying it to this one.
	ExportDomain = storage.OwnershipDomainSession
	// ExportIndexFile is the package's own description, JSON so an operator can
	// read a rollback package without a decoder.
	ExportIndexFile = "export.json"
)

type exportFile struct {
	Name          string `json:"name"`
	WorkspaceID   string `json:"workspaceId"`
	Bytes         uint64 `json:"bytes"`
	Sha256        string `json:"sha256"`
	ContentSha256 string `json:"contentSha256"`
	EntityCount   uint64 `json:"entityCount"`
}

type exportIndex struct {
	FormatVersion int          `json:"formatVersion"`
	HostID        string       `json:"hostId"`
	Epoch         uint64       `json:"epoch"`
	EventSequence uint64       `json:"eventSequence"`
	Domain        string       `json:"domain"`
	EntityCount   uint64       `json:"entityCount"`
	Files         []exportFile `json:"files"`
}

func digest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

// Export writes every session this Host holds into `directory` and reads the
// result back. The directory must be empty: overwriting a package would destroy
// the only copy of a previous reversal attempt.
func (s *Service) Export(ctx context.Context, directory string, epoch uint64) (*pb.OwnershipReport, error) {
	if !filepath.IsAbs(directory) {
		return nil, ErrInvalid
	}
	if info, err := os.Lstat(directory); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrInvalid
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return nil, err
		}
		if len(entries) != 0 {
			return nil, ErrInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else if err = os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err := storage.ProtectArtifactDirectory(directory); err != nil {
		return nil, err
	}
	_, watermark, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	index := exportIndex{
		FormatVersion: ExportFormatVersion,
		HostID:        s.options.HostID,
		Epoch:         epoch,
		EventSequence: watermark,
		Domain:        ExportDomain,
	}
	grouped, order, err := s.groupedSessions(ctx)
	if err != nil {
		return nil, err
	}
	for _, workspaceID := range order {
		records := []*pb.ReverseExportRecord{}
		canonical := []*pb.ReverseExportRecord{}
		var entities uint64
		for _, session := range grouped[workspaceID] {
			value := message(session)
			records = append(records, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Session{Session: value}})
			canonical = append(canonical, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Session{Session: canonicalSession(value)}})
			entities++
			runs, err := s.store.SessionRuns(ctx, session.SessionID)
			if err != nil {
				return nil, err
			}
			for _, run := range runs {
				value := runMessage(run)
				records = append(records, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_SessionRun{SessionRun: value}})
				canonical = append(canonical, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_SessionRun{SessionRun: canonicalRun(value)}})
				entities++
			}
		}
		encoded, err := encodeRecords(records)
		if err != nil {
			return nil, err
		}
		canonicalEncoded, err := encodeRecords(canonical)
		if err != nil {
			return nil, err
		}
		name := hex.EncodeToString(digest([]byte(workspaceID))[:16]) + ".pb"
		if err = writeExactly(filepath.Join(directory, name), encoded); err != nil {
			return nil, err
		}
		index.EntityCount += entities
		index.Files = append(index.Files, exportFile{
			Name:          name,
			WorkspaceID:   workspaceID,
			Bytes:         uint64(len(encoded)),
			Sha256:        hex.EncodeToString(digest(encoded)),
			ContentSha256: hex.EncodeToString(digest(canonicalEncoded)),
			EntityCount:   entities,
		})
	}
	encoded, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = writeExactly(filepath.Join(directory, ExportIndexFile), append(encoded, '\n')); err != nil {
		return nil, err
	}

	// Read the package back. A digest computed from the buffer that was just
	// written proves nothing about what reached the disk, and this package is
	// the only copy of a domain the Host is about to stop owning.
	differences := []string{}
	for _, file := range index.Files {
		stored, err := os.ReadFile(filepath.Join(directory, file.Name))
		if err != nil {
			return nil, err
		}
		if uint64(len(stored)) != file.Bytes || hex.EncodeToString(digest(stored)) != file.Sha256 {
			differences = append(differences, file.WorkspaceID)
		}
	}
	builder := new(checkBuilder)
	builder.record("session.export_sessions", uint64(len(index.Files)), uint64(len(index.Files)), differences)
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SESSION,
		Checks:           builder.checks,
		Matched:          len(differences) == 0,
		EntityCount:      index.EntityCount,
		VerifiedAtUnixMs: s.now(),
	}
	if !report.Matched {
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// groupedSessions reads every record, tombstones included, grouped by
// workspace and ordered so two exports of an unchanged Host produce identical
// bytes. Tombstones are in the package because a rollback that dropped them
// would let the Runtime keep a session somebody closed.
func (s *Service) groupedSessions(ctx context.Context) (map[string][]storage.Session, []string, error) {
	sessions, err := s.store.AllSessions(ctx)
	if err != nil {
		return nil, nil, err
	}
	grouped := map[string][]storage.Session{}
	order := []string{}
	for _, session := range sessions {
		if _, seen := grouped[session.WorkspaceID]; !seen {
			order = append(order, session.WorkspaceID)
		}
		grouped[session.WorkspaceID] = append(grouped[session.WorkspaceID], session)
	}
	sort.Strings(order)
	return grouped, order, nil
}

// canonicalSession is one session in the form both sides hash.
//
// It carries only what a `terminal_sessions` row can hold, and that is a
// smaller thing than a `Session`. Everything the Runtime has no column for is
// cleared here rather than compared and found missing: the frozen argv, the
// environment names, the SSH target, the agent's permission mode and model, the
// launch digest this Host computed, and this Host's own revision and reason
// code. They are all still in the package — the reverse export carries the full
// record — but a *comparison* over them would be permanently false, because the
// Runtime cannot read them back after storing them.
//
// The two enums are folded for the same reason. `terminal_sessions.status` has
// four words and this domain has six values: STARTING, LOST and RECLAIMING have
// no spelling there, because the Runtime *was* the execution host and could
// never be out of touch with one. Folding them to RUNNING is what the column
// has always meant — nobody observed this end — so a session the Host recorded
// as LOST comes back as one the Runtime is simply not sure about, rather than
// as one it believes finished.
func canonicalSession(value *pb.Session) *pb.Session {
	canonical := &pb.Session{
		SessionId:   value.GetSessionId(),
		WorkspaceId: value.GetWorkspaceId(),
		// The Runtime's row has no execution host column: every session it
		// holds is one it runs.
		SessionKey:         value.GetSessionKey(),
		OwnerNodeId:        value.GetOwnerNodeId(),
		Launch:             canonicalLaunch(value.GetLaunch()),
		BackendKind:        value.GetBackendKind(),
		Generation:         value.GetGeneration(),
		Kind:               value.GetKind(),
		Status:             canonicalStatus(value.GetStatus()),
		AttachState:        canonicalAttach(value.GetAttachState()),
		TerminationIntent:  value.GetTerminationIntent(),
		CreatedAtUnixMs:    value.GetCreatedAtUnixMs(),
		EndedAtUnixMs:      value.GetEndedAtUnixMs(),
		LastOutputAtUnixMs: value.GetLastOutputAtUnixMs(),
		Deleted:            value.GetDeleted(),
	}
	if value.ExitCode != nil {
		code := value.GetExitCode()
		canonical.ExitCode = &code
	}
	return canonical
}

// canonicalLaunch reduces a frozen launch to the four columns that hold it:
// `cwd`, `shell`, `command` and `agent_id`.
func canonicalLaunch(launch *pb.SessionLaunch) *pb.SessionLaunch {
	if launch == nil {
		return nil
	}
	canonical := &pb.SessionLaunch{
		Shell:            launch.GetShell(),
		Command:          launch.GetCommand(),
		WorkingDirectory: launch.GetWorkingDirectory(),
	}
	if agent := launch.GetAgent(); agent.GetAgentId() != "" {
		canonical.Agent = &pb.AgentLaunchSpec{
			AgentId:          agent.GetAgentId(),
			WorkingDirectory: launch.GetWorkingDirectory(),
		}
	}
	return canonical
}

// canonicalStatus folds the six lifecycle values onto the two a
// `terminal_sessions` row can express.
func canonicalStatus(status pb.SessionStatus) pb.SessionStatus {
	if status == pb.SessionStatus_SESSION_STATUS_EXITED {
		return status
	}
	return pb.SessionStatus_SESSION_STATUS_RUNNING
}

func canonicalAttach(state pb.SessionAttachState) pb.SessionAttachState {
	switch state {
	case pb.SessionAttachState_SESSION_ATTACH_STATE_ATTACHED,
		pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED:
		return state
	default:
		return pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED
	}
}

// canonicalRun keeps only what a run says about a process. The revision is this
// Host's, and the reason code is often this Host's too.
func canonicalRun(value *pb.SessionRun) *pb.SessionRun {
	canonical := &pb.SessionRun{
		SessionId:       value.GetSessionId(),
		Generation:      value.GetGeneration(),
		BackendRef:      value.GetBackendRef(),
		StartedAtUnixMs: value.GetStartedAtUnixMs(),
		EndedAtUnixMs:   value.GetEndedAtUnixMs(),
	}
	if value.ExitCode != nil {
		code := value.GetExitCode()
		canonical.ExitCode = &code
	}
	return canonical
}

// encodeRecords writes a length-prefixed record sequence, matching the Worker
// frame convention, so a truncated file is a short read rather than a
// half-decoded session.
func encodeRecords(records []*pb.ReverseExportRecord) ([]byte, error) {
	payload := []byte(nil)
	for _, record := range records {
		encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(record)
		if err != nil {
			return nil, err
		}
		if len(encoded) == 0 {
			// An empty record decodes to "no entity", which a reader refuses.
			return nil, ErrInvalid
		}
		payload = binary.BigEndian.AppendUint32(payload, uint32(len(encoded)))
		payload = append(payload, encoded...)
	}
	return payload, nil
}

// readExportIndex reads back the index of a package this Host wrote, with the
// digest of the exact bytes on disk. That digest is what the Runtime is told to
// expect, so a package edited between writing and applying is refused by the
// reader rather than trusted because we wrote it.
func readExportIndex(directory string) (*exportIndex, []byte, error) {
	raw, err := os.ReadFile(filepath.Join(directory, ExportIndexFile))
	if err != nil {
		return nil, nil, err
	}
	index := new(exportIndex)
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(index); err != nil {
		return nil, nil, err
	}
	if index.FormatVersion != ExportFormatVersion || index.Domain != ExportDomain {
		return nil, nil, ErrInvalid
	}
	return index, digest(raw), nil
}

// writeExactly refuses to replace an existing file. A rollback package is
// written once; a second attempt uses a new directory so the first stays intact.
func writeExactly(path string, payload []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	written, err := file.Write(payload)
	if err == nil && written != len(payload) {
		err = errors.New("short write")
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(stored, payload) {
		return errors.New("export file changed while it was written")
	}
	return nil
}
