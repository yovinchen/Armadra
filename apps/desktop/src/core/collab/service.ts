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
  };
}

export function nowDate(context: CollabContext): Date {
  return context.now === undefined ? new Date() : context.now();
}

export function nowSeconds(context: CollabContext): number {
  return Math.floor(nowDate(context).getTime() / 1000);
}
