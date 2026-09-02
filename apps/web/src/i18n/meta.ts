import type { MessageModule } from "./index";

/**
 * 节点元数据的文案：命令面板的「历史对话」分组、节点头部的
 * 「AI 命名 / 评论 / 标签」。§14 规则 2：界面只出中文，`en` 仅作为键值留档。
 */
const zh = {
  /* 命令面板 */
  "meta.conversations": "历史对话",

  /* 节点头部补齐 */
  "meta.suggestTitle": "AI 命名",
  "meta.suggestTitleFailed": "命名失败",
  "meta.note": "评论",
  "meta.notePlaceholder": "写点批注…",
  "meta.labels": "标签",
  "meta.labelAdd": "添加标签",
  "meta.labelRemove": "移除标签 {label}",
  "meta.labelPlaceholder": "标签名",
} as const;

const en: Record<keyof typeof zh, string> = {
  "meta.conversations": "Conversations",

  "meta.suggestTitle": "AI title",
  "meta.suggestTitleFailed": "Could not name this session",
  "meta.note": "Comment",
  "meta.notePlaceholder": "Write a note…",
  "meta.labels": "Labels",
  "meta.labelAdd": "Add label",
  "meta.labelRemove": "Remove label {label}",
  "meta.labelPlaceholder": "Label name",
};

export const meta: MessageModule = { "zh-CN": zh, en };
