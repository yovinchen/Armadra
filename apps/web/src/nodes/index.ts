/**
 * 节点模块的对外面（计划书 §13.2 / tldraw 计划 §9.4）。
 *
 * 画布侧的入口不再是 React Flow 的 `nodeTypes`，而是 `canvas/shapes/
 * AiccShapeUtil` —— 它按 `NODE_BODY` 渲染节点体，按 `NODE_META` 夹住最小
 * 尺寸。这里只保留菜单、面板、侧栏要用的东西。
 */
export { NodeShell, maximizeRect, type NodeShellProps } from "./NodeShell";
export {
  COLLAPSED_HEIGHT,
  DRAG_HANDLE_CLASS,
  HEADER_HEIGHT,
  NODE_BODY,
  NODE_DRAG_HANDLE,
  NODE_META,
  NODE_SHELL_SELF,
  defaultNodeSize,
  minNodeSize,
  nodeMeta,
  type NodeBodyProps,
  type NodeMeta,
} from "./registry";
export { SubagentCard, type SubagentCardProps } from "./SubagentCard";
export { normalizeUrl } from "./BrowserNode";
export { breadcrumbs } from "./FilesNode";
