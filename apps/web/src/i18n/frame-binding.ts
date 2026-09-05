import type { MessageModule } from "./index";

/**
 * Frame ↔ worktree 绑定（roadmap §3.4 G03）。
 *
 * 键前缀 `frameBinding.`，和仓库面板的 `gitRepo.` 分开：绑定是画布上的东西，
 * 面板只是创建它的入口之一。
 */
export const frameBinding: MessageModule = {
  "zh-CN": {
    "frameBinding.worktree": "Worktree",
    "frameBinding.dirtyCount": "{count} 处未提交变更",
    "frameBinding.dirtyClean": "无未提交变更",
    "frameBinding.dirtyUnknown": "变更数未知（需要工作区执行权限）",
    "frameBinding.initPending": "初始化脚本待运行",
    "frameBinding.initRunning": "初始化脚本运行中",
    "frameBinding.initSucceeded": "初始化脚本已完成",
    "frameBinding.initFailed": "初始化脚本失败",
    "frameBinding.missing": "找不到这个 worktree",
    "frameBinding.missingHint":
      "磁盘上已经没有这个 checkout：可以按原分支重新创建，或者解绑这个 Frame。",
    "frameBinding.recreate": "重新创建",
    "frameBinding.unbind": "解绑",
    "frameBinding.unbindFrame": "解绑 Frame",
    "frameBinding.unbindHint":
      "解绑只清除画布上的绑定，磁盘上的 checkout 原样保留。",
    "frameBinding.removeHint":
      "「移除 worktree」删的是磁盘上的 checkout；有未提交改动时会被拒绝，不提供强制。",
    "frameBinding.boundFrame": "已绑定 Frame：{title}",
    "frameBinding.createFrame": "同时创建绑定这个 worktree 的 Frame",
    "frameBinding.initScript": "初始化脚本（在新 worktree 里只运行一次）",
    "frameBinding.initTerminalTitle": "初始化脚本",
  },
  en: {
    "frameBinding.worktree": "Worktree",
    "frameBinding.dirtyCount": "{count} uncommitted change(s)",
    "frameBinding.dirtyClean": "No uncommitted changes",
    "frameBinding.dirtyUnknown":
      "Change count unknown (needs an execution grant)",
    "frameBinding.initPending": "Init script pending",
    "frameBinding.initRunning": "Init script running",
    "frameBinding.initSucceeded": "Init script finished",
    "frameBinding.initFailed": "Init script failed",
    "frameBinding.missing": "Worktree not found",
    "frameBinding.missingHint":
      "The checkout is gone from disk. Recreate it on the same branch, or unbind this Frame.",
    "frameBinding.recreate": "Recreate",
    "frameBinding.unbind": "Unbind",
    "frameBinding.unbindFrame": "Unbind Frame",
    "frameBinding.unbindHint":
      "Unbinding only clears the binding on the canvas; the checkout stays on disk.",
    "frameBinding.removeHint":
      "Remove worktree deletes the checkout on disk. It is refused while anything is uncommitted, and there is no force.",
    "frameBinding.boundFrame": "Bound Frame: {title}",
    "frameBinding.createFrame": "Also create a Frame bound to this worktree",
    "frameBinding.initScript": "Init script (runs once in the new worktree)",
    "frameBinding.initTerminalTitle": "Init script",
  },
};
