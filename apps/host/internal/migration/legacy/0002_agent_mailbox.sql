-- Pull-only messages. No terminal writes, provider configuration or hooks needed.
CREATE TABLE agent_mailbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(source_node_id, target_node_id, message_key)
);
CREATE INDEX idx_agent_mailbox_inbox ON agent_mailbox(target_node_id, sequence);
CREATE INDEX idx_agent_mailbox_expiry ON agent_mailbox(expires_at);
