-- Write ownership for the five domains beyond the canvas
-- (Go Host 业务所有权迁移 §3.2).
--
-- The canvas row has existed since 0008. These five say the same thing about
-- settings, files, sessions, agents and repositories: the Runtime writes them,
-- at epoch 1, because it always has. The rows exist so that answer is read
-- from the record rather than inferred from a domain having no row at all --
-- an absent record is damage here, never "nobody has claimed it yet".
--
-- Nothing else changes. Each domain switches on its own epoch, and until one
-- does, every guard in the Runtime keeps allowing writes exactly as before.
INSERT INTO write_ownership (domain, owner, epoch, reason_code, updated_at)
VALUES
    ('settings', 'runtime', 1, 'ownership.initial', '1970-01-01T00:00:00Z'),
    ('filesystem', 'runtime', 1, 'ownership.initial', '1970-01-01T00:00:00Z'),
    ('session', 'runtime', 1, 'ownership.initial', '1970-01-01T00:00:00Z'),
    ('agent', 'runtime', 1, 'ownership.initial', '1970-01-01T00:00:00Z'),
    ('git', 'runtime', 1, 'ownership.initial', '1970-01-01T00:00:00Z');
