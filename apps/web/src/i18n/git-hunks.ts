import type { MessageModule } from "./index";
export const gitHunks: MessageModule = {
  "zh-CN": {
    "gitHunk.title": "逐片段操作",
    "gitHunk.loading": "正在读取片段…",
    "gitHunk.reload": "重新读取片段",
    "gitHunk.stage": "暂存此片段",
    "gitHunk.unstage": "取消暂存此片段",
    "gitHunk.revert": "还原此片段",
    "gitHunk.busy": "正在应用片段…",
    "gitHunk.applied": "片段操作已完成",
    "gitHunk.failed": "片段操作失败，请重新读取后检查当前状态。",
    "gitHunk.uncertain":
      "请求未能确认。请检查重新读取的文件和暂存状态；不会自动重试。",
    "gitHunk.stale": "文件内容已变化，请关闭确认框并重新选择片段。",
    "gitHunk.invalidResponse":
      "服务返回的片段结果与本次操作不一致，请重新检查状态。",
    "gitHunk.unsupported": "此文件暂不支持逐片段操作，请使用整文件操作。",
    "gitHunk.unsupported.binary": "二进制文件请使用整文件操作。",
    "gitHunk.unsupported.notTrackedModification":
      "新增、删除、重命名或无文本修改的文件请使用整文件操作。",
    "gitHunk.unsupported.modeChange": "包含文件权限变化，请使用整文件操作。",
    "gitHunk.unsupported.notRegularFile":
      "特殊文件、符号链接和子模块不支持逐片段操作。",
    "gitHunk.unsupported.filter":
      "此文件使用内容过滤器或编码转换，请使用整文件操作。",
    "gitHunk.unsupported.nonUtf8": "此文件不是 UTF-8 文本，请使用整文件操作。",
    "gitHunk.unsupported.unsupportedPatch":
      "此差异不符合可安全应用的文本片段格式，请使用整文件操作。",
    "gitHunk.revertTitle": "还原这一片段？",
    "gitHunk.revertDescription":
      "只丢弃下方片段中的未暂存修改，保留其他修改和暂存区内容。此操作不能通过 Git 自动找回。",
    "gitHunk.cancel": "取消",
    "gitHunk.worktree": "工作区修改",
    "gitHunk.staged": "已暂存修改",
  },
  en: {
    "gitHunk.title": "Individual hunks",
    "gitHunk.loading": "Reading hunks…",
    "gitHunk.reload": "Reload hunks",
    "gitHunk.stage": "Stage this hunk",
    "gitHunk.unstage": "Unstage this hunk",
    "gitHunk.revert": "Discard this hunk",
    "gitHunk.busy": "Applying hunk…",
    "gitHunk.applied": "Hunk operation completed",
    "gitHunk.failed":
      "The hunk operation failed. Reload and inspect the current state.",
    "gitHunk.uncertain":
      "The request could not be confirmed. Inspect the reloaded file and index state. It will not retry automatically.",
    "gitHunk.stale":
      "The file changed. Close this confirmation and select a hunk again.",
    "gitHunk.invalidResponse":
      "The returned hunk result does not match this operation. Check the state again.",
    "gitHunk.unsupported":
      "Individual hunks are not supported for this file. Use whole-file operations.",
    "gitHunk.unsupported.binary": "Use whole-file operations for binary files.",
    "gitHunk.unsupported.notTrackedModification":
      "Use whole-file operations for added, deleted, renamed, or textually unchanged files.",
    "gitHunk.unsupported.modeChange":
      "File permissions changed. Use whole-file operations.",
    "gitHunk.unsupported.notRegularFile":
      "Special files, symlinks, and submodules do not support individual hunks.",
    "gitHunk.unsupported.filter":
      "This file uses content filters or encoding conversion. Use whole-file operations.",
    "gitHunk.unsupported.nonUtf8":
      "This file is not UTF-8 text. Use whole-file operations.",
    "gitHunk.unsupported.unsupportedPatch":
      "This diff is not a supported, safely applicable text patch. Use whole-file operations.",
    "gitHunk.revertTitle": "Discard this hunk?",
    "gitHunk.revertDescription":
      "Discard only the unstaged edits shown below, preserving other edits and the index. Git cannot automatically recover these discarded edits.",
    "gitHunk.cancel": "Cancel",
    "gitHunk.worktree": "Working tree changes",
    "gitHunk.staged": "Staged changes",
  },
};
