/**
 * **R7 删除本文件。**
 *
 * 迁移 0020 给自动化的五张表各加了一个 JSON 列，并把原来的 protobuf BLOB 列改成
 * 可空。迁移本身不解码任何字节——SQL 里没有 protobuf 解码器——所以已经装过的机器
 * 在应用完 0020 之后，行还是只有 BLOB。这一遍在 core 启动时把它们补上 JSON。
 *
 * 三条规矩：
 *
 *   * **只补，不改**。只碰 `payload_json IS NULL AND payload IS NOT NULL` 的行；
 *     已经有 JSON 的行一个字节都不动。所以跑第二遍什么也不做，跑到一半断电下次
 *     接着跑。
 *   * **一个事务**。半转的库里「计划是 JSON 而它的运行还是字节」是合法状态（读
 *     侧两种都认），但一次崩在中间的转换不该留下一张表转完一张没转的分界线。
 *   * **解不开的行不吞**。一行解不开就整体回滚并抛出去——一条读不出来的自动化
 *     记录必须变成一次拒绝启动，而不是一个悄悄消失的计划。
 *
 * 摘要在这里不重算：`configSha256` 是**算出来的**而不是存下来的（`plan.ts` 的
 * `configHash` 每次读快照时现算），所以换成规范 JSON 之后它自己就是新值。直接
 * 后果写在迁移 0020 里：**已经激活的计划要重新授权一次**。
 *
 * `command_sessions.launch_sha256` 不一样，它是**存下来的**，所以这里跟着重算。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AutomationActivationSchema,
  AutomationPlanSchema,
  AutomationReceiptSchema,
  AutomationRunSchema,
  CommandLaunchSpecSchema,
  fromBinary,
} from "@armadra/protocol";

import {
  activationToJson,
  canonicalJson,
  launchSpecToJson,
  planToJson,
  receiptToJson,
  runToJson,
  storedJson,
} from "./json";

export interface ConversionReport {
  readonly plans: number;
  readonly activations: number;
  readonly runs: number;
  readonly receipts: number;
  readonly commandSessions: number;
}

const EMPTY: ConversionReport = {
  plans: 0,
  activations: 0,
  runs: 0,
  receipts: 0,
  commandSessions: 0,
};

/** 表名 → 主键列 + 解码器。顺序就是转换顺序，报告按这个顺序读。 */
const PAYLOAD_TABLES = [
  {
    table: "automation_plans",
    keys: ["workspace_id", "plan_id"],
    convert: (bytes: Uint8Array) =>
      storedJson(planToJson(fromBinary(AutomationPlanSchema, bytes))),
  },
  {
    table: "automation_activations",
    keys: ["workspace_id", "plan_id"],
    convert: (bytes: Uint8Array) =>
      storedJson(
        activationToJson(fromBinary(AutomationActivationSchema, bytes)),
      ),
  },
  {
    table: "automation_runs",
    keys: ["workspace_id", "run_id"],
    convert: (bytes: Uint8Array) =>
      storedJson(runToJson(fromBinary(AutomationRunSchema, bytes))),
  },
  {
    table: "automation_receipts",
    keys: ["operation_id"],
    convert: (bytes: Uint8Array) =>
      storedJson(receiptToJson(fromBinary(AutomationReceiptSchema, bytes))),
  },
] as const;

/**
 * 把还只有 BLOB 的自动化行补成 JSON 行。表不存在（0017 还没应用）就什么也不做。
 */
export function convertLegacyPayloads(
  database: DatabaseSync,
): ConversionReport {
  if (!hasColumn(database, "automation_plans", "payload_json")) return EMPTY;
  const counts: Record<string, number> = {};
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of PAYLOAD_TABLES) {
      counts[entry.table] = convertTable(
        database,
        entry.table,
        entry.keys,
        entry.convert,
      );
    }
    counts.command_sessions = convertCommandSessions(database);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    plans: counts.automation_plans ?? 0,
    activations: counts.automation_activations ?? 0,
    runs: counts.automation_runs ?? 0,
    receipts: counts.automation_receipts ?? 0,
    commandSessions: counts.command_sessions ?? 0,
  };
}

function convertTable(
  database: DatabaseSync,
  table: string,
  keys: readonly string[],
  convert: (bytes: Uint8Array) => string,
): number {
  const selected = [...keys, "payload"].join(", ");
  const rows = database
    .prepare(
      `SELECT ${selected} FROM ${table} WHERE payload_json IS NULL AND payload IS NOT NULL`,
    )
    .all() as Record<string, unknown>[];
  if (rows.length === 0) return 0;
  const where = keys.map((key) => `${key} = ?`).join(" AND ");
  const update = database.prepare(
    `UPDATE ${table} SET payload_json = ?, payload = NULL WHERE ${where}`,
  );
  for (const row of rows) {
    update.run(
      convert(row.payload as Uint8Array),
      ...keys.map((key) => row[key] as string),
    );
  }
  return rows.length;
}

function convertCommandSessions(database: DatabaseSync): number {
  const rows = database
    .prepare(
      "SELECT session_id AS sessionId, launch FROM command_sessions " +
        "WHERE launch_json IS NULL AND launch IS NOT NULL",
    )
    .all() as { sessionId: string; launch: Uint8Array }[];
  if (rows.length === 0) return 0;
  const update = database.prepare(
    "UPDATE command_sessions SET launch_json = ?, launch_sha256 = ?, launch = NULL " +
      "WHERE session_id = ?",
  );
  for (const row of rows) {
    const json = canonicalJson(
      launchSpecToJson(fromBinary(CommandLaunchSpecSchema, row.launch)),
    );
    update.run(
      json,
      createHash("sha256").update(json, "utf8").digest(),
      row.sessionId,
    );
  }
  return rows.length;
}

function hasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  try {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as {
      name?: unknown;
    }[];
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}
