package sessionhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Taking the session domain over (Go Host 业务所有权迁移 §2.11 steps 3-4,
// §3.3 session row).
//
// The source is the Runtime's `terminal_sessions` table, which the offline
// bundle already carries. Adopting is a projection of rows this Host has staged,
// and it is deliberately not a second export: the switch happens with the
// Runtime stopped, and asking a live process for its sessions during a
// maintenance window would be asking a side that is meant to be frozen.
//
// Nothing is invented, and one thing in particular is not: a row this
// projection cannot read blocks the switch instead of becoming a session with a
// default in it. A session with a default in it is a terminal node pointed at
// the wrong directory, running the wrong program.
//
// The status mapping is where the two vocabularies meet. The Runtime has four
// words and this domain has six values, and the extra two matter:
//
//	running    -> RUNNING
//	exited     -> EXITED
//	terminated -> EXITED, with the termination intent it was ended under
//	failed     -> EXITED, reason `session.run.failed`
//
// STARTING, LOST and RECLAIMING have no `terminal_sessions` spelling at all,
// because the Runtime never needed them: it *was* the execution host, so it
// could never be out of touch with one. They are reached only after the switch,
// which is exactly the state the Runtime could not represent.

const legacySessions = "legacy.terminal_sessions"

// maxDifferences bounds what a failed check reports. An operator needs to see
// which sessions differ, not every one of them.
const maxDifferences = 32

// stagedSession is one `terminal_sessions` row as this domain reads it.
type stagedSession struct {
	SessionID    string
	WorkspaceID  string
	SessionKey   string
	Kind         string
	OwnerNodeID  string
	AgentID      string
	CWD          string
	Shell        string
	Command      string
	Status       string
	ExitCode     *int32
	BackendKind  string
	Generation   uint64
	AttachState  string
	Intent       string
	CreatedAtMS  int64
	EndedAtMS    int64
	LastOutputMS int64
}

func column(row *pb.ImportedSqlRow, name string) (string, bool) {
	for _, value := range row.GetColumns() {
		if value.GetName() != name {
			continue
		}
		switch stored := value.GetValue().(type) {
		case *pb.ImportedSqlColumn_NullValue:
			return "", true
		case *pb.ImportedSqlColumn_TextValue:
			return stored.TextValue, true
		case *pb.ImportedSqlColumn_IntegerValue:
			return strconv.FormatInt(stored.IntegerValue, 10), true
		default:
			return "", false
		}
	}
	return "", false
}

// milliseconds converts a stored RFC 3339 timestamp. An unreadable one is
// reported rather than replaced: a session created in 1970 because a string
// could not be parsed is a silent data change.
func milliseconds(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0, fmt.Errorf("%w: unreadable timestamp", ErrInvalid)
	}
	return parsed.UnixMilli(), nil
}

func integer(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	var parsed int64
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return 0, fmt.Errorf("%w: unreadable number", ErrInvalid)
	}
	return parsed, nil
}

// readStaged reads the `terminal_sessions` rows one import staged, keyed by
// session identifier.
func (s *Service) readStaged(ctx context.Context, importID string) (map[string]stagedSession, error) {
	workspaces, err := s.store.WorkspacesOfKind(ctx, legacySessions)
	if err != nil {
		return nil, err
	}
	result := map[string]stagedSession{}
	for _, workspaceID := range workspaces {
		after := ""
		for {
			page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: legacySessions, AfterID: after, Limit: storage.MaxPageSize})
			if err != nil {
				return nil, err
			}
			for _, entity := range page.Entities {
				// Several imports can coexist in one Host; only this one's rows
				// are the source of the projection being verified.
				if !strings.HasPrefix(entity.ID, importID+".") {
					continue
				}
				row := new(pb.ImportedSqlRow)
				if err = proto.Unmarshal(entity.Payload, row); err != nil || row.GetTable() != "terminal_sessions" {
					return nil, storage.ErrCorrupt
				}
				staged, err := projectStaged(row)
				if err != nil {
					return nil, err
				}
				result[staged.SessionID] = staged
			}
			if !page.HasMore || page.NextID == after {
				break
			}
			after = page.NextID
		}
	}
	return result, nil
}

func projectStaged(row *pb.ImportedSqlRow) (stagedSession, error) {
	id, ok := column(row, "id")
	workspaceID, workspaceOK := column(row, "workspace_id")
	if !ok || !workspaceOK || !validID(id) || !validID(workspaceID) {
		return stagedSession{}, fmt.Errorf("%w: a staged session row is unreadable", ErrInvalid)
	}
	staged := stagedSession{SessionID: id, WorkspaceID: workspaceID}
	staged.SessionKey, _ = column(row, "session_key")
	staged.Kind, _ = column(row, "kind")
	staged.OwnerNodeID, _ = column(row, "owner_node_id")
	staged.AgentID, _ = column(row, "agent_id")
	staged.CWD, _ = column(row, "cwd")
	staged.Shell, _ = column(row, "shell")
	staged.Command, _ = column(row, "command")
	staged.Status, _ = column(row, "status")
	staged.BackendKind, _ = column(row, "backend_kind")
	staged.AttachState, _ = column(row, "attach_state")
	staged.Intent, _ = column(row, "termination_intent")
	if staged.SessionKey == "" {
		staged.SessionKey = id
	}
	exit, _ := column(row, "exit_code")
	if exit != "" {
		value, err := integer(exit)
		if err != nil {
			return stagedSession{}, err
		}
		code := int32(value)
		staged.ExitCode = &code
	}
	generation, _ := column(row, "generation")
	value, err := integer(generation)
	if err != nil || value < 0 {
		return stagedSession{}, fmt.Errorf("%w: a staged session has an unreadable generation", ErrInvalid)
	}
	staged.Generation = uint64(value)
	created, _ := column(row, "created_at")
	ended, _ := column(row, "ended_at")
	output, _ := column(row, "last_output_at")
	if staged.CreatedAtMS, err = milliseconds(created); err != nil {
		return stagedSession{}, err
	}
	if staged.EndedAtMS, err = milliseconds(ended); err != nil {
		return stagedSession{}, err
	}
	if staged.LastOutputMS, err = milliseconds(output); err != nil {
		return stagedSession{}, err
	}
	return staged, nil
}

// projectKind maps the Runtime's `kind` column. `command` is the automation
// command session that `command_sessions` records; projecting it here is what
// §3.1 v8 means by folding that table in, so there is one answer to "which
// sessions exist" rather than two tables to join.
func projectKind(kind string) pb.SessionKind {
	switch kind {
	case "agent":
		return pb.SessionKind_SESSION_KIND_AGENT
	case "command":
		return pb.SessionKind_SESSION_KIND_COMMAND
	default:
		return pb.SessionKind_SESSION_KIND_TERMINAL
	}
}

// projectStatus maps the Runtime's four status words onto this domain's enum.
// A word this build does not know is refused rather than mapped to a default:
// guessing would record a session as running, or as ended, on no evidence.
func projectStatus(status string) (pb.SessionStatus, string, error) {
	switch status {
	case "running":
		return pb.SessionStatus_SESSION_STATUS_RUNNING, "", nil
	case "exited":
		return pb.SessionStatus_SESSION_STATUS_EXITED, "", nil
	case "terminated":
		return pb.SessionStatus_SESSION_STATUS_EXITED, "", nil
	case "failed":
		return pb.SessionStatus_SESSION_STATUS_EXITED, "session.run.failed", nil
	default:
		return 0, "", fmt.Errorf("%w: a staged session has an unknown status %q", ErrInvalid, status)
	}
}

func projectAttach(state string) pb.SessionAttachState {
	switch state {
	case "live":
		return pb.SessionAttachState_SESSION_ATTACH_STATE_ATTACHED
	case "exited":
		return pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED
	default:
		return pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED
	}
}

// stagedRecord turns one staged row into the row this Host will store.
//
// The launch is reassembled from the columns the Runtime kept — the directory,
// the shell, the command and the agent id — and its digest is computed here.
// The argv is absent because `terminal_sessions` never stored one: an SSH
// session's argv was rebuilt from settings on every start, and inventing one
// would freeze a command line nobody reviewed.
func stagedRecord(staged stagedSession) (storage.Session, error) {
	status, reason, err := projectStatus(staged.Status)
	if err != nil {
		return storage.Session{}, err
	}
	if staged.CreatedAtMS <= 0 {
		return storage.Session{}, fmt.Errorf("%w: a staged session has no creation time", ErrInvalid)
	}
	launch := &pb.SessionLaunch{
		Shell:            staged.Shell,
		Command:          staged.Command,
		WorkingDirectory: staged.CWD,
	}
	if staged.AgentID != "" {
		launch.Agent = &pb.AgentLaunchSpec{AgentId: staged.AgentID, WorkingDirectory: staged.CWD}
	}
	value := &pb.Session{
		SessionId:          staged.SessionID,
		WorkspaceId:        staged.WorkspaceID,
		SessionKey:         staged.SessionKey,
		OwnerNodeId:        staged.OwnerNodeID,
		Launch:             launch,
		BackendKind:        staged.BackendKind,
		Generation:         staged.Generation,
		Kind:               projectKind(staged.Kind),
		Status:             status,
		AttachState:        projectAttach(staged.AttachState),
		TerminationIntent:  intentFor(staged.Intent),
		ReasonCode:         reason,
		EndedAtUnixMs:      staged.EndedAtMS,
		LastOutputAtUnixMs: staged.LastOutputMS,
	}
	if reason == "" && staged.Intent != "" && staged.Intent != "none" {
		// The Runtime's own word, kept verbatim so the rollback puts back the
		// value the column had rather than one derived from a lossy enum.
		value.ReasonCode = reasonFor(staged.Intent)
	}
	if staged.ExitCode != nil {
		code := *staged.ExitCode
		value.ExitCode = &code
	}
	updated := staged.EndedAtMS
	if updated <= 0 {
		updated = staged.CreatedAtMS
	}
	return record(value, staged.CreatedAtMS, updated)
}

// Adopt projects the staged `terminal_sessions` rows and verifies them item for
// item. A report that did not match is returned rather than swallowed: the
// operator needs to see which session blocked the switch.
func (s *Service) Adopt(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	staged, err := s.readStaged(ctx, importID)
	if err != nil {
		return nil, err
	}
	for _, sessionID := range sortedKeys(staged) {
		next, err := stagedRecord(staged[sessionID])
		if err != nil {
			return nil, err
		}
		current, err := s.store.GetSession(ctx, sessionID)
		expected := uint64(0)
		switch {
		case err == nil:
			// Re-adopting after a rollback: an identical record is left alone
			// rather than re-published, so a second switch does not tell every
			// client that every terminal changed.
			if sameSession(current, next) {
				continue
			}
			expected = current.Revision
			next.CreatedAtMS = current.CreatedAtMS
			if next, err = stamp(next); err != nil {
				return nil, err
			}
		case errors.Is(err, storage.ErrNotFound):
		default:
			return nil, err
		}
		if _, err = s.store.PutSession(ctx, "session/adopt/"+importID+"/"+sessionID, next, expected); err != nil {
			return nil, err
		}
		// A session that was running carries a run for its current generation.
		// Without it the record would claim a generation nothing accounts for,
		// which is the one state a reclaim cannot tell from a stale one.
		if next.Generation > 0 {
			run := storage.SessionRun{
				SessionID:   sessionID,
				Generation:  next.Generation,
				BackendRef:  "",
				ReasonCode:  "session.run.adopted",
				StartedAtMS: next.CreatedAtMS,
				EndedAtMS:   next.EndedAtMS,
				ExitCode:    next.ExitCode,
			}
			if run, err = stampRun(run); err != nil {
				return nil, err
			}
			if _, err = s.store.PutSessionRun(ctx, "session/adopt/"+importID+"/"+sessionID+"/run", run); err != nil {
				return nil, err
			}
		}
	}
	return s.Verify(ctx, importID)
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// sameSession compares what a record says about a session. Timestamps and the
// revision are excluded: they are how the record was reached, not what it says.
func sameSession(left, right storage.Session) bool {
	if (left.ExitCode == nil) != (right.ExitCode == nil) {
		return false
	}
	if left.ExitCode != nil && *left.ExitCode != *right.ExitCode {
		return false
	}
	return left.WorkspaceID == right.WorkspaceID && left.ExecutionHostID == right.ExecutionHostID &&
		left.SessionKey == right.SessionKey && left.OwnerNodeID == right.OwnerNodeID &&
		left.Kind == right.Kind && left.Status == right.Status &&
		left.AttachState == right.AttachState && left.Intent == right.Intent &&
		left.BackendKind == right.BackendKind && left.Generation == right.Generation &&
		string(left.LaunchSHA256) == string(right.LaunchSHA256) &&
		left.ReasonCode == right.ReasonCode && left.Deleted == right.Deleted
}

// Verify compares the stored records with the staged rows they came from
// (§3.3 session row). It writes nothing and grants nothing; the switch refuses
// on an unmatched report.
//
// The checks are the ones §3.3 names, each one a separate statement so a
// failure says which property broke rather than that "something differs":
// counts, identifiers, logical keys, node bindings, generations, statuses,
// launch digests and timestamps.
func (s *Service) Verify(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	staged, err := s.readStaged(ctx, importID)
	if err != nil {
		return nil, err
	}
	builder := new(checkBuilder)
	stored := map[string]storage.Session{}
	var missing, keys, bindings, generations, statuses, launches, timestamps []string
	for _, sessionID := range sortedKeys(staged) {
		row := staged[sessionID]
		session, err := s.store.GetSession(ctx, sessionID)
		if err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				missing = append(missing, sessionID)
				continue
			}
			return nil, err
		}
		stored[sessionID] = session
		expected, err := stagedRecord(row)
		if err != nil {
			return nil, err
		}
		if session.Deleted || session.WorkspaceID != row.WorkspaceID {
			missing = append(missing, sessionID)
		}
		if session.SessionKey != row.SessionKey {
			keys = append(keys, sessionID)
		}
		if session.OwnerNodeID != row.OwnerNodeID {
			bindings = append(bindings, sessionID)
		}
		if session.Generation != row.Generation {
			generations = append(generations, sessionID)
		}
		if session.Status != expected.Status || session.AttachState != expected.AttachState {
			statuses = append(statuses, sessionID)
		}
		if string(session.LaunchSHA256) != string(expected.LaunchSHA256) {
			launches = append(launches, sessionID)
		}
		if session.CreatedAtMS != row.CreatedAtMS || session.EndedAtMS != row.EndedAtMS {
			timestamps = append(timestamps, sessionID)
		}
	}
	total := uint64(len(staged))
	found := uint64(len(stored))
	builder.record("session.count", total, found, nil)
	builder.record("session.ids", total, found, missing)
	builder.record("session.keys", total, found, keys)
	builder.record("session.node_binding", total, found, bindings)
	builder.record("session.generation", total, found, generations)
	builder.record("session.status", total, found, statuses)
	builder.record("session.launch_sha256", total, found, launches)
	builder.record("session.timestamps", total, found, timestamps)
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SESSION,
		ImportId:         importID,
		Checks:           builder.checks,
		EntityCount:      found,
		VerifiedAtUnixMs: s.now(),
		Matched:          true,
	}
	for _, check := range builder.checks {
		if !check.Matched {
			report.Matched = false
		}
	}
	return report, nil
}

type checkBuilder struct{ checks []*pb.ConsistencyCheck }

func (b *checkBuilder) record(name string, expected, actual uint64, differences []string) {
	sort.Strings(differences)
	if len(differences) > maxDifferences {
		differences = differences[:maxDifferences]
	}
	b.checks = append(b.checks, &pb.ConsistencyCheck{
		Check:         name,
		ExpectedCount: expected,
		ActualCount:   actual,
		Matched:       expected == actual && len(differences) == 0,
		Differences:   differences,
	})
}
