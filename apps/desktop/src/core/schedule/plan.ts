import {
  AutomationColdStartPolicy,
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
  AutomationPlanConfigSchema,
  AutomationPlanState,
  AutomationRunState,
  AutomationTargetKind,
  type AutomationPlan,
  type AutomationPlanConfig,
  type AutomationTarget,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import { createHash } from "node:crypto";

import { MAX_TIMESTAMP_MS, nextCron, parseCron } from "./cron";

/**
 * 计划配置的归一化、首次到期、以及一次 tick 该物化哪个槽位。
 *
 * 移植自 `apps/host/internal/automation/schedule.go` 与 `plans.go` 的校验部分。
 * 载荷仍然是 protobuf 的 `AutomationPlanConfig`：配置摘要因此和 Go 算出来的逐
 * 字节相同，旧 `host.db` 里已经激活的计划搬过来之后不用重新授权，
 * `packages/host-client` 发的字节也不用翻译。
 *
 * 归一化是**幂等**的：存进去的配置会被再归一化一次来算摘要，所以「把未指定填成
 * 默认值」这件事做两遍必须得到同一份字节。
 */

export const SCHEDULE_ERRORS = {
  invalid: "invalid",
  authorization: "authorization",
  unsupported: "unsupported",
  conflict: "conflict",
  notFound: "notFound",
  receipt: "receipt",
} as const;

export type ScheduleErrorCode =
  (typeof SCHEDULE_ERRORS)[keyof typeof SCHEDULE_ERRORS];

/** 域内唯一的失败类型。HTTP 与 RPC 两张面各自把它翻成自己的错误码。 */
export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

export const invalid = (why = "配置不合法"): ScheduleError =>
  new ScheduleError("invalid", why);

/* --------------------------------- 小工具 --------------------------------- */

export const num = (value: bigint | number | undefined): number =>
  value === undefined ? 0 : Number(value);
export const big = (value: number | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(Math.trunc(value));

/** 控制字符一个都不许有：它们会在终端里被当成转义序列的一部分。 */
export function validText(
  value: string,
  limit: number,
  empty: boolean,
): boolean {
  if ((!empty && value === "") || value.length > limit) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function validId(value: string): boolean {
  return validText(value, 128, false) && !/[/\\ \t]/.test(value);
}

export function validTime(value: number): boolean {
  return value > 0 && value <= MAX_TIMESTAMP_MS;
}

export function configHash(config: AutomationPlanConfig): Buffer {
  return createHash("sha256")
    .update(toBinary(AutomationPlanConfigSchema, config))
    .digest();
}

/** 先归一化再算摘要——一份没归一化的配置算出来的是另一个数。 */
export function configurationHash(config: AutomationPlanConfig): Buffer {
  return configHash(normalize(config));
}

export function agentTarget(target: AutomationTarget | undefined): boolean {
  return target?.kind === AutomationTargetKind.AGENT_SESSION_PROMPT;
}

/**
 * 这次投递要不要求代数完全一致。
 *
 * 只有命令目标要：它钉在这个 core 冻结的那一个会话上，换一个代数就是换了一个
 * 进程。Agent 目标不能要——重启或者一次获授权的冷启动会合法地换掉会话，身份因
 * 此是节点加上冻结的那份定义，写入的时候再核一次。
 */
export function generationPinned(target: AutomationTarget): boolean {
  return !agentTarget(target);
}

/** 闸门按什么键。命令目标按会话，Agent 目标按节点。 */
export function gateIdentity(target: AutomationTarget): {
  readonly sessionId: string;
  readonly nodeId: string;
} {
  return agentTarget(target)
    ? { sessionId: "", nodeId: target.nodeId }
    : { sessionId: target.sessionId, nodeId: "" };
}

export function hashText(...parts: readonly string[]): string {
  let wire = "";
  for (const part of parts) wire += `${part.length}:${part}`;
  return createHash("sha256").update(wire).digest("hex");
}

export function gateId(target: AutomationTarget): string {
  const { sessionId, nodeId } = gateIdentity(target);
  return hashText(target.executionHostId, sessionId, nodeId);
}

/* -------------------------------- 归一化 ---------------------------------- */

function normalizeTarget(target: AutomationTarget): void {
  if (target.kind === AutomationTargetKind.UNSPECIFIED) {
    target.kind = AutomationTargetKind.NON_INTERACTIVE_COMMAND;
  }
  if (target.kind === AutomationTargetKind.NON_INTERACTIVE_COMMAND) {
    // 命令目标没有节点也没有启动定义：执行方从一份已经冻结的会话里起一个新
    // 进程，没有什么可以冷启动。归一成 SKIP 让这件事幂等。
    if (
      target.nodeId !== "" ||
      target.agentLaunch !== undefined ||
      target.coldStartPolicy === AutomationColdStartPolicy.LAUNCH_FROZEN
    ) {
      throw invalid("命令目标不能带节点或启动定义");
    }
    if (!validId(target.sessionId) || num(target.generation) === 0) {
      throw invalid("命令目标必须指明会话与代数");
    }
    target.coldStartPolicy = AutomationColdStartPolicy.SKIP;
    return;
  }
  if (target.kind !== AutomationTargetKind.AGENT_SESSION_PROMPT) {
    throw invalid("未知的目标类别");
  }
  const launch = target.agentLaunch;
  if (
    !validId(target.nodeId) ||
    launch === undefined ||
    !validText(launch.agentId, 128, false)
  ) {
    throw invalid("Agent 目标必须指明节点与冻结的定义");
  }
  // 会话与代数是「这个计划当初对着什么写的」，两个都可以缺：一个计划可以合法
  // 地写给一个还没起 Agent 的节点。
  if (target.sessionId !== "" && !validId(target.sessionId)) {
    throw invalid("Agent 目标的会话标识不合法");
  }
  if (launch.accountId !== "" && launch.accountId !== "default") {
    throw invalid("只支持默认账户");
  }
  if (
    launch.args.length > 64 ||
    !validText(launch.workingDirectory, 4096, true) ||
    !validText(launch.permissionMode, 64, true) ||
    !validText(launch.modelId, 128, true)
  ) {
    throw invalid("Agent 启动定义超出界限");
  }
  for (const argument of launch.args) {
    if (!validText(argument, 4096, true)) throw invalid("参数不合法");
  }
  launch.accountId = "default";
  if (target.coldStartPolicy === AutomationColdStartPolicy.UNSPECIFIED) {
    target.coldStartPolicy = AutomationColdStartPolicy.SKIP;
  }
  if (
    target.coldStartPolicy !== AutomationColdStartPolicy.SKIP &&
    target.coldStartPolicy !== AutomationColdStartPolicy.LAUNCH_FROZEN
  ) {
    throw invalid("未知的冷启动策略");
  }
}

const MAX_INT64 = 9_223_372_036_854_775_807n;

export function normalize(input: AutomationPlanConfig): AutomationPlanConfig {
  // protobuf-es 没有 `clone`：走一遍字节就是最诚实的深拷贝，而且顺带证明这份
  // 配置真的能编码——一份编不出字节的配置算不出摘要，也就激活不了。
  const config = fromBinary(
    AutomationPlanConfigSchema,
    toBinary(AutomationPlanConfigSchema, input),
  );
  if (
    !validId(config.workspaceId) ||
    !validText(config.title, 256, false) ||
    config.target === undefined ||
    !validId(config.target.executionHostId) ||
    config.target.generation > MAX_INT64 ||
    !validText(config.payloadRef, 256, false) ||
    config.payloadSha256.length !== 32 ||
    config.schedule === undefined ||
    config.maxRuns > MAX_INT64 ||
    num(config.expiresAtUnixMs) < 0 ||
    num(config.expiresAtUnixMs) > MAX_TIMESTAMP_MS ||
    config.safeRetryLimit > 3
  ) {
    throw invalid();
  }
  normalizeTarget(config.target);
  if (config.misfirePolicy === AutomationMisfirePolicy.UNSPECIFIED) {
    config.misfirePolicy = AutomationMisfirePolicy.SKIP;
  }
  if (
    config.misfirePolicy !== AutomationMisfirePolicy.SKIP &&
    config.misfirePolicy !== AutomationMisfirePolicy.COALESCE_ONE
  ) {
    throw invalid("未知的错过窗口策略");
  }
  if (config.concurrencyPolicy === AutomationConcurrencyPolicy.UNSPECIFIED) {
    config.concurrencyPolicy = AutomationConcurrencyPolicy.FORBID;
  }
  if (
    config.concurrencyPolicy !== AutomationConcurrencyPolicy.FORBID &&
    config.concurrencyPolicy !== AutomationConcurrencyPolicy.QUEUE_ONE
  ) {
    throw invalid("未知的并发策略");
  }
  if (num(config.misfireGraceMs) === 0) config.misfireGraceMs = 60_000n;
  if (num(config.busyTtlMs) === 0) config.busyTtlMs = 300_000n;
  if (num(config.retryBackoffMs) === 0) config.retryBackoffMs = 1_000n;
  const grace = num(config.misfireGraceMs);
  const busy = num(config.busyTtlMs);
  const backoff = num(config.retryBackoffMs);
  if (
    grace < 1 ||
    grace > 86_400_000 ||
    busy < 1_000 ||
    busy > 86_400_000 ||
    backoff < 1_000 ||
    backoff > 86_400_000
  ) {
    throw invalid("时间界限超出范围");
  }
  const schedule = config.schedule.kind;
  switch (schedule.case) {
    case "once":
      if (!validTime(num(schedule.value.atUnixMs)))
        throw invalid("一次性时刻不合法");
      break;
    case "interval": {
      const period = num(schedule.value.intervalMs);
      if (
        !validTime(num(schedule.value.anchorUnixMs)) ||
        period < 1_000 ||
        period > 31_536_000_000
      ) {
        throw invalid("间隔不合法");
      }
      break;
    }
    case "cron":
      if (
        parseCron(schedule.value.expression, schedule.value.timezone) ===
        undefined
      ) {
        throw invalid("cron 表达式或时区不合法");
      }
      break;
    case "loopAfterCompletion": {
      const delay = num(schedule.value.delayMs);
      // 循环必须有终点：没有次数上限也没有截止时间的循环计划会一直跑下去。
      if (
        delay < 1_000 ||
        delay > 31_536_000_000 ||
        (num(config.maxRuns) === 0 && num(config.expiresAtUnixMs) === 0)
      ) {
        throw invalid("循环计划必须有次数上限或截止时间");
      }
      break;
    }
    default:
      throw invalid("未指明日程");
  }
  return config;
}

/* -------------------------------- 到期计算 -------------------------------- */

export function firstDue(config: AutomationPlanConfig, nowMs: number): number {
  const schedule = config.schedule?.kind;
  switch (schedule?.case) {
    case "once":
      return num(schedule.value.atUnixMs);
    case "interval": {
      const anchor = num(schedule.value.anchorUnixMs);
      const period = num(schedule.value.intervalMs);
      if (nowMs <= anchor) return anchor;
      const steps = Math.ceil((nowMs - anchor) / period);
      const next = anchor + steps * period;
      if (!validTime(next)) throw invalid("下一次到期超出时间上界");
      return next;
    }
    case "cron": {
      const parsed = parseCron(
        schedule.value.expression,
        schedule.value.timezone,
      );
      if (parsed === undefined) throw invalid("cron 表达式不合法");
      const next = nextCron(parsed, nowMs - 1);
      if (next === undefined) throw invalid("这个 cron 永远不会再触发");
      return next;
    }
    case "loopAfterCompletion":
      return nowMs;
    default:
      throw invalid("未指明日程");
  }
}

/** 一次预览最多给多少个时刻。和 Host 的上限一致。 */
export const MAX_PREVIEW = 20;

/**
 * 只算不动。不激活、不存储、不投递——向导用它给人看「接下来会在什么时候跑」。
 */
export function preview(
  input: AutomationPlanConfig,
  afterMs: number,
  count: number,
): number[] {
  const config = normalize(input);
  if (count < 1 || count > MAX_PREVIEW) throw invalid("预览数量超出范围");
  if (!validTime(afterMs)) throw invalid("起点时刻不合法");
  if (config.schedule?.kind.case === "loopAfterCompletion") {
    // 循环的下一次取决于上一次什么时候跑完，不是一个能提前算出来的时刻。
    throw new ScheduleError("unsupported", "循环计划没有可预览的日程");
  }
  const values: number[] = [];
  let at = firstDue(config, afterMs);
  while (values.length < count && at > 0) {
    if (at >= afterMs) values.push(at);
    const schedule = config.schedule?.kind;
    if (schedule?.case === "once") break;
    if (schedule?.case === "interval") {
      at += num(schedule.value.intervalMs);
    } else if (schedule?.case === "cron") {
      const parsed = parseCron(
        schedule.value.expression,
        schedule.value.timezone,
      );
      const next = parsed === undefined ? undefined : nextCron(parsed, at);
      if (next === undefined) break;
      at = next;
    } else {
      break;
    }
    if (!validTime(at)) break;
  }
  return values;
}

/* -------------------------------- 到期窗口 -------------------------------- */

/** cron 补算错过槽位的上限。超过就标成截断，而不是把一次 tick 变成一次扫描。 */
export const MAX_CRON_COUNT = 10_000;

export interface DueWindow {
  /** 槽位标识：同一个槽位只会物化一次运行。 */
  readonly slot: string;
  readonly at: number;
  readonly next: number;
  readonly count: number;
  readonly truncated: boolean;
  readonly misfire: boolean;
}

/**
 * 这一次该物化哪个槽位，以及下一次什么时候。
 *
 * 「错过」有两种来源：一次 tick 之间跨过了不止一个槽位（`count > 1`），或者
 * 跨过一个槽位之后过了宽限期。两者都是同一个词，因为对使用者来说是同一件事。
 */
export function window(plan: AutomationPlan, nowMs: number): DueWindow {
  const config = plan.config;
  if (config === undefined) throw invalid();
  const at = num(plan.nextDueUnixMs);
  if (at <= 0 || at > nowMs) throw invalid("这个计划现在还没到期");
  let slot = "";
  let next = 0;
  let count = 1;
  let truncated = false;
  const schedule = config.schedule?.kind;
  switch (schedule?.case) {
    case "once":
      slot = `once:${at}`;
      break;
    case "interval": {
      const anchor = num(schedule.value.anchorUnixMs);
      const period = num(schedule.value.intervalMs);
      slot = `interval:${Math.trunc((at - anchor) / period)}`;
      count = Math.trunc((nowMs - at) / period) + 1;
      next = at + count * period;
      break;
    }
    case "cron": {
      const parsed = parseCron(
        schedule.value.expression,
        schedule.value.timezone,
      );
      if (parsed === undefined) throw invalid("cron 表达式不合法");
      const local = toLocalMinute(at, schedule.value.timezone);
      slot = `${schedule.value.timezone}:${local}`;
      let cursor = nextCron(parsed, at);
      if (cursor === undefined) throw invalid("这个 cron 不再触发");
      while (
        cursor !== undefined &&
        cursor <= nowMs &&
        count < MAX_CRON_COUNT
      ) {
        count += 1;
        cursor = nextCron(parsed, cursor);
      }
      if (cursor === undefined) throw invalid("这个 cron 不再触发");
      truncated = cursor <= nowMs;
      const following = nextCron(parsed, nowMs);
      if (following === undefined) throw invalid("这个 cron 不再触发");
      next = following;
      break;
    }
    case "loopAfterCompletion":
      slot = `loop:${num(plan.runCount) + 1}`;
      break;
    default:
      throw invalid("未指明日程");
  }
  if (next > MAX_TIMESTAMP_MS) next = 0;
  return {
    slot,
    at,
    next,
    count,
    truncated,
    misfire: count > 1 || nowMs - at > num(config.misfireGraceMs),
  };
}

/** `2026-09-20T09:30` —— 槽位标识里那一段本地民用时间。 */
function toLocalMinute(atMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(atMs));
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const hour = read("hour") === "24" ? "00" : read("hour");
  return `${read("year")}-${read("month")}-${read("day")}T${hour}:${read("minute")}`;
}

/* --------------------------------- 状态谓词 -------------------------------- */

export const TERMINAL_RUN_STATES = new Set<AutomationRunState>([
  AutomationRunState.SUCCEEDED,
  AutomationRunState.FAILED,
  AutomationRunState.CANCELLED,
  AutomationRunState.SKIPPED,
  AutomationRunState.EXPIRED,
]);

export function terminal(state: AutomationRunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function preDispatch(state: AutomationRunState): boolean {
  return (
    state === AutomationRunState.DUE ||
    state === AutomationRunState.CLAIMED ||
    state === AutomationRunState.WAITING_TARGET
  );
}

export const PLAN_STATES = AutomationPlanState;
