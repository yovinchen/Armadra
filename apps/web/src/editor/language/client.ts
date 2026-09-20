import type { Extension } from "@codemirror/state";
import { LSPClient } from "@codemirror/lsp-client";
import {
  LANGUAGE_UNSUPPORTED_REASONS,
  type LanguageServerState,
} from "@armadra/shared";

import {
  RuntimeRequestError,
  languageSessionUrl,
  runtimeApi,
} from "@/api/client";
import { ArmadraWorkspace } from "./documents";
import { armadraDiagnostics } from "./diagnostics";
import { useDiagnosticsStore } from "./diagnostics-store";
import { sanitizeHTML } from "./sanitize";
import { createSessionTransport, type SessionTransport } from "./transport";
import { useLanguageStatusStore } from "./status-store";
import { WORKSPACE_SCHEME } from "./uri";

/**
 * 一个工作空间、一种语言一个客户端（语言服务设计 §2.1、§4.2 `client.ts`）。
 *
 * 多个编辑器节点共用它：Runtime 的会话是按（工作空间, 语言）分的，所以
 * 每开一个节点就开一条会话会让影子文档在执行主机那边重复一份。节点用
 * 引用计数持有这里的客户端，最后一个走的时候关会话。
 *
 * **Web 不知道 server 在哪台机器上。** 会话回答里没有绝对路径，uri 全是
 * `armadra:///<rel>`，连「本机还是远端」都不是这一层的知识。
 */

/** 一条会话在 Web 侧的全部可见状态。 */
export interface LanguageClientState {
  state: LanguageServerState;
  reason?: string;
  serverId: string;
  sessionId: string | null;
  /** 断线退避中；重连成功后会重新 `didOpen` 全部打开的文件。 */
  reconnecting: boolean;
}

/** 断线重连的退避（上限 5 次，设计 §4.2）。 */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * 单条请求的客户端超时。执行主机侧是 30 s（§3.3），比它短会留下一个
 * 执行主机还在等、浏览器已经放弃的请求；比它长只是白等。
 */
const REQUEST_TIMEOUT_MS = 30_000;

export class LanguageClient {
  lsp: LSPClient | null = null;
  workspace: ArmadraWorkspace | null = null;
  private transport: SessionTransport | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private started: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  status: LanguageClientState = {
    state: "starting",
    serverId: "",
    sessionId: null,
    reconnecting: false,
  };

  constructor(
    readonly workspaceId: string,
    readonly languageId: string,
    /** 测试注入假 WebSocket；生产里就是全局构造函数。 */
    private readonly socketFactory?: (url: string) => WebSocket,
  ) {}

  /** 状态变化订阅；状态栏用。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(patch: Partial<LanguageClientState>): void {
    this.status = { ...this.status, ...patch };
    useLanguageStatusStore.getState().setSession({
      workspaceId: this.workspaceId,
      languageId: this.languageId,
      sessionId: this.status.sessionId,
      serverId: this.status.serverId,
      state: this.status.state,
      reason: this.status.reason,
      restartCount: 0,
      reconnecting: this.status.reconnecting,
    });
    for (const listener of [...this.listeners]) listener();
  }

  /** 开会话；重复调用返回同一个 promise。 */
  start(): Promise<void> {
    this.started ??= this.open();
    return this.started;
  }

  private async open(): Promise<void> {
    try {
      await ensureDiscovered(this.workspaceId);
      const session = await runtimeApi.openLanguageSession(this.workspaceId, {
        languageId: this.languageId,
        clientId: `web-${Math.random().toString(36).slice(2, 10)}`,
      });
      if (this.disposed) {
        void runtimeApi
          .closeLanguageSession(this.workspaceId, session.sessionId)
          .catch(() => undefined);
        return;
      }
      this.publish({
        state: session.state,
        reason: session.reason,
        serverId: session.serverId,
        sessionId: session.sessionId,
        reconnecting: false,
      });
      // `unsupported` 是一个答案，不是失败：不开 socket、不装补全源，
      // 状态栏照着 reason 说缺的是什么（§6.1 第 1、3 条）。
      if (session.state === "unsupported") return;
      this.connect(session.sessionId);
    } catch (error) {
      if (this.disposed) return;
      this.publish({ state: "unsupported", reason: refusalReason(error) });
    }
  }

  private connect(sessionId: string): void {
    const lsp =
      this.lsp ??
      new LSPClient({
        rootUri: `${WORKSPACE_SCHEME}:///`,
        timeout: REQUEST_TIMEOUT_MS,
        sanitizeHTML,
        workspace: (client) => new ArmadraWorkspace(client),
        extensions: [armadraDiagnostics()],
      });
    this.lsp = lsp;
    this.workspace = lsp.workspace as ArmadraWorkspace;
    this.transport = createSessionTransport(
      languageSessionUrl(this.workspaceId, sessionId),
      {
        onOpen: () => {
          this.reconnectAttempt = 0;
          if (this.status.reconnecting) this.publish({ reconnecting: false });
        },
        onClose: () => this.scheduleReconnect(),
      },
      this.socketFactory,
    );
    lsp.connect(this.transport);
    // `initializing` 在 server 一直不答 `initialize` 时会被拒绝。没有人等它
    // （我们不 await 初始化，扩展是热插的），所以这里显式收掉——否则每一次
    // 断线都在控制台留下一条无人处理的 rejection。真正的处置是重连。
    void lsp.initializing.catch(() => undefined);
  }

  /**
   * 断线后重开一条**新会话**，而不是重连旧的那条。
   *
   * 旧会话的出口在 Runtime 那边随 socket 一起没了（合并前的实现 的 `pump`
   * 退出即丢弃接收端），所以「重连同一个 sessionId」只会得到一条哑管道。
   * 新会话建好后 `LSPClient.connect` 会调 `workspace.connected()`，把打开
   * 的文件重新 `didOpen` 一遍，正是 §1.3 说的重放。
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const previous = this.status.sessionId;
    if (previous) {
      void runtimeApi
        .closeLanguageSession(this.workspaceId, previous)
        .catch(() => undefined);
    }
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.publish({ state: "disconnected", reconnecting: false });
      this.clearDiagnostics();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.reconnectAttempt += 1;
    this.publish({ reconnecting: true, sessionId: null });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      void this.reopen();
    }, delay);
  }

  private async reopen(): Promise<void> {
    try {
      const session = await runtimeApi.openLanguageSession(this.workspaceId, {
        languageId: this.languageId,
        clientId: `web-${Math.random().toString(36).slice(2, 10)}`,
      });
      if (this.disposed) return;
      this.publish({
        state: session.state,
        reason: session.reason,
        serverId: session.serverId,
        sessionId: session.sessionId,
      });
      if (session.state === "unsupported") {
        this.publish({ reconnecting: false });
        return;
      }
      this.transport?.close();
      this.lsp?.disconnect();
      this.connect(session.sessionId);
    } catch {
      if (!this.disposed) this.scheduleReconnect();
    }
  }

  /** 这个视图要用的扩展；没有会话时返回空数组（不装补全源，§6.1 第 1 条）。 */
  plugin(uri: string): Extension {
    if (!this.lsp || this.status.state === "unsupported") return [];
    return this.lsp.plugin(uri, this.languageId);
  }

  private clearDiagnostics(): void {
    const uris = (this.workspace?.files ?? []).map((file) => file.uri);
    useDiagnosticsStore.getState().clear(uris.length > 0 ? uris : undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearDiagnostics();
    this.transport?.close();
    this.transport = null;
    this.lsp?.disconnect();
    this.lsp = null;
    this.workspace = null;
    const sessionId = this.status.sessionId;
    if (sessionId) {
      void runtimeApi
        .closeLanguageSession(this.workspaceId, sessionId)
        .catch(() => undefined);
    }
    useLanguageStatusStore
      .getState()
      .dropSession(this.workspaceId, this.languageId);
    this.listeners.clear();
  }
}

/**
 * 这块工作空间探测过没有。
 *
 * Runtime 只启动**探测时冻结的绝对路径**（设计 §3.2），而探测结果是
 * `GET …/language-service` 写进设置缓存的。所以在一个刚起来的 Runtime 上，
 * 第一条会话必须排在第一次探测之后——否则它得到的是 `server_not_found`，
 * 而机器上明明装着 server。
 *
 * 每块工作空间一次：Runtime 侧的探测缓存 24 小时，这里只是保证「有过一次」。
 * 顺带把描述符放进状态 store，设置页与状态栏因此不必各拉一遍。
 */
const discovered = new Map<string, Promise<void>>();

function ensureDiscovered(workspaceId: string): Promise<void> {
  let pending = discovered.get(workspaceId);
  if (!pending) {
    pending = runtimeApi
      .languageService(workspaceId)
      .then((status) => {
        useLanguageStatusStore
          .getState()
          .setServers(workspaceId, status.servers);
      })
      // 探测失败不该挡住开会话：会话自己会给出它的答案与 reason。
      .catch(() => undefined);
    discovered.set(workspaceId, pending);
  }
  return pending;
}

/**
 * 会话开不起来时说清楚是为什么。
 *
 * Runtime 对「没有执行授权」回的是 403，`message` 就是那个稳定 reason key
 * （`execution_not_granted`）。把它原样留下来，界面才能照着 §6.1 第 3 条说
 * 「需要工作区的执行权限」，而不是一句放之四海的「打不开」。认不出来的错误
 * （断网、502）才落到 `session_failed`。
 */
function refusalReason(error: unknown): string {
  const message =
    error instanceof RuntimeRequestError ? error.message.trim() : "";
  return (LANGUAGE_UNSUPPORTED_REASONS as readonly string[]).includes(message)
    ? message
    : "session_failed";
}

/* --------------------------------- 注册表 --------------------------------- */

interface Entry {
  client: LanguageClient;
  refs: number;
}

const clients = new Map<string, Entry>();

function key(workspaceId: string, languageId: string): string {
  return `${workspaceId} ${languageId}`;
}

/**
 * 取（或新建）一个客户端并计一次引用。返回的 `release` 必须调用；最后一个
 * 引用消失时会话关闭，影子文档在执行主机那边引用减一。
 */
export function acquireLanguageClient(
  workspaceId: string,
  languageId: string,
  socketFactory?: (url: string) => WebSocket,
): { client: LanguageClient; release: () => void } {
  const id = key(workspaceId, languageId);
  const entry = clients.get(id) ?? {
    client: new LanguageClient(workspaceId, languageId, socketFactory),
    refs: 0,
  };
  if (!clients.has(id)) clients.set(id, entry);
  entry.refs += 1;
  void entry.client.start();

  let released = false;
  return {
    client: entry.client,
    release: () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      clients.delete(id);
      entry.client.dispose();
    },
  };
}

/**
 * 当前活着的全部客户端。
 *
 * 工作空间符号（`#`）要问遍每一种开着的语言：一个 Rust server 不知道
 * TypeScript 文件里有什么，所以这件事只能是「问所有人再合起来」。
 */
export function listLanguageClients(): LanguageClient[] {
  return [...clients.values()].map((entry) => entry.client);
}

/** 已经建起来的客户端，不新建。命令与预览对话框用。 */
export function peekLanguageClient(
  workspaceId: string,
  languageId: string,
): LanguageClient | null {
  return clients.get(key(workspaceId, languageId))?.client ?? null;
}

/** 测试与工作空间切换用：全部关掉。 */
export function resetLanguageClients(): void {
  for (const entry of clients.values()) entry.client.dispose();
  clients.clear();
  discovered.clear();
  useDiagnosticsStore.getState().clear();
}
