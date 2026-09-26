import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceEvent } from "../bus";
import type { AgentSettings } from "../agent/registry";
import type { ObservedActivity } from "../agent/target-state";
import type { Actor as DriveActor } from "../drive/lease";
import type { DriveTarget } from "../terminal/manager";
import { BoardLog } from "./board-log";
import type { Caller } from "./nodes";

export type { DriveTarget, DriveActor };

/**
 * What the collaboration verbs are handed at assembly time.
 *
 * Every dependency that is not the database arrives as a small interface
 * rather than as the real object, for one reason: the verbs are the part of
 * this domain with the most rules and the fewest moving parts, and a test that
 * has to stand up a PTY to check that `interrupt` refuses an unlinked node is
 * a test nobody will write. The bridges below are what the R2 terminal domain
 * and the handoff module fill in; a fixture fills them with literals.
 */

/** The PTY operations a collaboration verb needs. Implemented by R2. */
export interface TerminalBridge {
  /** Writes into a live session, refusing a generation that has moved on. */
  write(sessionId: string, generation: number, data: string): Promise<void>;
  /**
   * The last `lines` rendered rows of the pane.
   *
   * `withEscapes` is what the HTTP route calls `escapes`, and both callers
   * here pass `false`: a screen that is about to become prose for a model, or
   * a title, wants the characters and not the SGR around them. It was named
   * `plain` once, which reads as the opposite of what `false` does.
   */
  capture(
    sessionId: string,
    lines: number,
    withEscapes: boolean,
  ): Promise<{ readonly lines: number; readonly data: string }>;
  /** What is in the foreground, for the pane gate. */
  foreground(
    sessionId: string,
  ): Promise<
    { readonly command?: string; readonly children?: string[] } | undefined
  >;
  /** The live generation, or `undefined` when nothing is running. */
  generation(sessionId: string): number | undefined;
  terminate(sessionId: string, mode: "session" | "process"): Promise<void>;
  /** Whether this really is the session the node is running right now. */
  isCurrentNodeSession(
    nodeId: string,
    sessionId: string,
    generation: number,
  ): Promise<boolean>;
  /**
   * 一次投递要知道的全部：目标在五态里的哪一个、租约在谁手里、代次是几
   * （设计 `agent-delivery.md` §4 / §6，阶段 B 留下的接口）。
   *
   * 可选，与这个接口上其它几个一样的理由：没有终端域的装配照样要能答路由，
   * 只是需要 pane 的动词换一句拒绝。`send` 拿不到它就 503。
   */
  driveTarget?(nodeId: string): DriveTarget;
  /**
   * 写进去**并回车**，一次 `write`（§3.6）。
   *
   * 括号粘贴的包裹与 `\r` 必须是同一次写，所以这里借的是终端域那条原语而不是
   * 自己拼一遍：拼接只有一处，用例直接断言它写出去的字符串形状。
   */
  writeSubmit?(
    sessionId: string,
    generation: number,
    text: string,
    driver?: DriveActor,
  ): Promise<void>;
  /** 没有状态适配的会话，终端域对它知道的全部（§4.3 的启发式要的三样）。 */
  observed?(sessionId: string): ObservedActivity | undefined;
  /**
   * 替一个 Agent 节点起一个终端（一个 shell），与页面挂载时 `POST /api/terminals`
   * 起的是同一种：同样的地址变量、同样的节点令牌。
   *
   * 只有依赖编排用它（Agent 自动化设计 §6）：页面没开时，等待满足之后得有人
   * 替节点起终端。启动行仍然是之后一次 `write`，这里只起 shell。
   */
  spawnForNode?(request: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly agentId: string;
    readonly cwd: string;
    readonly shell?: string | undefined;
    readonly sshHostId?: string | undefined;
  }): Promise<{ readonly sessionId: string; readonly generation: number }>;
  /**
   * 这个节点休眠着（Eco 模式，终端宿主设计 §7.2）就把它接回来，答 `true`；
   * 醒着答 `false`。`send` 在走门链之前踢它一下（不等）：投给一个休眠节点的
   * 消息，本来会因为「没有在运行的会话」被当场拒绝。
   */
  wakeNode?(nodeId: string): Promise<boolean>;
  /**
   * 这个节点正休眠着或正在接回。这段时间里门链看到的是「没有会话」或「前台还
   * 是 shell」，那不是拒绝的理由，是「还早」：投递排队等它起来。
   */
  sleeping?(nodeId: string): boolean;
}

/**
 * The two questions the mailbox asks the handoff module.
 *
 * Injected rather than imported so the dependency runs one way: handoff needs
 * the mailbox (accepting writes an inbox entry), and the mailbox needs handoff
 * only for the one message key that names one.
 */
export interface HandoffBridge {
  /** Refuses a receipt that does not belong to the current Agent session. */
  authorizeMailboxAck(
    caller: Caller,
    handoffId: string,
    sessionId: string,
    generation: number,
  ): Promise<void>;
  /** The target acknowledged its inbox entry, so the handoff is settled. */
  noteAcknowledged(mailboxId: string): void;
}

/**
 * `handoff-read`, as the control dispatcher sees it.
 *
 * A function rather than a method on {@link HandoffBridge} because the two are
 * needed by different halves: the mailbox needs the bridge, the control verb
 * needs this, and a module that only implements one of them should not have to
 * stub the other.
 */
export type HandoffReader = (
  caller: Caller,
  handoffId: string,
  sessionId: string,
  generation: number,
) => Promise<Record<string, unknown>>;

export interface CollabContext {
  readonly database: DatabaseSync;
  readonly settings: AgentSettings;
  /** Emits one workspace event. Nothing here learns who was listening. */
  readonly publish: (workspaceId: string, event: WorkspaceEvent) => void;
  /**
   * How many clients are watching this workspace.
   *
   * `close` is the only verb that needs the number: it waits for a human, and
   * a workspace nobody is watching is a dialog that will never be drawn. Every
   * other verb publishes and moves on.
   */
  readonly audience: (workspaceId: string) => number;
  readonly terminals?: TerminalBridge | undefined;
  readonly handoff?: HandoffBridge | undefined;
  readonly handoffReader?: HandoffReader | undefined;
  readonly boardLog: BoardLog;
  /** `<data dir>`, for the pending-approval files. */
  readonly dataDir: string;
  readonly now?: (() => Date) | undefined;
  /**
   * 等一小会儿。`send --interrupt` 是唯一的用户：它发一个 `ESC` 之后要等目标
   * 报一条 `idle`（§4.5），而「等」在用例里必须是一个可以被跳过的值，否则那条
   * 「等不到就退回排队」的用例要真的睡五秒。
   */
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
  /**
   * 「这个节点现在值得看一眼」——出队泵的那一下推。
   *
   * `post` 是唯一的用户：一条投进空闲节点收件箱的消息，目标那一侧不会因此报
   * 任何状态（它本来就空着），所以只听 `agent.status` 的话收件箱唤醒要等到它
   * 下一次跑完一轮才发生，而那正好是它最不需要被提醒的时刻（§5）。
   *
   * 注入而不是 import：泵在 agent 域装配，协作域反过来 import 它就是一个环。
   */
  readonly nudge?: ((nodeId: string) => void) | undefined;
}

export interface CollabOptions {
  readonly database: DatabaseSync;
  readonly settings: AgentSettings;
  readonly publish?: (workspaceId: string, event: WorkspaceEvent) => void;
  readonly audience?: (workspaceId: string) => number;
  readonly terminals?: TerminalBridge | undefined;
  readonly handoff?: HandoffBridge | undefined;
  readonly handoffReader?: HandoffReader | undefined;
  readonly dataDir?: string;
  readonly now?: (() => Date) | undefined;
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
  readonly nudge?: ((nodeId: string) => void) | undefined;
}

/** A context with the optional halves defaulted, for tests and for assembly. */
export function collabContext(options: CollabOptions): CollabContext {
  return {
    database: options.database,
    settings: options.settings,
    publish: options.publish ?? (() => {}),
    audience: options.audience ?? (() => 0),
    terminals: options.terminals,
    handoff: options.handoff,
    handoffReader: options.handoffReader,
    boardLog: new BoardLog(),
    dataDir: options.dataDir ?? ".",
    now: options.now,
    delay: options.delay,
    nudge: options.nudge,
  };
}

export function nowDate(context: CollabContext): Date {
  return context.now === undefined ? new Date() : context.now();
}

export function nowSeconds(context: CollabContext): number {
  return Math.floor(nowDate(context).getTime() / 1000);
}
