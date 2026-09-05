package canvashost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// C02 consistency verification.
//
// The switch precondition is not "the import reported no error"; it is "what
// the Host now holds is item-for-item what the Runtime exported". This file
// does that comparison and reports every difference it finds. A single
// difference blocks the switch — there is no severity that lets a mismatch
// through, because a canvas that lost one node is not a migrated canvas.
//
// Two independent sources are compared against, on purpose:
//
//   - the export manifest, which the Runtime produced and signed with digests
//     (identifiers, whiteboard digests, annotations, managed assets), and
//   - the staged legacy rows themselves, which are a lossless copy of the
//     source database (positions, sizes, frame nesting, links, node payloads).
//
// Comparing only against the manifest would verify the manifest, not the
// projection; comparing only against the rows would verify the projection, not
// the export. Both together say the canvas survived the trip.

const maxDifferences = 32
const maxManifestBytes = 64 << 20

var importIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func validImportID(value string) bool { return importIDPattern.MatchString(value) }

func digest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

// manifest reads the staged export manifest from the import directory the
// staging record names. The bytes are re-hashed against the staging metadata,
// so a manifest edited on disk after the import cannot authorize a switch.
func (s *Service) manifest(ctx context.Context, importID string) (*pb.MigrationExportManifest, string, error) {
	stage, err := s.store.GetStaging(ctx, importID)
	if err != nil {
		return nil, "", err
	}
	if stage.Active || stage.Purpose != "migration.import" || len(stage.Metadata) != 32 {
		return nil, "", storage.ErrOwnership
	}
	root := filepath.Join(filepath.Dir(s.store.Path()), filepath.FromSlash(stage.RelativePath))
	file, err := os.Open(filepath.Join(root, "manifest.pb"))
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxManifestBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(raw) > maxManifestBytes || !bytes.Equal(digest(raw), stage.Metadata) {
		return nil, "", storage.ErrCorrupt
	}
	value := new(pb.MigrationExportManifest)
	if err = (proto.UnmarshalOptions{RecursionLimit: 64}).Unmarshal(raw, value); err != nil {
		return nil, "", err
	}
	return value, root, nil
}

// assetReferences maps a manifest entity name ("nodes/<id>/data_json") to the
// asset references that entity carries, after re-hashing the staged file. An
// asset the export could not copy produces no reference and is reported as a
// difference during verification rather than attached with an empty digest.
func (s *Service) assetReferences(ctx context.Context, importID string) (map[string][]*pb.CanvasAssetRef, error) {
	value, root, err := s.manifest(ctx, importID)
	if err != nil {
		return nil, err
	}
	result := map[string][]*pb.CanvasAssetRef{}
	for _, asset := range value.Assets {
		if !asset.Copied {
			continue
		}
		if !strings.HasPrefix(asset.BundlePath, "assets/") || strings.Contains(asset.BundlePath, "..") {
			return nil, storage.ErrCorrupt
		}
		path := filepath.Join(root, filepath.FromSlash(asset.BundlePath))
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		hash := sha256.New()
		size, err := io.Copy(hash, file)
		file.Close()
		if err != nil {
			return nil, err
		}
		if uint64(size) != asset.Bytes || !bytes.Equal(hash.Sum(nil), asset.Sha256) {
			return nil, storage.ErrCorrupt
		}
		for _, entity := range asset.ReferencedBy {
			owner := entityOwner(entity)
			if owner == "" {
				continue
			}
			result[owner] = append(result[owner], &pb.CanvasAssetRef{
				AssetId:      filepath.ToSlash(asset.BundlePath),
				WorkspaceId:  asset.WorkspaceId,
				RelativePath: asset.RelativePath,
				Sha256:       append([]byte(nil), asset.Sha256...),
				Bytes:        asset.Bytes,
			})
		}
	}
	for _, refs := range result {
		sort.Slice(refs, func(a, b int) bool { return refs[a].AssetId < refs[b].AssetId })
	}
	return result, nil
}

// entityOwner reduces a manifest reference like "nodes/<id>/data_json" to
// "nodes/<id>". A reference this version cannot attribute returns "" and is
// left out rather than guessed onto some other object.
func entityOwner(entity string) string {
	parts := strings.Split(entity, "/")
	if len(parts) < 2 || parts[1] == "" {
		return ""
	}
	switch parts[0] {
	case "nodes", "boards":
		return parts[0] + "/" + parts[1]
	default:
		return ""
	}
}

type checkBuilder struct{ checks []*pb.CanvasConsistencyCheck }

func (b *checkBuilder) record(name string, expected, actual uint64, differences []string) {
	sort.Strings(differences)
	if len(differences) > maxDifferences {
		differences = differences[:maxDifferences]
	}
	b.checks = append(b.checks, &pb.CanvasConsistencyCheck{
		Check:         name,
		ExpectedCount: expected,
		ActualCount:   actual,
		Matched:       expected == actual && len(differences) == 0,
		Differences:   differences,
	})
}

// Verify compares the materialized canvas against the export it came from and
// returns a report. It performs no writes and grants nothing; the caller
// decides what an unmatched report means, and the switch refuses on one.
func (s *Service) Verify(ctx context.Context, importID string) (*pb.CanvasConsistencyReport, error) {
	if !validImportID(importID) {
		return nil, ErrInvalid
	}
	value, _, err := s.manifest(ctx, importID)
	if err != nil {
		return nil, err
	}
	report := &pb.CanvasConsistencyReport{
		ImportId:         importID,
		ExportId:         value.ExportId,
		ManifestSha256:   digest2(value),
		VerifiedAtUnixMs: s.now(),
	}
	builder := &checkBuilder{}
	assets, err := s.assetReferences(ctx, importID)
	if err != nil {
		return nil, err
	}

	// 1. Identifiers, straight from the manifest's own identity sets.
	expected := map[string][]string{}
	for _, set := range value.Identities {
		expected[set.Table] = set.Ids
	}
	stored := map[string]map[string]bool{"workspaces": {}, "boards": {}, "nodes": {}, "edges": {}}

	workspaces, err := s.store.WorkspacesOfKind(ctx, KindWorkspace)
	if err != nil {
		return nil, err
	}
	var entityCount uint64
	positionDifferences := []string{}
	nestingDifferences := []string{}
	linkDifferences := []string{}
	whiteboardDifferences := []string{}
	assetDifferences := []string{}
	annotationDifferences := []string{}

	canvasWhiteboards := map[string]*pb.CanvasWhiteboard{}
	nodeAssets := map[string][]*pb.CanvasAssetRef{}
	annotations := map[string]*pb.CanvasAnnotation{}

	for _, workspaceID := range workspaces {
		entity, err := s.store.Read(ctx, workspaceKey(workspaceID))
		if err != nil || entity.Deleted {
			continue
		}
		stored["workspaces"][workspaceID] = true
		entityCount++
		tables, err := s.readLegacy(ctx, importID, workspaceID)
		if err != nil {
			return nil, err
		}
		canvases, err := s.collect(ctx, workspaceID, KindCanvas, "")
		if err != nil {
			return nil, err
		}
		for _, item := range canvases {
			canvas, err := decodeCanvas(item)
			if err != nil {
				return nil, err
			}
			stored["boards"][canvas.CanvasId] = true
			entityCount++
			canvasWhiteboards[canvas.CanvasId] = canvas.Whiteboard
			document, err := s.document(ctx, workspaceID, canvas.CanvasId)
			if err != nil {
				return nil, err
			}
			nodeIDs := map[string]bool{}
			for _, node := range document.Nodes {
				stored["nodes"][node.NodeId] = true
				nodeIDs[node.NodeId] = true
				entityCount++
				nodeAssets["nodes/"+node.NodeId] = node.Assets
				row, ok := tables.nodes[node.NodeId]
				if !ok {
					positionDifferences = append(positionDifferences, node.NodeId)
					continue
				}
				// 2. Position, size and collapse state, against the source row.
				if !samePosition(node, row) {
					positionDifferences = append(positionDifferences, node.NodeId)
				}
				// 3. Frame nesting, against the source row's parent column.
				parent, _ := row.text("parent_id")
				if node.ParentId != parent {
					nestingDifferences = append(nestingDifferences, node.NodeId)
				}
			}
			for _, node := range document.Nodes {
				if node.ParentId != "" && !nodeIDs[node.ParentId] {
					nestingDifferences = append(nestingDifferences, node.NodeId)
				}
			}
			// 4. Context links, against the source rows' endpoints.
			for _, edge := range document.Edges {
				stored["edges"][edge.EdgeId] = true
				entityCount++
				row, ok := tables.edges[edge.EdgeId]
				if !ok {
					linkDifferences = append(linkDifferences, edge.EdgeId)
					continue
				}
				source, _ := row.text("source_node_id")
				target, _ := row.text("target_node_id")
				if edge.SourceNodeId != source || edge.TargetNodeId != target || !nodeIDs[source] || !nodeIDs[target] {
					linkDifferences = append(linkDifferences, edge.EdgeId)
				}
			}
			for _, annotation := range document.Annotations {
				entityCount++
				annotations[annotation.NodeId] = annotation
			}
		}
	}

	for _, table := range []string{"workspaces", "boards", "nodes", "edges"} {
		missing := []string{}
		seen := map[string]bool{}
		for _, id := range expected[table] {
			seen[id] = true
			if !stored[table][id] {
				missing = append(missing, id)
			}
		}
		// An object the Host holds that the export never listed is just as much
		// a difference as a missing one: it did not come from this migration.
		for id := range stored[table] {
			if !seen[id] {
				missing = append(missing, id)
			}
		}
		builder.record(table, uint64(len(expected[table])), uint64(len(stored[table])), missing)
	}

	// 5. Whiteboard snapshots, against the manifest's own digests.
	for _, canvas := range value.Canvases {
		board := canvasWhiteboards[canvas.CanvasId]
		if canvas.WhiteboardBytes == 0 {
			if board != nil {
				whiteboardDifferences = append(whiteboardDifferences, canvas.CanvasId)
			}
			continue
		}
		if board == nil || board.Bytes != canvas.WhiteboardBytes || !bytes.Equal(board.Sha256, canvas.WhiteboardSha256) {
			whiteboardDifferences = append(whiteboardDifferences, canvas.CanvasId)
		}
	}
	builder.record("whiteboards", uint64(len(value.Canvases)), uint64(len(canvasWhiteboards)), whiteboardDifferences)

	// 6. Managed assets. The comparison is per node reference, not per file: one
	// image can be named by a node payload and by a whiteboard snapshot, and
	// those are two different statements about where it is used. A whiteboard
	// reference is covered by the snapshot digest checked above, so only node
	// references are counted here. An asset the export could not copy is a
	// difference on its own: the switch would otherwise move ownership of a
	// canvas whose picture is gone.
	expectedAssets := 0
	actualAssets := 0
	for _, asset := range value.Assets {
		if !asset.Copied {
			assetDifferences = append(assetDifferences, asset.RelativePath)
		}
	}
	for owner, refs := range assets {
		if !strings.HasPrefix(owner, "nodes/") {
			continue
		}
		expectedAssets += len(refs)
		held := nodeAssets[owner]
		actualAssets += len(held)
		if len(held) != len(refs) {
			assetDifferences = append(assetDifferences, owner)
			continue
		}
		for index, ref := range refs {
			if held[index].RelativePath != ref.RelativePath || !bytes.Equal(held[index].Sha256, ref.Sha256) || held[index].Bytes != ref.Bytes {
				assetDifferences = append(assetDifferences, owner)
				break
			}
		}
	}
	// A node holding a reference the export never listed is equally a
	// difference; it did not come from this migration.
	for owner, held := range nodeAssets {
		if len(held) > 0 && len(assets[owner]) == 0 {
			assetDifferences = append(assetDifferences, owner)
			actualAssets += len(held)
		}
	}
	builder.record("assets", uint64(expectedAssets), uint64(actualAssets), assetDifferences)

	// 7. Labels and notes, against the manifest's annotation archive.
	expectedAnnotations := 0
	for _, archived := range value.Annotations {
		labels := []string{}
		if len(archived.LabelsJson) > 0 {
			if err := json.Unmarshal(archived.LabelsJson, &labels); err != nil {
				annotationDifferences = append(annotationDifferences, archived.NodeId)
				continue
			}
		}
		note := string(archived.NoteUtf8)
		if len(labels) == 0 && note == "" {
			continue
		}
		expectedAnnotations++
		held, ok := annotations[archived.NodeId]
		if !ok || held.Note != note || !equalStrings(held.Labels, labels) {
			annotationDifferences = append(annotationDifferences, archived.NodeId)
		}
	}
	builder.record("annotations", uint64(expectedAnnotations), uint64(len(annotations)), annotationDifferences)

	builder.record("positions", uint64(len(stored["nodes"])), uint64(len(stored["nodes"])), positionDifferences)
	builder.record("frame_nesting", uint64(len(stored["nodes"])), uint64(len(stored["nodes"])), nestingDifferences)
	builder.record("context_links", uint64(len(stored["edges"])), uint64(len(stored["edges"])), linkDifferences)

	report.Checks = builder.checks
	report.EntityCount = entityCount
	report.Matched = true
	for _, check := range report.Checks {
		if !check.Matched {
			report.Matched = false
		}
	}
	// An export that reported an error about its own contents cannot authorize
	// a switch either, whatever the comparison says about what survived.
	for _, issue := range value.Issues {
		if issue.Severity != "warning" {
			report.Matched = false
			report.Checks = append(report.Checks, &pb.CanvasConsistencyCheck{Check: "export_issue", Matched: false, Differences: []string{issue.Code}})
		}
	}
	if !value.AssetsComplete {
		report.Matched = false
		report.Checks = append(report.Checks, &pb.CanvasConsistencyCheck{Check: "assets_complete", Matched: false, Differences: []string{"assets_incomplete"}})
	}
	return report, nil
}

func digest2(value *pb.MigrationExportManifest) []byte {
	raw, err := (proto.MarshalOptions{Deterministic: true}).Marshal(value)
	if err != nil {
		return nil
	}
	return digest(raw)
}

func samePosition(node *pb.CanvasNode, row legacyRow) bool {
	x, _, okX := row.real("x")
	y, _, okY := row.real("y")
	if !okX || !okY || node.Position == nil || node.Position.X != x || node.Position.Y != y {
		return false
	}
	width, hasWidth, _ := row.real("width")
	height, hasHeight, _ := row.real("height")
	if hasWidth && hasHeight {
		if node.Size == nil || node.Size.Width != width || node.Size.Height != height {
			return false
		}
	} else if node.Size != nil {
		return false
	}
	collapsed, hasCollapsed, _ := row.integer("collapsed")
	if hasCollapsed {
		if node.Collapsed == nil || node.GetCollapsed() != (collapsed != 0) {
			return false
		}
	} else if node.Collapsed != nil {
		return false
	}
	return true
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
