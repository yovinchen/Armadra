import type { MessageModule } from "./index";

/**
 * 编辑器节点的文件体验（编辑器设计 §2、§3）：最近文件与跳转到行、媒体预览
 * 的缩放、草稿保护与另存为。三方合并对话框的草稿模式文案在
 * `editor-merge.ts` 的 `merge.draft.*`。
 */
export const editorFiles: MessageModule = {
  "zh-CN": {
    "editor.image.zoom": "缩放",
    "editor.image.fit": "适应",
    "editor.image.actual": "1:1",
  },
  en: {
    "editor.image.zoom": "Zoom",
    "editor.image.fit": "Fit",
    "editor.image.actual": "1:1",
  },
};
