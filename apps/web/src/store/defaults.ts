import type {
  CanvasNodeData,
  CanvasNodeType,
  Size,
} from "@ai-coding-canvas/shared";
import { t } from "../app/preferences-store";
import { nodeMeta } from "../nodes/registry";

/**
 * 新建节点时的默认值 —— docs/v3-agent-terminal-plan.md §3.4。
 *
 * 尺寸 / 颜色 / 标签的唯一真相是 `nodes/registry.ts` 的 `nodeMeta()`（归属
 * nodes agent），这里只做转发，绝不复制那张表——两处各写一份尺寸是上一版
 * 「节点尺寸对不上」的根因。
 *
 * ⚠ 所有查表都发生在函数体里而不是模块顶层：`store → nodes/registry →
 * NodeShell → store` 是一个合法的 ESM 环，顶层求值会拿到未初始化的绑定。
 */

/**
 * 浏览器节点的默认页：Google 搜索。裸 `google.com` 带 `X-Frame-Options:
 * SAMEORIGIN`，在 iframe 里一片空白；`webhp?igu=1` 是 Google 自己保留的可嵌入
 * 入口（实测无 frame 限制），从它发起的搜索会带着 `igu=1` 一路可见。
 */
export const DEFAULT_BROWSER_URL = "https://www.google.com/webhp?igu=1";

/** 折叠后只剩头部（§3.4）。 */
export const COLLAPSED_HEIGHT = 40;

export function defaultNodeSize(type: CanvasNodeType): Size {
  return { ...nodeMeta(type).defaultSize };
}

export function minNodeSize(type: CanvasNodeType): Size {
  return { ...nodeMeta(type).minSize };
}

export function defaultNodeColor(type: CanvasNodeType): string {
  return nodeMeta(type).defaultColor;
}

/**
 * 头部标题的默认值；用户随时可以改写。
 *
 * 标题一旦写进文档就是用户数据，所以在这里按**当时**的语言定死，
 * 之后切语言不会把已有节点的标题改掉。
 */
export function defaultNodeTitle(type: CanvasNodeType): string {
  return t(nodeMeta(type).labelKey);
}

export interface NodeDataContext {
  /** 工作空间根目录：files / diff 节点的落点。 */
  workspaceRoot?: string;
}

/**
 * 每种节点的最小可用 data。调用方给的 `data` 会浅覆盖在它上面，
 * 所以「打开某个文件」只需要传 `{ path }`。
 */
export function defaultNodeData(
  type: CanvasNodeType,
  context: NodeDataContext = {},
): CanvasNodeData {
  const root = context.workspaceRoot?.trim() || ".";
  switch (type) {
    case "terminal":
      return { kind: "terminal" };
    case "sticky":
      return { kind: "sticky", content: "" };
    case "group":
      return { kind: "group" };
    case "editor":
      // `path` 是必填且非空；真实路径由打开文件的一方覆盖。
      return { kind: "editor", path: root };
    case "diff":
      return { kind: "diff", repoPath: root, scope: "worktree" };
    case "files":
      return { kind: "files", path: root };
    case "browser":
      return { kind: "browser", url: DEFAULT_BROWSER_URL };
  }
}
