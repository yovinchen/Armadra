import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  AutomationOutcome,
  AutomationPlanConfigSchema,
  AutomationReceiptSchema,
  AutomationTargetKind,
  type AutomationPlanConfig,
  type AutomationReceipt,
  type AutomationRun,
  type AutomationTarget,
  create,
} from "@armadra/protocol";

import {
  type Authorization,
  type Dispatcher,
  ScheduleEngine,
  type TargetStatus,
} from "./engine";
import { configHash } from "./plan";
import { ScheduleStore } from "./store";

/**
 * 调度域的用例夹具。
 *
 * 只建 0017 那一批表：这个域不碰身份、画布或终端的表，把整条迁移链搬进一个
 * 内存库只会让一次断言失败的原因变得更难读。
 *
 * 时钟和投递方都是可控的。Go 那边的用例也是这么搭的，理由一样：调度是一门关于
 * 「什么时候」的学问，一个跟着真实时间走的用例证明不了任何一条关于时间的规则。
 */

const here = dirname(fileURLToPath(import.meta.url));
/** 0017 建表，0020 把载荷换成 JSON 列。两条都要，读写走的是 0020 之后的形状。 */
const migrations = [
  resolve(here, "../db/migrations/0017_event_outbox.sql"),
  resolve(here, "../db/migrations/0020_automation_json.sql"),
];

export const HOST_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
export const PRINCIPAL = "0123456789abcdef0123456789abcdef";
export const DEVICE = "fedcba9876543210fedcba9876543210";

export const AUTH: Authorization = {
  principalId: PRINCIPAL,
  authorizationId: DEVICE,
};

export function openStore(): { database: DatabaseSync; store: ScheduleStore } {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE store_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), " +
      "host_id TEXT NOT NULL, event_floor INTEGER NOT NULL DEFAULT 0, " +
      "last_sequence INTEGER NOT NULL DEFAULT 0)",
  );
  for (const migration of migrations) {
    database.exec(readFileSync(migration, "utf8"));
  }
  return { database, store: new ScheduleStore(database) };
}

/** 可控的投递方：记下每一次调用，答案由用例摆布。 */
export class FakeDispatcher implements Dispatcher {
  status: TargetStatus = { state: "ready", generation: 7 };
  /** `undefined` 表示这次投递结果不明。 */
  outcome: AutomationOutcome | undefined = AutomationOutcome.DELIVERED;
  reasonCode = "WRITTEN";
  readonly dispatched: string[] = [];
  readonly probed: string[] = [];
  readonly looked: string[] = [];
  private sequence = 0;
  /** 投递时抛出来，模拟一次连目标都没问到的失败。 */
  throwOnDispatch = false;

  async supports(target: AutomationTarget): Promise<TargetStatus> {
    this.probed.push(target.sessionId || target.nodeId);
    return this.status;
  }

  async dispatch(run: AutomationRun): Promise<AutomationReceipt | undefined> {
    this.dispatched.push(run.id);
    if (this.throwOnDispatch) throw new Error("投递失败");
    if (this.outcome === undefined) return undefined;
    this.sequence += 1;
    return create(AutomationReceiptSchema, {
      operationId: run.operationId,
      requestSha256: run.requestSha256,
      outcome: this.outcome,
      sequence: BigInt(this.sequence),
      observedAtUnixMs: 1_700_000_000_000n,
      reasonCode: this.reasonCode,
    });
  }

  async lookup(run: AutomationRun): Promise<AutomationReceipt | undefined> {
    this.looked.push(run.id);
    return undefined;
  }
}

export interface Harness {
  readonly database: DatabaseSync;
  readonly store: ScheduleStore;
  readonly engine: ScheduleEngine;
  readonly dispatcher: FakeDispatcher;
  /** 当前的假墙上时钟，毫秒。 */
  now: number;
  advance(ms: number): void;
}

export function harness(options: { now?: number } = {}): Harness {
  const { database, store } = openStore();
  const dispatcher = new FakeDispatcher();
  const state = { now: options.now ?? 1_700_000_000_000 };
  const engine = new ScheduleEngine({
    store,
    dispatcher,
    // 默认放行：授权本身由服务层的用例单独守，这里守的是调度。
    authorizer: { verify: async () => {} },
    hostId: HOST_ID,
    instanceId: "instance-1",
    clock: () => state.now,
    monotonic: () => state.now,
    claimLeaseMs: 30_000,
    dispatchTimeoutMs: 5_000,
    pollIntervalMs: 1_000,
  });
  return {
    database,
    store,
    engine,
    dispatcher,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    advance(ms: number) {
      state.now += ms;
    },
  };
}

/** 一份最小的合法配置：Agent 目标 + 一次性日程。 */
export function config(
  overrides: {
    workspaceId?: string;
    atMs?: number;
    schedule?: AutomationPlanConfig["schedule"];
    target?: Record<string, unknown>;
    maxRuns?: number;
    expiresAtUnixMs?: number;
    misfireGraceMs?: number;
    busyTtlMs?: number;
    safeRetryLimit?: number;
    concurrencyPolicy?: number;
    misfirePolicy?: number;
  } = {},
): AutomationPlanConfig {
  return create(AutomationPlanConfigSchema, {
    workspaceId: overrides.workspaceId ?? "ws",
    title: "测试计划",
    payloadRef: "b".repeat(64),
    payloadSha256: new Uint8Array(32).fill(5),
    schedule:
      overrides.schedule ??
      ({
        kind: {
          case: "once",
          value: { atUnixMs: BigInt(overrides.atMs ?? 1_700_000_000_000) },
        },
      } as AutomationPlanConfig["schedule"]),
    target: {
      executionHostId: HOST_ID,
      kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
      nodeId: "node-1",
      agentLaunch: { agentId: "claude", accountId: "default" },
      ...overrides.target,
    } as AutomationTarget,
    ...(overrides.maxRuns === undefined
      ? {}
      : { maxRuns: BigInt(overrides.maxRuns) }),
    ...(overrides.expiresAtUnixMs === undefined
      ? {}
      : { expiresAtUnixMs: BigInt(overrides.expiresAtUnixMs) }),
    ...(overrides.misfireGraceMs === undefined
      ? {}
      : { misfireGraceMs: BigInt(overrides.misfireGraceMs) }),
    ...(overrides.busyTtlMs === undefined
      ? {}
      : { busyTtlMs: BigInt(overrides.busyTtlMs) }),
    ...(overrides.safeRetryLimit === undefined
      ? {}
      : { safeRetryLimit: overrides.safeRetryLimit }),
    ...(overrides.concurrencyPolicy === undefined
      ? {}
      : { concurrencyPolicy: overrides.concurrencyPolicy }),
    ...(overrides.misfirePolicy === undefined
      ? {}
      : { misfirePolicy: overrides.misfirePolicy }),
  });
}

/** 定义并激活一个计划，返回它最新的快照。 */
export async function activated(
  harnessed: Harness,
  planId: string,
  configuration: AutomationPlanConfig = config(),
): Promise<{ revision: number }> {
  const defined = await harnessed.engine.define(AUTH, planId, configuration, 0);
  // 和页面做的事一样：拿着你看过的那份配置的摘要去激活。归一化之后的那份才是
  // 计划真正存着的，所以摘要从它算。
  const stored = harnessed.engine.getPlan(configuration.workspaceId, planId);
  const activatedPlan = await harnessed.engine.activate(
    AUTH,
    configuration.workspaceId,
    planId,
    defined.revision,
    Number(defined.plan.configVersion),
    configHash(stored.plan.config as AutomationPlanConfig),
  );
  return { revision: activatedPlan.revision };
}
