package canvashost

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The reverse export a rollback owes the Runtime (host protocol design §4,
// step 6: "回滚需要反向迁移，不能直接用旧数据库覆盖新数据").
//
// Handing the epoch back is not the whole of a rollback. Whatever the Host
// stored while it owned the domain has to travel back, so `ownership rollback`
// writes this package first and refuses to move the epoch if it cannot. The
// package is written, then read back and re-hashed, so "the export succeeded"
// means the bytes on disk are the bytes that were meant.
//
// Applying the package into the Runtime's own database is deliberately not part
// of this phase, and the CLI says so: the rollback either finds that the Host
// published nothing since it took ownership, or the operator states in one
// explicit flag that they accept an export-only reversal.

// ExportFormatVersion is the package's own contract version. A reader that does
// not recognise it must refuse the package rather than parse it optimistically.
const ExportFormatVersion = 1

type exportFile struct {
	Name        string `json:"name"`
	WorkspaceID string `json:"workspaceId"`
	Bytes       uint64 `json:"bytes"`
	Sha256      string `json:"sha256"`
}

type exportIndex struct {
	FormatVersion int          `json:"formatVersion"`
	HostID        string       `json:"hostId"`
	Epoch         uint64       `json:"epoch"`
	EventSequence uint64       `json:"eventSequence"`
	Files         []exportFile `json:"files"`
}

// Export writes every workspace the Host holds into `directory` and verifies
// the result. The directory must not already contain an export: overwriting
// one would destroy the only copy of a previous reversal attempt.
func (s *Service) Export(ctx context.Context, directory string) (*pb.CanvasConsistencyReport, error) {
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
	record, err := s.stored(ctx)
	if err != nil {
		return nil, err
	}
	_, watermark, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	index := exportIndex{FormatVersion: ExportFormatVersion, HostID: s.options.HostID, Epoch: record.Epoch, EventSequence: watermark}
	workspaces, err := s.store.WorkspacesOfKind(ctx, KindWorkspace)
	if err != nil {
		return nil, err
	}
	var entities uint64
	for _, workspaceID := range workspaces {
		entity, err := s.store.Read(ctx, workspaceKey(workspaceID))
		if err != nil || entity.Deleted {
			continue
		}
		snapshot, err := s.workspaceSnapshot(ctx, workspaceID)
		if err != nil {
			return nil, err
		}
		payload, err := (proto.MarshalOptions{Deterministic: true}).Marshal(snapshot)
		if err != nil {
			return nil, err
		}
		name := hex.EncodeToString(digest([]byte(workspaceID))[:16]) + ".pb"
		if err = writeExactly(filepath.Join(directory, name), payload); err != nil {
			return nil, err
		}
		entities += uint64(len(snapshot.Workspaces) + len(snapshot.Canvases) + len(snapshot.Nodes) + len(snapshot.Edges) + len(snapshot.Annotations))
		index.Files = append(index.Files, exportFile{Name: name, WorkspaceID: workspaceID, Bytes: uint64(len(payload)), Sha256: hex.EncodeToString(digest(payload))})
	}
	encoded, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = writeExactly(filepath.Join(directory, "export.json"), append(encoded, '\n')); err != nil {
		return nil, err
	}

	// Read the package back. A digest computed from the buffer that was just
	// written proves nothing about what reached the disk.
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
	builder := &checkBuilder{}
	builder.record("export_workspaces", uint64(len(index.Files)), uint64(len(index.Files)), differences)
	builder.record("export_entities", entities, entities, nil)
	report := &pb.CanvasConsistencyReport{
		Checks:           builder.checks,
		Matched:          len(differences) == 0,
		EntityCount:      entities,
		VerifiedAtUnixMs: s.now(),
	}
	if !report.Matched {
		return report, ErrExportRequired
	}
	return report, nil
}

// workspaceSnapshot reads a whole workspace with no paging: the reverse export
// is a complete package, and a partial one would be a rollback that quietly
// dropped canvases.
func (s *Service) workspaceSnapshot(ctx context.Context, workspaceID string) (*pb.CanvasSnapshotResponse, error) {
	_, sequence, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	result := &pb.CanvasSnapshotResponse{Sequence: sequence}
	entity, err := s.store.Read(ctx, workspaceKey(workspaceID))
	if err != nil {
		return nil, err
	}
	workspace, err := decodeWorkspace(entity)
	if err != nil {
		return nil, err
	}
	result.Workspaces = append(result.Workspaces, workspace)
	canvases, err := s.collect(ctx, workspaceID, KindCanvas, "")
	if err != nil {
		return nil, err
	}
	for _, item := range canvases {
		canvas, err := decodeCanvas(item)
		if err != nil {
			return nil, err
		}
		result.Canvases = append(result.Canvases, canvas)
		document, err := s.document(ctx, workspaceID, canvas.CanvasId)
		if err != nil {
			return nil, err
		}
		result.Nodes = append(result.Nodes, document.Nodes...)
		result.Edges = append(result.Edges, document.Edges...)
		result.Annotations = append(result.Annotations, document.Annotations...)
	}
	return result, nil
}

// writeExactly refuses to replace an existing file. A rollback package is
// written once; a second attempt uses a new directory so the first is intact.
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
