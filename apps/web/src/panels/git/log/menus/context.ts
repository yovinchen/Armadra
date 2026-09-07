import type { GitLogCommit, GitRepositoryAction } from "@armadra/shared";

/**
 * 右键菜单与日志页之间的那层约定（Git 工具窗口设计 §2.2）。
 *
 * 菜单不知道 gateway 的存在：它要么造一个 `GitRepositoryAction` 交给
 * `request`，要么把「开哪个对话框 / 动哪个画布节点」的意图交回页面。写因此
 * 只有一条路径——`LogPage` 的 `RepositoryConfirmDialog` 与 `operate`。
 */

/**
 * 需要输入的那几件事。
 *
 * 它们共用一个对话框而不是各写一个：区别只在「填几个框、填完造哪个动作」，
 * 而这两件事都是纯判断（`prompt-action.ts`），值得被单测钉住。
 */
export type NamePromptKind =
  | "branch"
  | "tag"
  | "renameBranch"
  | "addRemote"
  | "renameRemote"
  | "remoteUrl";

export interface NamePrompt {
  kind: NamePromptKind;
  repositoryPath: string;
  /**
   * 这次操作绑定的对象 ID。从提交 / 分支出发时是那一行画出来的那个；仓库根上
   * 的「新建分支」没有，表示从 HEAD 起。
   */
  oid?: string;
  /** 被改的那条引用或那个远端**现在**的名字（改名、改地址靠它定位）。 */
  reference?: string;
}

/** 对话框收上来的两个框；用不到的那个是空串。 */
export interface NamePromptValue {
  name: string;
  url: string;
}

/** 一条 stash 的只读差异要看哪一条。 */
export interface StashDiffTarget {
  repositoryPath: string;
  oid: string;
}

/** 带预览的两个整合对话框看的是哪个提交。 */
export interface CommitDialogTarget {
  repositoryPath: string;
  oid: string;
}

export interface MenuContext {
  /** 交给确认门；日志页负责接上当前仓库。 */
  request: (repositoryPath: string, action: GitRepositoryAction) => void;
  /** 有写在跑，或者读回来的快照已经过期。 */
  busy: boolean;
  /** 仓库空闲（没有进行中的合并 / rebase / cherry-pick）才允许序列类动作。 */
  idle: (repositoryPath: string) => boolean;
  /** 该仓库当前的 state token；没有就不发需要它的动作。 */
  stateToken: (repositoryPath: string) => string | null;
  /** 当前分支名，用于「合并到当前分支」这类措辞与目标。 */
  currentBranch: (repositoryPath: string) => string | null;
  /** 本地分支列表，用于「与分支比较」子菜单。 */
  branches: (repositoryPath: string) => readonly string[];
  /**
   * 这个仓库配了哪些远端。推标签、fetch、推分支都按它决定是禁用、直接给一项，
   * 还是折成子菜单——「推到哪个远端」不该由菜单替用户猜一个 origin。
   */
  remotes: (repositoryPath: string) => readonly string[];
  /** 与某个基线比较：`null` 回到「与第一父比」。 */
  onCompare: (base: string | null) => void;
  /** 在画布上引用这个提交。 */
  onReference: (commit: GitLogCommit) => void;
  /** 打开「引用日志…」。 */
  onReflog: (repositoryPath: string) => void;
  onPrompt: (prompt: NamePrompt) => void;
  onToggleFavorite: (key: string) => void;
  /** 只读地看一条 stash 存了什么。 */
  onStashDiff: (target: StashDiffTarget) => void;
  /** 在画布上打开绑定这条 worktree 的 Frame。 */
  onWorktreeFrame: (input: { path: string; branch: string }) => void;
  /** 可审阅的交互式 rebase todo。 */
  onInteractiveRebase: (target: CommitDialogTarget) => void;
  /** 带 mainline 选择与差异预览的 cherry-pick。 */
  onCherryPick: (target: CommitDialogTarget) => void;
}
