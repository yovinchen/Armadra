ALTER TABLE terminal_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'terminal';
ALTER TABLE terminal_sessions ADD COLUMN owner_node_id TEXT;
ALTER TABLE terminal_sessions ADD COLUMN adapter TEXT;

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_owner
  ON terminal_sessions(workspace_id, kind, owner_node_id);
