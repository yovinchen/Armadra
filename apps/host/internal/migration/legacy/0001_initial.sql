-- The one and only schema.
--
-- There is no upgrade path into this file. The product recognises a single data
-- model, and a database written by an older build is not migrated: `db::connect`
-- renames it aside (`<name>.legacy-<timestamp>`) and creates a fresh one here.
-- So this migration is only ever applied to an empty database, and every future
-- change is a new numbered file next to it.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Workspaces and boards
-- ---------------------------------------------------------------------------

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#5B5BD6',
  permissions_json TEXT NOT NULL DEFAULT '{"read":true,"write":true,"execute":false}',
  last_opened_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- `viewport_json`, `kanban_json` and `whiteboard_json` are opaque blobs written
-- by the same optimistic `PUT .../document` that writes nodes and edges; the
-- runtime never queries inside them, so they are columns rather than tables.
-- `whiteboard_json` holds the whiteboard-native tldraw records only (ink, text,
-- geo, images, unbound arrows); '' means "no whiteboard content".
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  kanban_json TEXT NOT NULL DEFAULT '{}',
  whiteboard_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_boards_workspace ON boards(workspace_id, sort_order);

-- ---------------------------------------------------------------------------
-- Document: nodes and edges
-- ---------------------------------------------------------------------------

-- `type` is one of `db::NODE_TYPES` (terminal / sticky / group / editor / diff /
-- files / browser); `title` and `color` live outside `data_json` because the
-- shared node header shows them for every type, and so do `labels_json` and
-- `note`, which are per-node UI state rather than type-specific payload.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  title TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0a84ff',
  collapsed INTEGER NOT NULL DEFAULT 0,
  expanded_height REAL,
  parent_id TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_nodes_board ON nodes(board_id);

-- One edge kind (`link`); the semantic edge vocabulary is gone.
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_edges_board ON edges(board_id);

-- ---------------------------------------------------------------------------
-- Terminals
-- ---------------------------------------------------------------------------

-- `session_key` is the logical identity (the owning node, or the row's own id
-- for a node-less session) so a node keeps its session across recycles;
-- `backend_kind` / `backend_ref` name whoever actually owns the process, and
-- `generation` is what every WS frame is validated against.
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'terminal',
  owner_node_id TEXT,
  agent_id TEXT,
  cwd TEXT NOT NULL,
  shell TEXT NOT NULL,
  command TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  backend_kind TEXT NOT NULL DEFAULT 'direct',
  backend_ref TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  attach_state TEXT NOT NULL DEFAULT 'exited',
  last_output_at TEXT,
  termination_intent TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX idx_terminal_sessions_owner
  ON terminal_sessions(workspace_id, kind, owner_node_id);
CREATE INDEX idx_terminal_sessions_key
  ON terminal_sessions(session_key, generation);
CREATE INDEX idx_terminal_sessions_attach
  ON terminal_sessions(attach_state, last_output_at);

CREATE TABLE terminal_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  stream TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_terminal_logs_session ON terminal_logs(session_id, created_at);

-- ---------------------------------------------------------------------------
-- Agent runtime
-- ---------------------------------------------------------------------------

-- `last_event_at` is the last hook report, which `updated_at` cannot stand in
-- for: the stale-working sweep and `POST /api/agent-status/{nodeId}/read` both
-- write rows without one. `errored` / `interrupted` are nullable on purpose —
-- NULL is "no verdict yet", 0 is "finished cleanly".
CREATE TABLE agent_status (
  node_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  state TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  pending_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  restored INTEGER NOT NULL DEFAULT 0,
  transcript_path TEXT,
  last_event_at TEXT,
  session_phase TEXT,
  errored INTEGER,
  interrupted INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_status_workspace ON agent_status(workspace_id, updated_at);
-- The stale-working sweep scans `state = 'working' AND last_event_at < ?`.
CREATE INDEX idx_agent_status_stale ON agent_status(state, last_event_at);

CREATE TABLE agent_approvals (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX idx_agent_approvals_node ON agent_approvals(node_id, created_at);

CREATE TABLE agent_deliveries (
  trace_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  receipt TEXT,
  body_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agent_deliveries_workspace ON agent_deliveries(workspace_id, created_at);

CREATE TABLE context_links (
  node_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  links_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_context_links_workspace ON context_links(workspace_id);

CREATE TABLE hook_installs (
  agent_id TEXT PRIMARY KEY,
  client_revision INTEGER NOT NULL,
  installed_at TEXT NOT NULL,
  config_path TEXT
);

-- ---------------------------------------------------------------------------
-- Conversation index
-- ---------------------------------------------------------------------------

-- The cross-project index of every CLI transcript found on this machine, so the
-- command palette can offer "resume this one". Keyed by (provider, session_id)
-- rather than by path: a session keeps its id when its file is moved or
-- rewritten, so `path` is data, not identity.
CREATE TABLE conversations (
  provider   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  path       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  PRIMARY KEY (provider, session_id)
);

-- The index is served newest-first and filtered by a substring, so the ordering
-- index is the only useful one; a rescan looks a file up by path to decide
-- whether its mtime moved.
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conversations_path ON conversations(provider, path);
