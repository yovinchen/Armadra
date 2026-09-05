import type { TerminalNodeData, TerminateMode } from "@armadra/shared";
import type { TerminalRenderState } from "../render-state";

export type TerminalConnection =
  | "idle"
  | "starting"
  | "connecting"
  | "live"
  | "detached"
  | "exited"
  | "failed";

export interface TerminalSurfaceStatus {
  connection: TerminalConnection;
  exitCode: number | null;
  error: string | null;
  /** Actual PTY identity from the current transport hello; never provider IDs. */
  binding?: { sessionId: string; generation: number } | null;
  /**
   * 视图状态（终端宿主设计 §7.1）。与 `connection` 正交：它只说这个终端此刻
   * 以什么强度渲染，进程的死活仍然只看 `connection`。
   */
  render: TerminalRenderState;
}

/**
 * 表面内部维护的那一半状态。
 *
 * `render` 不在里面：它是从折叠 / 视口 / 窗口前后台 / 焦点 / 渲染名额算出来的
 * 派生值，放进 `patch()` 能改的状态里，迟早会有人用一次连接事件把它覆盖掉。
 */
export type ConnectionStatus = Omit<TerminalSurfaceStatus, "render">;

export interface TerminalSurfaceHandle {
  /** 搜索（⌘F 打开的输入框调它）。 */
  find: (query: string, direction?: "next" | "previous") => void;
  clearSearch: () => void;
  focus: () => void;
  /** 三级 terminate（§15.5）。 */
  terminate: (mode: TerminateMode) => void;
  /** 丢弃当前会话并新建一个（重新运行）。 */
  restart: () => void;
  /** 同一 session_key 换新 generation。 */
  recycle: () => void;
  /** 直接写一行到 PTY（重启 Agent、投递消息用）。 */
  writeLine: (line: string) => void;
  /**
   * 原样写进 PTY，不补回车。手机软键盘工具条用它发 Esc / Tab / 方向键 /
   * 控制码——那些键触摸键盘上根本没有。
   */
  sendKeys: (data: string) => void;
  /** 右键菜单「复制」。没有选区时是空操作。 */
  copySelection: () => void;
  /** 右键菜单「粘贴」。 */
  paste: () => void;
}

export interface TerminalSurfaceProps {
  nodeId: string;
  data: TerminalNodeData;
  collapsed: boolean;
  onStatusChange?: (status: TerminalSurfaceStatus) => void;
  /** 收到 BEL：头部图标闪一下，**不改变任何尺寸**（§18.2 规则 1）。 */
  onBell?: () => void;
  /** ⌘F：打开头部的搜索 Popover（§18.3 搜索行），不进终端。 */
  onFind?: () => void;
  ref?: React.Ref<TerminalSurfaceHandle>;
}
