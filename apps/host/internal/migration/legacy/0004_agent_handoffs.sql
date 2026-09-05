-- Frozen, user-reviewed peer context. No provider credentials or permissions.
-- Identities survive node/session deletion so historical receipts remain honest.
CREATE TABLE agent_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  target_node_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  target_generation INTEGER NOT NULL,
  bundle_json TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  mailbox_id TEXT,
  trace_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_handoffs_workspace ON agent_handoffs(workspace_id, created_at);
CREATE INDEX idx_agent_handoffs_target ON agent_handoffs(target_node_id, state);
CREATE TRIGGER freeze_agent_handoff_bundle
BEFORE UPDATE OF id, workspace_id, source_node_id, source_session_id,
  source_generation, target_node_id, target_session_id, target_generation,
  bundle_json, bundle_digest, created_at ON agent_handoffs
BEGIN
  SELECT RAISE(ABORT, 'handoff bundle is immutable');
END;

-- Claim is persisted before any terminal write. A dispatching row is never
-- automatically resent after a crash: it becomes unknownOutcome instead.
CREATE TABLE agent_handoff_outbox (
  handoff_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  claimed_at TEXT,
  instance_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_handoff_outbox_pending ON agent_handoff_outbox(state, created_at);
