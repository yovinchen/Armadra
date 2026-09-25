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
    // 绑定坏掉的方式不止一种，修法也不一样：目录没了可以重建，分支被切走
    // 了不能——那个检出还在，重建只会失败。
    "frameBinding.reason.missing": "找不到这个 worktree",
    "frameBinding.reasonHint.missing":
      "磁盘上已经没有这个 checkout：可以按原分支重新创建，或者解绑这个 Frame。",
    "frameBinding.reason.mismatch": "这个目录已经不属于原来的仓库",
    "frameBinding.reasonHint.mismatch":
      "路径还在，但它现在是另一个仓库的检出。重建会落在错的地方，请解绑后重新绑定。",
    "frameBinding.reason.branchChanged": "这个 worktree 的分支被切走了",
    "frameBinding.reasonHint.branchChanged":
      "检出本身还在，只是不在绑定记录的那个分支上了。切回去，或者解绑后重新绑定。",
    "frameBinding.recreate": "重新创建",
    "frameBinding.unbind": "解绑",
    "frameBinding.unbindFrame": "解绑 Frame",
    "frameBinding.unbindHint":
      "解绑只清除画布上的绑定，磁盘上的 checkout 原样保留。",
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
    "frameBinding.reason.missing": "Worktree not found",
    "frameBinding.reasonHint.missing":
      "The checkout is gone from disk. Recreate it on the same branch, or unbind this Frame.",
    "frameBinding.reason.mismatch":
      "This directory is no longer that repository",
    "frameBinding.reasonHint.mismatch":
      "The path is still there, but it is a checkout of a different repository now. Recreating would land in the wrong place; unbind and bind it again.",
    "frameBinding.reason.branchChanged": "This worktree switched branch",
    "frameBinding.reasonHint.branchChanged":
      "The checkout is still there, just not on the branch the binding recorded. Switch it back, or unbind and bind it again.",
    "frameBinding.recreate": "Recreate",
    "frameBinding.unbind": "Unbind",
    "frameBinding.unbindFrame": "Unbind Frame",
    "frameBinding.unbindHint":
      "Unbinding only clears the binding on the canvas; the checkout stays on disk.",
    "frameBinding.createFrame": "Also create a Frame bound to this worktree",
    "frameBinding.initScript": "Init script (runs once in the new worktree)",
    "frameBinding.initTerminalTitle": "Init script",
  },
};
