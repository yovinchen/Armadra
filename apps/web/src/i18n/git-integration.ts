import type { MessageModule } from "./index";
export const gitIntegration: MessageModule = {
  "zh-CN": {
    "gitRepo.startCherryPick": "择取提交",
    "gitRepo.skipIntegration": "跳过空提交",
    "gitIntegration.cherryPick": "Cherry-pick · 择取提交",
    "gitIntegration.commitOid": "来源提交 OID",
    "gitIntegration.fullOid": "完整的提交对象 ID",
    "gitIntegration.pickSafety":
      "将此提交相对其父提交的修改应用到当前分支；无冲突时直接创建新提交并保留来源作者。冲突会保留 Git 状态，不会自动 Stash 或重试。",
    "gitIntegration.mainline": "主线父提交",
    "gitIntegration.chooseMainline": "选择作为比较基础的父提交",
    "gitIntegration.mainlineSafety":
      "择取合并提交时，只应用相对所选父提交的差异；不会合并原有分支历史。",
    "gitIntegration.pickDiff": "本次将应用的差异",
    "gitIntegration.emptyPreview":
      "该提交相对所选基础没有文件差异；Git 会停下等待你明确处理空结果。",
    "gitIntegration.recordOrigin": "在提交信息中记录来源 OID",
    "gitIntegration.pickReady": "冲突结果已暂存，可明确继续并创建择取提交。",
    "gitIntegration.emptyPick":
      "当前择取结果为空，不会自动创建或丢弃提交。可以明确跳过，或中止本次操作。",
    "gitIntegration.skipSafety":
      "仅允许跳过已核验的空结果；保留当前 HEAD 和未跟踪文件，不创建新提交。非空冲突不能使用跳过来丢弃修改。",
    "gitIntegration.continueMerge": "继续并提交合并",
    "gitIntegration.abortMerge": "中止合并",
    "gitIntegration.continuePick": "继续择取提交",
    "gitIntegration.abortPick": "中止择取",

    "gitRepo.startMerge": "开始合并",
    "gitRepo.startRebase": "开始变基",
    "gitIntegration.rebaseOnto": "变基到",
    "gitIntegration.rebaseSafety":
      "把当前分支上的提交依次重放到所选提交之上；期间 HEAD 处于游离状态，完成后回到原分支。开始前工作区和暂存区必须干净，不会自动 Stash；冲突停下后由你继续或中止。",
    "gitIntegration.rebaseReady": "冲突结果已暂存，可继续重放剩余提交。",
    "gitIntegration.continueRebase": "继续变基",
    "gitIntegration.abortRebase": "中止变基",
    "gitIntegration.originalBranch": "原分支",
    "gitRepo.continueIntegration": "继续 Git 操作",
    "gitRepo.abortIntegration": "中止 Git 操作",
    "gitRepo.state.awaitingResolution": "等待解决或确认提交",
    "gitIntegration.title": "合并与冲突",
    "gitIntegration.target": "合并目标",
    "gitIntegration.message": "提交说明",
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
      "中止会丢弃此次 Git 操作的解决结果，并尝试恢复开始时的状态。不会强制覆盖或清理文件；恢复失败时保留实际 Git 状态。",
    "gitIntegration.none": "没有正在进行的 Git 整合操作。",
    "gitIntegration.open": "在编辑器打开",
    "gitIntegration.markResolved": "标记已解决",
    "gitIntegration.markResolvedSafety":
      "保存文件不等于解决冲突：标记已解决会把该文件加入索引，前提是文件里已经没有冲突标记；仍有标记时会被拒绝，并给出所在行号。",
    "gitIntegration.failed": "标记已解决失败",
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
    "gitRepo.startCherryPick": "Cherry-pick commit",
    "gitRepo.skipIntegration": "Skip empty commit",
    "gitIntegration.cherryPick": "Cherry-pick a commit",
    "gitIntegration.commitOid": "Source commit OID",
    "gitIntegration.fullOid": "Full commit object ID",
    "gitIntegration.pickSafety":
      "Apply this commit's changes relative to its parent onto the current branch. A clean pick creates a new commit and keeps the source author. Conflicts retain Git state; changes are never stashed or retried automatically.",
    "gitIntegration.mainline": "Mainline parent",
    "gitIntegration.chooseMainline":
      "Choose the parent used as the comparison base",
    "gitIntegration.mainlineSafety":
      "For a merge commit, only replay the difference from the selected parent; the original branch history is not merged.",
    "gitIntegration.pickDiff": "Changes to apply",
    "gitIntegration.emptyPreview":
      "This commit has no file difference from the chosen base. Git will stop for an explicit decision about the empty result.",
    "gitIntegration.recordOrigin":
      "Record the source OID in the commit message",
    "gitIntegration.pickReady":
      "The resolved changes are staged. Explicitly continue to create the cherry-picked commit.",
    "gitIntegration.emptyPick":
      "This cherry-pick has an empty result. No commit is created or dropped automatically. Explicitly skip it or abort this operation.",
    "gitIntegration.skipSafety":
      "Only a verified empty result can be skipped. Keep the current HEAD and untracked files without creating a commit. Nonempty conflicts cannot be silently discarded using Skip.",
    "gitIntegration.continueMerge": "Continue and commit merge",
    "gitIntegration.abortMerge": "Abort merge",
    "gitIntegration.continuePick": "Continue cherry-pick",
    "gitIntegration.abortPick": "Abort cherry-pick",

    "gitRepo.startMerge": "Start merge",
    "gitRepo.startRebase": "Start rebase",
    "gitIntegration.rebaseOnto": "Rebase onto",
    "gitIntegration.rebaseSafety":
      "Replay this branch's commits on top of the selected commit. HEAD is detached while the sequence runs and returns to the original branch when it finishes. Start from a clean index and worktree; nothing is stashed automatically, and a conflict stops for your explicit continue or abort.",
    "gitIntegration.rebaseReady":
      "The resolved changes are staged. Continue to replay the remaining commits.",
    "gitIntegration.continueRebase": "Continue rebase",
    "gitIntegration.abortRebase": "Abort rebase",
    "gitIntegration.originalBranch": "Original branch",
    "gitRepo.continueIntegration": "Continue Git operation",
    "gitRepo.abortIntegration": "Abort Git operation",
    "gitRepo.state.awaitingResolution":
      "Awaiting resolution or commit confirmation",
    "gitIntegration.title": "Merge and conflicts",
    "gitIntegration.target": "Merge target",
    "gitIntegration.message": "Commit message",
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
      "Abort discards this Git operation's resolution work and attempts to restore its starting state. It does not force-overwrite or clean files; failed restoration leaves the actual Git state available for inspection.",
    "gitIntegration.none": "No Git integration is in progress.",
    "gitIntegration.open": "Open in editor",
    "gitIntegration.markResolved": "Mark resolved",
    "gitIntegration.markResolvedSafety":
      "Saving the file is not the same as resolving it. Mark resolved adds the file to the index, and only once it no longer contains conflict markers; while any remain the request is refused and their line numbers are reported.",
    "gitIntegration.failed": "Could not mark the file resolved",
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
