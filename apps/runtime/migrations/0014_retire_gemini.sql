-- Gemini CLI is no longer an adapter (2026-09-19).
--
-- The registry, the hook installer, the transcript index and the quota lookup
-- for `gemini` are gone from the Runtime. Rows that name it would otherwise
-- outlive the code that understood them: a conversation row the palette's
-- schema now rejects, a status row nothing will ever update, a terminal node
-- whose `agent.id` fails validation on its next save. Each is retired here,
-- once, so the data the Runtime serves is data it can still describe.
--
-- A terminal that ran Gemini keeps its node, title, position and links; only
-- the agent binding is dropped, which turns it into a plain terminal. Nothing
-- of the user's is deleted — the CLI's own transcripts under `~/.gemini` are
-- not ours and are not touched.
DELETE FROM conversations WHERE provider = 'gemini';
DELETE FROM agent_status WHERE agent_id = 'gemini';
DELETE FROM hook_installs WHERE agent_id = 'gemini';
UPDATE terminal_sessions SET agent_id = NULL WHERE agent_id = 'gemini';
UPDATE nodes
SET data_json = json_remove(data_json, '$.agent')
WHERE type = 'terminal'
  AND json_extract(data_json, '$.agent.id') = 'gemini';
