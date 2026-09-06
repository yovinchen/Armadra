/**
 * 工作空间事件流（§5.4 / §7 / §13.4）。
 *
 * 一个工作空间一条 WebSocket：`App` 里 `useWorkspaceEvents` 挂一次，
 * 其余模块通过 `onWorkspaceEvent(type, handler)` 订阅，不各自开连接。
 *
 * 每一帧都先 `workspaceEventSchema` 解析；解析失败只丢这一帧并告警，
 * 不断开连接（Runtime 可能比前端新，多出来的事件类型不该让侧栏失效）。
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceEventSchema, type WorkspaceEvent } from "@armadra/shared";

import { workspaceEventsUrl } from "./client";
import { useAgentStatusStore } from "../agent/status-store";
import { useLanguageStatusStore } from "../editor/language/status-store";

type EventType = WorkspaceEvent["type"];
type EventOf<T extends EventType> = Extract<WorkspaceEvent, { type: T }>;
type AnyHandler = (event: WorkspaceEvent) => void;

const handlers = new Map<EventType, Set<AnyHandler>>();
type ConnectionHandler = (workspaceId: string, connected: boolean) => void;
const connectionHandlers = new Set<ConnectionHandler>();
/** Transport lifecycle lets volatile read models discard a previous runtime's cache. */
export function onWorkspaceConnection(handler: ConnectionHandler): () => void {
  connectionHandlers.add(handler);
  return () => {
    connectionHandlers.delete(handler);
  };
}

/** 订阅一种事件；返回退订函数。 */
export function onWorkspaceEvent<T extends EventType>(
  type: T,
  handler: (event: EventOf<T>) => void,
): () => void {
  const bucket = handlers.get(type) ?? new Set<AnyHandler>();
  handlers.set(type, bucket);
  const wrapped = handler as AnyHandler;
  bucket.add(wrapped);
  return () => {
    bucket.delete(wrapped);
  };
}

/**
 * 派发一条已解析的事件：先喂状态镜像，再通知订阅者。
 * 导出是为了让不接 WebSocket 的测试与本地回放也能走同一条路径。
 */
export function dispatchWorkspaceEvent(event: WorkspaceEvent): void {
  useAgentStatusStore.getState().handleEvent(event);
  // 语言会话与服务器状态走同一条流（语言服务设计 §2.9）：状态栏和设置页
  // 因此不必为了看一眼状态就开一条会话 socket。
  useLanguageStatusStore.getState().handleEvent(event);
  for (const handler of handlers.get(event.type) ?? []) handler(event);
}

/* ------------------------------- 重连退避 -------------------------------- */

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;

/** 指数退避 1s → 2s → 4s → 8s → 10s（封顶）。 */
export function nextReconnectDelay(previous: number | null): number {
  if (previous === null || previous <= 0) return RECONNECT_MIN_MS;
  return Math.min(previous * 2, RECONNECT_MAX_MS);
}

/* -------------------------------- 连接管理 ------------------------------- */

interface Connection {
  workspaceId: string;
  socket: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  delay: number | null;
  refs: number;
  stopped: boolean;
}

let current: Connection | null = null;

function parseFrame(raw: unknown): WorkspaceEvent | null {
  if (typeof raw !== "string") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = workspaceEventSchema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}

function open(connection: Connection): void {
  if (connection.stopped) return;
  const Socket = globalThis.WebSocket;
  if (!Socket) return;

  let socket: WebSocket;
  try {
    socket = new Socket(workspaceEventsUrl(connection.workspaceId));
  } catch {
    schedule(connection);
    return;
  }
  connection.socket = socket;

  socket.onopen = () => {
    if (connection.socket !== socket || connection.stopped) return;
    connection.delay = null;
    for (const handler of connectionHandlers)
      handler(connection.workspaceId, true);
  };
  socket.onmessage = (event: MessageEvent) => {
    const parsed = parseFrame(event.data);
    if (parsed) dispatchWorkspaceEvent(parsed);
  };
  socket.onclose = () => {
    if (connection.socket !== socket || connection.stopped) return;
    for (const handler of connectionHandlers)
      handler(connection.workspaceId, false);
    connection.socket = null;
    schedule(connection);
  };
  // `onerror` 之后浏览器一定会再发 `onclose`，重连只挂在 close 上，避免排两次。
  socket.onerror = () => {};
}

function schedule(connection: Connection): void {
  if (connection.stopped || connection.timer) return;
  const delay = nextReconnectDelay(connection.delay);
  connection.delay = delay;
  connection.timer = setTimeout(() => {
    connection.timer = null;
    open(connection);
  }, delay);
}

function teardown(connection: Connection): void {
  for (const handler of connectionHandlers)
    handler(connection.workspaceId, false);
  connection.stopped = true;
  if (connection.timer) clearTimeout(connection.timer);
  connection.timer = null;
  const socket = connection.socket;
  connection.socket = null;
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }
  if (current === connection) current = null;
}

/**
 * 连接（或复用）某个工作空间的事件流，返回释放函数。
 * 引用计数保证 StrictMode 的双次挂载不会来回开关连接。
 */
export function connectWorkspaceEvents(workspaceId: string): () => void {
  if (current && current.workspaceId !== workspaceId) teardown(current);
  const connection: Connection = current ?? {
    workspaceId,
    socket: null,
    timer: null,
    delay: null,
    refs: 0,
    stopped: false,
  };
  if (!current) {
    current = connection;
    open(connection);
  }
  connection.refs += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    connection.refs -= 1;
    if (connection.refs <= 0) teardown(connection);
  };
}

/** 测试与热重载用：断开当前连接并清空订阅者。 */
export function resetWorkspaceEvents(): void {
  if (current) teardown(current);
  handlers.clear();
  connectionHandlers.clear();
}

/* --------------------------------- Hook ---------------------------------- */

/**
 * App 挂一次。除了维持连接，还负责把服务端事件翻译成查询失效：
 * 会话列表与 Git 状态都是「服务端为准」的读模型，事件到了就重取。
 */
export function useWorkspaceEvents(workspaceId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;
    const release = connectWorkspaceEvents(workspaceId);
    const invalidate = () => {
      void queryClient.invalidateQueries({
        queryKey: ["sessions", workspaceId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["git-status", workspaceId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["git-diff", workspaceId],
      });
    };
    const offExit = onWorkspaceEvent("terminal.exit", invalidate);
    const offBoard = onWorkspaceEvent("board.changed", invalidate);
    return () => {
      offExit();
      offBoard();
      release();
    };
  }, [workspaceId, queryClient]);
}
