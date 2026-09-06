package fshost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Taking the filesystem domain over (Go Host 业务所有权迁移 §2.11 steps 3-4,
// §3.3 filesystem row).
//
// The domain has no table of its own on the Runtime side: where a workspace's
// files are and what may be done with them are three columns of `workspaces`,
// which the canvas domain already exports. So adopting is a projection of rows
// this Host has already staged, not a second export — and because the filesystem
// domain may only move after the canvas has settled here, those rows are always
// present by the time this runs.
//
// Nothing is invented. A staged row this projection cannot read blocks the
// switch instead of becoming a root with a default in it, because a root with a
// default in it is a workspace pointed at the wrong directory.

const legacyWorkspaces = "legacy.workspaces"

// maxDifferences bounds what a failed check reports. An operator needs to see
// which workspaces differ, not every one of them.
const maxDifferences = 32

// stagedRoot is one `workspaces` row as the filesystem domain reads it.
type stagedRoot struct {
	WorkspaceID     string
	ExecutionHostID string
	RootPath        string
	Read            bool
	Write           bool
	Execute         bool
	CreatedAtMS     int64
	UpdatedAtMS     int64
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
		default:
			return "", false
		}
	}
	return "", false
}

// milliseconds converts a stored RFC 3339 timestamp. An unreadable one is
// reported rather than replaced: a root registered in 1970 because a string
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

// readStaged reads the `workspaces` rows one import staged, keyed by workspace.
func (s *Service) readStaged(ctx context.Context, importID string) (map[string]stagedRoot, error) {
	workspaces, err := s.store.WorkspacesOfKind(ctx, legacyWorkspaces)
	if err != nil {
		return nil, err
	}
	result := map[string]stagedRoot{}
	for _, workspaceID := range workspaces {
		after := ""
		for {
			page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: legacyWorkspaces, AfterID: after, Limit: storage.MaxPageSize})
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
				if err = proto.Unmarshal(entity.Payload, row); err != nil || row.GetTable() != "workspaces" {
					return nil, storage.ErrCorrupt
				}
				staged, err := projectStaged(row)
				if err != nil {
					return nil, err
				}
				result[staged.WorkspaceID] = staged
			}
			if !page.HasMore || page.NextID == after {
				break
			}
			after = page.NextID
		}
	}
	return result, nil
}

func projectStaged(row *pb.ImportedSqlRow) (stagedRoot, error) {
	id, ok := column(row, "id")
	rootPath, pathOK := column(row, "root_path")
	if !ok || !pathOK || !validID(id) {
		return stagedRoot{}, fmt.Errorf("%w: a staged workspace row is unreadable", ErrInvalid)
	}
	// `execution_host_id` arrived with migration 0009; a database exported
	// before it has no column at all, which means "this machine".
	host, _ := column(row, "execution_host_id")
	permissionsJSON, _ := column(row, "permissions_json")
	created, _ := column(row, "created_at")
	updated, _ := column(row, "updated_at")
	staged := stagedRoot{WorkspaceID: id, ExecutionHostID: host, RootPath: rootPath}
	if permissionsJSON != "" {
		var decoded struct{ Read, Write, Execute bool }
		if err := json.Unmarshal([]byte(permissionsJSON), &decoded); err != nil {
			return stagedRoot{}, fmt.Errorf("%w: unreadable workspace permissions", ErrInvalid)
		}
		staged.Read, staged.Write, staged.Execute = decoded.Read, decoded.Write, decoded.Execute
	}
	var err error
	if staged.CreatedAtMS, err = milliseconds(created); err != nil {
		return stagedRoot{}, err
	}
	if staged.UpdatedAtMS, err = milliseconds(updated); err != nil {
		return stagedRoot{}, err
	}
	return staged, nil
}

// stagedRecord turns one staged row into the row this Host will store. A remote
// root keeps the execution host it was opened on; its registration proof is the
// digest of the frozen path, which is what the remote Worker canonicalized and
// the Runtime stored — this Host cannot reach that machine to ask again, and
// inventing a proof would be worse than carrying the one the path already is.
func stagedRecord(staged stagedRoot) (storage.WorkspaceRoot, error) {
	value := &pb.WorkspaceRoot{
		WorkspaceId:     staged.WorkspaceID,
		ExecutionHostId: staged.ExecutionHostID,
		CanonicalPath:   staged.RootPath,
		Permissions:     &pb.CanvasWorkspacePermissions{Read: staged.Read, Write: staged.Write, Execute: staged.Execute},
	}
	if staged.ExecutionHostID != "" {
		value.ProofSha256 = pathProof(staged.ExecutionHostID, staged.RootPath)
	}
	registered := staged.CreatedAtMS
	updated := staged.UpdatedAtMS
	if registered <= 0 {
		return storage.WorkspaceRoot{}, fmt.Errorf("%w: a staged workspace has no creation time", ErrInvalid)
	}
	if updated <= 0 {
		updated = registered
	}
	return record(value, registered, updated)
}

// Adopt projects the staged `workspaces` rows into registrations and verifies
// them item for item. A report that did not match is returned rather than
// swallowed: the operator needs to see which workspace blocked the switch.
func (s *Service) Adopt(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	staged, err := s.readStaged(ctx, importID)
	if err != nil {
		return nil, err
	}
	for _, workspaceID := range sortedKeys(staged) {
		next, err := stagedRecord(staged[workspaceID])
		if err != nil {
			return nil, err
		}
		current, err := s.store.GetWorkspaceRoot(ctx, workspaceID)
		expected := uint64(0)
		switch {
		case err == nil:
			// Re-adopting after a rollback: an identical registration is left
			// alone rather than re-published, so a second switch does not tell
			// every client that every workspace changed.
			if sameRegistration(current, next) {
				continue
			}
			expected = current.Revision
			next.RegisteredAtMS = current.RegisteredAtMS
			if next.Payload, err = payload(message(next)); err != nil {
				return nil, err
			}
		case errors.Is(err, storage.ErrNotFound):
		default:
			return nil, err
		}
		if _, err = s.store.PutWorkspaceRoot(ctx, "filesystem/adopt/"+importID+"/"+workspaceID, next, expected); err != nil {
			return nil, err
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

// Verify compares the stored registrations with the staged rows they came from
// (§3.3). It writes nothing and grants nothing; the switch refuses on an
// unmatched report.
func (s *Service) Verify(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	staged, err := s.readStaged(ctx, importID)
	if err != nil {
		return nil, err
	}
	builder := new(checkBuilder)
	roots := map[string]storage.WorkspaceRoot{}
	pathDifferences := []string{}
	proofDifferences := []string{}
	permissionDifferences := []string{}
	for _, workspaceID := range sortedKeys(staged) {
		row := staged[workspaceID]
		stored, err := s.store.GetWorkspaceRoot(ctx, workspaceID)
		if err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				pathDifferences = append(pathDifferences, workspaceID)
				continue
			}
			return nil, err
		}
		roots[workspaceID] = stored
		if stored.Deleted || stored.CanonicalPath != row.RootPath || stored.ExecutionHostID != row.ExecutionHostID {
			pathDifferences = append(pathDifferences, workspaceID)
		}
		expectedProof := []byte(nil)
		if row.ExecutionHostID != "" {
			expectedProof = pathProof(row.ExecutionHostID, row.RootPath)
		}
		if string(stored.ProofSHA256) != string(expectedProof) {
			proofDifferences = append(proofDifferences, workspaceID)
		}
		if stored.Read != row.Read || stored.Write != row.Write || stored.Execute != row.Execute {
			permissionDifferences = append(permissionDifferences, workspaceID)
		}
	}
	builder.record("filesystem.roots", uint64(len(staged)), uint64(len(roots)), pathDifferences)
	builder.record("filesystem.remote_proofs", uint64(len(staged)), uint64(len(roots)), proofDifferences)
	builder.record("filesystem.permissions", uint64(len(staged)), uint64(len(roots)), permissionDifferences)
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_FILESYSTEM,
		ImportId:         importID,
		Checks:           builder.checks,
		EntityCount:      uint64(len(roots)),
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
