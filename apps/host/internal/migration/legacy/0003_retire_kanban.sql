-- Immutable retirement snapshots. No foreign keys: deleting a live workspace,
-- canvas or node must not erase its historical board or label records.
CREATE TABLE legacy_kanban_archives (
  canvas_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  canvas_name TEXT NOT NULL,
  kanban_json TEXT NOT NULL,
  canvas_created_at TEXT NOT NULL,
  canvas_updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

INSERT INTO legacy_kanban_archives
  (canvas_id, workspace_id, workspace_name, canvas_name, kanban_json,
   canvas_created_at, canvas_updated_at, archived_at)
SELECT b.id, b.workspace_id, COALESCE(w.name, ''), b.name, b.kanban_json,
       b.created_at, b.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM boards b LEFT JOIN workspaces w ON w.id = b.workspace_id;

CREATE TABLE legacy_node_label_archives (
  node_id TEXT PRIMARY KEY NOT NULL,
  canvas_id TEXT NOT NULL,
  workspace_id TEXT,
  node_title TEXT NOT NULL,
  node_type TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  note TEXT NOT NULL,
  node_created_at TEXT NOT NULL,
  node_updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

INSERT INTO legacy_node_label_archives
  (node_id, canvas_id, workspace_id, node_title, node_type, labels_json, note,
   node_created_at, node_updated_at, archived_at)
SELECT n.id, n.board_id, b.workspace_id, n.title, n.type, n.labels_json, n.note,
       n.created_at, n.updated_at,
       COALESCE(a.archived_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM nodes n LEFT JOIN boards b ON b.id = n.board_id
LEFT JOIN legacy_kanban_archives a ON a.canvas_id = n.board_id;

CREATE INDEX idx_legacy_label_archives_canvas ON legacy_node_label_archives(canvas_id, node_id);

-- Keep the old column byte-for-byte for audits. Fresh canvases get only the
-- inert default, and old writers cannot put task-board state back into it.
CREATE TRIGGER retired_kanban_no_update BEFORE UPDATE OF kanban_json ON boards
WHEN NEW.kanban_json IS NOT OLD.kanban_json
BEGIN SELECT RAISE(ABORT, 'Task-board state is retired and cannot be modified'); END;
CREATE TRIGGER retired_kanban_no_insert BEFORE INSERT ON boards
WHEN NEW.kanban_json <> '{}'
BEGIN SELECT RAISE(ABORT, 'New canvases cannot contain task-board state'); END;

CREATE TRIGGER legacy_kanban_archives_no_insert BEFORE INSERT ON legacy_kanban_archives
BEGIN SELECT RAISE(ABORT, 'Historical archives are read-only'); END;
CREATE TRIGGER legacy_kanban_archives_no_update BEFORE UPDATE ON legacy_kanban_archives
BEGIN SELECT RAISE(ABORT, 'Historical archives are read-only'); END;
CREATE TRIGGER legacy_kanban_archives_no_delete BEFORE DELETE ON legacy_kanban_archives
BEGIN SELECT RAISE(ABORT, 'Historical archives are read-only'); END;
CREATE TRIGGER legacy_node_label_archives_no_insert BEFORE INSERT ON legacy_node_label_archives
BEGIN SELECT RAISE(ABORT, 'Historical archives are read-only'); END;
CREATE TRIGGER legacy_node_label_archives_no_update BEFORE UPDATE ON legacy_node_label_archives
BEGIN SELECT RAISE(ABORT, 'Historical archives are read-only'); END;
CREATE TRIGGER legacy_node_label_archives_no_delete BEFORE DELETE ON legacy_node_label_archives
BEGIN SELECT RAISE(ABORT, 'Historical archives are read-only'); END;
