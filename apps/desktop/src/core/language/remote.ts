/**
 * 远端工作空间的语言服务：控制端这一半。
 *
 * 服务器跑在执行主机上、由那台机器上的第二个 Worker（语言连接）管理
 * （取舍见 `remote/language.ts`）。这里只做三件事：
 *
 *  * **授权与路由**：权限照本机的门判完，再把同一件事交给语言连接；
 *  * **搬运**：浏览器 socket 上的每条文本是一次 `language.send`，Worker 推来的
 *    `language.message` 按会话 id 写回对应的 socket；
 *  * **断线**：语言连接一断，那台主机上的服务器随 Worker 一起停了。它的会话全部
 *    发一帧 `disconnected / link_lost` 并关掉 socket——编辑器的传输层看到关闭就
 *    退避重连，重连时新开的会话会重新拉起连接。控制端不假装还握着任何东西。
 */

import type { WebSocket } from "ws";

import {
  executeLanguage,
  listenRemote,
  type RemotePushEvent,
} from "../remote/execute";
import { notFound } from "../workspaces/support";
import type { Workspace } from "../workspaces/table";
import type { ApplyResult, AppliedFile } from "./edits";
import type { JsonValue } from "./jsonrpc";
import { reason } from "./limits";
import type { OpenedSession } from "./lifecycle";
import {
  languages,
  type Control,
  type LanguageServiceStatus,
  type ServerDescriptor,
} from "./registry";

/** 控制端把 Worker 推来的状态发到哪里。 */
export interface RemoteLanguageSink {
  publish(workspaceId: string, event: Record<string, unknown>): void;
  fileChanged(workspaceId: string, file: AppliedFile): void;
}

interface RemoteSession {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly serverId: string;
  readonly generation: number;
  socket: WebSocket | undefined;
  readonly queue: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 发往 Worker 的消息按序串起来：一条没写出去，后面的不能先到。 */
  sending: Promise<void>;
}

/** 与本机的停放时限相同：开了会话却一直没人连 socket，就当它没开过。 */
const PARK_TIMEOUT_MS = 60_000;
/** 会话 id 还不认识时先收着的帧：开会话的答复晚于它的第一批推送。 */
const EARLY_LIMIT = 256;
const EARLY_TTL_MS = 30_000;

export class RemoteLanguage {
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly early = new Map<string, { frames: string[]; at: number }>();
  private sink: RemoteLanguageSink | undefined;
  private readonly unlisten: () => void;

  constructor() {
    this.unlisten = listenRemote({
      event: (hostId, channel, event) => {
        if (channel === "language") this.pushed(hostId, event);
      },
      disconnected: (hostId, channel) => {
        if (channel === "language") this.linkLost(hostId);
      },
    });
  }

  /** 语言域装配时接上；之前收到的状态帧没有地方去，丢掉。 */
  attachSink(sink: RemoteLanguageSink | undefined): void {
    this.sink = sink;
  }

  dispose(): void {
    this.unlisten();
    for (const [id, session] of [...this.sessions]) {
      this.forget(id, session);
      session.socket?.close(1001, "The core is shutting down");
    }
  }

  has(workspaceId: string, sessionId: string): boolean {
    return this.sessions.get(sessionId)?.workspaceId === workspaceId;
  }

  /** 是否还没有 socket 连上——本机的 `sessionGuard` 用同一个判据答 409。 */
  awaitingSocket(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && session.socket === undefined;
  }

  /* ------------------------------- 推送 ------------------------------- */

  private pushed(hostId: string, event: RemotePushEvent): void {
    const workspaceId =
      typeof event.workspaceId === "string" ? event.workspaceId : "";
    if (event.type === "language.message") {
      const sessionId =
        typeof event.sessionId === "string" ? event.sessionId : "";
      const body = typeof event.body === "string" ? event.body : undefined;
      if (body === undefined || sessionId === "") return;
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        this.keepEarly(sessionId, body);
        return;
      }
      if (session.hostId !== hostId) return;
      if (session.socket !== undefined) session.socket.send(body);
      else session.queue.push(body);
      return;
    }
    if (workspaceId === "") return;
    if (event.type === "language.session") {
      const payload =
        typeof event.event === "object" && event.event !== null
          ? (event.event as Record<string, unknown>)
          : {};
      this.sink?.publish(workspaceId, {
        type: "language.session",
        workspaceId,
        ...payload,
      });
      return;
    }
    if (event.type === "language.server") {
      this.sink?.publish(workspaceId, {
        type: "language.server",
        workspaceId,
        executionHostId: hostId,
        server: event.server,
        ...(typeof event.stderrTail === "string"
          ? { stderrTail: event.stderrTail }
          : {}),
      });
      return;
    }
    if (event.type === "language.fileChanged") {
      const file = event.file as AppliedFile | undefined;
      if (file !== undefined) this.sink?.fileChanged(workspaceId, file);
    }
  }

  private keepEarly(sessionId: string, body: string): void {
    const now = Date.now();
    for (const [id, entry] of this.early) {
      if (now - entry.at > EARLY_TTL_MS) this.early.delete(id);
    }
    const entry = this.early.get(sessionId) ?? { frames: [], at: now };
    if (entry.frames.length < EARLY_LIMIT) entry.frames.push(body);
    this.early.set(sessionId, entry);
  }

  private linkLost(hostId: string): void {
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.hostId !== hostId) continue;
      this.forget(sessionId, session);
      this.sink?.publish(session.workspaceId, {
        type: "language.session",
        workspaceId: session.workspaceId,
        sessionId,
        serverId: session.serverId,
        generation: session.generation,
        state: "disconnected",
        reason: reason.LINK_LOST,
        restartCount: 0,
      });
      session.socket?.close(1011, "The remote language link went away");
    }
  }

  private forget(sessionId: string, session: RemoteSession): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    this.sessions.delete(sessionId);
  }

  /* ------------------------------- 路由 ------------------------------- */

  /** `GET …/language-service`：那台机器上的行；连接不上时如实说断了。 */
  async service(
    workspace: Workspace,
    hostId: string,
    settings: JsonValue,
    refresh: boolean,
  ): Promise<LanguageServiceStatus> {
    try {
      const answered = (await executeLanguage(
        hostId,
        "language.discover",
        workspace.rootPath,
        {
          workspaceId: workspace.id,
          allowExecute: workspace.permissions.execute,
          refresh,
          settings,
        },
        true,
      )) as Omit<LanguageServiceStatus, "executionHostId">;
      return { ...answered, executionHostId: hostId };
    } catch (failure) {
      // 老 Worker 不带语言能力是 501：那台机器上确实跑不了，说 `unsupported_remote`。
      // 其余（主机不可达、认证失败、连接断开）是链路问题，说 `link_lost`。
      const unsupported =
        (failure as { status?: unknown }).status === 501 &&
        (failure as { code?: unknown }).code === "unsupported";
      const why = unsupported ? reason.UNSUPPORTED_REMOTE : reason.LINK_LOST;
      return {
        status: "unavailable",
        reason: why,
        executionHostId: hostId,
        servers: placeholderRows(
          unsupported ? "unsupported" : "disconnected",
          why,
        ),
      };
    }
  }

  async open(
    workspace: Workspace,
    hostId: string,
    settings: JsonValue,
    languageId: string,
    clientId: string,
  ): Promise<OpenedSession> {
    const opened = (await executeLanguage(
      hostId,
      "language.open",
      workspace.rootPath,
      {
        workspaceId: workspace.id,
        languageId,
        clientId,
        allowWrite: workspace.permissions.write,
        allowExecute: workspace.permissions.execute,
        settings,
      },
    )) as OpenedSession;
    const session: RemoteSession = {
      hostId,
      workspaceId: workspace.id,
      serverId: opened.serverId,
      generation: opened.generation,
      socket: undefined,
      queue: this.early.get(opened.sessionId)?.frames ?? [],
      timer: undefined,
      sending: Promise.resolve(),
    };
    this.early.delete(opened.sessionId);
    this.sessions.set(opened.sessionId, session);
    session.timer = setTimeout(() => {
      if (this.sessions.get(opened.sessionId) !== session) return;
      if (session.socket !== undefined) return;
      void this.close(workspace.id, opened.sessionId);
    }, PARK_TIMEOUT_MS);
    session.timer.unref?.();
    return opened;
  }

  async close(workspaceId: string, sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.workspaceId !== workspaceId) {
      return false;
    }
    this.forget(sessionId, session);
    try {
      const answered = (await executeLanguage(
        session.hostId,
        "language.close",
        "/",
        { workspaceId, sessionId },
        true,
      )) as { closed?: boolean };
      return answered.closed === true;
    } catch {
      // 连接已经没了：那边的会话随 Worker 一起没了，这里也就算关了。
      return true;
    }
  }

  async edit(
    workspace: Workspace,
    sessionId: string,
    edit: JsonValue,
    expected: Record<string, string>,
  ): Promise<ApplyResult> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.workspaceId !== workspace.id) {
      return notFoundSession();
    }
    return (await executeLanguage(
      session.hostId,
      "language.edit",
      workspace.rootPath,
      { workspaceId: workspace.id, sessionId, edit, expected },
    )) as ApplyResult;
  }

  async control(
    workspace: Workspace,
    hostId: string,
    serverId: string,
    action: Control,
    settings: JsonValue,
  ): Promise<ServerDescriptor> {
    return (await executeLanguage(
      hostId,
      "language.control",
      workspace.rootPath,
      { workspaceId: workspace.id, serverId, action, settings },
    )) as ServerDescriptor;
  }

  /** 授权变了：那台机器上的服务器按新授权停或收窄，与本机同一条规则。 */
  async grants(
    workspaceId: string,
    grants: { write: boolean; execute: boolean } | null,
  ): Promise<void> {
    const hosts = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId) hosts.add(session.hostId);
    }
    for (const hostId of hosts) {
      await executeLanguage(
        hostId,
        "language.grants",
        "/",
        { workspaceId, grants },
        true,
      );
    }
  }

  /** 接上浏览器的 socket；没有这个会话或它已有 socket 时答 `false`。 */
  attach(workspaceId: string, sessionId: string, socket: WebSocket): boolean {
    const session = this.sessions.get(sessionId);
    if (
      session === undefined ||
      session.workspaceId !== workspaceId ||
      session.socket !== undefined
    ) {
      return false;
    }
    session.socket = socket;
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    for (const body of session.queue.splice(0)) socket.send(body);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const body = Buffer.from(data as Buffer).toString("utf8");
      session.sending = session.sending.then(async () => {
        if (this.sessions.get(sessionId) !== session) return;
        try {
          await executeLanguage(session.hostId, "language.send", "/", {
            workspaceId,
            sessionId,
            body,
          });
        } catch {
          // 这条没送到（或送到了但答复丢了）：会话的状态已经说不清，关掉让
          // 编辑器重连，比留着一个悄悄丢了消息的会话诚实。
          socket.close(1011, "The remote language link failed");
        }
      });
    });
    const end = (): void => {
      if (this.sessions.get(sessionId) !== session) return;
      void this.close(workspaceId, sessionId);
    };
    socket.on("close", end);
    socket.on("error", end);
    return true;
  }
}

function notFoundSession(): never {
  throw notFound("No such language session");
}

/** 连接不可用时每种语言一行，写明为什么，而不是一个空面板。 */
export function placeholderRows(
  state: "unsupported" | "disconnected",
  why: string,
): ServerDescriptor[] {
  const rows: ServerDescriptor[] = [];
  for (const entry of languages()) {
    const candidate = entry.candidates[0];
    if (candidate === undefined) continue;
    rows.push({
      serverId: candidate.serverId,
      languageId: entry.languageId,
      fileExtensions: [...entry.extensions],
      executable: "",
      version: "",
      state,
      reason: why,
      features: [...candidate.features],
      restartCount: 0,
      pid: null,
      startTimeUnixMs: null,
      openDocuments: 0,
      probedAtUnixMs: 0,
    });
  }
  return rows;
}

/** core 里唯一的一份。 */
export const remoteLanguage = new RemoteLanguage();
