/**
 * 自动化那一半的搬运：同名表逐列照搬，通用实体投影进各自的表。
 *
 * 这个文件真正在守的是「不翻译载荷」：计划的 protobuf 字节原样进新表，所以配置
 * 摘要和 Host 算出来的还是同一个数——已经激活的计划搬过来之后不用重新授权。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  AutomationPlanSchema,
  AutomationPlanState,
  AutomationRunSchema,
  AutomationRunState,
  AutomationTargetGateSchema,
  AutomationTargetKind,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { planFromJson } from "../schedule/json";
import { configHash } from "../schedule/plan";
import { absorbHostDatabase, hostDatabaseFile } from "./absorb-host";
import { openDatabase } from "./open";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../../runtime/migrations");
const unifiedDir = join(here, "migrations");

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // 已经关掉了。
    }
  }
});

const HOST_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function plan() {
  return create(AutomationPlanSchema, {
    id: "plan-1",
    configVersion: 3n,
    state: AutomationPlanState.ACTIVE,
    nextDueUnixMs: 1_800_000_000_000n,
    updatedAtUnixMs: 1_700_000_000_000n,
    runCount: 4n,
    config: {
      workspaceId: "ws",
      title: "每天九点",
      payloadRef: "a".repeat(64),
      payloadSha256: new Uint8Array(32).fill(3),
      schedule: {
        kind: {
          case: "cron",
          value: { expression: "0 9 * * *", timezone: "UTC" },
        },
      },
      target: {
        executionHostId: HOST_ID,
        kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
        nodeId: "node-1",
        agentLaunch: { agentId: "claude", accountId: "default" },
      },
    },
  });
}

function run() {
  return create(AutomationRunSchema, {
    id: "run-1",
    planId: "plan-1",
    workspaceId: "ws",
    operationId: "automation/p/host-x/ws/dispatch/run-1",
    scheduledAtUnixMs: 1_700_000_000_000n,
    state: AutomationRunState.SUCCEEDED,
  });
}

function gate() {
  return create(AutomationTargetGateSchema, {
    executionHostId: HOST_ID,
    nodeId: "node-1",
    active: { runId: "run-1", planId: "plan-1", workspaceId: "ws" },
  });
}

/** 一份带自动化数据的旧 `host.db`：通用实体表 + 载荷表。 */
function legacyHost(directory: string): void {
  const database = new DatabaseSync(hostDatabaseFile(directory));
  database.exec(`CREATE TABLE store_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 host_id TEXT NOT NULL,
 event_floor INTEGER NOT NULL DEFAULT 0,
 last_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE entities (
 workspace_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 revision INTEGER NOT NULL, payload BLOB NOT NULL, deleted INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, kind, entity_id)
);
CREATE TABLE automation_payloads (
 workspace_id TEXT NOT NULL, payload_ref TEXT NOT NULL, payload BLOB NOT NULL,
 payload_sha256 BLOB NOT NULL, created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, payload_ref)
)`);
  database
    .prepare("INSERT INTO store_meta(singleton,host_id) VALUES(1,?)")
    .run(HOST_ID);
  const insert = database.prepare(
    "INSERT INTO entities(workspace_id,kind,entity_id,revision,payload,deleted) VALUES(?,?,?,?,?,?)",
  );
  insert.run(
    "ws",
    "automation.plan",
    "plan-1",
    7,
    toBinary(AutomationPlanSchema, plan()),
    0,
  );
  insert.run(
    "ws",
    "automation.run",
    "run-1",
    2,
    toBinary(AutomationRunSchema, run()),
    0,
  );
  insert.run(
    "",
    "automation.target-gate",
    "gate-hash",
    1,
    toBinary(AutomationTargetGateSchema, gate()),
    0,
  );
  // 墓碑：统一库里没有对应物，一行被删掉的计划就是不在那张表里。
  insert.run(
    "ws",
    "automation.plan",
    "plan-gone",
    9,
    toBinary(AutomationPlanSchema, plan()),
    1,
  );
  // 三种不搬的实体，确认它们真的没被搬。
  insert.run(
    "ws",
    "automation.plan-index",
    "plan-1",
    1,
    new Uint8Array([1]),
    0,
  );
  insert.run("", "automation.operation-index", "op", 1, new Uint8Array([1]), 0);
  insert.run(
    "ws",
    "automation.run-history",
    "plan-1/x/run-1",
    1,
    new Uint8Array([1]),
    0,
  );
  database
    .prepare(
      "INSERT INTO automation_payloads(workspace_id,payload_ref,payload,payload_sha256,created_at_ms) VALUES(?,?,?,?,?)",
    )
    .run(
      "ws",
      "a".repeat(64),
      Buffer.from("写点什么"),
      new Uint8Array(32).fill(3),
      1_700_000_000_000,
    );
  database.close();
}

function unified(directory: string) {
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
    unifiedMigrationsDir: unifiedDir,
  });
  closing.push(opened.close);
  return opened;
}

describe("搬运自动化域", () => {
  it("同名表照搬，通用实体投影进各自的表", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-absorb-auto-"));
    legacyHost(directory);
    const opened = unified(directory);
    const result = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
    });
    expect(result.absorbed).toBe(true);
    expect(result.rows).toMatchObject({
      automation_payloads: 1,
      automation_plans: 1,
      automation_runs: 1,
      automation_gates: 1,
      automation_activations: 0,
    });

    const stored = opened.database
      .prepare(
        "SELECT revision, payload, payload_json AS payloadJson, state, " +
          "next_due_at_ms AS nextDue FROM automation_plans WHERE plan_id = 'plan-1'",
      )
      .get() as {
      revision: number;
      payload: Uint8Array | null;
      payloadJson: string;
      state: number;
      nextDue: number;
    };
    // 修订号原样带过来：搬运不是一次新的写入。
    expect(Number(stored.revision)).toBe(7);
    expect(Number(stored.state)).toBe(AutomationPlanState.ACTIVE);
    expect(Number(stored.nextDue)).toBe(1_800_000_000_000);
    // 0020 之后投影时就解码成 JSON：字节列留空，记录本身一个字段都不少。
    expect(stored.payload).toBeNull();
    const decoded = planFromJson(JSON.parse(stored.payloadJson));
    expect(toBinary(AutomationPlanSchema, decoded)).toEqual(
      toBinary(AutomationPlanSchema, plan()),
    );
    expect(configHash(decoded.config!).toString("hex")).toBe(
      configHash(plan().config!).toString("hex"),
    );

    // 运行那三列是索引用的投影列，从载荷里解出来。
    expect(
      opened.database
        .prepare(
          "SELECT plan_id AS planId, operation_id AS operationId, scheduled_at_ms AS at FROM automation_runs",
        )
        .get(),
    ).toEqual({
      planId: "plan-1",
      operationId: "automation/p/host-x/ws/dispatch/run-1",
      at: 1_700_000_000_000,
    });

    // 闸门的实体标识就是统一库的 `gate_id`，活跃的那次运行也跟着过来。
    expect(
      opened.database
        .prepare(
          "SELECT gate_id AS gateId, node_id AS nodeId, active_run_id AS activeRunId FROM automation_gates",
        )
        .get(),
    ).toEqual({ gateId: "gate-hash", nodeId: "node-1", activeRunId: "run-1" });

    // 墓碑不搬，三种索引实体也不搬。
    expect(
      opened.database
        .prepare("SELECT count(*) AS total FROM automation_plans")
        .get(),
    ).toEqual({ total: 1 });
  });

  it("目标表里已经有计划就整体跳过", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-absorb-auto-"));
    legacyHost(directory);
    const opened = unified(directory);
    opened.database
      .prepare(
        "INSERT INTO automation_plans(workspace_id,plan_id,revision,payload,state) VALUES('ws','mine',1,?,1)",
      )
      .run(toBinary(AutomationPlanSchema, plan()));
    const result = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
    });
    expect(result).toEqual({
      absorbed: false,
      skipped: "targetNotEmpty",
      rows: {},
    });
  });
});
