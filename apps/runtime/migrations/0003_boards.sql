-- Workspace/Board model v2.
--
-- SQLite runs this migration inside a transaction with `PRAGMA foreign_keys`
-- already ON, so the pragma cannot be toggled here. The rebuild order below is
-- chosen so that no table is ever dropped while another table still references
-- it (a DROP TABLE with foreign keys enabled performs an implicit DELETE FROM
-- which would cascade into the children).

-- 1. boards replaces the 1:1 canvases table. Board ids reuse the canvas ids so
--    existing nodes/edges keep pointing at the right board.
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  strokes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, strokes_json, created_at, updated_at)
SELECT id, workspace_id, 'Default', 0, '{"x":0,"y":0,"zoom":1}', '[]', created_at, updated_at
FROM canvases;

CREATE INDEX idx_boards_workspace ON boards(workspace_id, sort_order);

-- 2. Park the edges out of the way: they reference nodes, which is rebuilt next.
--    CREATE TABLE ... AS SELECT copies rows without any constraint, and
--    `permissions_json` is dropped here.
CREATE TABLE edges_migration_backup AS
SELECT id, canvas_id, source_node_id, target_node_id, type, label, created_at, updated_at
FROM edges;

DROP TABLE edges;

-- 3. nodes: canvas_id -> board_id (FK to boards) and the new `zoom` column.
CREATE TABLE nodes_v2 (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  zoom TEXT NOT NULL DEFAULT 'normal',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO nodes_v2 (id, board_id, type, x, y, width, height, zoom, data_json, created_at, updated_at)
SELECT id, canvas_id, type, x, y, width, height, 'normal', data_json, created_at, updated_at
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_v2 RENAME TO nodes;
CREATE INDEX idx_nodes_board ON nodes(board_id);

-- 4. edges: canvas_id -> board_id, permissions_json removed.
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO edges (id, board_id, source_node_id, target_node_id, type, label, created_at, updated_at)
SELECT id, canvas_id, source_node_id, target_node_id, type, label, created_at, updated_at
FROM edges_migration_backup;

DROP TABLE edges_migration_backup;
CREATE INDEX idx_edges_board ON edges(board_id);

DROP TABLE canvases;

-- 5. workspaces gains the v2 presentation/permission columns.
ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT '#5B5BD6';
ALTER TABLE workspaces ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{"read":true,"write":true,"execute":false}';
ALTER TABLE workspaces ADD COLUMN gateway_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN last_opened_at TEXT;
UPDATE workspaces SET last_opened_at = updated_at WHERE last_opened_at IS NULL;

-- 6. Legacy value mapping (domain model v2).
UPDATE nodes SET type = 'context' WHERE type = 'folder';
UPDATE nodes SET data_json = json_set(data_json, '$.kind', 'context')
  WHERE json_extract(data_json, '$.kind') = 'folder';
UPDATE nodes SET data_json = json_set(data_json, '$.status', 'error')
  WHERE json_extract(data_json, '$.status') = 'failed';

UPDATE edges SET type = CASE type
  WHEN 'context' THEN 'ref'
  WHEN 'input' THEN 'dispatch'
  WHEN 'output' THEN 'produce'
  WHEN 'patches' THEN 'write'
  WHEN 'depends_on' THEN 'trigger'
  WHEN 'verifies' THEN 'link'
  ELSE type
END;

-- 7. Backfill the fields v2 requires but v1 never stored.
UPDATE nodes SET data_json = json_set(data_json, '$.checklist', json('[]'))
  WHERE type = 'task' AND json_extract(data_json, '$.checklist') IS NULL;
UPDATE nodes SET data_json = json_set(data_json, '$.contextChips', json('[]'))
  WHERE type = 'agent' AND json_extract(data_json, '$.contextChips') IS NULL;
UPDATE nodes SET data_json = json_set(
  data_json,
  '$.files',
  (SELECT json_group_array(
      json_set(
        json_set(
          f.value,
          '$.status',
          CASE
            WHEN json_extract(f.value, '$.status') IN ('M', 'A', 'D', 'R', '?') THEN json_extract(f.value, '$.status')
            WHEN json_extract(f.value, '$.status') IS NULL THEN 'M'
            WHEN substr(json_extract(f.value, '$.status'), 1, 1) IN ('M', 'A', 'D', 'R') THEN substr(json_extract(f.value, '$.status'), 1, 1)
            ELSE '?'
          END
        ),
        '$.state',
        coalesce(json_extract(f.value, '$.state'), 'pending')
      )
    )
   FROM json_each(nodes.data_json, '$.files') f)
)
WHERE type = 'diff' AND json_type(data_json, '$.files') = 'array';
