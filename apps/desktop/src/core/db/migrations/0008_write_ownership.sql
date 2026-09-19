-- Write ownership per business domain (host protocol design §4, step 5).
--
-- One row per domain. `owner` names the process allowed to write that domain
-- and `epoch` is monotonic: a handoff carrying an epoch that is not greater
-- than the stored one is refused rather than applied out of order. The Runtime
-- starts out owning the canvas domain, which is what it has always done; the
-- row exists so that statement is explicit and can be read back.
--
-- Terminals, files, Git and hooks are not listed here. They stay with the
-- Runtime regardless of who owns the canvas.
CREATE TABLE write_ownership (
    domain      TEXT PRIMARY KEY,
    owner       TEXT NOT NULL CHECK (owner IN ('runtime', 'host')),
    epoch       INTEGER NOT NULL CHECK (epoch > 0),
    reason_code TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL
);

INSERT INTO write_ownership (domain, owner, epoch, reason_code, updated_at)
VALUES ('canvas', 'runtime', 1, 'ownership.initial', '1970-01-01T00:00:00Z');
