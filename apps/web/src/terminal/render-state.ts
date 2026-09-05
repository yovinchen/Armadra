/**
 * 终端表面的「视图状态」（终端宿主设计 §7.1 的那张表）。
 *
 * 这一层只回答一个问题：**这个终端此刻该以什么强度渲染**。它和进程无关——
 * 五个状态里没有一个意味着 CLI 结束了，`detached` 和 `disconnected` 尤其不是
 * 「已退出」。执行端的生死只由 `TerminalConnection` 的 `exited` / `failed` 说了算。
 *
 * 纯函数单独放在这里，是因为判定要靠单测钉死：`detached`（我们自己关掉的 socket）
 * 与 `disconnected`（socket 意外没了）长得很像，但对用户的含义完全相反——前者是
 * 「省电，回来就接上」，后者是「有东西断了，正在退避重连」。混成一个之后，界面
 * 要么天天报假警，要么把真的断线藏起来。
 */

import type { TerminalConnection } from "./surface/types";

/* -------------------------------- 视图状态 -------------------------------- */

export type TerminalRenderState =
  | "focused"
  | "visible"
  | "offscreen"
  | "detached"
  | "disconnected";

export interface RenderInputs {
  /** WebSocket 状态机的当前状态。 */
  connection: TerminalConnection;
  /** 节点折叠（`display:none`）。 */
  collapsed: boolean;
  /** `IntersectionObserver` 说它还在视口里。画布不裁剪节点，离屏节点仍在 DOM 上。 */
  onScreen: boolean;
  /** 整个窗口没有切到后台。 */
  pageVisible: boolean;
  /** 键盘焦点确实在这个终端里。 */
  focused: boolean;
  /** 表面**主动**关掉了 socket（折叠宽限到期，或窗口后台过久）。 */
  detached: boolean;
  /** 持有一个渲染名额（见 `render-budget.ts`）。 */
  budgeted: boolean;
}

/**
 * 输入 → 视图状态。优先级从上往下，第一条命中即返回：
 *
 * 1. `detached`——**我们自己**关的 socket。进程还在跑，执行端保留着 VT/tmux
 *    状态，重新可见时会走「reset → attach → 快照/重绘」那条路。这不是错误。
 * 2. `disconnected`——socket **意外**没了：`connection === "detached"`（退避重连
 *    正在跑）或 `failed`（连不上 / 建会话失败）。界面必须能和第 1 条区分开，
 *    否则用户分不清「省下来的」和「断掉的」。
 *    注意 `exited` 不在这里：进程正常结束是结束，不是掉线。
 * 3. `focused`——真的有键盘焦点，**并且**看得见。焦点在一个折叠的节点上
 *    （比如刚被折叠的那一帧）不算，那时候没人在看。
 * 4. `visible`——看得见（未折叠 + 在视口 + 窗口在前台）且持有渲染名额。
 *    没抢到名额的可见终端按 `offscreen` 走：批量写入、不开 WebGL。
 * 5. 其余都是 `offscreen`。
 */
export function resolveRenderState(inputs: RenderInputs): TerminalRenderState {
  if (inputs.detached) return "detached";
  if (inputs.connection === "detached" || inputs.connection === "failed") {
    return "disconnected";
  }
  const visible = !inputs.collapsed && inputs.onScreen && inputs.pageVisible;
  if (!visible) return "offscreen";
  if (inputs.focused) return "focused";
  return inputs.budgeted ? "visible" : "offscreen";
}

/** 该不该走「每帧写穿 + fit + WebGL」这条全速路径。 */
export function rendersActively(state: TerminalRenderState): boolean {
  return state === "focused" || state === "visible";
}

/* -------------------------------- 时序常量 -------------------------------- */

/**
 * 离屏时把攒下来的输出灌进 xterm 的节奏。
 *
 * 不能一帧一写：设计 §7.1 明说「不能因 `display:none` 仍让几十个终端每帧 fit
 * 和重绘」。也不能一直不写——xterm 自己的 scrollback 才是最终的状态机，
 * 攒太久等于把状态挪到一个没有上限的数组里。半秒是个折中。
 */
export const OFFSCREEN_FLUSH_MS = 500;

/**
 * 窗口切到后台多久之后主动 detach（§7.1 的 detached 行）。
 *
 * 比折叠的 5 秒宽松得多：切出去回个消息就掉 socket，回来还要重连一遍，
 * 用户只会觉得应用在抖。一分钟是「真的不在用了」的量级。
 */
export const HIDDEN_DETACH_MS = 60_000;

/**
 * 离屏缓冲的上限（UTF-16 码元数，约等于 2 MiB）。
 *
 * 越界时**从头部丢**：xterm 的 scrollback 本来也只留 5000 行，最早的那些
 * 行无论如何都会被丢掉，丢尾部反而会把最新的画面弄坏。
 */
export const OFFSCREEN_BUFFER_LIMIT = 2 * 1024 * 1024;

/* ------------------------------- 离屏缓冲 --------------------------------- */

export interface OffscreenBuffer {
  /** 按到达顺序排列的分片；灌回 xterm 时原样拼接。 */
  chunks: string[];
  /** `chunks` 的码元总数，省得每次重算。 */
  size: number;
  /** 因越界从头部丢掉的码元数。只做记录，不改动画面。 */
  dropped: number;
}

export function createOffscreenBuffer(): OffscreenBuffer {
  return { chunks: [], size: 0, dropped: 0 };
}

/**
 * 攒一段输出。**永远不重排、不合并**——PTY 的字节流里半个转义序列也不能错位。
 *
 * 唯一允许的损失是越界后从头部整片丢弃，并记在 `dropped` 里。
 */
export function bufferOffscreenChunk(
  buffer: OffscreenBuffer,
  chunk: string,
  limit: number = OFFSCREEN_BUFFER_LIMIT,
): OffscreenBuffer {
  if (chunk === "") return buffer;
  buffer.chunks.push(chunk);
  buffer.size += chunk.length;
  while (buffer.size > limit && buffer.chunks.length > 1) {
    const oldest = buffer.chunks.shift() as string;
    buffer.size -= oldest.length;
    buffer.dropped += oldest.length;
  }
  return buffer;
}

/** 取出全部内容并清空。`dropped` 保留：它是这个表面的累计计数。 */
export function drainOffscreenBuffer(buffer: OffscreenBuffer): string {
  if (buffer.chunks.length === 0) return "";
  const text = buffer.chunks.join("");
  buffer.chunks.length = 0;
  buffer.size = 0;
  return text;
}
