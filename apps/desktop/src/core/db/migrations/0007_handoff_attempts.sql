-- How many times a queued notification has been claimed for delivery.
--
-- A refusal the delivery gate proved (the target was busy, the pane was not
-- the Agent) returns the notification to the queue, so a handoff history that
-- showed only the current state could not tell one attempt from twenty. The
-- counter is incremented at the claim, before anything is written, so it counts
-- attempts rather than successes.
ALTER TABLE agent_handoff_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
