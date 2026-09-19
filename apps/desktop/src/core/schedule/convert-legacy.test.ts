/**
 * 迁移 0020 与那一遍一次性转换。
 *
 * 两件事要证：**0017 写下的字节行在 0020 之后读得回来**（这是升级路径），以及
 * **转换之后摘要换了一个数**（这是那次「已激活的计划要重新授权」的代价，它必须
 * 是被测出来的，而不是被希望的）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  AutomationPlanConfigSchema,
  AutomationPlanSchema,
  AutomationReceiptSchema,
  AutomationRunSchema,
  CommandLaunchSpecSchema,
  create,
  toBinary,
} from "@armadra/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { convertLegacyPayloads } from "./convert-legacy";
import { canonicalJson, launchSpecToJson, planConfigToJson } from "./json";
import { configHash } from "./plan";
import { ScheduleStore } from "./store";
import { config } from "./fixture";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) =>
  readFileSync(resolve(here, `../db/migrations/${name}`), "utf8");

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const database of open.splice(0)) database.close();
});

/** 一个只到 0017 的库：载荷列还是 `NOT NULL` 的 BLOB。 */
function legacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  open.push(database);
  database.exec(
    "CREATE TABLE store_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), " +
      "host_id TEXT NOT NULL, event_floor INTEGER NOT NULL DEFAULT 0, " +
      "last_sequence INTEGER NOT NULL DEFAULT 0)",
  );
  database.exec(sql("0017_event_outbox.sql"));
  return database;
}

describe("0020：自动化载荷从 protobuf 转成 JSON", () => {
  it("字节行经迁移与转换之后读得回来，摘要换成规范 JSON 的那个数", () => {
    const database = legacyDatabase();
    const planConfig = config({
      case: "once",
      value: { atUnixMs: 1_800_000_000_000n },
    });
    const plan = create(AutomationPlanSchema, {
      id: "plan-1",
      configVersion: 2n,
      config: planConfig,
      state: 2,
      nextDueUnixMs: 1_800_000_000_000n,
      updatedAtUnixMs: 1_700_000_000_000n,
    });
    const legacyDigest = createHash("sha256")
      .update(toBinary(AutomationPlanConfigSchema, planConfig))
      .digest("hex");

    database
      .prepare(
        "INSERT INTO automation_plans (workspace_id, plan_id, revision, payload, state, " +
          "next_due_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        planConfig.workspaceId,
        "plan-1",
        7,
        toBinary(AutomationPlanSchema, plan),
        2,
        1_800_000_000_000,
        1_700_000_000_000,
      );
    const run = create(AutomationRunSchema, {
      id: "run-1",
      planId: "plan-1",
      workspaceId: planConfig.workspaceId,
      operationId: "op-1",
      scheduledAtUnixMs: 1_800_000_000_000n,
    });
    database
      .prepare(
        "INSERT INTO automation_runs (workspace_id, run_id, plan_id, operation_id, " +
          "scheduled_at_ms, revision, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        planConfig.workspaceId,
        "run-1",
        "plan-1",
        "op-1",
        1_800_000_000_000,
        3,
        toBinary(AutomationRunSchema, run),
      );
    database
      .prepare(
        "INSERT INTO automation_receipts (operation_id, request_sha256, payload, observed_at_ms) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(
        "op-1",
        new Uint8Array(32).fill(3),
        toBinary(
          AutomationReceiptSchema,
          create(AutomationReceiptSchema, {
            operationId: "op-1",
            outcome: 5,
            sequence: 1n,
            observedAtUnixMs: 1_800_000_000_001n,
          }),
        ),
        1_800_000_000_001,
      );
    const launch = create(CommandLaunchSpecSchema, {
      executable: "/bin/echo",
      args: ["hello"],
    });
    database
      .prepare(
        "INSERT INTO command_roots (root_id, workspace_id, path, created_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("root-1", planConfig.workspaceId, "/tmp/ws", 1);
    database
      .prepare(
        "INSERT INTO command_sessions (session_id, root_id, workspace_id, execution_host_id, launch, " +
          "launch_sha256, generation, state, reason_code, revision, created_at_ms, updated_at_ms) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)",
      )
      .run(
        "session-1",
        "root-1",
        planConfig.workspaceId,
        "host-1",
        toBinary(CommandLaunchSpecSchema, launch),
        new Uint8Array(32).fill(1),
        4,
        1,
        1,
        1,
        1,
      );

    // 迁移只加列：转换之前那些行仍然只有字节，而读侧照样读得出来。
    database.exec(sql("0020_automation_json.sql"));
    const store = new ScheduleStore(database);
    expect(store.plan(planConfig.workspaceId, "plan-1").value.id).toBe(
      "plan-1",
    );
    expect(store.commandSession("session-1")?.launch.executable).toBe(
      "/bin/echo",
    );

    const report = convertLegacyPayloads(database);
    expect(report).toEqual({
      plans: 1,
      activations: 0,
      runs: 1,
      receipts: 1,
      commandSessions: 1,
    });

    // 转换之后字节列空了，记录本身一个字段都不少。
    const row = database
      .prepare(
        "SELECT payload, payload_json AS json FROM automation_plans WHERE plan_id = 'plan-1'",
      )
      .get() as { payload: Uint8Array | null; json: string };
    expect(row.payload).toBeNull();
    const reread = store.plan(planConfig.workspaceId, "plan-1");
    expect(reread.revision).toBe(7);
    expect(reread.value.config?.title).toBe(planConfig.title);
    expect(store.run(planConfig.workspaceId, "run-1").value.operationId).toBe(
      "op-1",
    );
    expect(store.receipt("op-1")?.sequence).toBe(1n);

    // 存的是规范文本：同一条记录只有一种字节。
    expect(row.json).toBe(canonicalJson(JSON.parse(row.json)));

    // 摘要换了一个数——这就是那次要重新授权的原因。
    const digest = configHash(reread.value.config!).toString("hex");
    expect(digest).not.toBe(legacyDigest);
    expect(digest).toBe(
      createHash("sha256")
        .update(canonicalJson(planConfigToJson(planConfig)), "utf8")
        .digest("hex"),
    );

    // 命令会话的身份摘要跟着按规范 JSON 重算。
    const session = store.commandSession("session-1");
    expect(session?.launch.args).toEqual(["hello"]);
    expect(Buffer.from(session!.launchSha256).toString("hex")).toBe(
      createHash("sha256")
        .update(canonicalJson(launchSpecToJson(launch)), "utf8")
        .digest("hex"),
    );

    // 再跑一遍什么也不做。
    expect(convertLegacyPayloads(database)).toEqual({
      plans: 0,
      activations: 0,
      runs: 0,
      receipts: 0,
      commandSessions: 0,
    });
  });

  it("没有 0020 的库上什么也不做", () => {
    expect(convertLegacyPayloads(legacyDatabase())).toEqual({
      plans: 0,
      activations: 0,
      runs: 0,
      receipts: 0,
      commandSessions: 0,
    });
  });
});
