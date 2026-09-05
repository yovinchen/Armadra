import { z } from "zod";

import { agentEventSchema, agentStatusSchema } from "../domain/index.js";

import { browserDownloadSchema, browserSessionSchema } from "./browser.js";
import { fileChangeKindSchema } from "./files.js";
import {
  languageServerEventSchema,
  languageSessionEventSchema,
} from "./language.js";
import { resourceSnapshotSchema } from "./resources.js";

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
    outcome: z.string(),
  }),
  z.object({
    type: z.literal("terminal.exit"),
    sessionId: z.string(),
    nodeId: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
  }),
  z.object({
    type: z.literal("board.changed"),
    boardId: z.string(),
    updatedAt: z.string(),
  }),
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
  /**
   * 一帧受控浏览器画面（B01，设计 §8）。`data` 是 base64 的 JPEG 字节；
   * 只有持有订阅的客户端会收到，被遮挡 / 无人订阅的会话不推帧。
   */
  z.object({
    type: z.literal("browser.frame"),
    sessionId: z.string(),
    generation: z.number().int().nonnegative(),
    frameSeq: z.number().int().nonnegative(),
    navigationEpoch: z.number().int().nonnegative(),
    viewportWidth: z.number().int().positive(),
    viewportHeight: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
    encoding: z.literal("jpeg"),
    data: z.string(),
    capturedAt: z.string(),
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
export type BrowserFrameEvent = Extract<
  WorkspaceEvent,
  { type: "browser.frame" }
>;
