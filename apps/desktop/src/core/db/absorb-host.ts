import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  AutomationActivationSchema,
  AutomationPlanSchema,
  AutomationRunSchema,
  AutomationTargetGateSchema,
  CommandLaunchSpecSchema,
  fromBinary,
} from "@armadra/protocol";

import {
  activationToJson,
  canonicalJson,
  launchSpecToJson,
  planToJson,
  runToJson,
  storedJson,
} from "../schedule/json";

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
 * 搬的是 R1 的五张身份表，加上 R4 的自动化域与 R5 的三张 `github_*`；其余域的
 * 表由各自的迁移和搬运处理。
 *
 * GitHub 那三张跟着同一趟走，理由和 `host_id` 一样：`github_config` 记的是这台
 * 机器选了哪个凭据来源、密钥存在哪个引用名下，而令牌本身在 OS 钥匙串里，还在
 * 原地。不搬这一行，令牌还在钥匙串里躺着但没有人再指向它——用户看到的是「未
 * 配置」，然后被要求重新粘一次已经存在的令牌。`github_references` 同理：那些
 * 连接是人手工连出来的，重建不了。
 *
 * ## 自动化的两半
 *
 * 一半是**同名同列的表**（载荷、授权记录、命令根与命令会话），和身份表一样逐列
 * 照搬。
 *
 * 另一半在 Host 那边**根本不是表**：计划、激活记录、运行、目标闸门躺在通用
 * `entities` 里，一行一个 protobuf BLOB。统一库里它们各有各的表（设计 §4.1：
 * 「通用实体投影改为各域自己的表」），所以这一半是一次**投影**而不是一次拷贝。
 *
 * 投影只动形状，不动载荷：BLOB 原样进新表的 `payload` 列，修订号原样带过来。
 * 配置摘要因此和 Host 算出来的逐字节相同——已经激活的计划搬过来之后不用重新
 * 授权，这正是「不翻译载荷」换来的东西。
 *
 * 三种实体不搬，因为统一库里没有对应物、也不需要：`automation.plan-index`
 * （计划表自己就是索引）、`automation.operation-index`（运行表上的
 * `operation_id` 唯一索引就是它）、`automation.run-history*`（一条 SQL 索引就是
 * 那张按时间倒排的索引实体，所以也没有 Host 那次一次性回填）。
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
  "command_sessions",
  // GitHub 三张之间没有外键，排在最后；`store_meta` 的 `host_id` 已经先到位。
  "github_config",
  "github_status_mappings",
  "github_references",
] as const;

/** 由 `legacy.entities` 投影出来的表。空判断把它们也算上。 */
export const PROJECTED_TABLES = [
  "automation_plans",
  "automation_activations",
  "automation_runs",
  "automation_gates",
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

/** Host 的实体 kind → 统一库里的表。投影只认这四种。 */
const PROJECTIONS = [
  { kind: "automation.plan", table: "automation_plans" },
  { kind: "automation.activation", table: "automation_activations" },
  { kind: "automation.run", table: "automation_runs" },
  { kind: "automation.target-gate", table: "automation_gates" },
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
  for (const table of [...ABSORBED_TABLES, ...PROJECTED_TABLES]) {
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
        if (table === "command_sessions") {
          // 这一张的 `launch` 在旧库里是 protobuf 字节，在 0020 之后是 JSON，
          // 所以它是一次**投影**而不是一次逐列拷贝。R7 删掉本分支的解码。
          copyCommandSessions(database);
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
      // 自动化的另一半：从通用实体投影出来。它在同一个事务里，所以「身份进了
      // 而计划没进」这种半搬状态不存在。
      Object.assign(rows, projectAutomation(database, present));
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

/**
 * 把 `legacy.entities` 里的自动化实体投影进各自的表。
 *
 * 逐行核对：删除墓碑跳过（它们在统一库里没有对应物，一行被删掉的计划就是不在
 * 那张表里），修订号原样带过来，BLOB 原样写进 `payload`。运行那张表多三列
 * （`plan_id` / `operation_id` / `scheduled_at_ms`），它们是索引用的投影列，从
 * 载荷里解出来——解不开就整体回滚，因为一条读不出计划标识的运行记录排不进任何
 * 一页历史。
 */
function projectAutomation(
  database: DatabaseSync,
  present: ReadonlySet<string>,
): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const projection of PROJECTIONS) rows[projection.table] = 0;
  if (!present.has("entities")) return rows;
  for (const projection of PROJECTIONS) {
    if (!tableExists(database, projection.table)) continue;
    const entities = database
      .prepare(
        "SELECT workspace_id AS workspaceId, entity_id AS entityId, revision, payload " +
          "FROM legacy.entities WHERE kind = ? AND deleted = 0",
      )
      .all(projection.kind) as {
      workspaceId: string;
      entityId: string;
      revision: number;
      payload: Uint8Array;
    }[];
    for (const entity of entities) {
      insertProjected(database, projection.table, entity);
      rows[projection.table] = (rows[projection.table] ?? 0) + 1;
    }
  }
  return rows;
}

function insertProjected(
  database: DatabaseSync,
  table: string,
  entity: {
    workspaceId: string;
    entityId: string;
    revision: number;
    payload: Uint8Array;
  },
): void {
  const revision = Math.max(1, Number(entity.revision));
  switch (table) {
    case "automation_plans": {
      const plan = fromBinary(AutomationPlanSchema, entity.payload);
      database
        .prepare(
          "INSERT INTO automation_plans (workspace_id, plan_id, revision, payload, payload_json, state, " +
            "next_due_at_ms, updated_at_ms) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
        )
        .run(
          entity.workspaceId,
          entity.entityId,
          revision,
          storedJson(planToJson(plan)),
          plan.state,
          Number(plan.nextDueUnixMs),
          Number(plan.updatedAtUnixMs),
        );
      return;
    }
    case "automation_activations":
      database
        .prepare(
          "INSERT INTO automation_activations (workspace_id, plan_id, revision, payload, payload_json) " +
            "VALUES (?, ?, ?, NULL, ?)",
        )
        .run(
          entity.workspaceId,
          entity.entityId,
          revision,
          storedJson(
            activationToJson(
              fromBinary(AutomationActivationSchema, entity.payload),
            ),
          ),
        );
      return;
    case "automation_runs": {
      const run = fromBinary(AutomationRunSchema, entity.payload);
      if (run.planId === "") {
        throw new Error(`运行 ${entity.entityId} 的记录里没有计划标识`);
      }
      database
        .prepare(
          "INSERT INTO automation_runs (workspace_id, run_id, plan_id, operation_id, " +
            "scheduled_at_ms, revision, payload, payload_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          entity.workspaceId,
          entity.entityId,
          run.planId,
          run.operationId,
          Number(run.scheduledAtUnixMs),
          revision,
          storedJson(runToJson(run)),
        );
      return;
    }
    case "automation_gates": {
      // 闸门的实体标识就是 `hashText(执行主机, 会话, 节点)`，统一库的 `gate_id`
      // 用的是同一个拼法，所以这一列原样搬。
      const gate = fromBinary(AutomationTargetGateSchema, entity.payload);
      database
        .prepare(
          "INSERT INTO automation_gates (gate_id, execution_host_id, session_id, node_id, " +
            "active_run_id, active_plan_id, active_workspace_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          entity.entityId,
          gate.executionHostId,
          gate.sessionId,
          gate.nodeId,
          gate.active?.runId ?? "",
          gate.active?.planId ?? "",
          gate.active?.workspaceId ?? "",
          revision,
        );
      return;
    }
    default:
      throw new Error(`没有 ${table} 的投影规则`);
  }
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

/**
 * 冻结的命令会话：`launch` 从 protobuf 字节解成 JSON，身份摘要跟着按**规范
 * JSON** 重算（迁移 0020）。
 *
 * 摘要重算的后果和计划的 `configSha256` 一样：搬过来的会话身份换了一个数。它只
 * 被这个 core 自己用来核对「这还是当初冻结的那份定义」，所以重算之后仍然自洽。
 *
 * **R7 删除本函数**：那时候旧 `host.db` 已经不存在了。
 */
function copyCommandSessions(database: DatabaseSync): void {
  const rows = database
    .prepare(
      "SELECT session_id AS sessionId, root_id AS rootId, workspace_id AS workspaceId, " +
        "execution_host_id AS executionHostId, launch, generation, state, " +
        "reason_code AS reasonCode, revision, created_at_ms AS createdAtMs, " +
        "updated_at_ms AS updatedAtMs FROM legacy.command_sessions",
    )
    .all() as {
    sessionId: string;
    rootId: string;
    workspaceId: string;
    executionHostId: string;
    launch: Uint8Array;
    generation: number;
    state: number;
    reasonCode: string;
    revision: number;
    createdAtMs: number;
    updatedAtMs: number;
  }[];
  const insert = database.prepare(
    "INSERT INTO main.command_sessions (session_id, root_id, workspace_id, execution_host_id, " +
      "launch, launch_json, launch_sha256, generation, state, reason_code, revision, " +
      "created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    const json = canonicalJson(
      launchSpecToJson(fromBinary(CommandLaunchSpecSchema, row.launch)),
    );
    insert.run(
      row.sessionId,
      row.rootId,
      row.workspaceId,
      row.executionHostId,
      json,
      createHash("sha256").update(json, "utf8").digest(),
      row.generation,
      row.state,
      row.reasonCode,
      row.revision,
      row.createdAtMs,
      row.updatedAtMs,
    );
  }
}
