import type { MessageModule } from "./index";

/**
 * 编辑器节点的文件体验（编辑器设计 §2、§3）：最近文件与跳转到行、媒体预览
 * 的缩放、草稿保护与另存为。三方合并对话框的草稿模式文案在
 * `editor-merge.ts` 的 `merge.draft.*`。
 */
export const editorFiles: MessageModule = {
  "zh-CN": {
    "quickOpen.recent": "最近打开",
    "quickOpen.goToLine": "跳转到行",
    "quickOpen.lineHint": "输入行号，可带列号，如 :12:4",
    "quickOpen.lineTarget": "第 {line} 行",
    "quickOpen.lineColumnTarget": "第 {line} 行第 {column} 列",

    "editor.image.zoom": "缩放",
    "editor.image.fit": "适应",
    "editor.image.actual": "1:1",
  },
  en: {
    "quickOpen.recent": "Recently opened",
    "quickOpen.goToLine": "Go to line",
    "quickOpen.lineHint": "Type a line, optionally a column, e.g. :12:4",
    "quickOpen.lineTarget": "Line {line}",
    "quickOpen.lineColumnTarget": "Line {line}, column {column}",

    "editor.image.zoom": "Zoom",
    "editor.image.fit": "Fit",
    "editor.image.actual": "1:1",
  },
};
