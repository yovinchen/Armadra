import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CREATE_LEDGER,
  LEDGER_TABLE,
  appliedVersions,
  preflight,
  recordApplied,
} from "./ledger";
import { type Migration, loadMigrations } from "./migrations";
import { UNIFIED_VERSION, backupPath } from "./unified";

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
  /** 备份文件名里的时间戳来源；测试用它固定文件名。 */
  readonly now?: () => Date;
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
  /** 这次启动过单向门时写下的备份路径；没过就是 `null`。 */
  readonly backup: string | null;
  /** 统一库迁移是否已经在账本里（这次应用的，或早先应用的）。 */
  readonly unified: boolean;
  close(): void;
}

export function openDatabase(options: OpenOptions): OpenedDatabase {
  const migrations = loadMigrations(options.migrationsDir);
  // 单向门在不在这批迁移里。一个目录之后这就是「这次启动会不会应用 0015」的
  // 全部判据。
  const carriesGate = migrations.some(
    (migration) => migration.version === UNIFIED_VERSION,
  );
  mkdirSync(dirname(options.file), { recursive: true });
  const database = new DatabaseSync(options.file);
  let backup: string | null = null;
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

    // 单向门的备份。位置是刻意的：在 `BEGIN IMMEDIATE` 之外，因为 SQLite 的
    // `VACUUM INTO` 不能在事务里跑；在 0015 应用之前，因为应用之后这个库对
    // 旧实现就是「多了一条不认识的迁移」，回滚只能靠替换文件。
    //
    // `VACUUM INTO` 而不是 `cp`：它在一次读事务里把整个库写成一个新文件，已
    // 提交的 WAL 内容一起带上，也不会拷到一个写到一半的页。空库不备份——没有
    // 数据可丢，多一个 0 字节文件只会让人以为回滚点在那儿。
    if (
      carriesGate &&
      options.migrate !== false &&
      hasLedger(database) &&
      !appliedVersions(database).includes(UNIFIED_VERSION)
    ) {
      const target = backupPath(
        options.file,
        (options.now ?? (() => new Date()))(),
      );
      if (existsSync(target)) {
        throw new DatabaseRefused(
          `单向门备份 ${target} 已存在；请先移走它再启动`,
        );
      }
      database.exec(`VACUUM INTO ${quote(target)}`);
      // 拷出来的东西要能打开，否则这个「回滚点」是假的。
      verifyBackup(target);
      backup = target;
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
    backup,
    unified: hasLedger(database)
      ? appliedVersions(database).includes(UNIFIED_VERSION)
      : false,
    close: () => database.close(),
  };
}

function hasLedger(database: DatabaseSync): boolean {
  const found = database
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(LEDGER_TABLE);
  return found !== undefined;
}

/** SQLite 的字符串字面量：单引号成对。路径不进 SQL 的任何其他位置。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 备份要能被打开、要有账本、要有内容。做不到就不是回滚点，宁可在应用迁移前
 * 报错，也不要留一个看着像备份的文件。
 */
function verifyBackup(path: string): void {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new DatabaseRefused(`单向门备份 ${path} 没有写出来`);
  }
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = copy
      .prepare(`SELECT count(*) AS total FROM ${LEDGER_TABLE}`)
      .get() as { total?: number } | undefined;
    if (!rows || Number(rows.total ?? 0) === 0) {
      throw new DatabaseRefused(`单向门备份 ${path} 里没有迁移账本`);
    }
  } finally {
    copy.close();
  }
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
