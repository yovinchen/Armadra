import { resolveSocketBase, runtimeSocketUrl } from "./runtime-url";
import { RUNTIME_URL, query } from "./request";

/* ------------------------------- WebSocket URL ---------------------------- */

/**
 * WebSocket 的基址不一定等于 HTTP 的基址：桌面壳里 Runtime 的端口由内核分配，
 * 两个基址都由壳在页面加载前一并给出（electron-migration §2.1）。由
 * {@link initRuntimeSockets} 在建立任何 socket 之前定下来。
 */
let socketBase = RUNTIME_URL;

/** 应用启动时调用一次；壳之外保持 HTTP 基址，二者本来就相同。 */
export async function initRuntimeSockets(): Promise<string> {
  socketBase = resolveSocketBase(RUNTIME_URL);
  return socketBase;
}

function socketUrl(pathname: string): string {
  return runtimeSocketUrl(socketBase, pathname);
}

/**
 * `writerId` 让 Runtime 在 `hello` 里带回这个客户端已经落地的输入序号，
 * 重连时只重发没落地的那几条（见 `terminal/input-log.ts`）。
 */
export function terminalWebSocketUrl(
  sessionId: string,
  writerId?: string,
): string {
  const base = socketUrl(`/api/terminals/${sessionId}/ws`);
  return writerId ? `${base}?writer=${query(writerId)}` : base;
}

/** 工作空间事件流：agent.status / agent.approval / terminal.exit / board.changed。 */
export function workspaceEventsUrl(workspaceId: string): string {
  return socketUrl(`/api/workspaces/${workspaceId}/events`);
}

/**
 * 一个语言会话一条 WebSocket（语言服务设计 §2.9）。
 *
 * 文本帧就是一条 JSON-RPC 消息。不复用工作空间事件流：那条是单向推送，
 * 而会话必须能往上发；会话*状态*仍走事件流，所以状态栏和设置页不必为了
 * 看一眼状态就开一条会话 socket。
 */
export function languageSessionUrl(
  workspaceId: string,
  sessionId: string,
): string {
  return socketUrl(
    `/api/workspaces/${workspaceId}/language/sessions/${query(sessionId)}/stream`,
  );
}

/**
 * 单个浏览器会话的专用画面流（设计 §2.9）。
 *
 * 帧是二进制 Protobuf，不走工作空间事件通道：那条通道是所有客户端共读的，
 * 一路 base64 图片会让每个客户端都付一次解码代价，而且它没法逐订阅者确认。
 * Host 的 `proxyStream` 原样代理这条连接，不看里面是什么。
 */
export function browserStreamUrl(
  workspaceId: string,
  sessionId: string,
): string {
  return socketUrl(
    `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/stream`,
  );
}
