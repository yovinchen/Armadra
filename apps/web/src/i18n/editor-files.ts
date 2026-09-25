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

    "editor.draft.restored": "已恢复未保存的草稿",
    "editor.draft.restoredStale": "已恢复草稿，磁盘上的文件在此期间被修改",
    "editor.draft.discard": "丢弃草稿",
    "editor.draft.merge": "合并",
    "editor.saveAs": "另存为",
    "editor.saveAs.path": "工作空间内的路径",
    "editor.saveAs.exists": "该路径已有文件",
    "editor.relocate": "重新定位",
    "editor.relocate.overwrite": "覆盖",
    "editor.relocate.confirm": "用草稿覆盖「{path}」的现有内容？",
    "editor.relocate.missing": "该路径没有文件",
    "editor.relocate.changed": "目标文件刚被修改，请重试",
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

    "editor.draft.restored": "Restored an unsaved draft",
    "editor.draft.restoredStale":
      "Restored a draft; the file changed on disk in the meantime",
    "editor.draft.discard": "Discard draft",
    "editor.draft.merge": "Merge",
    "editor.saveAs": "Save as",
    "editor.saveAs.path": "Path in the workspace",
    "editor.saveAs.exists": "A file already exists at this path",
    "editor.relocate": "Relocate",
    "editor.relocate.overwrite": "Overwrite",
    "editor.relocate.confirm":
      "Replace the current contents of “{path}” with the draft?",
    "editor.relocate.missing": "No file at this path",
    "editor.relocate.changed": "The target file just changed; try again",
  },
};
