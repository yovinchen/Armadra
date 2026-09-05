package canvashost

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

// Projection of a staged Runtime import into canvas entities (H01 step 4).
//
// `armadra-host import` stores the exported database losslessly as
// `legacy.<table>` rows; nothing about that grants write ownership and nothing
// about it is a canvas yet. This file turns those rows into the typed canvas
// objects the Host serves, and does it in a way a reviewer can check: the
// projection is pure, deterministic and idempotent, and every field it derives
// is compared back against both the staged row and the export manifest before
// ownership is allowed to move (see verify.go).
//
// The projection never invents data. A row it cannot read is a failure that
// blocks the switch, not a default value written into a canvas.

const legacyPrefix = "legacy."

type legacyRow struct {
	table   string
	columns map[string]*pb.ImportedSqlColumn
}

func (r legacyRow) text(name string) (string, bool) {
	column, ok := r.columns[name]
	if !ok {
		return "", false
	}
	if _, isNull := column.GetValue().(*pb.ImportedSqlColumn_NullValue); isNull {
		return "", true
	}
	value, ok := column.GetValue().(*pb.ImportedSqlColumn_TextValue)
	if !ok {
		return "", false
	}
	return value.TextValue, true
}

func (r legacyRow) integer(name string) (int64, bool, bool) {
	column, ok := r.columns[name]
	if !ok {
		return 0, false, false
	}
	if _, isNull := column.GetValue().(*pb.ImportedSqlColumn_NullValue); isNull {
		return 0, false, true
	}
	value, ok := column.GetValue().(*pb.ImportedSqlColumn_IntegerValue)
	if !ok {
		return 0, false, false
	}
	return value.IntegerValue, true, true
}

// real accepts an integer storage class as well: SQLite stores 0.0 written to
// a REAL column as an integer, and refusing that would fail on real data.
func (r legacyRow) real(name string) (float64, bool, bool) {
	column, ok := r.columns[name]
	if !ok {
		return 0, false, false
	}
	switch value := column.GetValue().(type) {
	case *pb.ImportedSqlColumn_NullValue:
		return 0, false, true
	case *pb.ImportedSqlColumn_RealValue:
		return value.RealValue, true, true
	case *pb.ImportedSqlColumn_IntegerValue:
		return float64(value.IntegerValue), true, true
	default:
		return 0, false, false
	}
}

// milliseconds converts a stored RFC 3339 timestamp. An unparseable value is
// reported rather than replaced: a canvas dated 1970 because a string could not
// be read is a silent data change.
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

type legacyTables struct {
	workspaces map[string]legacyRow
	boards     map[string]legacyRow
	nodes      map[string]legacyRow
	edges      map[string]legacyRow
	// Insertion order per canvas, so a projection is byte-stable across runs.
	boardsOf map[string][]string
	nodesOf  map[string][]string
	edgesOf  map[string][]string
}

func (s *Service) readLegacy(ctx context.Context, importID, workspaceID string) (*legacyTables, error) {
	tables := &legacyTables{
		workspaces: map[string]legacyRow{},
		boards:     map[string]legacyRow{},
		nodes:      map[string]legacyRow{},
		edges:      map[string]legacyRow{},
		boardsOf:   map[string][]string{},
		nodesOf:    map[string][]string{},
		edgesOf:    map[string][]string{},
	}
	for _, table := range []string{"workspaces", "boards", "nodes", "edges"} {
		entities, err := s.collect(ctx, workspaceID, legacyPrefix+table, "")
		if err != nil {
			return nil, err
		}
		for _, entity := range entities {
			// Several imports can coexist in one Host; only this one's rows are
			// the source of the projection being verified.
			if !strings.HasPrefix(entity.ID, importID+".") {
				continue
			}
			row := new(pb.ImportedSqlRow)
			if err = proto.Unmarshal(entity.Payload, row); err != nil || row.Table != table {
				return nil, storage.ErrCorrupt
			}
			columns := map[string]*pb.ImportedSqlColumn{}
			for _, column := range row.Columns {
				columns[column.GetName()] = column
			}
			parsed := legacyRow{table: table, columns: columns}
			id, ok := parsed.text("id")
			if !ok || id == "" {
				return nil, storage.ErrCorrupt
			}
			switch table {
			case "workspaces":
				tables.workspaces[id] = parsed
			case "boards":
				workspace, _ := parsed.text("workspace_id")
				tables.boards[id] = parsed
				tables.boardsOf[workspace] = append(tables.boardsOf[workspace], id)
			case "nodes":
				board, _ := parsed.text("board_id")
				tables.nodes[id] = parsed
				tables.nodesOf[board] = append(tables.nodesOf[board], id)
			case "edges":
				board, _ := parsed.text("board_id")
				tables.edges[id] = parsed
				tables.edgesOf[board] = append(tables.edgesOf[board], id)
			}
		}
	}
	for _, ids := range []map[string][]string{tables.boardsOf, tables.nodesOf, tables.edgesOf} {
		for _, list := range ids {
			sort.Strings(list)
		}
	}
	return tables, nil
}

type projection struct {
	workspace   *pb.CanvasWorkspace
	canvases    []*pb.Canvas
	nodes       []*pb.CanvasNode
	edges       []*pb.CanvasEdge
	annotations []*pb.CanvasAnnotation
}

func projectWorkspace(row legacyRow) (*pb.CanvasWorkspace, error) {
	id, _ := row.text("id")
	name, _ := row.text("name")
	root, _ := row.text("root_path")
	color, _ := row.text("color")
	permissionsJSON, _ := row.text("permissions_json")
	created, _ := row.text("created_at")
	updated, _ := row.text("updated_at")
	opened, _ := row.text("last_opened_at")
	if !validID(id) {
		return nil, fmt.Errorf("%w: workspace identifier is not portable", ErrInvalid)
	}
	permissions := &pb.CanvasWorkspacePermissions{}
	if permissionsJSON != "" {
		var decoded struct{ Read, Write, Execute bool }
		if err := json.Unmarshal([]byte(permissionsJSON), &decoded); err != nil {
			return nil, fmt.Errorf("%w: unreadable workspace permissions", ErrInvalid)
		}
		permissions.Read, permissions.Write, permissions.Execute = decoded.Read, decoded.Write, decoded.Execute
	}
	createdMS, err := milliseconds(created)
	if err != nil {
		return nil, err
	}
	updatedMS, err := milliseconds(updated)
	if err != nil {
		return nil, err
	}
	openedMS, err := milliseconds(opened)
	if err != nil {
		return nil, err
	}
	return &pb.CanvasWorkspace{
		WorkspaceId:        id,
		Name:               name,
		RootPath:           root,
		Color:              color,
		Permissions:        permissions,
		CreatedAtUnixMs:    createdMS,
		UpdatedAtUnixMs:    updatedMS,
		LastOpenedAtUnixMs: openedMS,
	}, nil
}

func projectCanvas(row legacyRow) (*pb.Canvas, error) {
	id, _ := row.text("id")
	workspace, _ := row.text("workspace_id")
	name, _ := row.text("name")
	viewportJSON, _ := row.text("viewport_json")
	whiteboard, _ := row.text("whiteboard_json")
	created, _ := row.text("created_at")
	updated, _ := row.text("updated_at")
	order, _, _ := row.integer("sort_order")
	if !validID(id) || !validID(workspace) {
		return nil, fmt.Errorf("%w: canvas identifier is not portable", ErrInvalid)
	}
	viewport := &pb.CanvasViewport{Zoom: 1}
	if viewportJSON != "" {
		var decoded struct{ X, Y, Zoom float64 }
		if err := json.Unmarshal([]byte(viewportJSON), &decoded); err != nil {
			return nil, fmt.Errorf("%w: unreadable canvas viewport", ErrInvalid)
		}
		viewport = &pb.CanvasViewport{X: decoded.X, Y: decoded.Y, Zoom: decoded.Zoom}
	}
	createdMS, err := milliseconds(created)
	if err != nil {
		return nil, err
	}
	updatedMS, err := milliseconds(updated)
	if err != nil {
		return nil, err
	}
	canvas := &pb.Canvas{
		CanvasId:        id,
		WorkspaceId:     workspace,
		Name:            name,
		SortOrder:       order,
		Viewport:        viewport,
		CreatedAtUnixMs: createdMS,
		UpdatedAtUnixMs: updatedMS,
	}
	// The whiteboard travels as opaque bytes with its own digest, exactly as
	// the export recorded it. Nothing here parses tldraw's records.
	if whiteboard != "" {
		canvas.Whiteboard = &pb.CanvasWhiteboard{
			SchemaVersion: 1,
			EngineVersion: "tldraw",
			Snapshot:      []byte(whiteboard),
			Sha256:        digest([]byte(whiteboard)),
			Bytes:         uint64(len(whiteboard)),
		}
	}
	return canvas, nil
}

func projectNode(row legacyRow) (*pb.CanvasNode, *pb.CanvasAnnotation, error) {
	id, _ := row.text("id")
	board, _ := row.text("board_id")
	nodeType, _ := row.text("type")
	title, _ := row.text("title")
	color, _ := row.text("color")
	parent, _ := row.text("parent_id")
	labelsJSON, _ := row.text("labels_json")
	note, _ := row.text("note")
	data, _ := row.text("data_json")
	created, _ := row.text("created_at")
	updated, _ := row.text("updated_at")
	if !validID(id) || !validID(board) {
		return nil, nil, fmt.Errorf("%w: node identifier is not portable", ErrInvalid)
	}
	x, hasX, okX := row.real("x")
	y, hasY, okY := row.real("y")
	if !okX || !okY || !hasX || !hasY {
		return nil, nil, fmt.Errorf("%w: node position is missing", ErrInvalid)
	}
	createdMS, err := milliseconds(created)
	if err != nil {
		return nil, nil, err
	}
	updatedMS, err := milliseconds(updated)
	if err != nil {
		return nil, nil, err
	}
	node := &pb.CanvasNode{
		NodeId:          id,
		CanvasId:        board,
		Type:            nodeType,
		Title:           title,
		Color:           color,
		Position:        &pb.CanvasPoint{X: x, Y: y},
		ParentId:        parent,
		DataJson:        []byte(data),
		CreatedAtUnixMs: createdMS,
		UpdatedAtUnixMs: updatedMS,
	}
	// Width and height are nullable in the source. An absent size stays absent:
	// writing 0 would resize the node on the first render after the migration.
	width, hasWidth, okWidth := row.real("width")
	height, hasHeight, okHeight := row.real("height")
	if !okWidth || !okHeight {
		return nil, nil, fmt.Errorf("%w: node size column is not numeric", ErrInvalid)
	}
	if hasWidth && hasHeight {
		node.Size = &pb.CanvasSize{Width: width, Height: height}
	}
	if collapsed, has, ok := row.integer("collapsed"); ok && has {
		node.Collapsed = proto.Bool(collapsed != 0)
	}
	if expanded, has, ok := row.real("expanded_height"); ok && has {
		node.ExpandedHeight = proto.Float64(expanded)
	}
	labels := []string{}
	if labelsJSON != "" {
		if err := json.Unmarshal([]byte(labelsJSON), &labels); err != nil {
			return nil, nil, fmt.Errorf("%w: unreadable node labels", ErrInvalid)
		}
	}
	// Labels and the header note are their own object so they survive a node
	// type change and can be compared independently during verification.
	var annotation *pb.CanvasAnnotation
	if len(labels) > 0 || note != "" {
		annotation = &pb.CanvasAnnotation{
			AnnotationId:    id,
			CanvasId:        board,
			NodeId:          id,
			Labels:          labels,
			Note:            note,
			CreatedAtUnixMs: createdMS,
			UpdatedAtUnixMs: updatedMS,
		}
	}
	return node, annotation, nil
}

func projectEdge(row legacyRow) (*pb.CanvasEdge, error) {
	id, _ := row.text("id")
	board, _ := row.text("board_id")
	source, _ := row.text("source_node_id")
	target, _ := row.text("target_node_id")
	kind, _ := row.text("kind")
	created, _ := row.text("created_at")
	updated, _ := row.text("updated_at")
	if !validID(id) || !validID(board) || !validID(source) || !validID(target) {
		return nil, fmt.Errorf("%w: edge identifier is not portable", ErrInvalid)
	}
	// Only the context link is persisted. Any other stored kind is reported
	// rather than rewritten into a link the user never drew.
	if kind != "link" {
		return nil, fmt.Errorf("%w: unsupported edge kind", ErrInvalid)
	}
	createdMS, err := milliseconds(created)
	if err != nil {
		return nil, err
	}
	updatedMS, err := milliseconds(updated)
	if err != nil {
		return nil, err
	}
	return &pb.CanvasEdge{
		EdgeId:          id,
		CanvasId:        board,
		SourceNodeId:    source,
		TargetNodeId:    target,
		Kind:            pb.CanvasEdgeKind_CANVAS_EDGE_KIND_LINK,
		CreatedAtUnixMs: createdMS,
		UpdatedAtUnixMs: updatedMS,
	}, nil
}

// project turns one workspace's staged rows into canvas objects and attaches
// the manifest's asset references to the nodes and canvases that name them.
func project(tables *legacyTables, workspaceID string, assets map[string][]*pb.CanvasAssetRef) (*projection, error) {
	row, ok := tables.workspaces[workspaceID]
	if !ok {
		return nil, storage.ErrNotFound
	}
	workspace, err := projectWorkspace(row)
	if err != nil {
		return nil, err
	}
	result := &projection{workspace: workspace}
	for _, canvasID := range tables.boardsOf[workspaceID] {
		canvas, err := projectCanvas(tables.boards[canvasID])
		if err != nil {
			return nil, err
		}
		result.canvases = append(result.canvases, canvas)
		for _, nodeID := range tables.nodesOf[canvasID] {
			node, annotation, err := projectNode(tables.nodes[nodeID])
			if err != nil {
				return nil, err
			}
			node.Assets = assets["nodes/"+nodeID]
			for _, asset := range node.Assets {
				asset.WorkspaceId = workspaceID
			}
			result.nodes = append(result.nodes, node)
			if annotation != nil {
				result.annotations = append(result.annotations, annotation)
			}
		}
		for _, edgeID := range tables.edgesOf[canvasID] {
			edge, err := projectEdge(tables.edges[edgeID])
			if err != nil {
				return nil, err
			}
			result.edges = append(result.edges, edge)
		}
	}
	return result, nil
}

// Materialize writes the projection into canvas entities. It is idempotent by
// construction: every change is CAS-checked against what is already stored and
// an object whose bytes already match produces no write and no event, so
// re-running a switch that failed halfway does not duplicate or churn history.
//
// It does not grant write ownership. Nothing in this function moves the epoch.
func (s *Service) Materialize(ctx context.Context, importID string) ([]string, error) {
	if !validImportID(importID) {
		return nil, ErrInvalid
	}
	assets, err := s.assetReferences(ctx, importID)
	if err != nil {
		return nil, err
	}
	workspaces, err := s.store.WorkspacesOfKind(ctx, legacyPrefix+"workspaces")
	if err != nil {
		return nil, err
	}
	touched := []string{}
	for _, workspaceID := range workspaces {
		tables, err := s.readLegacy(ctx, importID, workspaceID)
		if err != nil {
			return nil, err
		}
		if _, ok := tables.workspaces[workspaceID]; !ok {
			continue
		}
		result, err := project(tables, workspaceID, assets)
		if err != nil {
			return nil, err
		}
		if err = s.write(ctx, importID, workspaceID, result); err != nil {
			return nil, err
		}
		touched = append(touched, workspaceID)
	}
	return touched, nil
}

// write applies one workspace's projection in ordered batches. Each batch is
// its own transaction with its own receipt, so a failure part-way leaves the
// batches that already committed intact and a re-run continues from there.
// Ownership does not move until verification passes over the whole result.
func (s *Service) write(ctx context.Context, importID, workspaceID string, result *projection) error {
	changes := []storage.Change{}
	batch := 0
	flush := func() error {
		if len(changes) == 0 {
			return nil
		}
		_, err := s.store.Apply(ctx, fmt.Sprintf("canvas/materialize/%s/%s/%d", importID, workspaceID, batch), changes)
		batch++
		changes = nil
		return err
	}
	add := func(key storage.Key, payload []byte) error {
		current, err := s.store.Read(ctx, key)
		switch {
		case errors.Is(err, storage.ErrNotFound):
			changes = append(changes, storage.Change{Key: key, Payload: payload})
		case err != nil:
			return err
		case current.Deleted || string(current.Payload) != string(payload):
			changes = append(changes, storage.Change{Key: key, ExpectedRevision: current.Revision, Payload: payload})
		}
		if len(changes) >= MaxDocumentChanges {
			return flush()
		}
		return nil
	}
	payload, err := encodeWorkspace(result.workspace)
	if err != nil {
		return err
	}
	if err = add(workspaceKey(workspaceID), payload); err != nil {
		return err
	}
	for _, canvas := range result.canvases {
		payload, err := encodeCanvas(canvas)
		if err != nil {
			return err
		}
		if err = add(canvasKey(workspaceID, canvas.CanvasId), payload); err != nil {
			return err
		}
	}
	for _, node := range result.nodes {
		payload, err := encodeNode(node)
		if err != nil {
			return err
		}
		if err = add(objectKey(workspaceID, KindNode, node.CanvasId, node.NodeId), payload); err != nil {
			return err
		}
	}
	for _, edge := range result.edges {
		payload, err := encodeEdge(edge)
		if err != nil {
			return err
		}
		if err = add(objectKey(workspaceID, KindEdge, edge.CanvasId, edge.EdgeId), payload); err != nil {
			return err
		}
	}
	for _, annotation := range result.annotations {
		payload, err := encodeAnnotation(annotation)
		if err != nil {
			return err
		}
		if err = add(objectKey(workspaceID, KindAnnotation, annotation.CanvasId, annotation.AnnotationId), payload); err != nil {
			return err
		}
	}
	return flush()
}
