package githost

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The package a rollback leaves behind (Go Host 业务所有权迁移 §2.12).
//
// The other domains write a package so the Runtime can apply it. This one
// writes a package so a *person* can read it, and the difference is the whole
// design of the git rollback: the Runtime has no git table, so there is nothing
// to import into, and manufacturing one would create the second source of
// truth this domain is arranged to avoid.
//
// What the package holds is the one thing the Runtime genuinely cannot
// reconstruct: the history of what this Host queued while it held the domain,
// including every operation that ended `UNKNOWN_OUTCOME`. Those are the entries
// somebody has to look at — a push that may or may not have reached a remote is
// not a row you throw away because ownership moved — and after the handback
// they exist nowhere else.
//
// The format is the one `canvashost/export.go` writes and `fshost` reuses:
// version 2, a JSON index naming the domain and epoch, one length-prefixed
// record file per workspace. The index is deliberately readable without a
// decoder, because the audience is an operator in a maintenance window.

const (
	// ExportFormatVersion is the package's own contract version.
	ExportFormatVersion = 2
	// ExportDomain is written into the index so a reader refuses a package
	// meant for another domain.
	ExportDomain = storage.OwnershipDomainGit
	// ExportIndexFile is the package's own description.
	ExportIndexFile = "export.json"
)

type exportFile struct {
	Name        string `json:"name"`
	WorkspaceID string `json:"workspaceId"`
	Bytes       uint64 `json:"bytes"`
	Sha256      string `json:"sha256"`
	EntityCount uint64 `json:"entityCount"`
	// Unresolved is how many of this workspace's operations ended without an
	// answer. It is in the index rather than only inside the records because it
	// is the number an operator is looking for.
	Unresolved uint64 `json:"unresolved"`
}

type exportIndex struct {
	FormatVersion int          `json:"formatVersion"`
	HostID        string       `json:"hostId"`
	Epoch         uint64       `json:"epoch"`
	EventSequence uint64       `json:"eventSequence"`
	Domain        string       `json:"domain"`
	EntityCount   uint64       `json:"entityCount"`
	Unresolved    uint64       `json:"unresolved"`
	Files         []exportFile `json:"files"`
}

// Export writes this Host's queue history into `directory` and reads it back.
// The directory must be empty: overwriting a package would destroy the only
// copy of a previous attempt.
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
		Files:         []exportFile{},
	}
	workspaces, err := s.store.WorkspacesOfKind(ctx, OperationKind)
	if err != nil {
		return nil, err
	}
	for _, workspaceID := range workspaces {
		operations, err := s.operations(ctx, workspaceID)
		if err != nil {
			return nil, err
		}
		if len(operations) == 0 {
			continue
		}
		payload, unresolved, err := encodeOperations(operations)
		if err != nil {
			return nil, err
		}
		name := hex.EncodeToString(digest([]byte(workspaceID))[:16]) + ".pb"
		if err = writeExactly(filepath.Join(directory, name), payload); err != nil {
			return nil, err
		}
		index.EntityCount += uint64(len(operations))
		index.Unresolved += unresolved
		index.Files = append(index.Files, exportFile{
			Name:        name,
			WorkspaceID: workspaceID,
			Bytes:       uint64(len(payload)),
			Sha256:      hex.EncodeToString(digest(payload)),
			EntityCount: uint64(len(operations)),
			Unresolved:  unresolved,
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
	// the only copy of a history nothing else holds.
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
	builder.record("git.export_operations", uint64(len(index.Files)), uint64(len(index.Files)), differences)
	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_GIT,
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

// encodeOperations writes one workspace's queue history as a length-prefixed
// record sequence, and counts the entries nobody can settle.
func encodeOperations(operations []*pb.GitOperation) ([]byte, uint64, error) {
	var payload []byte
	var unresolved uint64
	for _, operation := range operations {
		if operation.GetState() == pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME {
			unresolved++
		}
		encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(operation)
		if err != nil {
			return nil, 0, err
		}
		if len(encoded) == 0 {
			return nil, 0, ErrInvalid
		}
		payload = appendUint32(payload, uint32(len(encoded)))
		payload = append(payload, encoded...)
	}
	return payload, unresolved, nil
}

func appendUint32(buffer []byte, value uint32) []byte {
	return append(buffer, byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
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
