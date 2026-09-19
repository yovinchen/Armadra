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
 * 搬的是 R1 的五张身份表，加上自动化域里那几张同名同列的表与 R5 的三张
 * `github_*`；其余域的表由各自的迁移和搬运处理。
 *
 * GitHub 那三张跟着同一趟走，理由和 `host_id` 一样：`github_config` 记的是这台
 * 机器选了哪个凭据来源、密钥存在哪个引用名下，而令牌本身在 OS 钥匙串里，还在
 * 原地。不搬这一行，令牌还在钥匙串里躺着但没有人再指向它——用户看到的是「未
 * 配置」，然后被要求重新粘一次已经存在的令牌。`github_references` 同理：那些
 * 连接是人手工连出来的，重建不了。
 *
 * 自动化域只搬**同名同列的表**（载荷、授权记录与命令根）。计划、激活、运行、
 * 目标闸门与命令会话在旧库里是一行一个 protobuf BLOB，读它们需要一份已经不存在
 * 的生成码；R7 之后 core 只有一种表示，所以这四种记录不再搬——代价是升级上来的
 * 机器要重新定义一次计划，而换来的是库里没有第二种说法。
 */

/** 逐列照搬的表，顺序即插入顺序——外键要求被引用的行先进。 */
export const ABSORBED_TABLES = [
  "store_meta",
  "identity_principals",
  "identity_devices",
  "identity_sessions",
  "identity_bootstrap_tickets",
  "automation_payloads",
  "automation_grants",
  "command_roots",
  // GitHub 三张之间没有外键，排在最后；`store_meta` 的 `host_id` 已经先到位。
  "github_config",
  "github_status_mappings",
  "github_references",
] as const;

/**
 * 统一库的表 → 旧 `host.db` 里对应的表。
 *
 * 只有一条：迁移 0019 把单行的 `identity_owner` 换成了多行的
 * `identity_principals`（owner 行 `kind='owner'`）。Go Host 那边永远只有
 * `identity_owner`，所以这一张是**投影**而不是拷贝：列不一样，行的含义一样。
 */
const LEGACY_SOURCE: Readonly<Record<string, string>> = {
  identity_principals: "identity_owner",
};

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
    // 目标表还不存在（这个库还没过对应那条迁移）就当它是空的：一张没有的表
    // 里没有任何东西需要被保护。
    if (!tableExists(database, table)) continue;
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
        const source = LEGACY_SOURCE[table] ?? table;
        if (!present.has(source) || !tableExists(database, table)) {
          rows[table] = 0;
          continue;
        }
        if (table === "identity_principals") {
          // owner 那一行进新形状：标识、建立时间原样，`kind` 补成 'owner'，
          // 显示名留空——Go Host 从来没有存过它。
          database.exec(
            "INSERT INTO main.identity_principals " +
              "(principal_id, kind, display_name, created_at_ms, disabled_at_ms) " +
              "SELECT principal_id, 'owner', '', created_at_ms, 0 FROM legacy.identity_owner",
          );
          rows[table] = count(database, table);
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
        const source = LEGACY_SOURCE[table] ?? table;
        if (!present.has(source) || !tableExists(database, table)) continue;
        const expected = count(database, source, "legacy");
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

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM main.sqlite_schema WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return row !== undefined;
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
