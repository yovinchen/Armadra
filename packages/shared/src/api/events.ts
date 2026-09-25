import { z } from "zod";

import { agentEventSchema, agentStatusSchema } from "../domain/index.js";

import {
  browserActivitySchema,
  browserDialogSchema,
  browserDownloadSchema,
  browserFileChooserSchema,
  browserLeaseSchema,
  browserSessionSchema,
  browserTabListSchema,
} from "./browser.js";
import { boardPresenceSchema } from "./boards.js";
import { driveLeaseSchema } from "./drive.js";
import { fileChangeKindSchema } from "./files.js";
import {
  languageServerEventSchema,
  languageSessionEventSchema,
} from "./language.js";
import { resourceSnapshotSchema } from "./resources.js";
import { sshPromptSchema } from "./ssh.js";

/** `WS /api/workspaces/{id}/events` — plan §5.4 / §7. */
export const workspaceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.context"),
    nodeId: z.string(),
    sessionId: z.string(),
    generation: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("agent.status"), status: agentStatusSchema }),
  z.object({ type: z.literal("agent.subagent"), event: agentEventSchema }),
  z.object({
    type: z.literal("agent.approval"),
    nodeId: z.string(),
    pendingId: z.string(),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal("agent.delivery"),
    traceId: z.string(),
    sourceNodeId: z.string(),
    targetNodeId: z.string(),
    /** `delivered` / `queued` / `unknown` / `refused`。 */
    outcome: z.string(),
    /**
     * 被拦下时的稳定码（`LOOP_DETECTED`、`RATE_LIMITED`…）。页面按它取文案，
     * core 的中文句子不上界面（设计 `agent-delivery.md` §3.5、§10）。
     */
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal("terminal.exit"),
    sessionId: z.string(),
    nodeId: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
  }),
  /**
   * 终端的驱动权换手了（`agent-delivery.md` §6）。
   *
   * 与 `browser.lease` 同形状、同四个错误码：节点头的徽标从这里同步，而不是
   * 各自根据「我刚才敲过」推断谁在驱动。`nodeId` 在会话属于一个画布节点时才
   * 有——一个不属于任何节点的终端没有节点头可画。
   */
  z.object({
    type: z.literal("terminal.lease"),
    sessionId: z.string(),
    nodeId: z.string().optional(),
    lease: driveLeaseSchema,
  }),
  /**
   * Eco 休眠的状态变了（终端宿主设计 §7.2）。`hibernated` 只在进程确认结束之后
   * 才发；`failed` 表示没能用 CLI 的 resume 接回来，要人处理。
   */
  z.object({
    type: z.literal("terminal.hibernation"),
    sessionId: z.string(),
    nodeId: z.string(),
    state: z.enum(["hibernated", "resuming", "running", "failed"]),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("board.changed"),
    boardId: z.string(),
    updatedAt: z.string(),
  }),
  /**
   * 谁在看这块画布、谁持有写租约（core JSON §9.4）。有人来、有人走、租约
   * 换手时各一帧。
   */
  boardPresenceSchema.extend({ type: z.literal("canvas.presence") }),
  /**
   * A control verb added a node on behalf of `originNodeId` — the node whose
   * agent ran the verb.
   *
   * `board.changed` is what makes every client re-read the board; this frame
   * says which node appeared and who asked for it, which is what a page needs
   * in order to take the person to it the way the add menu does. Only a page
   * that is looking at `boardId` acts on it.
   */
  z.object({
    type: z.literal("node.created"),
    boardId: z.string(),
    nodeId: z.string(),
    nodeType: z.string(),
    originNodeId: z.string(),
  }),
  /**
   * `ssh` needs a password or a key passphrase and has no TTY to ask on
   * (remote completion design §3.6). Broadcast rather than answered by the
   * runtime: the secret belongs to a person, and the prompt text has already
   * been redacted by the time it reaches the wire.
   */
  z.object({ type: z.literal("ssh.prompt"), prompt: sshPromptSchema }),
  /**
   * The workspace changed in a way that invalidates everything the client
   * holds about it — today only an execution-host switch, which re-points
   * every path at a different machine (design §3.3). Carries no detail on
   * purpose: a partial patch is exactly what must not happen here.
   */
  z.object({ type: z.literal("workspace.updated"), workspaceId: z.string() }),
  /**
   * A control verb that must not run without a human (plan §5.8: `close`).
   * The runtime is blocked on `POST /api/control/confirm/{requestId}` while
   * this frame is on the wire, and gives up after 130 seconds.
   */
  z.object({
    type: z.literal("control.confirm"),
    requestId: z.string(),
    verb: z.string(),
    nodeId: z.string(),
    summary: z.string(),
  }),
  /**
   * A file an editor node registered through `POST …/file-watch` changed on
   * disk outside the app. `sha256` / `size` / `mtime` are null for a removal.
   */
  /**
   * A host / session resource sample (T02). Only sent while a client holds a
   * subscription for this workspace, so a closed panel produces no traffic.
   */
  z.object({
    type: z.literal("resource.sample"),
    snapshot: resourceSnapshotSchema,
  }),
  /** 会话状态变了：导航、标题、可前进/后退、崩溃或结束（设计 §9）。 */
  z.object({
    type: z.literal("browser.session"),
    session: browserSessionSchema,
  }),
  /** 下载队列的一条状态（设计 §6）。 */
  z.object({
    type: z.literal("browser.download"),
    download: browserDownloadSchema,
  }),
  /**
   * 控制租约换手了（§2.6）。所有客户端的徽标都从这里同步，而不是各自
   * 根据「我刚才点过」推断谁在控制。
   */
  z.object({
    type: z.literal("browser.lease"),
    sessionId: z.string(),
    lease: browserLeaseSchema,
  }),
  /**
   * 标签条变了：开了、关了、导航了，或者活动标签换了（§2.2）。
   *
   * 整张表一起送而不是逐条差分：一次 `window.open` 会同时改活动标签和标签
   * 数量，分两条推会让标签条在中间那一刻显示一个从未存在过的状态。
   */
  z.object({
    type: z.literal("browser.tabs"),
    sessionId: z.string(),
    tabs: browserTabListSchema,
  }),
  /**
   * 某个标签被 `alert` / `confirm` / `prompt` / `beforeunload` 挡住了，或者
   * 挡住它的对话框已经被答复（§2.4）。`dialog` 缺席就是后者。
   */
  z.object({
    type: z.literal("browser.dialog"),
    sessionId: z.string(),
    dialog: browserDialogSchema.optional(),
  }),
  /** 页面开了文件选择器，或者选择器已经被答复 / 超时（§2.3）。 */
  z.object({
    type: z.literal("browser.fileChooser"),
    sessionId: z.string(),
    chooser: browserFileChooserSchema.optional(),
  }),
  /** 节点头部的一行「谁做了什么」（§2.8）；一次动作一条，不是一帧一条。 */
  browserActivitySchema.extend({ type: z.literal("browser.activity") }),
  /**
   * A language session changed state (language service design §2.9). It rides
   * the workspace event stream rather than the session socket, so the status
   * line and the settings page can follow a server without opening one.
   */
  languageSessionEventSchema.extend({
    type: z.literal("language.session"),
  }),
  /** A server was probed, started, stopped or crashed (design §2.9). */
  languageServerEventSchema.extend({ type: z.literal("language.server") }),
  z.object({
    type: z.literal("file.changed"),
    workspaceId: z.string(),
    path: z.string(),
    kind: fileChangeKindSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullish(),
    size: z.number().int().nonnegative().nullish(),
    mtime: z.string().nullish(),
  }),
]);

export type FileChangedEvent = Extract<
  WorkspaceEvent,
  { type: "file.changed" }
>;
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type LanguageSessionWorkspaceEvent = Extract<
  WorkspaceEvent,
  { type: "language.session" }
>;
export type LanguageServerWorkspaceEvent = Extract<
  WorkspaceEvent,
  { type: "language.server" }
>;
export type ResourceSampleEvent = Extract<
  WorkspaceEvent,
  { type: "resource.sample" }
>;
export type CanvasPresenceEvent = Extract<
  WorkspaceEvent,
  { type: "canvas.presence" }
>;
export type TerminalLeaseEvent = Extract<
  WorkspaceEvent,
  { type: "terminal.lease" }
>;
export type TerminalHibernationEvent = Extract<
  WorkspaceEvent,
  { type: "terminal.hibernation" }
>;
export type BrowserLeaseEvent = Extract<
  WorkspaceEvent,
  { type: "browser.lease" }
>;
export type BrowserActivityEvent = Extract<
  WorkspaceEvent,
  { type: "browser.activity" }
>;
export type BrowserTabsEvent = Extract<
  WorkspaceEvent,
  { type: "browser.tabs" }
>;
export type BrowserDialogEvent = Extract<
  WorkspaceEvent,
  { type: "browser.dialog" }
>;
export type BrowserFileChooserEvent = Extract<
  WorkspaceEvent,
  { type: "browser.fileChooser" }
>;
export type SshPromptEvent = Extract<WorkspaceEvent, { type: "ssh.prompt" }>;
export type WorkspaceUpdatedEvent = Extract<
  WorkspaceEvent,
  { type: "workspace.updated" }
>;
