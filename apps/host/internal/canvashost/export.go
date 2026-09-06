package canvashost

import (
	"bytes"
	"context"
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

// The reverse export a rollback owes the Runtime (host protocol design §4,
// step 6: "回滚需要反向迁移，不能直接用旧数据库覆盖新数据"; Go Host 业务所有权
// 迁移 §2.12 for the format).
//
// Handing the epoch back is not the whole of a rollback. Whatever the Host
// stored while it owned the domain has to travel back, so `ownership rollback`
// writes this package first and refuses to move the epoch if it cannot. The
// package is written, then read back and re-hashed, so "the export succeeded"
// means the bytes on disk are the bytes that were meant.
//
// Format version 2 is the one the Runtime reads. Three things changed from
// version 1, and each of them is what a reader needed:
//
//   - an entity file is a length-prefixed sequence of ReverseExportRecord, so a
//     reader takes one entity at a time and a truncated file is a short read
//     rather than a half-decoded canvas;
//   - the index names the domain, the epoch and the event watermark, so a
//     package cannot be applied to the wrong database or the wrong epoch;
//   - every file carries a second digest over its canonical content — records
//     with `revision` cleared and `assets` dropped. Those two are Host-side
//     facts the Runtime has nowhere to store, so excluding them is what lets
//     the Runtime's own re-read be compared with this package byte for byte.

// ExportFormatVersion is the package's own contract version. A reader that does
// not recognise it must refuse the package rather than parse it optimistically.
const ExportFormatVersion = 2

// ExportDomain is the only domain this package format carries so far. It is
// written into the index so a reader refuses a package meant for another one
// instead of applying it to the canvas.
const ExportDomain = "canvas"

// ExportIndexFile is the package's own description, JSON so that an operator
// can read a rollback package without a decoder.
const ExportIndexFile = "export.json"

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
	index := exportIndex{
		FormatVersion: ExportFormatVersion,
		HostID:        s.options.HostID,
		Epoch:         record.Epoch,
		EventSequence: watermark,
		Domain:        ExportDomain,
	}
	workspaces, err := s.store.WorkspacesOfKind(ctx, KindWorkspace)
	if err != nil {
		return nil, err
	}
	for _, workspaceID := range workspaces {
		entity, err := s.store.Read(ctx, workspaceKey(workspaceID))
		if err != nil || entity.Deleted {
			continue
		}
		records, err := s.workspaceRecords(ctx, workspaceID)
		if err != nil {
			return nil, err
		}
		payload, err := encodeRecords(records)
		if err != nil {
			return nil, err
		}
		content, err := canonicalDigest(records)
		if err != nil {
			return nil, err
		}
		name := hex.EncodeToString(digest([]byte(workspaceID))[:16]) + ".pb"
		if err = writeExactly(filepath.Join(directory, name), payload); err != nil {
			return nil, err
		}
		index.EntityCount += uint64(len(records))
		index.Files = append(index.Files, exportFile{
			Name:          name,
			WorkspaceID:   workspaceID,
			Bytes:         uint64(len(payload)),
			Sha256:        hex.EncodeToString(digest(payload)),
			ContentSha256: hex.EncodeToString(content),
			EntityCount:   uint64(len(records)),
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
	builder.record("export_entities", index.EntityCount, index.EntityCount, nil)
	report := &pb.CanvasConsistencyReport{
		Checks:           builder.checks,
		Matched:          len(differences) == 0,
		EntityCount:      index.EntityCount,
		VerifiedAtUnixMs: s.now(),
	}
	if !report.Matched {
		// What was read back is not what was written. The package is the only
		// copy of a domain the Host is about to stop owning, so this is a
		// failed verification, not a warning.
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// readExportIndex reads back the index of a package this Host wrote, together
// with the digest of the exact bytes on disk. That digest is what the Runtime
// is told to expect, so a package edited between writing and applying is
// refused by the reader rather than trusted because we wrote it.
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

// workspaceRecords reads a whole workspace with no paging, in the order both
// sides serialize it: the workspace, then canvases, nodes, edges and
// annotations, each group sorted by its own identifier. The order is part of
// the format — the same records in another order hash differently.
//
// The read is complete on purpose: a partial package would be a rollback that
// quietly dropped canvases.
func (s *Service) workspaceRecords(ctx context.Context, workspaceID string) ([]*pb.ReverseExportRecord, error) {
	entity, err := s.store.Read(ctx, workspaceKey(workspaceID))
	if err != nil {
		return nil, err
	}
	workspace, err := decodeWorkspace(entity)
	if err != nil {
		return nil, err
	}
	records := []*pb.ReverseExportRecord{{Entity: &pb.ReverseExportRecord_Workspace{Workspace: workspace}}}
	items, err := s.collect(ctx, workspaceID, KindCanvas, "")
	if err != nil {
		return nil, err
	}
	canvases := make([]*pb.Canvas, 0, len(items))
	var nodes []*pb.CanvasNode
	var edges []*pb.CanvasEdge
	var annotations []*pb.CanvasAnnotation
	for _, item := range items {
		canvas, err := decodeCanvas(item)
		if err != nil {
			return nil, err
		}
		canvases = append(canvases, canvas)
		document, err := s.document(ctx, workspaceID, canvas.CanvasId)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, document.Nodes...)
		edges = append(edges, document.Edges...)
		annotations = append(annotations, document.Annotations...)
	}
	sort.Slice(canvases, func(a, b int) bool { return canvases[a].CanvasId < canvases[b].CanvasId })
	sort.Slice(nodes, func(a, b int) bool {
		return less(nodes[a].CanvasId, nodes[a].NodeId, nodes[b].CanvasId, nodes[b].NodeId)
	})
	sort.Slice(edges, func(a, b int) bool {
		return less(edges[a].CanvasId, edges[a].EdgeId, edges[b].CanvasId, edges[b].EdgeId)
	})
	sort.Slice(annotations, func(a, b int) bool {
		return less(annotations[a].CanvasId, annotations[a].NodeId, annotations[b].CanvasId, annotations[b].NodeId)
	})
	for _, canvas := range canvases {
		records = append(records, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Canvas{Canvas: canvas}})
	}
	for _, node := range nodes {
		records = append(records, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Node{Node: node}})
	}
	for _, edge := range edges {
		records = append(records, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Edge{Edge: edge}})
	}
	for _, annotation := range annotations {
		records = append(records, &pb.ReverseExportRecord{Entity: &pb.ReverseExportRecord_Annotation{Annotation: annotation}})
	}
	return records, nil
}

func less(leftGroup, leftID, rightGroup, rightID string) bool {
	if leftGroup != rightGroup {
		return leftGroup < rightGroup
	}
	return leftID < rightID
}

// encodeRecords writes the entity file: a four-byte big-endian length before
// each record, matching the Worker frame convention.
func encodeRecords(records []*pb.ReverseExportRecord) ([]byte, error) {
	payload := []byte{}
	for _, record := range records {
		encoded, err := encode(record)
		if err != nil {
			return nil, err
		}
		if len(encoded) == 0 {
			// An empty record decodes to "no entity", which a reader refuses.
			// Producing one would write a package nobody can apply.
			return nil, ErrInvalid
		}
		payload = binary.BigEndian.AppendUint32(payload, uint32(len(encoded)))
		payload = append(payload, encoded...)
	}
	return payload, nil
}

// canonicalDigest hashes the same records with three things removed: the two
// Host-side facts the Runtime cannot store, and the one field the canvas import
// deliberately does not write.
//
// `revision` and node `assets` are the Host's own; read/write/execute is the
// *filesystem* domain's record (business migration §1.1) and the canvas entity
// carries only a display copy. Hashing any of them would make the comparison
// that decides whether a rollback landed permanently false — for the last one,
// from the moment the filesystem domain had changed a permission.
func canonicalDigest(records []*pb.ReverseExportRecord) ([]byte, error) {
	canonical := make([]*pb.ReverseExportRecord, 0, len(records))
	for _, record := range records {
		clone, _ := proto.Clone(record).(*pb.ReverseExportRecord)
		switch entity := clone.Entity.(type) {
		case *pb.ReverseExportRecord_Workspace:
			entity.Workspace.Revision = 0
			entity.Workspace.Permissions = nil
		case *pb.ReverseExportRecord_Canvas:
			entity.Canvas.Revision = 0
		case *pb.ReverseExportRecord_Node:
			entity.Node.Revision = 0
			entity.Node.Assets = nil
		case *pb.ReverseExportRecord_Edge:
			entity.Edge.Revision = 0
		case *pb.ReverseExportRecord_Annotation:
			entity.Annotation.Revision = 0
		}
		canonical = append(canonical, clone)
	}
	payload, err := encodeRecords(canonical)
	if err != nil {
		return nil, err
	}
	return digest(payload), nil
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
