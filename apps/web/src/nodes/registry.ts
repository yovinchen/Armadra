import { lazy, type ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CalendarClock,
  FileCode2,
  FolderTree,
  GitCompare,
  Globe,
  Group,
  StickyNote,
  Terminal,
} from "lucide-react";
import {
  DEFAULT_NODE_COLOR,
  type CanvasNode,
  type CanvasNodeType,
  type Size,
} from "@armadra/shared";

/**
 * 节点体按种类懒加载（§17「代码分割」）。
 *
 * 这张表以前是八条顶层 import，于是一块空画布也要把八种节点体全部加载：
 * 终端拖着 xterm（443 kB）、编辑器拖着 CodeMirror（862 kB）与语言服务
 * （153 kB）、对比拖着三方合并（834 kB）、便签拖着 react-markdown
 * （544 kB）——实测空闲时页面已加载 6.17 MB JS，其中这一段占 2.8 MB，而画
 * 布上一个节点都没有。
 *
 * `NODE_BODY[type]` 只在画布上真的有那一种节点时才被渲染，所以懒加载的边界
 * 就落在这里最自然。两个渲染点（`ArmadraNode`、`MobileFocusPage`）各自包了
 * `<Suspense fallback={null}>`：节点壳、头部、尺寸都是外面画的，等的只是壳
 * 里那一块，而它本来就要等自己的数据。
 *
 * `NODE_META` 不动：图标与尺寸是同步读的（新建节点要立刻知道默认大小），
 * 而 lucide 图标本来就在入口 chunk 里。
 */
function body<T extends string>(
  name: T,
  load: () => Promise<Record<T, ComponentType<NodeBodyProps>>>,
): ComponentType<NodeBodyProps> {
  return lazy<ComponentType<NodeBodyProps>>(() =>
    load().then((module) => ({ default: module[name] })),
  );
}

/* -------------------------------------------------------------------------- */
/* 契约（计划书 §13.2 / React Flow 计划 §2.2）                                  */
/* -------------------------------------------------------------------------- */

export interface NodeBodyProps {
  id: string;
  node: CanvasNode;
  selected: boolean;
  collapsed: boolean;
  focused: boolean;
}

export interface NodeMeta {
  /** i18n 键，不是文案：渲染时用 `useT()` 翻译，切语言立刻跟着变。 */
  labelKey: string;
  icon: LucideIcon;
  defaultSize: Size;
  minSize: Size;
  defaultColor: string;
  /**
   * 左右两侧的上下文链接把手。§21 起除了分组，**每种节点都有**：
   * 任意两个节点都能连线，连上之后 Agent 就能读对方的内容。
   */
  hasBridgeHandles: boolean;
}

/**
 * 头部拖拽把手。这个类名直接就是 React Flow 的 `dragHandle` 选择器
 * （`sync/project.ts` 投影时给的），所以「哪块能拖」只在这里定义一次。
 */
export const DRAG_HANDLE_CLASS = "drag-handle";
export const NODE_DRAG_HANDLE = `.${DRAG_HANDLE_CLASS}`;

export { COLLAPSED_HEIGHT, HEADER_HEIGHT } from "./geometry";

/** 便签的默认色 = 调色板里的黄（`--node-color-3`）。 */
const STICKY_COLOR = "#ffd60a";

/**
 * 分组由 `flow/nodes/GroupNode.tsx` 自己画，没有节点体。
 * 键保留只为让类型完备：漏登记一种新节点类型必须是编译错误。
 */
const GroupNodeBody: ComponentType<NodeBodyProps> = () => null;

/**
 * 尺寸表逐字来自计划书 §3.4。改这里之前先改文档——
 * `registry.test.ts` 会逐条比对。
 *
 * 2026-09-19 上调了一轮默认尺寸。旧表是按「画布上的一张卡片」定的，于是
 * 浏览器只有 900×620、终端只有 640×440——两者装下的内容都比一个真窗口少
 * 一截。现在按**内容自己的标准尺寸**定：浏览器等于一块标准视口 1280×800，
 * 终端 960×600 在 12px 字号下排得下约 120×36，其余按同一口径跟上。
 * 最小尺寸跟着抬，是为了让节点缩到最小时仍是「一块能用的内容区」。
 */
export const NODE_META: Record<CanvasNodeType, NodeMeta> = {
  terminal: {
    labelKey: "node.terminal",
    icon: Terminal,
    defaultSize: { width: 960, height: 600 },
    minSize: { width: 320, height: 200 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  sticky: {
    labelKey: "node.sticky",
    icon: StickyNote,
    defaultSize: { width: 280, height: 220 },
    minSize: { width: 160, height: 120 },
    defaultColor: STICKY_COLOR,
    hasBridgeHandles: true,
  },
  group: {
    labelKey: "node.group",
    icon: Group,
    defaultSize: { width: 800, height: 560 },
    minSize: { width: 200, height: 140 },
    defaultColor: DEFAULT_NODE_COLOR,
    // frame 自己有标签与裁剪，把手在它身上没有意义。
    hasBridgeHandles: false,
  },
  editor: {
    labelKey: "node.editor",
    icon: FileCode2,
    defaultSize: { width: 960, height: 640 },
    minSize: { width: 320, height: 200 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  diff: {
    labelKey: "node.diff",
    icon: GitCompare,
    defaultSize: { width: 1200, height: 700 },
    minSize: { width: 420, height: 220 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  files: {
    labelKey: "node.files",
    icon: FolderTree,
    defaultSize: { width: 360, height: 640 },
    minSize: { width: 220, height: 160 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  browser: {
    labelKey: "node.browser",
    icon: Globe,
    defaultSize: { width: 1280, height: 800 },
    minSize: { width: 480, height: 320 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  // 两张 Host 侧卡片：内容都从 Host 读，连线拿不到任何东西，所以不给把手。
  automation: {
    labelKey: "node.automation",
    icon: CalendarClock,
    defaultSize: { width: 360, height: 260 },
    minSize: { width: 260, height: 180 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: false,
  },
  agentActivity: {
    labelKey: "node.agentActivity",
    icon: Activity,
    defaultSize: { width: 340, height: 240 },
    minSize: { width: 240, height: 160 },
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: false,
  },
};

export const NODE_BODY: Record<CanvasNodeType, ComponentType<NodeBodyProps>> = {
  terminal: body("TerminalNode", () => import("./TerminalNode")),
  sticky: body("StickyNode", () => import("./StickyNode")),
  group: GroupNodeBody,
  editor: body("EditorNode", () => import("./EditorNode")),
  diff: body("DiffNode", () => import("./DiffNode")),
  files: body("FilesNode", () => import("./FilesNode")),
  browser: body("BrowserNode", () => import("./browser")),
  automation: body("AutomationNode", () => import("./AutomationNode")),
  agentActivity: body("AgentActivityNode", () => import("./AgentActivityNode")),
};

/**
 * 这些类型自己渲染 `NodeShell`，`ArmadraShapeUtil` 不再包一层。
 *
 * 原因很实际：它们的头部按钮（中断 / 保存 / 刷新 / 面包屑 / 地址栏）
 * 的状态就住在节点体里，从外面包壳就得把状态再抬一层。便签没有头部插槽，
 * 走通用包壳。
 */
export const NODE_SHELL_SELF: ReadonlySet<CanvasNodeType> =
  new Set<CanvasNodeType>([
    "terminal",
    "editor",
    "diff",
    "files",
    "browser",
    "automation",
    "agentActivity",
  ]);

export function nodeMeta(type: CanvasNodeType): NodeMeta {
  return NODE_META[type];
}

export function defaultNodeSize(type: CanvasNodeType): Size {
  return nodeMeta(type).defaultSize;
}

export function minNodeSize(type: CanvasNodeType): Size {
  return nodeMeta(type).minSize;
}
