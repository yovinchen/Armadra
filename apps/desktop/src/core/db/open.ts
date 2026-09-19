import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CREATE_LEDGER,
  appliedVersions,
  preflight,
  recordApplied,
} from "./ledger";
import { type Migration, loadMigrations } from "./migrations";

/**
 * Opening the one database.
 *
 * `node:sqlite` rather than `better-sqlite3`: it is built into Node 22+ and
 * into the Electron this shell ships (verified on Electron 42.11.6, whose Node
 * is 24.19.0), which means **no native module** — no `electron-rebuild`, no
 * `asarUnpack` entry, and nothing extra to sign under notarisation. The API is
 * synchronous, which matches how the Rust Runtime used it: every query here is
 * short, and the one place that will not be — an 8 MiB whiteboard snapshot —
 * is R1's to measure and, if it must, move into a worker thread.
 *
 * R0 keeps every call on the main thread. **The decision R1 owes:** measure the
 * document save at the P95 threshold in the design (< 20 ms for 8 MiB) and, if
 * it is over, move `documents` behind `worker_threads` before any other domain
 * builds on the synchronous shape.
 *
 * The preflight that authorises the migrations runs inside the same
 * `BEGIN IMMEDIATE` as the migrations themselves: a read-only check and a write
 * in two transactions would let something change the schema in between. A
 * second, earlier preflight runs before anything is written at all — see
 * `openDatabase` for why a refusal has to happen before the journal mode does.
 */

export interface OpenOptions {
  /** `<data dir>/canvas.db`. */
  readonly file: string;
  /** The directory holding the `.sql` files. */
  readonly migrationsDir: string;
  /**
   * Stop after the preflight. R0's shell switch uses this to prove a database
   * opens without writing to it.
   */
  readonly migrate?: boolean;
}

export class DatabaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRefused";
  }
}

export interface OpenedDatabase {
  readonly database: DatabaseSync;
  readonly migrations: readonly Migration[];
  close(): void;
}

export function openDatabase(options: OpenOptions): OpenedDatabase {
  const migrations = loadMigrations(options.migrationsDir);
  mkdirSync(dirname(options.file), { recursive: true });
  const database = new DatabaseSync(options.file);
  try {
    // A connection setting, not a file write.
    database.exec("PRAGMA foreign_keys = ON");

    // The preflight runs twice, and both runs are load-bearing.
    //
    // The first is read-only and happens before anything at all is written,
    // because a database this core refuses must come out of the attempt byte
    // for byte as it went in — including the journal-mode header, which
    // switching to WAL would rewrite. "Refuse without changing its data" has to
    // mean the file, not just the rows.
    //
    // The second runs inside the `BEGIN IMMEDIATE` that also carries the
    // migrations, which is the arrangement the design requires: a read-only
    // check and a write in two transactions would let something change the
    // schema in between. Between the two runs nothing but the journal mode
    // moves, and a database that passed the first and fails the second is a
    // database something else is writing — which is exactly what the second
    // exists to catch.
    const early = preflight(database, migrations);
    if (early !== null) {
      database.close();
      throw new DatabaseRefused(early);
    }

    // The Rust pool's default, so a file the two implementations share is
    // journalled the same way. Read first: on the WAL database every existing
    // install already has, this writes nothing.
    const journal = database.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") {
      database.exec("PRAGMA journal_mode = WAL");
    }

    database.exec("BEGIN IMMEDIATE");
    let refusal: string | null;
    try {
      refusal = preflight(database, migrations);
      if (refusal === null && options.migrate !== false) {
        migrate(database, migrations);
      }
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (refusal !== null) {
      // Rolled back, then closed. Nothing renamed, nothing rebuilt: that is
      // what makes a refusal safe to retry after a person has looked at it.
      database.exec("ROLLBACK");
      database.close();
      throw new DatabaseRefused(refusal);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (!(error instanceof DatabaseRefused)) {
      try {
        database.close();
      } catch {
        // Already closed by the refusal path.
      }
    }
    throw error;
  }
  return {
    database,
    migrations,
    close: () => database.close(),
  };
}

/**
 * Applies what the ledger does not have yet.
 *
 * R0 adds no migration of its own and writes no business row — in particular
 * it does **not** do the Rust startup recovery that marks non-tmux `running`
 * terminal sessions as failed. That belongs to R2, with the terminal domain
 * that knows what a session is.
 */
function migrate(
  database: DatabaseSync,
  migrations: readonly Migration[],
): void {
  database.exec(CREATE_LEDGER);
  const applied = new Set(appliedVersions(database));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const started = process.hrtime.bigint();
    database.exec(migration.sql);
    recordApplied(database, migration, process.hrtime.bigint() - started);
  }
}
