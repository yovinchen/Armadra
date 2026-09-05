-- The ledger of reverse export packages this Runtime has applied
-- (Go Host 业务所有权迁移 §2.12).
--
-- A rollback applies the Host's package to this database before the epoch
-- comes back. The apply is one transaction, but the answer to it can be lost:
-- the controller retries, and without a record the second attempt would delete
-- and rewrite rows that are already correct while reporting a fresh import.
--
-- `import_id` is the idempotency key. The same identifier with the same
-- `index_sha256` replays the stored report and writes nothing; the same
-- identifier with a different digest is refused, because two different
-- packages claiming one identity is a controller bug, not a retry.
--
-- `report` is the encoded ReverseImportReport of the run that actually wrote,
-- so a replay answers with the digests the Host verified the first time rather
-- than with digests re-derived from rows that may have moved since.
CREATE TABLE host_imports (
    import_id    TEXT PRIMARY KEY,
    domain       TEXT NOT NULL,
    epoch        INTEGER NOT NULL CHECK (epoch > 0),
    index_sha256 BLOB NOT NULL CHECK (length(index_sha256) = 32),
    entity_count INTEGER NOT NULL DEFAULT 0,
    report       BLOB NOT NULL,
    applied_at   TEXT NOT NULL
);

CREATE INDEX idx_host_imports_domain ON host_imports(domain, applied_at);
