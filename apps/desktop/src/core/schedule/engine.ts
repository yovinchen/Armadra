import { createHash, randomBytes } from "node:crypto";
import {
  AutomationActivationSchema,
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
  AutomationOutcome,
  AutomationPlanSchema,
  AutomationPlanState,
  AutomationRunSchema,
  AutomationRunState,
  type AutomationActivation,
  type AutomationPlan,
  type AutomationPlanConfig,
  type AutomationReceipt,
  type AutomationRun,
  type AutomationTarget,
  create,
} from "./types";

import {
  ScheduleError,
  agentTarget,
  big,
  configHash,
  firstDue,
  generationPinned,
  hashText,
  invalid,
  normalize,
  num,
  preDispatch,
  terminal,
  validId,
  validTime,
  window as dueWindow,
} from "./plan";
import {
  ATTENTION_THRESHOLD,
  activationDigest,
  dispatchHash,
  equalBytes,
  noteAttention,
  outcomeState,
  receiptDigest,
} from "./digest";
import type {
  Authorization,
  Authorizer,
  Dispatcher,
  EngineOptions,
  PlanSnapshot,
  RunSnapshot,
  TargetStatus,
} from "./contracts";
import { type Snapshot, ScheduleStore, conflict } from "./store";

/**
 * 持久化的调度内核。
 *
 * 逐条移植自 合并前的实现。
 * 它不创建 PTY、不跑 shell，也不把「送到了」当成「做完了」——真正的写入由
 * {@link Dispatcher} 负责，这一层只决定「该不该写、写哪一次、结果算什么」。
 *
 * 搬过来之后唯一变的是执行模型：Go 那边一次提交要跨进程，这里 SQLite 是同步的，
 * 所以「读—判断—提交」之间没有别的代码能插进来。跨进程留下的那些 CAS 栅栏**一条
 * 没删**，因为它们同时也在挡另一件事：投递是异步的，`await` 前后的世界可以完全
 * 不同（有人暂停了计划、有人改了配置），而那正是 Go 那边反复重读再比对的理由。
 */

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 1_000;
const MAX_INT64_NUMBER = 9_223_372_036_854_775_807;

interface IntervalClock {
  readonly version: number;
  readonly activation: string;
  baseMs: number;
  baseMono: number;
}

export class ScheduleEngine {
  private readonly store: ScheduleStore;
  private readonly dispatcher: Dispatcher;
  private readonly authorizer: Authorizer;
  private readonly clock: () => number;
  private readonly monotonic: () => number;
  private readonly intervalClocks = new Map<string, IntervalClock>();
  private readonly instance: string;
  private readonly lease: number;
  private readonly dispatchTimeout: number;
  private readonly poll: number;
  readonly hostId: string;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.dispatcher = options.dispatcher;
    this.authorizer = options.authorizer;
    this.hostId = options.hostId;
    this.clock = options.clock ?? (() => Date.now());
    this.monotonic = options.monotonic ?? (() => Date.now());
    this.instance = options.instanceId ?? randomBytes(16).toString("hex");
    this.lease = options.claimLeaseMs ?? DEFAULT_LEASE_MS;
    this.dispatchTimeout =
      options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.poll = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (
      this.lease < 1_000 ||
      this.lease > 300_000 ||
      this.dispatchTimeout <= 0 ||
      this.dispatchTimeout >= this.lease ||
      this.poll < 1 ||
      this.poll > 60_000 ||
      !validId(this.instance)
    ) {
      throw invalid("调度器参数超出范围");
    }
  }

  /* -------------------------------- 生命周期 -------------------------------- */

  /** 属于 core 的生命周期，不属于某一次请求。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // 一次 tick 失败不该把定时器拆掉：下一拍重来，而失败的原因（冲突、
        // 目标暂时不在）多半就是下一拍会好的那一类。
      });
    }, this.poll);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    const value = this.clock();
    if (!validTime(value)) throw invalid("系统时钟不在合法范围内");
    return value;
  }

  /* --------------------------------- 定义 ---------------------------------- */

  /**
   * 新建或改一个计划。
   *
   * 改也走这里，靠一个精确的修订号。**每次改配置都会把计划退回草稿并作废激活
   * 记录**：人批准的是他看过的那一份配置，改完之后那份批准就不再指向任何东西。
   */
  async define(
    auth: Authorization,
    planId: string,
    config: AutomationPlanConfig,
    expectedRevision: number,
  ): Promise<PlanSnapshot> {
    if (!validId(planId)) throw invalid("计划标识不合法");
    const normalized = normalize(config);
    await this.verify(auth, normalized);
    const now = this.now();
    return this.store.transact(() => {
      let plan: AutomationPlan;
      let revision = expectedRevision;
      let activation: AutomationActivation;
      let activationRevision = 0;
      const cancellations: RunSnapshot[] = [];
      if (expectedRevision === 0) {
        plan = create(AutomationPlanSchema, {
          id: planId,
          configVersion: 1n,
          config: normalized,
          createdAtUnixMs: big(now),
        });
        activation = create(AutomationActivationSchema, {
          planId,
          hostId: this.hostId,
          principalId: auth.principalId,
        });
      } else {
        const snapshot = this.store.plan(normalized.workspaceId, planId);
        if (snapshot.revision !== expectedRevision) throw conflict();
        plan = snapshot.value;
        const stored = this.store.activation(normalized.workspaceId, planId);
        activation = stored.value;
        activationRevision = stored.revision;
        if (activation.principalId !== auth.principalId) {
          throw new ScheduleError(
            "authorization",
            "只有创建它的人能改这个计划",
          );
        }
        if (num(plan.configVersion) >= MAX_INT64_NUMBER) {
          throw invalid("配置版本用尽");
        }
        cancellations.push(
          ...this.cancelUndelivered(plan, now, "CONFIGURATION_CHANGED"),
        );
        plan.configVersion = big(num(plan.configVersion) + 1);
        plan.config = normalized;
        plan.runCount = 0n;
        revision = snapshot.revision;
      }
      if (plan.state === AutomationPlanState.DELETED) {
        throw invalid("这个计划已经删除");
      }
      plan.state = AutomationPlanState.DRAFT;
      plan.nextDueUnixMs = 0n;
      plan.activationSha256 = new Uint8Array(0);
      // 改配置就是对着一个被拒的目标做的修复动作，所以旧的连续拒绝次数不能继续
      // 给一个刚刚被换掉的目标打标记。
      plan.needsAttention = false;
      plan.attentionReasonCode = "";
      plan.attentionStreak = 0;
      plan.updatedAtUnixMs = big(Math.max(now, num(plan.updatedAtUnixMs)));
      activation.enabled = false;
      activation.planId = planId;
      activation.configVersion = plan.configVersion;
      activation.authorizationId = auth.authorizationId;
      activation.configSha256 = configHash(normalized);
      activation.activationSha256 = new Uint8Array(0);
      for (const cancelled of cancellations) {
        this.store.writeRun(cancelled.run, cancelled.revision);
      }
      const written = this.store.writePlan(plan, revision);
      this.store.writeActivation(
        normalized.workspaceId,
        activation,
        activationRevision,
      );
      return { plan, revision: written };
    });
  }

  /**
   * 激活。
   *
   * 要求调用方报出它看过的那个修订号、配置版本与摘要：对不上就是冲突，而不是
   * 「以库里的为准」——那等于替人批准了一份他没看过的配置。
   */
  async activate(
    auth: Authorization,
    workspaceId: string,
    planId: string,
    expectedRevision: number,
    configVersion: number,
    expectedHash: Uint8Array,
  ): Promise<PlanSnapshot> {
    const snapshot = this.store.plan(workspaceId, planId);
    const plan = snapshot.value;
    if (
      plan.state === AutomationPlanState.EXPIRED ||
      plan.state === AutomationPlanState.DELETED
    ) {
      throw invalid("这个计划已经结束");
    }
    const config = plan.config;
    if (config === undefined) throw invalid();
    const digest = configHash(config);
    if (
      snapshot.revision !== expectedRevision ||
      num(plan.configVersion) !== configVersion ||
      !equalBytes(expectedHash, digest)
    ) {
      throw conflict();
    }
    const stored = this.store.activation(workspaceId, planId);
    if (stored.value.principalId !== auth.principalId) {
      throw new ScheduleError("authorization", "只有创建它的人能激活这个计划");
    }
    await this.verify(auth, config);
    const now = this.now();
    if (
      (num(config.expiresAtUnixMs) !== 0 &&
        now >= num(config.expiresAtUnixMs)) ||
      (num(config.maxRuns) !== 0 && num(plan.runCount) >= num(config.maxRuns))
    ) {
      throw invalid("这个计划已经到达它的终点");
    }
    const status = await this.dispatcher.supports(
      config.target as AutomationTarget,
    );
    if (status.state === "unsupported") {
      throw new ScheduleError("unsupported", "这个目标现在用不了");
    }
    if (
      plan.state === AutomationPlanState.ACTIVE &&
      stored.value.enabled &&
      stored.value.authorizationId === auth.authorizationId &&
      this.validActivation(plan, stored.value)
    ) {
      return { plan, revision: snapshot.revision };
    }
    return this.store.transact(() => {
      const activation = create(AutomationActivationSchema, {
        planId,
        configVersion: big(configVersion),
        configSha256: digest,
        hostId: this.hostId,
        principalId: auth.principalId,
        authorizationId: auth.authorizationId,
        authorizedAtUnixMs: big(now),
        enabled: true,
      });
      activation.activationSha256 = activationDigest(activation);
      plan.activationSha256 = activation.activationSha256;
      plan.state = AutomationPlanState.ACTIVE;
      plan.updatedAtUnixMs = big(Math.max(now, num(plan.updatedAtUnixMs)));
      plan.nextDueUnixMs = big(
        firstDue(config, Math.max(now, num(plan.observedThroughUnixMs))),
      );
      if (
        config.schedule?.kind.case === "loopAfterCompletion" &&
        plan.activeRunId !== ""
      ) {
        plan.nextDueUnixMs = 0n;
      }
      const revision = this.store.writePlan(plan, snapshot.revision);
      this.store.writeActivation(workspaceId, activation, stored.revision);
      this.resetIntervalClock(
        plan,
        Math.max(now, num(plan.observedThroughUnixMs)),
      );
      return { plan, revision };
    });
  }

  async pause(
    auth: Authorization,
    workspaceId: string,
    planId: string,
    expectedRevision: number,
  ): Promise<PlanSnapshot> {
    const snapshot = this.store.plan(workspaceId, planId);
    const plan = snapshot.value;
    if (
      plan.state !== AutomationPlanState.ACTIVE &&
      plan.state !== AutomationPlanState.PAUSED
    ) {
      throw invalid("只有活动或已暂停的计划可以暂停");
    }
    if (snapshot.revision !== expectedRevision) throw conflict();
    const stored = this.store.activation(workspaceId, planId);
    if (stored.value.principalId !== auth.principalId) {
      throw new ScheduleError("authorization", "只有创建它的人能暂停这个计划");
    }
    if (plan.config === undefined) throw invalid();
    await this.verify(auth, plan.config);
    const now = this.now();
    return this.store.transact(() => {
      const cancellations = this.cancelUndelivered(plan, now, "PLAN_PAUSED");
      plan.state = AutomationPlanState.PAUSED;
      plan.nextDueUnixMs = 0n;
      plan.updatedAtUnixMs = big(Math.max(now, num(plan.updatedAtUnixMs)));
      stored.value.enabled = false;
      for (const cancelled of cancellations) {
        this.store.writeRun(cancelled.run, cancelled.revision);
      }
      const revision = this.store.writePlan(plan, snapshot.revision);
      this.store.writeActivation(workspaceId, stored.value, stored.revision);
      return { plan, revision };
    });
  }

  /**
   * 手动加一个槽位。
   *
   * 它不挪日程、不复用已排的槽位、不绕过目标闸门，也不绕过激活与授权：接下来
   * 还是那条普通的认领与投递路径在决定到底写不写。
   */
  async runNow(
    auth: Authorization,
    workspaceId: string,
    planId: string,
    expectedRevision: number,
  ): Promise<RunSnapshot> {
    const snapshot = this.store.plan(workspaceId, planId);
    if (snapshot.revision !== expectedRevision) throw conflict();
    const plan = snapshot.value;
    if (plan.state !== AutomationPlanState.ACTIVE) {
      throw invalid("只有活动的计划可以立即运行");
    }
    const stored = this.store.activation(workspaceId, planId);
    if (stored.value.principalId !== auth.principalId) {
      throw new ScheduleError("authorization", "只有创建它的人能立即运行");
    }
    const config = plan.config;
    if (config === undefined) throw invalid();
    await this.verify(auth, config);
    if (!this.validActivation(plan, stored.value)) {
      throw new ScheduleError("authorization", "激活记录已经失效");
    }
    const now = this.now();
    if (
      (num(config.maxRuns) > 0 && num(plan.runCount) >= num(config.maxRuns)) ||
      (num(config.expiresAtUnixMs) > 0 && now >= num(config.expiresAtUnixMs))
    ) {
      throw invalid("这个计划已经到达它的终点");
    }
    if (
      plan.pendingRunId !== "" ||
      (config.concurrencyPolicy === AutomationConcurrencyPolicy.FORBID &&
        plan.activeRunId !== "")
    ) {
      throw conflict();
    }
    return this.store.transact(() => {
      const slot = `manual:${now}`;
      const runId = hashText(plan.id, String(num(plan.configVersion)), slot);
      if (this.store.runOrUndefined(config.workspaceId, runId) !== undefined) {
        throw conflict();
      }
      const run = this.newRun({
        plan,
        config,
        activation: stored.value,
        runId,
        slot,
        scheduledAtMs: now,
        now,
        missedSlots: 1,
        misfire: false,
        truncated: false,
      });
      run.reasonCode = "MANUAL_RUN";
      run.requestSha256 = dispatchHash(run);
      plan.runCount = big(num(plan.runCount) + 1);
      plan.pendingRunId = runId;
      plan.updatedAtUnixMs = big(Math.max(now, num(plan.updatedAtUnixMs)));
      this.store.writePlan(plan, snapshot.revision);
      this.store.writeRun(run, 0);
      return { run, revision: 1 };
    });
  }

  /* --------------------------------- 读 ------------------------------------ */

  getPlan(workspaceId: string, planId: string): PlanSnapshot {
    if (!validId(workspaceId) || !validId(planId)) throw invalid();
    const snapshot = this.store.plan(workspaceId, planId);
    const plan = snapshot.value;
    if (
      plan.id !== planId ||
      plan.config === undefined ||
      plan.config.workspaceId !== workspaceId ||
      num(plan.configVersion) === 0
    ) {
      throw invalid("这个计划的记录已经损坏");
    }
    return { plan, revision: snapshot.revision };
  }

  getRun(workspaceId: string, runId: string): RunSnapshot {
    const snapshot = this.store.run(workspaceId, runId);
    const run = snapshot.value;
    if (
      run.id !== runId ||
      run.workspaceId !== workspaceId ||
      run.frozenConfig === undefined ||
      run.activation === undefined
    ) {
      throw invalid("这次运行的记录已经损坏");
    }
    return { run, revision: snapshot.revision };
  }

  listPlans(
    workspaceId: string,
    after: string,
    limit: number,
  ): { plans: PlanSnapshot[]; nextId: string; hasMore: boolean } {
    if (!validId(workspaceId)) throw invalid();
    const page = this.store.listPlans(workspaceId, after, limit);
    return {
      plans: page.plans.map((entry) => ({
        plan: entry.value,
        revision: entry.revision,
      })),
      nextId: page.nextId,
      hasMore: page.hasMore,
    };
  }

  listRuns(
    workspaceId: string,
    planId: string,
    after: string,
    limit: number,
  ): { runs: RunSnapshot[]; nextId: string; hasMore: boolean } {
    if (!validId(workspaceId) || !validId(planId)) throw invalid();
    // 别的计划的游标会带着调用方翻进别人的历史里，所以它是坏请求。
    if (after !== "" && !after.startsWith(`${planId}/`)) {
      throw invalid("这个游标不属于这个计划");
    }
    const page = this.store.listRuns(workspaceId, planId, after, limit);
    return {
      runs: page.runs.map((entry) => ({
        run: entry.value,
        revision: entry.revision,
      })),
      nextId: page.nextId,
      hasMore: page.hasMore,
    };
  }

  /* -------------------------------- 调度循环 -------------------------------- */

  /** 走一遍所有计划。重入直接返回：两个 tick 叠在一起没有任何好处。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const ref of this.store.everyPlanRef()) {
        try {
          await this.tickPlan(ref.workspaceId, ref.planId);
        } catch (error) {
          if (error instanceof ScheduleError && error.code === "conflict") {
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickPlan(workspaceId: string, planId: string): Promise<void> {
    let snapshot = this.getPlan(workspaceId, planId);
    let now = this.now();
    const expiry = num(snapshot.plan.config?.expiresAtUnixMs);
    if (
      expiry > 0 &&
      now >= expiry &&
      snapshot.plan.state !== AutomationPlanState.EXPIRED
    ) {
      this.expire(snapshot, now);
      snapshot = this.getPlan(workspaceId, planId);
    }
    if (snapshot.plan.pendingRunId !== "") {
      const pending = this.getRun(workspaceId, snapshot.plan.pendingRunId);
      if (
        preDispatch(pending.run.state) &&
        now >= num(pending.run.waitingExpiresAtUnixMs)
      ) {
        this.finish(
          pending,
          AutomationRunState.EXPIRED,
          "WAITING_EXPIRED",
          now,
          undefined,
        );
        snapshot = this.getPlan(workspaceId, planId);
      }
    }
    if (snapshot.plan.activeRunId !== "") {
      await this.advance(workspaceId, snapshot.plan.activeRunId);
      snapshot = this.getPlan(workspaceId, planId);
    }
    now = this.now();
    if (
      snapshot.plan.state === AutomationPlanState.ACTIVE &&
      num(snapshot.plan.config?.expiresAtUnixMs) > 0 &&
      now >= num(snapshot.plan.config?.expiresAtUnixMs)
    ) {
      this.expire(snapshot, now);
      return;
    }
    const scheduleNow = this.intervalNow(snapshot.plan, now);
    if (
      snapshot.plan.state === AutomationPlanState.ACTIVE &&
      num(snapshot.plan.nextDueUnixMs) > 0 &&
      num(snapshot.plan.nextDueUnixMs) <= scheduleNow &&
      scheduleNow >= num(snapshot.plan.observedThroughUnixMs)
    ) {
      this.materialize(snapshot, now, scheduleNow);
      snapshot = this.getPlan(workspaceId, planId);
    }
    if (
      snapshot.plan.state === AutomationPlanState.ACTIVE &&
      snapshot.plan.activeRunId === "" &&
      snapshot.plan.pendingRunId !== ""
    ) {
      const runId = snapshot.plan.pendingRunId;
      if (this.claim(snapshot, now)) await this.advance(workspaceId, runId);
    }
  }

  private expire(snapshot: PlanSnapshot, now: number): void {
    const plan = snapshot.plan;
    const workspaceId = plan.config?.workspaceId ?? "";
    this.store.transact(() => {
      const cancellations = this.cancelUndelivered(plan, now, "PLAN_EXPIRED");
      for (const cancelled of cancellations) {
        cancelled.run.state = AutomationRunState.EXPIRED;
        this.store.writeRun(cancelled.run, cancelled.revision);
      }
      plan.state = AutomationPlanState.EXPIRED;
      plan.nextDueUnixMs = 0n;
      plan.updatedAtUnixMs = big(Math.max(now, num(plan.updatedAtUnixMs)));
      const activation = this.store.activation(workspaceId, plan.id);
      activation.value.enabled = false;
      this.store.writePlan(plan, snapshot.revision);
      this.store.writeActivation(
        workspaceId,
        activation.value,
        activation.revision,
      );
    });
  }

  /** 到期的那个槽位变成一次运行。同一个槽位物化两次只会得到同一个运行标识。 */
  private materialize(
    snapshot: PlanSnapshot,
    now: number,
    scheduleNow: number,
  ): void {
    const plan = snapshot.plan;
    const config = plan.config;
    if (config === undefined) throw invalid();
    if (num(config.maxRuns) > 0 && num(plan.runCount) >= num(config.maxRuns)) {
      plan.nextDueUnixMs = 0n;
      if (plan.activeRunId === "" && plan.pendingRunId === "") {
        plan.state = AutomationPlanState.EXPIRED;
      }
      this.store.writePlan(plan, snapshot.revision);
      return;
    }
    const activation = this.store.activation(config.workspaceId, plan.id);
    if (!this.validActivation(plan, activation.value)) {
      throw new ScheduleError("authorization", "激活记录已经失效");
    }
    const w = dueWindow(plan, scheduleNow);
    const runId = hashText(plan.id, String(num(plan.configVersion)), w.slot);
    const existing = this.store.runOrUndefined(config.workspaceId, runId);
    plan.nextDueUnixMs = big(w.next);
    plan.observedThroughUnixMs = big(
      Math.max(scheduleNow, num(plan.observedThroughUnixMs)),
    );
    plan.updatedAtUnixMs = big(Math.max(now, num(plan.updatedAtUnixMs)));
    if (existing !== undefined) {
      if (
        existing.value.id !== runId ||
        existing.value.planId !== plan.id ||
        existing.value.workspaceId !== config.workspaceId ||
        num(existing.value.configVersion) !== num(plan.configVersion) ||
        existing.value.scheduledSlot !== w.slot
      ) {
        throw invalid("同一个槽位上挂着另一次运行");
      }
      this.store.writePlan(plan, snapshot.revision);
      return;
    }
    this.store.transact(() => {
      const run = this.newRun({
        plan,
        config,
        activation: activation.value,
        runId,
        slot: w.slot,
        scheduledAtMs: w.at,
        now,
        missedSlots: w.count,
        misfire: w.misfire,
        truncated: w.truncated,
      });
      if (w.misfire && config.misfirePolicy === AutomationMisfirePolicy.SKIP) {
        run.state = AutomationRunState.SKIPPED;
        run.reasonCode = "MISFIRE_SKIPPED";
        if (config.schedule?.kind.case === "once") {
          run.state = AutomationRunState.EXPIRED;
          run.reasonCode = "ONCE_EXPIRED";
        }
      }
      if (
        run.state === AutomationRunState.DUE &&
        ((config.concurrencyPolicy === AutomationConcurrencyPolicy.FORBID &&
          plan.activeRunId !== "") ||
          plan.pendingRunId !== "")
      ) {
        run.state = AutomationRunState.SKIPPED;
        run.reasonCode = "CONCURRENCY_LIMIT";
      }
      if (run.state === AutomationRunState.DUE) {
        if (num(plan.runCount) >= MAX_INT64_NUMBER)
          throw invalid("运行次数用尽");
        plan.runCount = big(num(plan.runCount) + 1);
        plan.pendingRunId = runId;
      } else {
        run.completedAtUnixMs = big(now);
        if (config.schedule?.kind.case === "once") {
          plan.state = AutomationPlanState.EXPIRED;
        }
        if (config.schedule?.kind.case === "loopAfterCompletion") {
          plan.state = AutomationPlanState.PAUSED;
        }
      }
      run.requestSha256 = dispatchHash(run);
      this.store.writePlan(plan, snapshot.revision);
      this.store.writeRun(run, 0);
    });
  }

  private newRun(input: {
    plan: AutomationPlan;
    config: AutomationPlanConfig;
    activation: AutomationActivation;
    runId: string;
    slot: string;
    scheduledAtMs: number;
    now: number;
    missedSlots: number;
    misfire: boolean;
    truncated: boolean;
  }): AutomationRun {
    const run = create(AutomationRunSchema, {
      id: input.runId,
      planId: input.plan.id,
      workspaceId: input.config.workspaceId,
      configVersion: input.plan.configVersion,
      scheduledSlot: input.slot,
      scheduledAtUnixMs: big(input.scheduledAtMs),
      misfire: input.misfire,
      missedSlots: big(input.missedSlots),
      missedSlotsTruncated: input.truncated,
      frozenConfig: input.config,
      activation: input.activation,
      state: AutomationRunState.DUE,
      createdAtUnixMs: big(input.now),
      updatedAtUnixMs: big(input.now),
      waitingExpiresAtUnixMs: big(input.now + num(input.config.busyTtlMs)),
    });
    run.operationId = `automation/${input.activation.principalId}/host-${this.hostId}/${input.config.workspaceId}/dispatch/${input.runId}`;
    run.requestSha256 = dispatchHash(run);
    return run;
  }

  /** 占住目标闸门。占不住的那个进入等待，而不是失败。 */
  private claim(snapshot: PlanSnapshot, now: number): boolean {
    const plan = snapshot.plan;
    const workspaceId = plan.config?.workspaceId ?? "";
    const run = this.getRun(workspaceId, plan.pendingRunId);
    if (!this.validRun(run.run) || !preDispatch(run.run.state)) {
      throw invalid("待投递的运行记录已经损坏");
    }
    if (now >= num(run.run.waitingExpiresAtUnixMs)) {
      this.finish(
        run,
        AutomationRunState.EXPIRED,
        "WAITING_EXPIRED",
        now,
        undefined,
      );
      return false;
    }
    if (
      num(run.run.configVersion) !== num(plan.configVersion) ||
      !equalBytes(
        run.run.activation?.activationSha256 ?? new Uint8Array(0),
        plan.activationSha256,
      )
    ) {
      this.finish(
        run,
        AutomationRunState.CANCELLED,
        "STALE_ACTIVATION",
        now,
        undefined,
      );
      return false;
    }
    const target = run.run.frozenConfig?.target as AutomationTarget;
    const gate = this.store.gate(target);
    if (gate.value.active !== undefined) {
      if (run.run.state === AutomationRunState.WAITING_TARGET) return false;
      run.run.state = AutomationRunState.WAITING_TARGET;
      run.run.reasonCode = "TARGET_GATE_BUSY";
      run.run.updatedAtUnixMs = big(now);
      this.store.writeRun(run.run, run.revision);
      return false;
    }
    return this.store.transact(() => {
      gate.value.active = {
        runId: run.run.id,
        planId: plan.id,
        workspaceId,
      };
      run.run.state = AutomationRunState.CLAIMED;
      run.run.claimOwner = this.instance;
      run.run.leaseUntilUnixMs = big(now + this.lease);
      run.run.updatedAtUnixMs = big(now);
      plan.activeRunId = run.run.id;
      plan.pendingRunId = "";
      this.store.writePlan(plan, snapshot.revision);
      this.store.writeRun(run.run, run.revision);
      this.store.writeGate(target, gate.value, gate.revision);
      return true;
    });
  }

  /**
   * 把一次已认领的运行往前推一步：续租、核对、探测、投递、收下收据。
   *
   * 每一次 `await` 之后都重读一遍再比对，因为那期间有人可能暂停了计划或者改了
   * 配置。Go 那边这么写是因为跨进程；这里保留，是因为异步投递同样让 `await`
   * 前后的世界可以不一样。
   */
  private async advance(workspaceId: string, runId: string): Promise<void> {
    let run = this.getRun(workspaceId, runId);
    if (terminal(run.run.state)) return;
    if (!this.validRun(run.run)) throw invalid("这次运行的记录已经损坏");
    let now = this.now();
    if (
      run.run.claimOwner !== this.instance &&
      num(run.run.leaseUntilUnixMs) > now
    ) {
      return;
    }
    // 在飞的那次投递在租约结束前一直拥有这个边界。
    if (
      run.run.state === AutomationRunState.DISPATCHING &&
      num(run.run.leaseUntilUnixMs) > now
    ) {
      return;
    }
    if (
      run.run.claimOwner !== this.instance ||
      num(run.run.leaseUntilUnixMs) <= now + this.lease / 2
    ) {
      run.run.claimOwner = this.instance;
      run.run.leaseUntilUnixMs = big(now + this.lease);
      run.run.updatedAtUnixMs = big(
        Math.max(now, num(run.run.updatedAtUnixMs)),
      );
      const revision = this.store.writeRun(run.run, run.revision);
      run = { run: run.run, revision };
    }
    if (!preDispatch(run.run.state)) {
      const receipt = await this.withTimeout(
        this.dispatcher.lookup(run.run),
      ).catch(() => undefined);
      if (receipt === undefined) {
        this.markUnknown(run, "LOOKUP_UNAVAILABLE");
        return;
      }
      this.receive(run, receipt);
      return;
    }
    if (now < num(run.run.nextAttemptUnixMs)) return;
    const planSnapshot = this.getPlan(workspaceId, run.run.planId);
    const activation = this.store.activation(workspaceId, planSnapshot.plan.id);
    if (planSnapshot.plan.activeRunId !== runId) return;
    if (
      planSnapshot.plan.state !== AutomationPlanState.ACTIVE ||
      num(run.run.configVersion) !== num(planSnapshot.plan.configVersion) ||
      !this.validActivation(planSnapshot.plan, activation.value) ||
      !equalBytes(
        run.run.activation?.activationSha256 ?? new Uint8Array(0),
        activation.value.activationSha256,
      )
    ) {
      this.finish(
        run,
        AutomationRunState.CANCELLED,
        "STALE_ACTIVATION",
        now,
        undefined,
      );
      return;
    }
    if (now >= num(run.run.waitingExpiresAtUnixMs)) {
      this.finish(
        run,
        AutomationRunState.EXPIRED,
        "WAITING_EXPIRED",
        now,
        undefined,
      );
      return;
    }
    const auth: Authorization = {
      principalId: activation.value.principalId,
      authorizationId: activation.value.authorizationId,
    };
    const frozen = run.run.frozenConfig as AutomationPlanConfig;
    try {
      await this.verify(auth, frozen);
    } catch {
      this.invalidate(planSnapshot, now);
      return;
    }
    let status: TargetStatus;
    try {
      status = await this.withTimeout(
        this.dispatcher.supports(frozen.target as AutomationTarget),
      );
    } catch {
      status = { state: "unknown", generation: 0 };
    }
    if (status.state === "busy" || status.state === "unknown") {
      if (run.run.state === AutomationRunState.WAITING_TARGET) return;
      run.run.state = AutomationRunState.WAITING_TARGET;
      run.run.reasonCode = "TARGET_NOT_IDLE";
      this.store.writeRun(run.run, run.revision);
      return;
    }
    if (status.state === "offline") {
      this.finish(
        run,
        AutomationRunState.SKIPPED,
        "TARGET_OFFLINE",
        now,
        undefined,
      );
      return;
    }
    if (status.state === "unsupported") {
      this.finish(
        run,
        AutomationRunState.SKIPPED,
        "TARGET_UNSUPPORTED",
        now,
        undefined,
      );
      return;
    }
    // 命令目标钉在冻结的那个代数上：换一个就是换了一个进程，不许写进去。
    // Agent 目标钉不住，假装钉得住比没有还糟——那个会话的生命周期归终端域管，
    // 身份因此是节点加上冻结的定义，写入的时候再核一次。
    if (
      generationPinned(frozen.target as AutomationTarget) &&
      status.generation !== num(frozen.target?.generation)
    ) {
      this.finish(
        run,
        AutomationRunState.SKIPPED,
        "STALE_GENERATION",
        now,
        undefined,
      );
      return;
    }
    // 探测与授权都要等，期间暂停/改配置可能已经把这一条取消了。重读再比对。
    const latest = this.getPlan(workspaceId, planSnapshot.plan.id);
    const fresh = this.getRun(workspaceId, runId);
    if (
      latest.plan.state !== AutomationPlanState.ACTIVE ||
      latest.plan.activeRunId !== runId ||
      num(latest.plan.configVersion) !== num(run.run.configVersion) ||
      !equalBytes(
        latest.plan.activationSha256,
        run.run.activation?.activationSha256 ?? new Uint8Array(0),
      ) ||
      fresh.revision !== run.revision ||
      !preDispatch(fresh.run.state) ||
      fresh.run.claimOwner !== this.instance
    ) {
      return;
    }
    now = this.now();
    if (
      num(latest.plan.config?.expiresAtUnixMs) > 0 &&
      now >= num(latest.plan.config?.expiresAtUnixMs)
    ) {
      this.expire(latest, now);
      return;
    }
    if (
      now >= num(fresh.run.leaseUntilUnixMs) ||
      now >= num(fresh.run.waitingExpiresAtUnixMs)
    ) {
      return;
    }
    fresh.run.state = AutomationRunState.DISPATCHING;
    fresh.run.dispatchAttempts += 1;
    fresh.run.updatedAtUnixMs = big(
      Math.max(now, num(fresh.run.updatedAtUnixMs)),
    );
    // 计划那条空写是一次刻意的 CAS 栅栏，挡住「读完到写下 DISPATCHING 之间的
    // 暂停或改配置」。过了这一行就是在飞。
    const dispatching = this.store.transact(() => {
      const revision = this.store.writeRun(fresh.run, fresh.revision);
      this.store.writePlan(latest.plan, latest.revision);
      return revision;
    });
    const inFlight: RunSnapshot = { run: fresh.run, revision: dispatching };
    let receipt: AutomationReceipt | undefined;
    try {
      receipt = await this.withTimeout(this.dispatcher.dispatch(fresh.run));
    } catch {
      receipt = undefined;
    }
    if (receipt === undefined) {
      this.markUnknown(inFlight, "DISPATCH_OUTCOME_UNKNOWN");
      return;
    }
    this.receive(inFlight, receipt);
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new ScheduleError("unsupported", "投递超时")),
          this.dispatchTimeout,
        );
        timer.unref?.();
      }),
    ]);
  }

  private invalidate(snapshot: PlanSnapshot, now: number): void {
    const plan = snapshot.plan;
    const workspaceId = plan.config?.workspaceId ?? "";
    this.store.transact(() => {
      const cancellations = this.cancelUndelivered(
        plan,
        now,
        "AUTHORIZATION_REVOKED",
      );
      for (const cancelled of cancellations) {
        this.store.writeRun(cancelled.run, cancelled.revision);
      }
      const activation = this.store.activation(workspaceId, plan.id);
      activation.value.enabled = false;
      plan.state = AutomationPlanState.DRAFT;
      plan.activationSha256 = new Uint8Array(0);
      plan.nextDueUnixMs = 0n;
      this.store.writePlan(plan, snapshot.revision);
      this.store.writeActivation(
        workspaceId,
        activation.value,
        activation.revision,
      );
    });
  }

  /* --------------------------------- 收据 ---------------------------------- */

  /**
   * 收下一张可信的、对得上号的执行方事件。
   *
   * 浏览器端的调用方无法凭一条未经核对的「done」信号造出一次成功的运行：收据要
   * 对得上操作标识、请求摘要和序号，否则它就不是这次投递的收据。
   */
  observe(receipt: AutomationReceipt): void {
    const found = this.store.runByOperation(receipt.operationId);
    if (found === undefined)
      throw new ScheduleError("notFound", "没有这次投递");
    this.receive({ run: found.value, revision: found.revision }, receipt);
  }

  private receive(snapshot: RunSnapshot, receipt: AutomationReceipt): void {
    try {
      this.applyReceipt(snapshot, receipt);
    } catch (error) {
      if (error instanceof ScheduleError && error.code === "receipt") {
        this.markUnknown(snapshot, "INVALID_RECEIPT");
        return;
      }
      throw error;
    }
  }

  private applyReceipt(
    snapshot: RunSnapshot,
    receipt: AutomationReceipt,
  ): void {
    const run = snapshot.run;
    if (
      !this.validRun(run) ||
      receipt.operationId !== run.operationId ||
      !equalBytes(receipt.requestSha256, run.requestSha256) ||
      num(receipt.sequence) === 0 ||
      !validTime(num(receipt.observedAtUnixMs)) ||
      !/^[A-Z0-9_]{0,64}$/.test(receipt.reasonCode) ||
      run.dispatchAttempts === 0
    ) {
      throw new ScheduleError("receipt", "这张收据不属于这次投递");
    }
    const digest = receiptDigest(receipt);
    if (num(receipt.sequence) < num(run.receiptSequence)) return;
    if (num(receipt.sequence) === num(run.receiptSequence)) {
      if (equalBytes(digest, run.receiptSha256)) return;
      throw new ScheduleError("receipt", "同一个序号上有两张不同的收据");
    }
    const state = outcomeState(receipt.outcome);
    if (terminal(run.state)) {
      if (state === run.state) return;
      throw new ScheduleError("receipt", "这次运行已经结束了");
    }
    if (
      state === undefined &&
      receipt.outcome !== AutomationOutcome.NOT_DISPATCHED
    ) {
      throw new ScheduleError("receipt", "未知的结果");
    }
    if (
      run.state === AutomationRunState.RUNNING &&
      state === AutomationRunState.DELIVERED
    ) {
      throw new ScheduleError("receipt", "已经在跑的运行不会退回「已送达」");
    }
    if (
      run.state === AutomationRunState.DELIVERED ||
      run.state === AutomationRunState.RUNNING
    ) {
      run.deliveryObserved = true;
    }
    if (
      receipt.outcome === AutomationOutcome.NOT_DISPATCHED &&
      run.deliveryObserved
    ) {
      throw new ScheduleError("receipt", "已经观察到送达，不能再声称没投递");
    }
    if (
      state === AutomationRunState.DELIVERED ||
      state === AutomationRunState.RUNNING ||
      state === AutomationRunState.SUCCEEDED
    ) {
      run.deliveryObserved = true;
    }
    run.receiptSequence = receipt.sequence;
    run.receiptSha256 = digest;
    const now = this.now();
    run.updatedAtUnixMs = big(Math.max(now, num(run.updatedAtUnixMs)));
    if (receipt.outcome === AutomationOutcome.NOT_DISPATCHED) {
      // 只有肯定的「没有产生任何效果」才是可以安全重试的那种失败。
      if (run.dispatchAttempts <= (run.frozenConfig?.safeRetryLimit ?? 0)) {
        run.state = AutomationRunState.CLAIMED;
        run.nextAttemptUnixMs = big(
          now + num(run.frozenConfig?.retryBackoffMs),
        );
        run.reasonCode = "NO_EFFECT_RETRY_PENDING";
        this.store.writeRun(run, snapshot.revision);
        return;
      }
      this.finish(
        snapshot,
        AutomationRunState.FAILED,
        "NO_EFFECT_RETRY_EXHAUSTED",
        num(receipt.observedAtUnixMs),
        receipt,
      );
      return;
    }
    if (state !== undefined && terminal(state)) {
      this.finish(
        snapshot,
        state,
        receipt.reasonCode,
        num(receipt.observedAtUnixMs),
        receipt,
      );
      return;
    }
    run.state = state ?? AutomationRunState.UNKNOWN;
    run.reasonCode = receipt.reasonCode;
    this.store.writeRun(run, snapshot.revision);
  }

  private markUnknown(snapshot: RunSnapshot, reason: string): void {
    const run = snapshot.run;
    if (run.state === AutomationRunState.UNKNOWN && run.reasonCode === reason) {
      return;
    }
    const now = this.now();
    if (
      run.state === AutomationRunState.DELIVERED ||
      run.state === AutomationRunState.RUNNING
    ) {
      run.deliveryObserved = true;
    }
    run.state = AutomationRunState.UNKNOWN;
    run.reasonCode = reason;
    run.updatedAtUnixMs = big(Math.max(now, num(run.updatedAtUnixMs)));
    // 闸门不放。结果不明的投递从来不会让一个目标重新变得可用。
    this.store.writeRun(run, snapshot.revision);
  }

  /** 结束一次运行：放闸门、收尾计划、记下「需要处理」。 */
  private finish(
    snapshot: RunSnapshot,
    state: AutomationRunState,
    reason: string,
    atMs: number,
    receipt: AutomationReceipt | undefined,
  ): void {
    const run = snapshot.run;
    if (!terminal(state)) throw invalid("这不是一个终止状态");
    const now = this.now();
    const planSnapshot = this.getPlan(run.workspaceId, run.planId);
    const plan = planSnapshot.plan;
    this.store.transact(() => {
      const wasActive = plan.activeRunId === run.id;
      if (wasActive) {
        const target = run.frozenConfig?.target as AutomationTarget;
        const gate = this.store.gate(target);
        if (
          gate.value.active === undefined ||
          gate.value.active.runId !== run.id ||
          gate.value.active.workspaceId !== run.workspaceId
        ) {
          throw invalid("目标闸门上挂着另一次运行");
        }
        gate.value.active = undefined;
        this.store.writeGate(target, gate.value, gate.revision);
        plan.activeRunId = "";
      }
      if (plan.pendingRunId === run.id) plan.pendingRunId = "";
      run.state = state;
      run.reasonCode = reason;
      run.completedAtUnixMs = big(atMs);
      run.updatedAtUnixMs = big(Math.max(now, atMs, num(run.updatedAtUnixMs)));
      run.leaseUntilUnixMs = 0n;
      if (receipt !== undefined) {
        run.receiptSequence = receipt.sequence;
        run.receiptSha256 = receiptDigest(receipt);
      }
      if (num(run.configVersion) === num(plan.configVersion)) {
        noteAttention(plan, run, state, reason);
      }
      const config = plan.config;
      if (
        config !== undefined &&
        plan.state === AutomationPlanState.ACTIVE &&
        num(run.configVersion) === num(plan.configVersion)
      ) {
        const loop = config.schedule?.kind;
        if (loop?.case === "loopAfterCompletion") {
          const completed =
            state === AutomationRunState.SUCCEEDED ||
            (state === AutomationRunState.FAILED &&
              (receipt === undefined ||
                receipt.outcome === AutomationOutcome.FAILED));
          if (wasActive && completed) {
            plan.nextDueUnixMs = big(atMs + num(loop.value.delayMs));
          } else {
            plan.state = AutomationPlanState.PAUSED;
            plan.nextDueUnixMs = 0n;
          }
        }
        if (config.schedule?.kind.case === "once") {
          plan.state = AutomationPlanState.EXPIRED;
          plan.nextDueUnixMs = 0n;
        }
        if (
          ((num(config.maxRuns) > 0 &&
            num(plan.runCount) >= num(config.maxRuns)) ||
            (num(config.expiresAtUnixMs) > 0 &&
              Math.max(now, atMs) >= num(config.expiresAtUnixMs))) &&
          plan.activeRunId === "" &&
          plan.pendingRunId === ""
        ) {
          plan.state = AutomationPlanState.EXPIRED;
          plan.nextDueUnixMs = 0n;
        }
      }
      plan.updatedAtUnixMs = big(
        Math.max(now, atMs, num(plan.updatedAtUnixMs)),
      );
      this.store.writeRun(run, snapshot.revision);
      this.store.writePlan(plan, planSnapshot.revision);
    });
  }

  /**
   * 暂停与改配置在投递边界之前取消排着的那次。
   *
   * 它**不**终止已经送达/在跑/结果不明的工作，也不抹掉它占着的闸门：那次写入已经
   * 发生了，抹掉记录不会让它没发生。
   */
  private cancelUndelivered(
    plan: AutomationPlan,
    now: number,
    reason: string,
  ): RunSnapshot[] {
    const workspaceId = plan.config?.workspaceId ?? "";
    const updates: RunSnapshot[] = [];
    for (const runId of [plan.pendingRunId, plan.activeRunId]) {
      if (runId === "") continue;
      const snapshot = this.getRun(workspaceId, runId);
      if (!preDispatch(snapshot.run.state)) continue;
      snapshot.run.state = AutomationRunState.CANCELLED;
      snapshot.run.reasonCode = reason;
      snapshot.run.completedAtUnixMs = big(now);
      snapshot.run.updatedAtUnixMs = big(now);
      snapshot.run.leaseUntilUnixMs = 0n;
      updates.push(snapshot);
      if (plan.pendingRunId === runId) plan.pendingRunId = "";
      if (plan.activeRunId === runId) {
        plan.activeRunId = "";
        const target = snapshot.run.frozenConfig?.target as AutomationTarget;
        const gate = this.store.gate(target);
        if (
          gate.value.active === undefined ||
          gate.value.active.runId !== runId
        ) {
          throw invalid("目标闸门上挂着另一次运行");
        }
        gate.value.active = undefined;
        this.store.writeGate(target, gate.value, gate.revision);
      }
    }
    return updates;
  }

  /* -------------------------------- 校验与时钟 ------------------------------ */

  private async verify(
    auth: Authorization,
    config: AutomationPlanConfig,
  ): Promise<void> {
    if (!validId(auth.principalId) || !validId(auth.authorizationId)) {
      throw new ScheduleError("authorization", "授权身份不合法");
    }
    try {
      await this.withTimeout(this.authorizer.verify(auth, config));
    } catch {
      throw new ScheduleError("authorization", "这次授权已经不成立");
    }
  }

  validActivation(
    plan: AutomationPlan,
    activation: AutomationActivation,
  ): boolean {
    const config = plan.config;
    if (config === undefined) return false;
    return (
      activation.enabled &&
      activation.hostId === this.hostId &&
      activation.planId === plan.id &&
      num(activation.configVersion) === num(plan.configVersion) &&
      equalBytes(activation.configSha256, configHash(config)) &&
      equalBytes(activationDigest(activation), activation.activationSha256) &&
      equalBytes(plan.activationSha256, activation.activationSha256)
    );
  }

  validRun(run: AutomationRun): boolean {
    return (
      run.frozenConfig !== undefined &&
      run.frozenConfig.target !== undefined &&
      run.activation !== undefined &&
      run.activation.hostId === this.hostId &&
      run.activation.planId === run.planId &&
      num(run.activation.configVersion) === num(run.configVersion) &&
      run.frozenConfig.workspaceId === run.workspaceId &&
      equalBytes(dispatchHash(run), run.requestSha256)
    );
  }

  /**
   * 间隔计划的进程内时间线只前进，不后退。
   *
   * 持久化的锚点仍然决定槽位标识；墙上时钟往前跳一次只形成一个错过窗口。这份缓存
   * 不是执行的依据：重启丢掉它之后从持久的 UTC 游标恢复，永远不会让一个已经记下
   * 的槽位复活。
   */
  private intervalNow(plan: AutomationPlan, wallMs: number): number {
    const key = `${plan.config?.workspaceId ?? ""}/${plan.id}`;
    if (
      plan.state !== AutomationPlanState.ACTIVE ||
      plan.config?.schedule?.kind.case !== "interval" ||
      num(plan.nextDueUnixMs) === 0
    ) {
      this.intervalClocks.delete(key);
      return wallMs;
    }
    const mono = this.monotonic();
    const version = num(plan.configVersion);
    const activation = Buffer.from(plan.activationSha256).toString("hex");
    let mapping = this.intervalClocks.get(key);
    if (
      mapping === undefined ||
      mapping.version !== version ||
      mapping.activation !== activation
    ) {
      mapping = { version, activation, baseMs: wallMs, baseMono: mono };
    }
    const elapsed = Math.max(0, mono - mapping.baseMono);
    let projected = Math.min(253_402_300_799_999, mapping.baseMs + elapsed);
    if (wallMs > projected) {
      mapping.baseMs = wallMs;
      mapping.baseMono = mono;
      projected = wallMs;
    }
    this.intervalClocks.set(key, mapping);
    return Math.max(wallMs, projected);
  }

  private resetIntervalClock(plan: AutomationPlan, wallMs: number): void {
    if (plan.config?.schedule?.kind.case !== "interval") return;
    this.intervalClocks.set(`${plan.config.workspaceId}/${plan.id}`, {
      version: num(plan.configVersion),
      activation: Buffer.from(plan.activationSha256).toString("hex"),
      baseMs: wallMs,
      baseMono: this.monotonic(),
    });
  }
}

export type {
  Authorization,
  Authorizer,
  Dispatcher,
  EngineOptions,
  PlanSnapshot,
  RunSnapshot,
  TargetState,
  TargetStatus,
} from "./contracts";
export {
  ATTENTION_THRESHOLD,
  activationDigest,
  dispatchHash,
  equalBytes,
} from "./digest";
export { agentTarget };
