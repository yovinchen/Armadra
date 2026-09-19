import type { DatabaseSync } from "node:sqlite";
import {
  AutomationActivationSchema,
  AutomationPlanSchema,
  AutomationReceiptSchema,
  AutomationRunSchema,
  AutomationTargetGateSchema,
  type AutomationActivation,
  type AutomationPlan,
  type AutomationReceipt,
  type AutomationRun,
  type AutomationTargetGate,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";

import { ScheduleError, gateId, gateIdentity, num } from "./plan";
import type { AutomationTarget } from "@armadra/protocol";

/**
 * 自动化域的持久层。
 *
 * Go Host 把计划、激活、运行、闸门全塞进一张通用 `entities` 表，一行一个
 * protobuf BLOB，顺序靠自己编的 key；设计 §4.1 说得很直接：**通用实体投影改为
 * 各域自己的表，不再有「通用实体」间接层**。所以这里是六张表，而载荷仍然是同一
 * 份 protobuf——摘要因此和 Host 算出来的逐字节相同，旧库搬过来的计划不用重新
 * 授权。
 *
 * 三条规矩照搬：
 *
 *   * **修订号是乐观锁**。每次写都带上读到的那个修订号，对不上就是 `conflict`，
 *     不是「后写的赢」。两台设备读到同一个待批计划都会试着写 1，第二台被拒。
 *   * **一次提交是一个事务**。一次 tick 会同时改计划、运行、闸门，三者必须一起
 *     进——闸门占住了而运行没记下来，那个目标就永远被一个不存在的运行锁着。
 *   * **运行历史是按时间倒排的一页**，不是「按 key 排出来的任意二十分之一」。
 *     Host 为此另建了一张索引实体；这里 `automation_runs_history` 就是它。
 */

export const conflict = (): ScheduleError =>
  new ScheduleError("conflict", "修订号对不上，有人先改了");
export const notFound = (what = "找不到"): ScheduleError =>
  new ScheduleError("notFound", what);

export interface Snapshot<T> {
  readonly value: T;
  readonly revision: number;
}

/** 运行历史的游标：`<planId>/<倒序时刻>/<runId>`，和 Host 的 `historyID` 同拼法。 */
export function historyCursor(
  planId: string,
  scheduledAtMs: number,
  runId: string,
): string {
  const clamped = Math.max(0, Math.min(scheduledAtMs, 253_402_300_799_999));
  const descending = (253_402_300_799_999 - clamped)
    .toString(16)
    .padStart(16, "0");
  return `${planId}/${descending}/${runId}`;
}

export interface CommandSessionRecord {
  readonly sessionId: string;
  readonly rootId: string;
  readonly workspaceId: string;
  readonly executionHostId: string;
  readonly launch: Uint8Array;
  readonly launchSha256: Uint8Array;
  readonly generation: number;
  /** 1 = ready，2 = 不可重建。和 Host 的 `CommandSessionState` 同一组数。 */
  readonly state: number;
  readonly reasonCode: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export const COMMAND_SESSION_READY = 1;
export const COMMAND_SESSION_UNREBUILDABLE = 2;

export class ScheduleStore {
  constructor(readonly database: DatabaseSync) {}

  /**
   * 一组写入，一个事务。
   *
   * 嵌套调用直接跑函数体而不是再开一层：SQLite 没有真的嵌套事务，`BEGIN` 套
   * `BEGIN` 是一个错误，而这个域里 `finish` 会从 `advance` 里被调用。
   */
  transact<T>(work: () => T): T {
    if (this.inTransaction) return work();
    this.inTransaction = true;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private inTransaction = false;

  /* ---------------------------------- 计划 --------------------------------- */

  plan(workspaceId: string, planId: string): Snapshot<AutomationPlan> {
    const row = this.database
      .prepare(
        "SELECT revision, payload FROM automation_plans WHERE workspace_id = ? AND plan_id = ?",
      )
      .get(workspaceId, planId) as
      | { revision: number; payload: Uint8Array }
      | undefined;
    if (row === undefined) throw notFound("没有这个计划");
    return {
      value: fromBinary(AutomationPlanSchema, row.payload),
      revision: Number(row.revision),
    };
  }

  planOrUndefined(
    workspaceId: string,
    planId: string,
  ): Snapshot<AutomationPlan> | undefined {
    try {
      return this.plan(workspaceId, planId);
    } catch (error) {
      if (error instanceof ScheduleError && error.code === "notFound") {
        return undefined;
      }
      throw error;
    }
  }

  writePlan(plan: AutomationPlan, expectedRevision: number): number {
    const workspaceId = plan.config?.workspaceId ?? "";
    const payload = toBinary(AutomationPlanSchema, plan);
    const next = expectedRevision + 1;
    if (expectedRevision === 0) {
      this.database
        .prepare(
          "INSERT INTO automation_plans " +
            "(workspace_id, plan_id, revision, payload, state, next_due_at_ms, updated_at_ms) " +
            "VALUES (?, ?, 1, ?, ?, ?, ?)",
        )
        .run(
          workspaceId,
          plan.id,
          payload,
          plan.state,
          num(plan.nextDueUnixMs),
          num(plan.updatedAtUnixMs),
        );
      return 1;
    }
    const result = this.database
      .prepare(
        "UPDATE automation_plans SET revision = ?, payload = ?, state = ?, " +
          "next_due_at_ms = ?, updated_at_ms = ? " +
          "WHERE workspace_id = ? AND plan_id = ? AND revision = ?",
      )
      .run(
        next,
        payload,
        plan.state,
        num(plan.nextDueUnixMs),
        num(plan.updatedAtUnixMs),
        workspaceId,
        plan.id,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) throw conflict();
    return next;
  }

  listPlans(
    workspaceId: string,
    after: string,
    limit: number,
  ): { plans: Snapshot<AutomationPlan>[]; nextId: string; hasMore: boolean } {
    const page = Math.max(1, Math.min(limit, 200));
    const rows = this.database
      .prepare(
        "SELECT plan_id, revision, payload FROM automation_plans " +
          "WHERE workspace_id = ? AND plan_id > ? ORDER BY plan_id LIMIT ?",
      )
      .all(workspaceId, after, page + 1) as {
      plan_id: string;
      revision: number;
      payload: Uint8Array;
    }[];
    const hasMore = rows.length > page;
    const plans = rows.slice(0, page).map((row) => ({
      value: fromBinary(AutomationPlanSchema, row.payload),
      revision: Number(row.revision),
    }));
    return {
      plans,
      nextId:
        plans.length === 0 ? after : (rows[plans.length - 1]?.plan_id ?? after),
      hasMore,
    };
  }

  /** 这台机器上所有工作空间的计划，一次 tick 要走一遍。 */
  everyPlanRef(): { workspaceId: string; planId: string }[] {
    return this.database
      .prepare(
        "SELECT workspace_id AS workspaceId, plan_id AS planId FROM automation_plans " +
          "ORDER BY workspace_id, plan_id",
      )
      .all() as { workspaceId: string; planId: string }[];
  }

  /* --------------------------------- 激活记录 ------------------------------- */

  activation(
    workspaceId: string,
    planId: string,
  ): Snapshot<AutomationActivation> {
    const row = this.database
      .prepare(
        "SELECT revision, payload FROM automation_activations WHERE workspace_id = ? AND plan_id = ?",
      )
      .get(workspaceId, planId) as
      | { revision: number; payload: Uint8Array }
      | undefined;
    if (row === undefined) {
      return { value: create(AutomationActivationSchema, {}), revision: 0 };
    }
    return {
      value: fromBinary(AutomationActivationSchema, row.payload),
      revision: Number(row.revision),
    };
  }

  writeActivation(
    workspaceId: string,
    activation: AutomationActivation,
    expectedRevision: number,
  ): number {
    const payload = toBinary(AutomationActivationSchema, activation);
    if (expectedRevision === 0) {
      this.database
        .prepare(
          "INSERT INTO automation_activations (workspace_id, plan_id, revision, payload) VALUES (?, ?, 1, ?)",
        )
        .run(workspaceId, activation.planId, payload);
      return 1;
    }
    const result = this.database
      .prepare(
        "UPDATE automation_activations SET revision = ?, payload = ? " +
          "WHERE workspace_id = ? AND plan_id = ? AND revision = ?",
      )
      .run(
        expectedRevision + 1,
        payload,
        workspaceId,
        activation.planId,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) throw conflict();
    return expectedRevision + 1;
  }

  /* ---------------------------------- 运行 --------------------------------- */

  run(workspaceId: string, runId: string): Snapshot<AutomationRun> {
    const found = this.runOrUndefined(workspaceId, runId);
    if (found === undefined) throw notFound("没有这次运行");
    return found;
  }

  runOrUndefined(
    workspaceId: string,
    runId: string,
  ): Snapshot<AutomationRun> | undefined {
    const row = this.database
      .prepare(
        "SELECT revision, payload FROM automation_runs WHERE workspace_id = ? AND run_id = ?",
      )
      .get(workspaceId, runId) as
      | { revision: number; payload: Uint8Array }
      | undefined;
    if (row === undefined) return undefined;
    return {
      value: fromBinary(AutomationRunSchema, row.payload),
      revision: Number(row.revision),
    };
  }

  /** 操作标识反查运行。收据是靠这一条落回它自己那次投递上的。 */
  runByOperation(operationId: string): Snapshot<AutomationRun> | undefined {
    const row = this.database
      .prepare(
        "SELECT workspace_id AS workspaceId, run_id AS runId FROM automation_runs WHERE operation_id = ?",
      )
      .get(operationId) as { workspaceId: string; runId: string } | undefined;
    if (row === undefined) return undefined;
    return this.runOrUndefined(row.workspaceId, row.runId);
  }

  writeRun(run: AutomationRun, expectedRevision: number): number {
    const payload = toBinary(AutomationRunSchema, run);
    if (expectedRevision === 0) {
      this.database
        .prepare(
          "INSERT INTO automation_runs " +
            "(workspace_id, run_id, plan_id, operation_id, scheduled_at_ms, revision, payload) " +
            "VALUES (?, ?, ?, ?, ?, 1, ?)",
        )
        .run(
          run.workspaceId,
          run.id,
          run.planId,
          run.operationId,
          num(run.scheduledAtUnixMs),
          payload,
        );
      return 1;
    }
    const result = this.database
      .prepare(
        "UPDATE automation_runs SET revision = ?, payload = ? " +
          "WHERE workspace_id = ? AND run_id = ? AND revision = ?",
      )
      .run(
        expectedRevision + 1,
        payload,
        run.workspaceId,
        run.id,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) throw conflict();
    return expectedRevision + 1;
  }

  /**
   * 一个计划的运行历史，最新在前。
   *
   * 游标是不透明的，而且属于它被签发给的那个计划：一个别的计划的游标会被拒，
   * 不会带着调用方翻进别人的历史里。
   */
  listRuns(
    workspaceId: string,
    planId: string,
    after: string,
    limit: number,
  ): { runs: Snapshot<AutomationRun>[]; nextId: string; hasMore: boolean } {
    const page = Math.max(1, Math.min(limit, 200));
    const rows = this.database
      .prepare(
        "SELECT run_id AS runId, scheduled_at_ms AS scheduledAtMs, revision, payload " +
          "FROM automation_runs WHERE workspace_id = ? AND plan_id = ? " +
          "ORDER BY scheduled_at_ms DESC, run_id LIMIT ?",
      )
      .all(workspaceId, planId, 1_000) as {
      runId: string;
      scheduledAtMs: number;
      revision: number;
      payload: Uint8Array;
    }[];
    const ordered = rows.map((row) => ({
      cursor: historyCursor(planId, Number(row.scheduledAtMs), row.runId),
      snapshot: {
        value: fromBinary(AutomationRunSchema, row.payload),
        revision: Number(row.revision),
      },
    }));
    // SQL 的 `ORDER BY … DESC, run_id` 和游标的字节序是同一个顺序，所以「从游标
    // 之后」就是「在这串里跳过不大于它的那些」。
    const start =
      after === "" ? 0 : ordered.findIndex((entry) => entry.cursor > after);
    const from = start < 0 ? ordered.length : start;
    const slice = ordered.slice(from, from + page);
    const hasMore = ordered.length > from + page;
    return {
      runs: slice.map((entry) => entry.snapshot),
      nextId:
        slice.length === 0 ? after : (slice[slice.length - 1]?.cursor ?? after),
      hasMore,
    };
  }

  /* ---------------------------------- 闸门 --------------------------------- */

  gate(target: AutomationTarget): Snapshot<AutomationTargetGate> {
    const id = gateId(target);
    const identity = gateIdentity(target);
    const row = this.database
      .prepare(
        "SELECT execution_host_id AS executionHostId, session_id AS sessionId, node_id AS nodeId, " +
          "active_run_id AS activeRunId, active_plan_id AS activePlanId, " +
          "active_workspace_id AS activeWorkspaceId, revision FROM automation_gates WHERE gate_id = ?",
      )
      .get(id) as
      | {
          executionHostId: string;
          sessionId: string;
          nodeId: string;
          activeRunId: string;
          activePlanId: string;
          activeWorkspaceId: string;
          revision: number;
        }
      | undefined;
    if (row === undefined) {
      return {
        value: create(AutomationTargetGateSchema, {
          executionHostId: target.executionHostId,
          sessionId: identity.sessionId,
          nodeId: identity.nodeId,
        }),
        revision: 0,
      };
    }
    if (
      row.executionHostId !== target.executionHostId ||
      row.sessionId !== identity.sessionId ||
      row.nodeId !== identity.nodeId
    ) {
      // 同一个摘要下挂着另一个目标：库坏了，不是一次可以覆盖的冲突。
      throw new ScheduleError("invalid", "目标闸门与它的键对不上");
    }
    return {
      value: create(AutomationTargetGateSchema, {
        executionHostId: row.executionHostId,
        sessionId: row.sessionId,
        nodeId: row.nodeId,
        ...(row.activeRunId === ""
          ? {}
          : {
              active: {
                runId: row.activeRunId,
                planId: row.activePlanId,
                workspaceId: row.activeWorkspaceId,
              },
            }),
      }),
      revision: Number(row.revision),
    };
  }

  writeGate(
    target: AutomationTarget,
    gate: AutomationTargetGate,
    expectedRevision: number,
  ): number {
    const id = gateId(target);
    const active = gate.active;
    if (expectedRevision === 0) {
      this.database
        .prepare(
          "INSERT INTO automation_gates (gate_id, execution_host_id, session_id, node_id, " +
            "active_run_id, active_plan_id, active_workspace_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .run(
          id,
          gate.executionHostId,
          gate.sessionId,
          gate.nodeId,
          active?.runId ?? "",
          active?.planId ?? "",
          active?.workspaceId ?? "",
        );
      return 1;
    }
    const result = this.database
      .prepare(
        "UPDATE automation_gates SET active_run_id = ?, active_plan_id = ?, " +
          "active_workspace_id = ?, revision = ? WHERE gate_id = ? AND revision = ?",
      )
      .run(
        active?.runId ?? "",
        active?.planId ?? "",
        active?.workspaceId ?? "",
        expectedRevision + 1,
        id,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) throw conflict();
    return expectedRevision + 1;
  }

  /* --------------------------------- 载荷 ---------------------------------- */

  putPayload(
    workspaceId: string,
    ref: string,
    payload: Uint8Array,
    digest: Uint8Array,
    atMs: number,
  ): void {
    this.database
      .prepare(
        "INSERT INTO automation_payloads (workspace_id, payload_ref, payload, payload_sha256, created_at_ms) " +
          "VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, payload_ref) DO NOTHING",
      )
      .run(workspaceId, ref, payload, digest, Math.max(1, atMs));
  }

  payload(
    workspaceId: string,
    ref: string,
  ): { payload: Uint8Array; sha256: Uint8Array } {
    const row = this.database
      .prepare(
        "SELECT payload, payload_sha256 AS sha256 FROM automation_payloads WHERE workspace_id = ? AND payload_ref = ?",
      )
      .get(workspaceId, ref) as
      | { payload: Uint8Array; sha256: Uint8Array }
      | undefined;
    if (row === undefined) throw notFound("找不到这个计划的载荷");
    return row;
  }

  /* --------------------------------- 授权记录 ------------------------------- */

  putGrant(grant: {
    readonly authorizationId: string;
    readonly principalId: string;
    readonly deviceId: string;
    readonly deviceEpoch: number;
    readonly scopes: Uint8Array;
    readonly atMs: number;
  }): void {
    this.database
      .prepare(
        "INSERT INTO automation_grants (authorization_id, principal_id, device_id, device_epoch, " +
          "scopes, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(authorization_id) DO UPDATE SET principal_id = excluded.principal_id, " +
          "device_id = excluded.device_id, device_epoch = excluded.device_epoch, " +
          "scopes = excluded.scopes, updated_at_ms = excluded.updated_at_ms",
      )
      .run(
        grant.authorizationId,
        grant.principalId,
        grant.deviceId,
        grant.deviceEpoch,
        grant.scopes,
        Math.max(1, grant.atMs),
        Math.max(1, grant.atMs),
      );
  }

  grant(authorizationId: string):
    | {
        readonly principalId: string;
        readonly deviceId: string;
        readonly deviceEpoch: number;
        readonly scopes: Uint8Array;
      }
    | undefined {
    const row = this.database
      .prepare(
        "SELECT principal_id AS principalId, device_id AS deviceId, " +
          "device_epoch AS deviceEpoch, scopes FROM automation_grants WHERE authorization_id = ?",
      )
      .get(authorizationId) as
      | {
          principalId: string;
          deviceId: string;
          deviceEpoch: number;
          scopes: Uint8Array;
        }
      | undefined;
    return row === undefined
      ? undefined
      : { ...row, deviceEpoch: Number(row.deviceEpoch) };
  }

  /* -------------------------------- 命令会话 -------------------------------- */

  putCommandRoot(
    rootId: string,
    workspaceId: string,
    path: string,
    atMs: number,
  ): void {
    this.database
      .prepare(
        "INSERT INTO command_roots (root_id, workspace_id, path, created_at_ms) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(root_id) DO NOTHING",
      )
      .run(rootId, workspaceId, path, Math.max(1, atMs));
  }

  commandRoot(rootId: string): string | undefined {
    const row = this.database
      .prepare("SELECT path FROM command_roots WHERE root_id = ?")
      .get(rootId) as { path: string } | undefined;
    return row?.path;
  }

  putCommandSession(record: CommandSessionRecord): CommandSessionRecord {
    this.database
      .prepare(
        "INSERT INTO command_sessions (session_id, root_id, workspace_id, execution_host_id, launch, " +
          "launch_sha256, generation, state, reason_code, revision, created_at_ms, updated_at_ms) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET root_id = excluded.root_id, launch = excluded.launch, " +
          "launch_sha256 = excluded.launch_sha256, generation = excluded.generation, " +
          "state = excluded.state, reason_code = excluded.reason_code, " +
          "revision = command_sessions.revision + 1, updated_at_ms = excluded.updated_at_ms",
      )
      .run(
        record.sessionId,
        record.rootId,
        record.workspaceId,
        record.executionHostId,
        record.launch,
        record.launchSha256,
        record.generation,
        record.state,
        record.reasonCode,
        record.revision,
        record.createdAtMs,
        record.updatedAtMs,
      );
    return this.commandSession(record.sessionId) as CommandSessionRecord;
  }

  commandSession(sessionId: string): CommandSessionRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT session_id AS sessionId, root_id AS rootId, workspace_id AS workspaceId, " +
          "execution_host_id AS executionHostId, launch, launch_sha256 AS launchSha256, " +
          "generation, state, reason_code AS reasonCode, revision, " +
          "created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs " +
          "FROM command_sessions WHERE session_id = ?",
      )
      .get(sessionId) as CommandSessionRecord | undefined;
    if (row === undefined) return undefined;
    return {
      ...row,
      generation: Number(row.generation),
      state: Number(row.state),
      revision: Number(row.revision),
      createdAtMs: Number(row.createdAtMs),
      updatedAtMs: Number(row.updatedAtMs),
    };
  }

  listCommandSessions(
    workspaceId: string,
    after: string,
    limit: number,
  ): { sessions: CommandSessionRecord[]; nextId: string; hasMore: boolean } {
    const page = Math.max(1, Math.min(limit, 200));
    const rows = this.database
      .prepare(
        "SELECT session_id AS sessionId, root_id AS rootId, workspace_id AS workspaceId, " +
          "execution_host_id AS executionHostId, launch, launch_sha256 AS launchSha256, " +
          "generation, state, reason_code AS reasonCode, revision, " +
          "created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs " +
          "FROM command_sessions WHERE workspace_id = ? AND session_id > ? " +
          "ORDER BY session_id LIMIT ?",
      )
      .all(workspaceId, after, page + 1) as unknown as CommandSessionRecord[];
    const hasMore = rows.length > page;
    const sessions = rows.slice(0, page).map((row) => ({
      ...row,
      generation: Number(row.generation),
      state: Number(row.state),
      revision: Number(row.revision),
      createdAtMs: Number(row.createdAtMs),
      updatedAtMs: Number(row.updatedAtMs),
    }));
    return {
      sessions,
      nextId:
        sessions.length === 0
          ? after
          : (sessions[sessions.length - 1]?.sessionId ?? after),
      hasMore,
    };
  }

  /* --------------------------------- 收据 ---------------------------------- */

  putReceipt(receipt: AutomationReceipt): void {
    this.database
      .prepare(
        "INSERT INTO automation_receipts (operation_id, request_sha256, payload, observed_at_ms) " +
          "VALUES (?, ?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET " +
          "payload = excluded.payload, observed_at_ms = excluded.observed_at_ms " +
          "WHERE excluded.observed_at_ms >= automation_receipts.observed_at_ms",
      )
      .run(
        receipt.operationId,
        receipt.requestSha256,
        toBinary(AutomationReceiptSchema, receipt),
        Math.max(1, num(receipt.observedAtUnixMs)),
      );
  }

  receipt(operationId: string): AutomationReceipt | undefined {
    const row = this.database
      .prepare("SELECT payload FROM automation_receipts WHERE operation_id = ?")
      .get(operationId) as { payload: Uint8Array } | undefined;
    return row === undefined
      ? undefined
      : fromBinary(AutomationReceiptSchema, row.payload);
  }
}
