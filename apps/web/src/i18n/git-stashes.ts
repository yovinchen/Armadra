import type { MessageModule } from "./index";

export const gitStashes: MessageModule = {
  "zh-CN": {
    "gitRepo.stashes": "Stash",
    "gitRepo.createStash": "保存 Stash",
    "gitRepo.applyStash": "应用 Stash",
    "gitRepo.popStash": "应用并移除 Stash",
    "gitRepo.dropStash": "移除 Stash",
    "gitStash.title": "Stash",
    "gitStash.message": "保存说明",
    "gitStash.includeUntracked": "同时保存未跟踪文件",
    "gitStash.reinstateIndex": "恢复原暂存状态",
    "gitStash.safety":
      "默认只保存已跟踪文件。勾选后也保存未跟踪文件；ignored 文件始终保留在工作区。",
    "gitStash.conflictSafety":
      "应用冲突时会保留 Stash，请先解决冲突；不会自动重试或移除记录。",
    "gitStash.dropSafety":
      "移除会删除这条 Stash 记录，无法通过撤销恢复。操作前请检查固定对象与差异；请勿同时在其他 Git 工具中修改 Stash。",
    "gitStash.empty": "没有已保存的 Stash。",
    "gitStash.noChanges": "当前没有可保存的改动。",
    "gitStash.existingConflicts":
      "暂存区存在冲突，请解决后再保存或应用 Stash。",
    "gitStash.view": "查看差异",
    "gitStash.patch": "工作区快照差异",
    "gitStash.noPatch": "此快照没有差异。",
    "gitStash.changed": "仓库或所选 Stash 已变化，请刷新并重新确认。",
    "gitStash.duplicate": "同一对象存在多条记录，请使用 Git 处理后再继续。",
  },
  en: {
    "gitRepo.stashes": "Stash",
    "gitRepo.createStash": "Create stash",
    "gitRepo.applyStash": "Apply stash",
    "gitRepo.popStash": "Apply and remove stash",
    "gitRepo.dropStash": "Drop stash",
    "gitStash.title": "Stash",
    "gitStash.message": "Stash message",
    "gitStash.includeUntracked": "Include untracked files",
    "gitStash.reinstateIndex": "Restore the saved index state",
    "gitStash.safety":
      "Tracked files are saved by default. The option also includes untracked files; ignored files always stay in the worktree.",
    "gitStash.conflictSafety":
      "Conflicts keep the stash. Resolve them before another apply; operations are never retried or dropped automatically.",
    "gitStash.dropSafety":
      "Dropping removes this stash entry and cannot be undone here. Review the fixed object and diff first; avoid modifying stashes in another Git tool at the same time.",
    "gitStash.empty": "No saved stashes.",
    "gitStash.noChanges": "There are no local changes to stash.",
    "gitStash.existingConflicts":
      "Resolve the existing index conflicts before creating or applying a stash.",
    "gitStash.view": "View diff",
    "gitStash.patch": "Worktree snapshot diff",
    "gitStash.noPatch": "This snapshot has no differences.",
    "gitStash.changed":
      "The repository or selected stash changed. Refresh and confirm again.",
    "gitStash.duplicate":
      "This object appears more than once. Resolve the duplicate entries with Git first.",
  },
};
