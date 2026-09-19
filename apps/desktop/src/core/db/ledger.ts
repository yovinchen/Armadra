import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations";

/**
 * The migration ledger, and the nine ways a database refuses to be opened.
 *
 * Unknown or damaged history requires an explicit recovery decision from a
 * person. This check only *reads* schema and ledger data; it never creates,
 * repairs, renames or deletes anything, and a rejection must leave both the
 * business data and the ledger byte for byte as it found them. That is the
 * rule the repository states as "未知或损坏的数据库拒绝启动，禁止自动清库或
 * 重建", and it is the one a rewrite is most likely to quietly soften.
 *
 * The ledger itself is `sqlx`'s, because a machine that ran the Rust Runtime
 * yesterday has one: `_sqlx_migrations` with six columns, `version` the
 * primary key, `checksum` a BLOB holding SHA-384 of the migration's bytes. The
 * column types are checked with `typeof()` rather than the declared type,
 * because SQLite lets a row hold whatever it likes regardless of the column's
 * declaration — a ledger with a TEXT checksum would otherwise compare unequal
 * for a reason nobody could see.
 *
 * Ported line for line from `apps/runtime/src/db/mod.rs:120-225`; the messages
 * are the Rust ones so a support answer written for either implementation fits
 * the other.
 */

export const LEDGER_TABLE = "_sqlx_migrations";

export const LEDGER_COLUMNS = [
  "version",
  "description",
  "installed_on",
  "success",
  "checksum",
  "execution_time",
] as const;

export const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
)`;

export interface AppliedMigration {
  readonly version: number;
  readonly checksum: Buffer;
}

/** `null` when the database may be opened; otherwise why it may not. */
export function preflight(
  database: DatabaseSync,
  known: readonly Migration[],
): string | null {
  const objects = database
    .prepare(
      `SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
    )
    .all() as { name: string; type: string }[];
  const ledger = objects.find((object) => object.name === LEDGER_TABLE);
  if (ledger === undefined) {
    // An empty file is a new database, and that is the only case where the
    // absence of a ledger says nothing is wrong.
    if (objects.length === 0) return null;
    return "Database has an unrecognized schema without a migration ledger; startup refused without changing its data";
  }
  if (ledger.type !== "table") {
    return "Database migration ledger is not a table; startup refused";
  }

  const columns = database
    .prepare(`PRAGMA table_info('${LEDGER_TABLE}')`)
    .all() as { name: string; pk: number; notnull: number }[];
  const shaped =
    columns.length === LEDGER_COLUMNS.length &&
    LEDGER_COLUMNS.every((expected) =>
      columns.some(
        (column) =>
          column.name === expected &&
          column.pk === (expected === "version" ? 1 : 0) &&
          (expected === "version" || column.notnull === 1),
      ),
    );
  if (!shaped) {
    return "Database migration ledger has an unrecognized structure; startup refused";
  }

  const applied = database
    .prepare(
      `SELECT version, checksum, success, typeof(version) AS version_type, ` +
        `typeof(checksum) AS checksum_type, typeof(success) AS success_type ` +
        `FROM ${LEDGER_TABLE} ORDER BY version`,
    )
    .all() as {
    version: unknown;
    checksum: unknown;
    success: unknown;
    version_type: string;
    checksum_type: string;
    success_type: string;
  }[];

  if (
    applied.length === 0 &&
    objects.some((object) => object.name !== LEDGER_TABLE)
  ) {
    return "Database schema has no recorded migrations; startup refused without changing its data";
  }

  for (const [index, row] of applied.entries()) {
    if (
      row.version_type !== "integer" ||
      row.checksum_type !== "blob" ||
      row.success_type !== "integer"
    ) {
      return "Database migration ledger contains invalid values; startup refused";
    }
    const version = Number(row.version);
    if (Number(row.success) !== 1) {
      return `Database migration ${version} is dirty or invalid; startup refused without changing its data`;
    }
    const migration = known.find((candidate) => candidate.version === version);
    if (migration === undefined) {
      return `Database migration ${version} is unknown to this build; startup refused without changing its data`;
    }
    if (!migration.checksum.equals(toBuffer(row.checksum))) {
      return `Database migration ${version} checksum does not match this build; startup refused without changing its data`;
    }
    // The history must be a complete prefix of what this build knows: a
    // database that skipped 0007 and applied 0008 has a schema no build has
    // ever produced, and applying the rest on top of it would invent a ninth.
    if (known[index]?.version !== version) {
      return "Database migration history is not a complete known prefix; startup refused";
    }
  }
  return null;
}

/** `node:sqlite` hands a BLOB back as a `Uint8Array`. */
function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

/** The versions already in the ledger, for deciding what is still pending. */
export function appliedVersions(database: DatabaseSync): number[] {
  const rows = database
    .prepare(`SELECT version FROM ${LEDGER_TABLE} ORDER BY version`)
    .all() as { version: unknown }[];
  return rows.map((row) => Number(row.version));
}

/**
 * Records one applied migration exactly the way `sqlx` records it: the row goes
 * in with `execution_time = -1` and is updated once the work is done, so a
 * process that dies mid-migration leaves a row that is visibly incomplete
 * rather than one that looks finished.
 */
export function recordApplied(
  database: DatabaseSync,
  migration: Migration,
  elapsedNanoseconds: bigint,
): void {
  database
    .prepare(
      `INSERT INTO ${LEDGER_TABLE} ( version, description, success, checksum, execution_time ) ` +
        `VALUES ( ?, ?, TRUE, ?, -1 )`,
    )
    .run(
      migration.version,
      migration.description,
      new Uint8Array(migration.checksum),
    );
  database
    .prepare(`UPDATE ${LEDGER_TABLE} SET execution_time = ? WHERE version = ?`)
    .run(elapsedNanoseconds, migration.version);
}
