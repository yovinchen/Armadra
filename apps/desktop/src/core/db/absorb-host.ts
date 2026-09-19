import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * 把旧 `host.db` 的身份记录搬进统一库，一次，不删原库。
 *
 * 已装机器升级到 TS core 时，`canvas.db` 刚应用完 0015：四张身份表和
 * `store_meta` 都是空的，而同一个数据目录里还躺着 Go Host 写了很久的
 * `host.db`。不搬的话用户要重新配对，而且 `host_id` 会换一个——页面存下来的
 * 那个 Host 就再也认不出来了。
 *
 * 三条规矩：
 *
 *   * **只在目标为空时搬**。任何一张目标表有行就整体跳过，不做合并、不做去重。
 *     合并两份身份记录没有正确答案，而「跳过」的代价只是一次重新配对。
 *   * **一个事务，要么全进要么全不进**。搬到一半的身份表比空表更糟：设备在、
 *     会话不在，页面会拿着一个永远认证不了的凭据重试。
 *   * **不删原库**。搬完把 `host.db` 改名 `host.db.absorbed-<ts>`，Go Host 下次
 *     就找不到它、也不会变成第二个写者，而人还能把它拿回去。
 *
 * 搬的是 R1 用得上的五张表；其余域的表由 R4 / R5 各自的迁移和搬运处理。
 */

/** 搬进来的表，顺序即插入顺序——外键要求 owner 在 device 之前。 */
export const ABSORBED_TABLES = [
  "store_meta",
  "identity_owner",
  "identity_devices",
  "identity_sessions",
  "identity_bootstrap_tickets",
] as const;

export interface AbsorbResult {
  /** 这次有没有真的搬。 */
  readonly absorbed: boolean;
  /** 为什么没搬；搬了就是 `undefined`。 */
  readonly skipped?: "noHostDatabase" | "targetNotEmpty" | "hostDatabaseEmpty";
  /** 每张表搬进来的行数。 */
  readonly rows: Readonly<Record<string, number>>;
  /** 原库改名后的路径。 */
  readonly renamedTo?: string;
}

export function hostDatabaseFile(dataDir: string): string {
  return join(dataDir, "host.db");
}

/** `host.db.absorbed-<UTC 时间戳>`，和单向门备份同一种拼法。 */
export function absorbedName(path: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${path}.absorbed-${stamp}`;
}

export function absorbHostDatabase(options: {
  readonly database: DatabaseSync;
  readonly dataDir: string;
  readonly now?: () => Date;
}): AbsorbResult {
  const empty: Readonly<Record<string, number>> = {};
  const source = hostDatabaseFile(options.dataDir);
  if (!existsSync(source)) {
    return { absorbed: false, skipped: "noHostDatabase", rows: empty };
  }
  const database = options.database;
  for (const table of ABSORBED_TABLES) {
    if (count(database, table) > 0) {
      return { absorbed: false, skipped: "targetNotEmpty", rows: empty };
    }
  }

  // `ATTACH` 只读：搬运不许改动原库，它是这一步唯一的回退点。
  database.exec(`ATTACH DATABASE ${quote(`file:${source}?mode=ro`)} AS legacy`);
  const rows: Record<string, number> = {};
  try {
    const present = new Set(
      (
        database
          .prepare(`SELECT name FROM legacy.sqlite_schema WHERE type = 'table'`)
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    if (!present.has("store_meta")) {
      return { absorbed: false, skipped: "hostDatabaseEmpty", rows: empty };
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ABSORBED_TABLES) {
        if (!present.has(table)) {
          rows[table] = 0;
          continue;
        }
        // 列名逐条列出来，而不是 `INSERT INTO t SELECT * FROM legacy.t`：两边
        // 列序一致是今天的事实，靠事实而不是靠约束搬数据，有一天列序变了就会
        // 悄悄把 `origin` 写进 `scopes`。
        const columns = columnNames(database, table);
        const names = columns.map(quoteIdentifier).join(", ");
        database.exec(
          `INSERT INTO main.${quoteIdentifier(table)} (${names}) ` +
            `SELECT ${names} FROM legacy.${quoteIdentifier(table)}`,
        );
        rows[table] = count(database, table);
      }
      // 搬完逐张核对行数：目标行数必须等于原库行数，差一行就整体回滚。
      for (const table of ABSORBED_TABLES) {
        if (!present.has(table)) continue;
        const expected = count(database, table, "legacy");
        if (rows[table] !== expected) {
          throw new Error(
            `${table} 搬运行数不符：原库 ${expected}，统一库 ${rows[table]}`,
          );
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.exec("DETACH DATABASE legacy");
  }

  const renamedTo = absorbedName(source, (options.now ?? (() => new Date()))());
  renameSync(source, renamedTo);
  // WAL 与 shm 跟着走，否则下一个 Go Host 会对着一个没有主库的 WAL 报错。
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) {
      renameSync(`${source}${suffix}`, `${renamedTo}${suffix}`);
    }
  }
  return { absorbed: true, rows, renamedTo };
}

function count(database: DatabaseSync, table: string, schema = "main"): number {
  const row = database
    .prepare(
      `SELECT count(*) AS total FROM ${schema}.${quoteIdentifier(table)}`,
    )
    .get() as { total?: unknown } | undefined;
  return Number(row?.total ?? 0);
}

function columnNames(database: DatabaseSync, table: string): string[] {
  const rows = database
    .prepare(`PRAGMA main.table_info(${quote(table)})`)
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
