import { resolveSocketBase, runtimeSocketUrl } from "./runtime-url";
import { RUNTIME_URL, query } from "./request";

/* ------------------------------- WebSocket URL ---------------------------- */

/**
 * WebSocket 的基址不一定等于 HTTP 的基址：打包桌面壳里 HTTP 走 `armadra://`
 * 自定义协议，而 ws 只能走壳开的回环转发端口（roadmap §4.4）。端口每次启动随机，
 * 所以由 {@link initRuntimeSockets} 在建立任何 socket 之前问一次壳。
 */
let socketBase = RUNTIME_URL;

/** 应用启动时调用一次；失败时保持 HTTP 基址，浏览器模式下二者本来就相同。 */
export async function initRuntimeSockets(): Promise<string> {
  socketBase = await resolveSocketBase(RUNTIME_URL);
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
