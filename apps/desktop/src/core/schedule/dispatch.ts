import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AutomationColdStartPolicy,
  AutomationOutcome,
  AutomationReceiptSchema,
  type AutomationReceipt,
  type AutomationRun,
  type AutomationTarget,
  create,
} from "./types";

import {
  type AgentSettings,
  baseAgent,
  startsSilently,
} from "../agent/registry";
import { type AgentStatus, getAgentStatus } from "../agent/status";
import {
  type ObservedActivity,
  silentStartIdle,
  stateSourceIsReported,
} from "../agent/target-state";
import type { WorkspaceEvent } from "../bus";
import {
  type NodeRef,
  loadNode,
  loadSession,
  workspaceRoot,
} from "../collab/nodes";
import type { TerminalBridge } from "../collab/service";
import { PASTE_END, PASTE_START, sanitizePaste } from "../terminal/backend";
import {
  type HibernationWaker,
  hibernatedSession,
  hibernationWaker,
} from "../terminal/hibernate";
import {
  type AgentLauncher,
  ColdStarts,
  agentLauncher,
  launchLine,
  rememberSession,
} from "./cold-start";
import { ScheduleError, agentTarget, big, num } from "./plan";
import { COMMAND_SESSION_READY, ScheduleStore } from "./store";
import type { Dispatcher, ProbeOptions, TargetStatus } from "./engine";

/**
 * 把一次到期的投递真的写出去。
 *
 * Go Host 这一层是跨进程的：`automationhost` 问 Rust Worker 要一个冻结的命令
 * 会话，或者问 Runtime 要一个 Agent 节点的 PTY。同进程之后两条路都落回 core
 * 自己的两个域：
 *
 *   * **Agent 目标**（`AGENT_SESSION_PROMPT`）——投递给 Agent 节点。节点、它当前
 *     的会话与代数由 `core/collab/nodes` 回答，写入走 `core/terminal` 的桥。
 *   * **命令目标**（`NON_INTERACTIVE_COMMAND`）——纯终端，只进 shell pane。这里
 *     的「命令会话」就是一个终端节点的会话加上它被冻结时的代数。
 *
 * 两条路共用同一条硬规矩，也是这个文件唯一真正重要的一句话：
 *
 * > **`blocked` / `waiting` 的节点不投递。**
 *
 * 那两个状态意味着有个 CLI 正停在一个问题上，往它的 pane 里写东西等于替人回答
 * 了那个问题，而回答的内容是这次投递碰巧带的字符。所以它算「忙」——等下一拍，
 * 不是失败，也不是跳过。这和 `core/terminal` 的安全闸门用的是同一个判据
 * （`isAwaitingHuman`），所以「在等人」这件事只有一个定义。
 *
 * 第二条：**送到不是做完**。写进去只报 `DELIVERED`，永远不报 `SUCCEEDED`。输入
 * 落进缓冲区不是工作被完成。
 */

export interface DispatchContext {
  readonly database: DatabaseSync;
  readonly store: ScheduleStore;
  readonly hostId: string;
  /**
   * 终端桥，每次现取。
   *
   * 不是一个构造时拿到的值：终端域把桥交回来是在装配的后半段，而且
   * `setTerminalBridge` 之后它还会换（协作域重建上下文时整个对象是新的）。
   * 取一次存下来就会一直对着那个旧的写。
   *
   * 还没有桥不是「目标坏了」，是「还不知道」——探测因此答 `unknown`，运行等下
   * 一拍，而不是被跳过。
   */
  readonly terminals: () => TerminalBridge | undefined;
  readonly clock?: () => number;
  /**
   * 冷启动要的三样（自动化设计 §4.2），都每次现取，理由与 {@link terminals}
   * 相同。缺哪一样，授权了冷启动的计划遇到空节点就如实答离线。
   *
   *   * `settings`：按 `agentId` 解析程序名的注册表（含自定义 Agent）；
   *   * `launcher`：终端域交回来的启动器，默认读 `cold-start.ts` 的那个接缝；
   *   * `publish`：把新会话写回节点之后告诉页面重读画布。
   */
  readonly settings?: () => AgentSettings | undefined;
  readonly launcher?: () => AgentLauncher | undefined;
  readonly publish?: () =>
    | ((workspaceId: string, event: WorkspaceEvent) => void)
    | undefined;
}

const unsupported = (why: string): ScheduleError =>
  new ScheduleError("unsupported", why);

export class TerminalDispatcher implements Dispatcher {
  private readonly coldStarts = new ColdStarts();

  constructor(private readonly context: DispatchContext) {}

  private now(): number {
    return (this.context.clock ?? (() => Date.now()))();
  }

  async supports(
    target: AutomationTarget,
    options: ProbeOptions = {},
  ): Promise<TargetStatus> {
    if (target.executionHostId !== this.context.hostId) {
      return { state: "unsupported", generation: 0 };
    }
    return agentTarget(target)
      ? this.supportsAgent(target, options.coldStart === true)
      : this.supportsCommand(target);
  }

  /**
   * Agent 目标的探测。
   *
   * 节点存在、是这个 Agent、当前有一个活着的会话，并且那个会话不在等人、输入
   * 行上没有人留下的半行——都成立才叫 `ready`。
   */
  private async supportsAgent(
    target: AutomationTarget,
    coldStart: boolean,
  ): Promise<TargetStatus> {
    const launch = target.agentLaunch;
    if (target.nodeId === "" || launch === undefined || launch.agentId === "") {
      return { state: "unsupported", generation: 0 };
    }
    const node = loadNode(this.context.database, target.nodeId);
    if (node === undefined) return { state: "unsupported", generation: 0 };
    // 节点还在，但它现在跑的是另一个 Agent：计划冻结的那份定义已经不成立了。
    if (node.agentId !== launch.agentId) {
      return { state: "unsupported", generation: 0 };
    }
    const terminals = this.context.terminals();
    if (terminals === undefined) return { state: "unknown", generation: 0 };
    const session = loadSession(this.context.database, target.nodeId);
    const live =
      session === undefined
        ? undefined
        : terminals.generation(session.sessionId);
    if (live === undefined || session === undefined) {
      // 节点没事，只是上面什么都没跑：离线，不是不支持。没授权冷启动的计划因此
      // 是跳过而不是一直等；授权了的，只在运行的目标探测里起一个。
      if (
        coldStart &&
        target.coldStartPolicy === AutomationColdStartPolicy.LAUNCH_FROZEN
      ) {
        // 休眠着的节点（终端宿主设计 §7.2）用 CLI 的 resume 接回原来那段对话，
        // 不按冻结定义另起一个——那会是同一个节点上第二段互不相识的会话。
        // 没有唤醒入口就是没有终端域，也就没有谁会休眠。
        const wake = hibernationWaker();
        if (
          wake !== undefined &&
          hibernatedSession(this.context.database, node.id) !== undefined
        ) {
          return this.resumeHibernated(node, wake);
        }
        return this.coldStart(target, node);
      }
      return { state: "offline", generation: 0 };
    }
    // 停在一个问题上的 pane 算忙。写进去就是替人回答了那个问题。
    const status = getAgentStatus(this.context.database, target.nodeId);
    if (status?.state === "blocked" || status?.state === "waiting") {
      return { state: "busy", generation: live };
    }
    if (status?.state === "working") return { state: "busy", generation: live };
    // 人打了一半的输入：租约过期之后那半行还在，写进去就接在它后面一起提交。
    // 与 `send` 的 `TARGET_INPUT_PENDING` 是同一条（终端域的输入围栏）。
    const observed = terminals.observed?.(session.sessionId);
    if (observed?.pending === true) return { state: "busy", generation: live };
    // 我们冷启动的会话：旧会话留下的那行状态不算，要等它起来之后自己报一条。
    const startedAt = this.coldStarts.startedAt(node.id, session.sessionId);
    if (
      startedAt !== undefined &&
      !this.settledSince(node, status, startedAt, observed)
    ) {
      return { state: "busy", generation: live };
    }
    return { state: "ready", generation: live };
  }

  /**
   * 冷启动的会话「上一回合已结束」了没有。
   *
   * 两条路，各对应一种 CLI：会报的，要一条晚于冷启动的真上报（`idle` / `done` /
   * `error`，不是 `restored` 读回来的行）；启动时一条都不报的（§4.3 的
   * `startsSilently`），走同一道首投门——会话够老、没有半截的行。
   */
  private settledSince(
    node: NodeRef,
    status: AgentStatus | undefined,
    startedAtMs: number,
    observed: ObservedActivity | undefined,
  ): boolean {
    const reportedAt = Date.parse(status?.lastEventAt ?? "");
    // 时间戳可能只精确到秒：按冷启动那一秒比，而不是那一毫秒。
    const fresh =
      status !== undefined &&
      !status.restored &&
      stateSourceIsReported(status.stateSource) &&
      Number.isFinite(reportedAt) &&
      reportedAt >= Math.floor(startedAtMs / 1000) * 1000;
    if (fresh) {
      return (
        status.state === "idle" ||
        status.state === "done" ||
        status.state === "error"
      );
    }
    const settings = this.context.settings?.();
    if (settings === undefined || node.agentId === null) return false;
    const nowMs = this.now();
    return silentStartIdle({
      startsSilently: startsSilently(baseAgent(settings, node.agentId)),
      reported: false,
      observed,
      sessionAgeMs: nowMs - startedAtMs,
      nowMs,
    });
  }

  /**
   * 按冻结的定义起一个会话，写回节点，报 `busy`。
   *
   * 起不来（没有启动器、没有目录、终端域拒绝）答离线：这一次运行照常跳过，而
   * 冷却窗口已经占上了，所以下一个计划不会紧接着再试一遍。
   */
  private async coldStart(
    target: AutomationTarget,
    node: NodeRef,
  ): Promise<TargetStatus> {
    const offline: TargetStatus = { state: "offline", generation: 0 };
    const nowMs = this.now();
    if (this.coldStarts.cooling(node.id, nowMs)) return offline;
    const spec = target.agentLaunch;
    const launch = (this.context.launcher ?? agentLauncher)();
    const settings = this.context.settings?.();
    if (spec === undefined || launch === undefined || settings === undefined) {
      return offline;
    }
    let line: string;
    try {
      line = launchLine(settings, spec);
    } catch {
      return { state: "unsupported", generation: 0 };
    }
    const cwd =
      (spec.workingDirectory ?? "") !== ""
        ? spec.workingDirectory
        : rootOf(this.context.database, node.workspaceId);
    if (cwd === "") return offline;
    this.coldStarts.claim(node.id, nowMs);
    let started: { sessionId: string; generation: number };
    try {
      started = await launch({
        workspaceId: node.workspaceId,
        nodeId: node.id,
        agentId: spec.agentId,
        cwd,
        line,
      });
    } catch {
      return offline;
    }
    this.coldStarts.note(node.id, started.sessionId, nowMs);
    rememberSession(
      this.context.database,
      node,
      started.sessionId,
      this.context.publish?.(),
    );
    // 刚起来的 CLI 还没铺完界面，更没有结束过一回合。
    return { state: "busy", generation: started.generation };
  }

  /**
   * 计划授权了冷启动、而目标休眠着：叫终端域把它接回来，报 `busy`。
   *
   * 与冷启动共用冷却窗口与「起来之后要等一条新上报」那道门（`coldStarts`）：
   * 接回来的 CLI 同样还没结束过一回合。会话 id 不变，所以不用写回节点。没授权
   * 冷启动的计划走不到这里——它们如实答离线，这一次运行被跳过（§7.2）。
   */
  private async resumeHibernated(
    node: NodeRef,
    wake: HibernationWaker,
  ): Promise<TargetStatus> {
    const offline: TargetStatus = { state: "offline", generation: 0 };
    const nowMs = this.now();
    if (this.coldStarts.cooling(node.id, nowMs)) return offline;
    this.coldStarts.claim(node.id, nowMs);
    let woken: { sessionId: string; generation: number };
    try {
      woken = await wake(node.id, "schedule");
    } catch {
      return offline;
    }
    this.coldStarts.note(node.id, woken.sessionId, nowMs);
    return { state: "busy", generation: woken.generation };
  }

  /** 命令目标：一个被冻结过的终端会话，代数必须完全一致。 */
  private supportsCommand(target: AutomationTarget): TargetStatus {
    const record = this.context.store.commandSession(target.sessionId);
    if (record === undefined) return { state: "unsupported", generation: 0 };
    if (
      record.state !== COMMAND_SESSION_READY ||
      record.executionHostId !== this.context.hostId ||
      record.generation !== num(target.generation)
    ) {
      return { state: "unsupported", generation: record.generation };
    }
    const terminals = this.context.terminals();
    if (terminals === undefined) return { state: "unknown", generation: 0 };
    const live = terminals.generation(target.sessionId);
    if (live === undefined) return { state: "offline", generation: 0 };
    if (live !== record.generation) {
      return { state: "unsupported", generation: live };
    }
    return { state: "ready", generation: live };
  }

  /**
   * 写出去。
   *
   * 第二次尝试先问上一次做了什么，再决定写不写：即便下游是幂等的，一个不看就重发
   * 的调度器仍然是在把「不知道」当成「安全」。
   */
  async dispatch(run: AutomationRun): Promise<AutomationReceipt | undefined> {
    const config = run.frozenConfig;
    const target = config?.target;
    if (
      config === undefined ||
      target === undefined ||
      target.executionHostId !== this.context.hostId ||
      run.requestSha256.length !== 32 ||
      run.workspaceId !== config.workspaceId
    ) {
      throw unsupported("这次投递的定义不完整");
    }
    if (run.dispatchAttempts > 1) {
      const proof = this.context.store.receipt(run.operationId);
      if (proof !== undefined) return proof;
    }
    const payload = this.context.store.payload(
      run.workspaceId,
      config.payloadRef,
    );
    const digest = createHash("sha256").update(payload.payload).digest();
    if (!sameBytes(digest, config.payloadSha256)) {
      throw unsupported("载荷与它被冻结时的摘要对不上");
    }
    const status = await this.supports(target);
    if (status.state !== "ready") {
      // 探测和写入之间目标变了。这是**肯定的没投递**：什么都还没写出去，所以
      // 它是那种可以安全重试的失败，而不是一次结果不明的投递。
      return this.record(
        run,
        AutomationOutcome.NOT_DISPATCHED,
        "TARGET_NOT_READY",
      );
    }
    const sessionId = agentTarget(target)
      ? (loadSession(this.context.database, target.nodeId)?.sessionId ?? "")
      : target.sessionId;
    const terminals = this.context.terminals();
    if (terminals === undefined || sessionId === "") {
      return this.record(run, AutomationOutcome.NOT_DISPATCHED, "NO_TERMINAL");
    }
    const text = Buffer.from(payload.payload).toString("utf8");
    try {
      // 包裹与回车必须是同一次写：分两次写的话，CLI 会在收到回车之前先看到一个
      // 没有结尾的粘贴，多行提示词会一行一行地自己提交出去。
      await terminals.write(
        sessionId,
        status.generation,
        `${PASTE_START}${sanitizePaste(text)}${PASTE_END}\r`,
      );
    } catch (error) {
      // 写到一半失败：不知道对面收到了多少。它**不是**可以重试的那种失败。
      return this.record(
        run,
        AutomationOutcome.UNKNOWN,
        "WRITE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    // 送到就是送到，不是做完。
    return this.record(run, AutomationOutcome.DELIVERED, "WRITTEN");
  }

  /** 这次投递到底做了什么，从这个 core 自己的收据表里读。 */
  async lookup(run: AutomationRun): Promise<AutomationReceipt | undefined> {
    const stored = this.context.store.receipt(run.operationId);
    if (stored === undefined) {
      // 没有记录就是没有证据。「没有证据」不等于「没有发生」，所以这里答
      // UNKNOWN 而不是 NOT_DISPATCHED——后者是可以重试的，而重试会再写一遍。
      return this.receipt(run, AutomationOutcome.UNKNOWN, "NO_RECEIPT");
    }
    return stored;
  }

  private record(
    run: AutomationRun,
    outcome: AutomationOutcome,
    reasonCode: string,
    _detail?: string,
  ): AutomationReceipt {
    const receipt = this.receipt(run, outcome, reasonCode);
    this.context.store.putReceipt(receipt);
    return receipt;
  }

  private receipt(
    run: AutomationRun,
    outcome: AutomationOutcome,
    reasonCode: string,
  ): AutomationReceipt {
    return create(AutomationReceiptSchema, {
      operationId: run.operationId,
      requestSha256: run.requestSha256,
      outcome,
      // 序号从这次投递的尝试次数来：同一次尝试重复观察得到同一个序号，而下一次
      // 尝试的收据一定比上一次大。
      sequence: big(Math.max(1, run.dispatchAttempts)),
      observedAtUnixMs: big(Math.max(1, this.now())),
      reasonCode,
    });
  }
}

/** 工作空间的根目录；读不到就是空串，冷启动因此答离线而不是抛。 */
function rootOf(database: DatabaseSync, workspaceId: string): string {
  try {
    return workspaceRoot(database, workspaceId) ?? "";
  } catch {
    return "";
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
