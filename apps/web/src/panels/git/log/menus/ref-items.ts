import type { GitRepositoryAction } from "@armadra/shared";

import { checkoutCommit } from "../../actions/commit";
import * as refActions from "../../actions/refs";
import { stashActionAt } from "../../actions/stash";
import { refKey, type BranchTreeNode } from "../build-tree";
import type { NamePrompt } from "./context";

/**
 * 分支树上每一类节点的右键项（Git 工具窗口设计 §2.2）。
 *
 * 菜单是**数据**，画菜单才是组件的事——和 `build-tree.ts` 同一个理由。九个页签
 * 的能力搬进一棵树之后，「标签删除带的是标签对象还是它指向的提交」「stash 动作
 * 认的是 oid 还是 `stash@{n}`」「没有远端时推送是不是禁用」这类问题只能靠单测
 * 钉住，而它们全都发生在这一层，不在 JSX 里。
 */

/** 不发请求、只改本地视图或画布的那几项。 */
export type RefMenuIntent =
  | { kind: "prompt"; prompt: NamePrompt }
  | { kind: "reflog"; repositoryPath: string }
  | { kind: "stashDiff"; repositoryPath: string; oid: string }
  | { kind: "worktreeFrame"; path: string; branch: string }
  | { kind: "favorite"; key: string }
  | { kind: "compare"; base: string | null };

export interface RefMenuItem {
  id: string;
  /** 走 `t()` 的文案键；远端名这类原样显示的文字用 `label`。 */
  labelKey?: string;
  label?: string;
  disabled: boolean;
  destructive?: boolean;
  /** 这一项之前画一条分隔线。 */
  separated?: boolean;
  action?: GitRepositoryAction;
  intent?: RefMenuIntent;
  /** 有子项时它自己不可点，只是一个子菜单的入口。 */
  children?: RefMenuItem[];
}

export interface RefMenuInput {
  node: BranchTreeNode;
  /** 这个仓库配了哪些远端。 */
  remotes: readonly string[];
  currentBranch: string | null;
  stateToken: string | null;
  /** 仓库空闲：没有进行中的合并 / rebase / cherry-pick。 */
  idle: boolean;
  busy: boolean;
}

/** 条件不成立时连动作都不造：一个不该发的请求不该只是「按钮灰着」。 */
function when(
  ok: unknown,
  build: () => GitRepositoryAction,
): GitRepositoryAction | undefined {
  return ok ? build() : undefined;
}

/**
 * 这条分支该推到哪个远端。
 *
 * 远端分支的名字自带远端前缀，本地分支没有——没有前缀时用第一个配置的远端，
 * 一个远端都没有时是 `null`，调用方据此禁用推 / 拉 / fetch，而不是硬塞一个
 * 并不存在的 `origin` 进去。
 */
export function remoteForReference(
  reference: string,
  remotes: readonly string[],
): string | null {
  const prefixed = remotes.find((remote) => reference.startsWith(`${remote}/`));
  return prefixed ?? remotes[0] ?? null;
}

/**
 * 一个「挑远端」的入口：只有一个远端时直接就是那一项，多个时折成子菜单，
 * 一个都没有时是一个禁用项。
 */
function remoteChoice(
  id: string,
  labelKey: string,
  remotes: readonly string[],
  blocked: boolean,
  build: (remote: string) => GitRepositoryAction | undefined,
  options: { separated?: boolean } = {},
): RefMenuItem {
  const base = {
    id,
    labelKey,
    separated: options.separated,
    disabled: blocked || remotes.length === 0,
  };
  if (remotes.length === 1) return { ...base, action: build(remotes[0]!) };
  if (remotes.length === 0) return base;
  return {
    ...base,
    disabled: blocked,
    children: remotes.map((remote) => ({
      id: `${id}:${remote}`,
      label: remote,
      disabled: blocked,
      action: build(remote),
    })),
  };
}

export function refMenuItems(input: RefMenuInput): RefMenuItem[] {
  const { node, remotes, currentBranch, stateToken, idle, busy } = input;
  if (node.kind === "head") {
    // `HEAD` 顶节点跨全部仓库，引用日志因此问的是工作区级的那一个。
    return [
      {
        id: "reflog",
        labelKey: "gitLog.menu.reflog",
        disabled: false,
        intent: { kind: "reflog", repositoryPath: "." },
      },
    ];
  }
  const repository = node.repositoryPath;
  if (!repository) return [];
  const oid = node.oid ?? null;

  if (node.kind === "repository") {
    return [
      remoteChoice("fetch", "gitRepo.fetch", remotes, busy, (remote) =>
        refActions.fetchRemote(remote, false),
      ),
      {
        id: "newBranch",
        labelKey: "gitLog.menu.newBranch",
        disabled: busy,
        intent: {
          kind: "prompt",
          prompt: { kind: "branch", repositoryPath: repository },
        },
      },
      {
        id: "reflog",
        labelKey: "gitLog.menu.reflog",
        separated: true,
        disabled: false,
        intent: { kind: "reflog", repositoryPath: repository },
      },
    ];
  }

  if (node.kind === "group") {
    if (node.group !== "remotes") return [];
    return [
      {
        id: "addRemote",
        labelKey: "gitRepo.addRemote",
        disabled: busy,
        intent: {
          kind: "prompt",
          prompt: { kind: "addRemote", repositoryPath: repository },
        },
      },
    ];
  }

  if (node.kind === "remote") {
    const remote = node.label;
    return [
      {
        id: "fetch",
        labelKey: "gitRepo.fetch",
        disabled: busy,
        action: refActions.fetchRemote(remote, false),
      },
      {
        id: "fetchPrune",
        labelKey: "gitLog.menu.fetchPrune",
        disabled: busy,
        action: refActions.fetchRemote(remote, true),
      },
      {
        id: "remoteUrl",
        labelKey: "gitLog.menu.editRemoteUrl",
        separated: true,
        disabled: busy,
        intent: {
          kind: "prompt",
          prompt: {
            kind: "remoteUrl",
            repositoryPath: repository,
            reference: remote,
          },
        },
      },
      {
        id: "renameRemote",
        labelKey: "gitLog.menu.renameRemote",
        disabled: busy,
        intent: {
          kind: "prompt",
          prompt: {
            kind: "renameRemote",
            repositoryPath: repository,
            reference: remote,
          },
        },
      },
      {
        id: "removeRemote",
        labelKey: "gitRepo.removeRemote",
        separated: true,
        destructive: true,
        disabled: busy,
        action: refActions.removeRemote(remote),
      },
    ];
  }

  if (node.kind === "tag") {
    const name = node.reference ?? node.label;
    return [
      {
        id: "checkout",
        labelKey: "gitRepo.checkoutCommit",
        disabled: busy || !oid,
        action: when(oid, () => checkoutCommit(oid!)),
      },
      remoteChoice(
        "pushTag",
        "gitRepo.pushTag",
        remotes,
        busy || !oid,
        (remote) => when(oid, () => refActions.pushTag(remote, name, oid!)),
      ),
      {
        id: "favorite",
        labelKey: node.favorite
          ? "gitLog.tree.unfavorite"
          : "gitLog.tree.favorite",
        separated: true,
        disabled: false,
        intent: { kind: "favorite", key: refKey(repository, name) },
      },
      {
        id: "deleteTag",
        labelKey: "gitRepo.deleteTag",
        separated: true,
        destructive: true,
        disabled: busy || !oid,
        // 带的是**标签对象**这一次读到的 ID：标签被重新指向之后这一次删除该被
        // 拒绝，而不是删掉一个已经换了目标的标签。
        action: when(oid, () => refActions.deleteTag(name, oid!)),
      },
    ];
  }

  if (node.kind === "worktree") {
    const path = node.path ?? null;
    const branch = node.reference ?? null;
    return [
      {
        id: "frame",
        labelKey: "gitLog.menu.openFrame",
        // 绑定要记一条分支名，游离的检出没有；这一项因此对它是灰的。
        disabled: !path || !branch,
        intent:
          path && branch ? { kind: "worktreeFrame", path, branch } : undefined,
      },
      {
        id: "removeWorktree",
        labelKey: "gitRepo.removeWorktree",
        separated: true,
        destructive: true,
        disabled: busy || !path || !oid || Boolean(node.locked),
        action: when(path && oid && !node.locked, () =>
          refActions.removeWorktree(path!, oid!, false),
        ),
      },
    ];
  }

  if (node.kind === "stash") {
    const ready = Boolean(oid && stateToken);
    return [
      {
        id: "applyStash",
        labelKey: "gitLog.menu.stashApply",
        disabled: busy || !ready,
        action: when(ready, () =>
          stashActionAt(oid!, stateToken!, "applyStash"),
        ),
      },
      {
        id: "popStash",
        labelKey: "gitLog.menu.stashPop",
        disabled: busy || !ready,
        action: when(ready, () => stashActionAt(oid!, stateToken!, "popStash")),
      },
      {
        id: "stashDiff",
        labelKey: "gitLog.menu.stashDiff",
        separated: true,
        disabled: !oid,
        intent: oid
          ? { kind: "stashDiff", repositoryPath: repository, oid }
          : undefined,
      },
      {
        id: "dropStash",
        labelKey: "gitLog.menu.stashDrop",
        separated: true,
        destructive: true,
        disabled: busy || !ready,
        action: when(ready, () =>
          stashActionAt(oid!, stateToken!, "dropStash"),
        ),
      },
    ];
  }

  if (node.kind !== "branch" || !node.reference) return [];
  const reference = node.reference;
  const sequenced = idle && stateToken !== null;
  const remote = remoteForReference(reference, remotes);
  const publishable = Boolean(remote && currentBranch);
  return [
    {
      id: "switch",
      labelKey: "gitRepo.switchBranch",
      disabled: busy || !oid || Boolean(node.current),
      action: when(oid && !node.current, () =>
        refActions.switchBranch(reference, oid!),
      ),
    },
    {
      id: "branchFromHere",
      labelKey: "gitLog.menu.branchFromHere",
      disabled: busy || !oid,
      intent: oid
        ? {
            kind: "prompt",
            prompt: { kind: "branch", repositoryPath: repository, oid },
          }
        : undefined,
    },
    {
      id: "rename",
      labelKey: "gitLog.menu.rename",
      disabled: busy || !oid,
      intent: oid
        ? {
            kind: "prompt",
            prompt: {
              kind: "renameBranch",
              repositoryPath: repository,
              oid,
              reference,
            },
          }
        : undefined,
    },
    {
      id: "merge",
      labelKey: "gitLog.menu.merge",
      separated: true,
      disabled: !sequenced || busy || !oid,
      action: when(sequenced && oid, () =>
        refActions.mergeInto(oid!, "", stateToken!),
      ),
    },
    {
      id: "rebaseOnto",
      labelKey: "gitLog.menu.rebaseOnto",
      disabled: !sequenced || busy,
      action: when(sequenced, () =>
        refActions.rebaseOnto(reference, stateToken!),
      ),
    },
    {
      id: "push",
      labelKey: "gitRepo.push",
      separated: true,
      disabled: busy || !publishable,
      action: when(publishable, () =>
        refActions.pushBranch(remote!, currentBranch!, false, null),
      ),
    },
    {
      id: "setUpstream",
      labelKey: "gitLog.menu.setUpstream",
      disabled: busy || !publishable,
      action: when(publishable, () =>
        refActions.pushBranch(remote!, currentBranch!, true, null),
      ),
    },
    {
      id: "pull",
      labelKey: "gitRepo.pull",
      disabled: busy || !publishable,
      action: when(publishable, () =>
        refActions.pullBranch(remote!, currentBranch!),
      ),
    },
    {
      id: "fetch",
      labelKey: "gitRepo.fetch",
      disabled: busy || !remote,
      action: when(remote, () => refActions.fetchRemote(remote!, false)),
    },
    {
      id: "compareBranch",
      labelKey: "gitLog.menu.compareWithBranch",
      separated: true,
      disabled: false,
      intent: { kind: "compare", base: reference },
    },
    {
      id: "compareWorktree",
      labelKey: "gitLog.menu.diffWithWorktree",
      disabled: false,
      intent: { kind: "compare", base: "HEAD" },
    },
    {
      id: "favorite",
      labelKey: node.favorite
        ? "gitLog.tree.unfavorite"
        : "gitLog.tree.favorite",
      disabled: false,
      intent: { kind: "favorite", key: refKey(repository, reference) },
    },
    {
      id: "deleteBranch",
      labelKey: "gitRepo.deleteBranch",
      separated: true,
      destructive: true,
      disabled: busy || !oid || Boolean(node.current),
      action: when(oid && !node.current, () =>
        refActions.deleteBranch(reference, oid!),
      ),
    },
  ];
}
