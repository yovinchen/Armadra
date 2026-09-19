import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AutomationOutcome,
  AutomationReceiptSchema,
  type AutomationReceipt,
  type AutomationRun,
  type AutomationTarget,
  create,
} from "@armadra/protocol";

import { getAgentStatus } from "../agent/status";
import { loadNode, loadSession } from "../collab/nodes";
import type { TerminalBridge } from "../collab/service";
import { PASTE_END, PASTE_START, sanitizePaste } from "../terminal/backend";
import { ScheduleError, agentTarget, big, num } from "./plan";
import { COMMAND_SESSION_READY, ScheduleStore } from "./store";
import type { Dispatcher, TargetStatus } from "./engine";

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
}

const unsupported = (why: string): ScheduleError =>
  new ScheduleError("unsupported", why);

export class TerminalDispatcher implements Dispatcher {
  constructor(private readonly context: DispatchContext) {}

  private now(): number {
    return (this.context.clock ?? (() => Date.now()))();
  }

  async supports(target: AutomationTarget): Promise<TargetStatus> {
    if (target.executionHostId !== this.context.hostId) {
      return { state: "unsupported", generation: 0 };
    }
    return agentTarget(target)
      ? this.supportsAgent(target)
      : this.supportsCommand(target);
  }

  /**
   * Agent 目标的探测。
   *
   * 节点存在、是这个 Agent、当前有一个活着的会话，并且那个会话不在等人——四件事
   * 都成立才叫 `ready`。
   */
  private supportsAgent(target: AutomationTarget): TargetStatus {
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
    if (live === undefined) {
      // 节点没事，只是上面什么都没跑：离线，不是不支持。没授权冷启动的计划因此
      // 是跳过而不是一直等。
      //
      // 授权了冷启动的计划今天也走同一条路：拉起一个 CLI 是一次有副作用的动
      // 作，这个 core 里还没有谁有权替人做它。冷启动接上时只改这一个分支。
      return { state: "offline", generation: 0 };
    }
    // 停在一个问题上的 pane 算忙。写进去就是替人回答了那个问题。
    const status = getAgentStatus(this.context.database, target.nodeId);
    if (status?.state === "blocked" || status?.state === "waiting") {
      return { state: "busy", generation: live };
    }
    if (status?.state === "working") return { state: "busy", generation: live };
    return { state: "ready", generation: live };
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
