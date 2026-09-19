-- One row per scheduled prompt delivery, written BEFORE the framed paste
-- reaches the PTY. The row is what makes a repeat safe: an operation that is
-- already recorded is answered from here and never pasted a second time.
--
-- `phase` is evidence, not a verdict:
--   notWritten  a preflight refusal; nothing reached the terminal
--   submitted   the framed paste and its submit key were accepted
--   completed   a turn finished that no other input could have produced
--   abandoned   the session ended or was replaced before any turn finished
--   unknown     written, but the outcome cannot be attributed to this delivery
-- Only `notWritten` proves absence of effect, so only it is ever retried.
CREATE TABLE agent_prompt_deliveries (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  reason_code TEXT NOT NULL DEFAULT '',
  cold_started INTEGER NOT NULL DEFAULT 0,
  -- The session's input revision immediately after our own paste. A later turn
  -- counts as ours only while this is still the newest input on the session.
  input_revision INTEGER,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_prompt_deliveries_target
  ON agent_prompt_deliveries(node_id, phase);
CREATE INDEX idx_agent_prompt_deliveries_workspace
  ON agent_prompt_deliveries(workspace_id, created_at);

-- The operation identity and what it was written into are frozen: a receipt
-- that could be re-pointed at another session would stop being evidence.
CREATE TRIGGER freeze_agent_prompt_delivery
BEFORE UPDATE OF operation_id, request_digest, workspace_id, node_id,
  created_at ON agent_prompt_deliveries
BEGIN
  SELECT RAISE(ABORT, 'prompt delivery identity is immutable');
END;
