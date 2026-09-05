import type { MessageModule } from "./index";
export const gitIntegration: MessageModule = {
  "zh-CN": {
    "gitRepo.startMerge": "开始合并",
    "gitRepo.continueIntegration": "继续并提交合并",
    "gitRepo.abortIntegration": "中止合并",
    "gitRepo.state.awaitingResolution": "等待解决或确认提交",
    "gitIntegration.title": "合并与冲突",
    "gitIntegration.target": "合并目标",
    "gitIntegration.message": "合并提交说明",
    "gitIntegration.startSafety":
      "开始前工作区和暂存区必须干净。即使没有冲突，也会先保留待提交状态，由你确认继续后创建合并提交。不会自动 Stash。",
    "gitIntegration.dirty": "先保存或处理本地修改，再开始合并。",
    "gitIntegration.pending": "合并已准备好，仍待你确认提交。",
    "gitIntegration.stageFirst":
      "在编辑器中解决冲突并保存，再到“更改”页暂存；保存文件不会自动标记为已解决。",
    "gitIntegration.external":
      "无法确认此 Git 操作属于当前 Armadra 进程。可以查看冲突，请使用发起操作的 Git 工具继续或中止。",
    "gitIntegration.restart": "Runtime 重启后不会猜测原操作的所有权。",
    "gitIntegration.abortSafety":
      "中止会丢弃此次合并的解决结果，并尝试恢复开始时的状态。不会强制覆盖或清理文件；恢复失败时保留实际 Git 状态。",
    "gitIntegration.none": "没有正在进行的 Git 合并或变基。",
    "gitIntegration.open": "在编辑器打开",
    "gitIntegration.base": "Base · 共同基础",
    "gitIntegration.ours": "Ours · 当前侧",
    "gitIntegration.theirs": "Theirs · 传入侧",
    "gitIntegration.absent": "此侧不存在该文件。",
    "gitIntegration.binary": "二进制内容不以内联文本展示。",
    "gitIntegration.truncated": "内容超过预览限额，请使用文件或 Git 工具检查。",
    "gitIntegration.submodule": "此项是子模块提交。",
    "gitIntegration.changed": "仓库或操作已变化，请刷新并重新确认。",
    "gitIntegration.kind.merge": "Merge",
    "gitIntegration.kind.rebase": "Rebase",
    "gitIntegration.kind.cherryPick": "Cherry-pick",
    "gitIntegration.kind.revert": "Revert",
    "gitIntegration.kind.bisect": "Bisect",
    "gitIntegration.kind.unknown": "外部 Git 操作",
  },
  en: {
    "gitRepo.startMerge": "Start merge",
    "gitRepo.continueIntegration": "Continue and commit merge",
    "gitRepo.abortIntegration": "Abort merge",
    "gitRepo.state.awaitingResolution":
      "Awaiting resolution or commit confirmation",
    "gitIntegration.title": "Merge and conflicts",
    "gitIntegration.target": "Merge target",
    "gitIntegration.message": "Merge commit message",
    "gitIntegration.startSafety":
      "Start from a clean index and worktree. Even a conflict-free merge pauses before creating the merge commit, until you explicitly continue. Changes are never stashed automatically.",
    "gitIntegration.dirty":
      "Save or handle local changes before starting a merge.",
    "gitIntegration.pending":
      "The merge is ready and still awaits your commit confirmation.",
    "gitIntegration.stageFirst":
      "Resolve and save files in the editor, then stage them on Changes. Saving a file does not automatically mark it resolved.",
    "gitIntegration.external":
      "This Git operation cannot be verified as owned by the current Armadra process. You can inspect conflicts; continue or abort using the Git tool that started it.",
    "gitIntegration.restart":
      "A restarted Runtime does not assume ownership of an existing operation.",
    "gitIntegration.abortSafety":
      "Abort discards this merge's resolution work and attempts to restore its starting state. It does not force-overwrite or clean files; failed restoration leaves the actual Git state available for inspection.",
    "gitIntegration.none": "No Git merge or rebase is in progress.",
    "gitIntegration.open": "Open in editor",
    "gitIntegration.base": "Base · common ancestor",
    "gitIntegration.ours": "Ours · current side",
    "gitIntegration.theirs": "Theirs · incoming side",
    "gitIntegration.absent": "This side has no file.",
    "gitIntegration.binary":
      "Binary contents are not displayed as inline text.",
    "gitIntegration.truncated":
      "This content exceeds the preview limit. Inspect it using a file or Git tool.",
    "gitIntegration.submodule": "This entry is a submodule commit.",
    "gitIntegration.changed":
      "The repository or operation changed. Refresh and confirm again.",
    "gitIntegration.kind.merge": "Merge",
    "gitIntegration.kind.rebase": "Rebase",
    "gitIntegration.kind.cherryPick": "Cherry-pick",
    "gitIntegration.kind.revert": "Revert",
    "gitIntegration.kind.bisect": "Bisect",
    "gitIntegration.kind.unknown": "External Git operation",
  },
};
