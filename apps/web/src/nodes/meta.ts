import {
  FileCode2,
  FileDiff,
  FolderOpen,
  Globe,
  Image,
  ListTodo,
  ScrollText,
  Sparkles,
  SquareTerminal,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import type {
  CanvasEdgeType,
  CanvasNodeType,
  NodeStatus,
  Size,
} from "@ai-coding-canvas/shared";

/**
 * Static node/status/edge vocabulary (docs/redesign-plan.md §6).
 * Kept apart from `index.ts` so `actions.ts` can read it without an import
 * cycle; every symbol is re-exported from `nodes/index.ts`.
 */

export interface NodeMeta {
  /** zh-CN display text; prefer `t(labelKey)` so `en` also resolves. */
  label: string;
  description: string;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  color: string;
  softColor: string;
  defaultSize: Size;
  /** Unicode badge from the design prototype (kept for the 18px glyph tile). */
  glyph: string;
}

/** docs/redesign-plan.md §6 — colours, glyphs and default sizes. */
export const NODE_META: Record<CanvasNodeType, NodeMeta> = {
  task: {
    label: "任务",
    description: "目标与验收标准",
    labelKey: "node.task",
    descriptionKey: "node.task.desc",
    icon: ListTodo,
    color: "#2E7CF6",
    softColor: "rgba(46,124,246,.14)",
    defaultSize: { width: 280, height: 250 },
    glyph: "☰",
  },
  agent: {
    label: "Agent",
    description: "ACP 代理会话",
    labelKey: "node.agent",
    descriptionKey: "node.agent.desc",
    icon: Sparkles,
    color: "#5B5BD6",
    softColor: "rgba(91,91,214,.14)",
    defaultSize: { width: 430, height: 600 },
    glyph: "✦",
  },
  terminal: {
    label: "终端",
    description: "真实 Shell 会话",
    labelKey: "node.terminal",
    descriptionKey: "node.terminal.desc",
    icon: SquareTerminal,
    color: "#1F9D64",
    softColor: "rgba(31,157,100,.14)",
    defaultSize: { width: 480, height: 280 },
    glyph: ">_",
  },
  diff: {
    label: "变更",
    description: "代码变更审阅",
    labelKey: "node.diff",
    descriptionKey: "node.diff.desc",
    icon: FileDiff,
    color: "#8A4FD6",
    softColor: "rgba(138,79,214,.14)",
    defaultSize: { width: 400, height: 420 },
    glyph: "±",
  },
  file: {
    label: "文件",
    description: "工作空间文件",
    labelKey: "node.file",
    descriptionKey: "node.file.desc",
    icon: FileCode2,
    color: "#D18F0F",
    softColor: "rgba(209,143,15,.14)",
    defaultSize: { width: 300, height: 230 },
    glyph: "▤",
  },
  context: {
    label: "上下文",
    description: "文件夹引用",
    labelKey: "node.context",
    descriptionKey: "node.context.desc",
    icon: FolderOpen,
    color: "#0E9AA7",
    softColor: "rgba(14,154,167,.14)",
    defaultSize: { width: 280, height: 150 },
    glyph: "◫",
  },
  note: {
    label: "便签",
    description: "文本片段",
    labelKey: "node.note",
    descriptionKey: "node.note.desc",
    icon: StickyNote,
    color: "#B8860B",
    softColor: "rgba(184,134,11,.14)",
    defaultSize: { width: 260, height: 180 },
    glyph: "▢",
  },
  browser: {
    label: "浏览器",
    description: "嵌入网页",
    labelKey: "node.browser",
    descriptionKey: "node.browser.desc",
    icon: Globe,
    color: "#0E9AA7",
    softColor: "rgba(14,154,167,.14)",
    defaultSize: { width: 520, height: 380 },
    glyph: "◍",
  },
  image: {
    label: "图片",
    description: "图片附件",
    labelKey: "node.image",
    descriptionKey: "node.image.desc",
    icon: Image,
    color: "#E0762E",
    softColor: "rgba(224,118,46,.14)",
    defaultSize: { width: 260, height: 200 },
    glyph: "▣",
  },
  log: {
    label: "日志",
    description: "运行记录",
    labelKey: "node.log",
    descriptionKey: "node.log.desc",
    icon: ScrollText,
    color: "#6B7080",
    softColor: "rgba(107,112,128,.14)",
    defaultSize: { width: 360, height: 220 },
    glyph: "≡",
  },
};

/** The 9 palette entries of the sidebar (plan §5) — `context` is drag-only. */
export const PALETTE_TYPES: readonly CanvasNodeType[] = [
  "task",
  "agent",
  "terminal",
  "diff",
  "file",
  "note",
  "browser",
  "image",
  "log",
];

export type StatusTone =
  | "accent"
  | "warn"
  | "ok"
  | "diff"
  | "muted"
  | "err"
  | "info";

export interface StatusMeta {
  /** i18n key; render with `t(STATUS_META[status].label)`. */
  label: string;
  glyph: string;
  tone: StatusTone;
}

/** Status vocabulary from plan §6 — always glyph **and** text (SPEC §3). */
export const STATUS_META: Record<NodeStatus, StatusMeta> = {
  running: { label: "status.running", glyph: "◐", tone: "accent" },
  waiting: { label: "status.waiting", glyph: "⏸", tone: "warn" },
  done: { label: "status.done", glyph: "✓", tone: "ok" },
  review: { label: "status.review", glyph: "◇", tone: "diff" },
  modified: { label: "status.modified", glyph: "●", tone: "warn" },
  idle: { label: "status.idle", glyph: "○", tone: "muted" },
  error: { label: "status.error", glyph: "✕", tone: "err" },
  disconnected: { label: "status.disconnected", glyph: "⊘", tone: "err" },
  connecting: { label: "status.connecting", glyph: "◌", tone: "warn" },
  linked: { label: "status.linked", glyph: "⇄", tone: "info" },
};

/** The two statuses whose glyph spins (plan §0: the only looping animation). */
export const SPINNING_STATUSES: readonly NodeStatus[] = [
  "running",
  "connecting",
];

export interface EdgeMeta {
  /** i18n key; render with `t(EDGE_META[type].label)`. */
  label: string;
  glyph: string;
  dashed: boolean;
}

/** Edge semantics from plan §6 / SPEC §4. */
export const EDGE_META: Record<CanvasEdgeType, EdgeMeta> = {
  link: { label: "edge.link", glyph: "⇄", dashed: true },
  dispatch: { label: "edge.dispatch", glyph: "➤", dashed: false },
  produce: { label: "edge.produce", glyph: "◆", dashed: false },
  write: { label: "edge.write", glyph: "✎", dashed: false },
  trigger: { label: "edge.trigger", glyph: "⚡", dashed: false },
  ref: { label: "edge.ref", glyph: "@", dashed: true },
};
