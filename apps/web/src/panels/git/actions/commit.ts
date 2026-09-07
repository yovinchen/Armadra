import type { GitRepositoryAction } from "@armadra/shared";

/**
 * 提交行上的写动作构造（Git 工具窗口设计 §2.2 右键菜单）。
 *
 * 纯函数，一个都不发请求：日志页的右键菜单、旧的历史页签、引用日志三处要
 * 造的是**同一批动作**，抄三遍的结果必然是某一处漏掉了 `expectedStateToken`
 * 或者把 `mainline` 猜成了 1。所以构造集中在这里，谁要用谁调用，确认与提交
 * 仍然走 `GitRepositoryPanel` 的 `request` 与 `RepositoryConfirmDialog`。
 *
 * 每个动作都带上界面上看到的那个不可变 OID：显示的是哪个提交，请求里就是
 * 哪个提交，服务端再按 HEAD / state token 复核一次。
 */

/** 合并提交必须先明确主线，这里不替用户猜：单亲提交是 `null`。 */
export function mainlineOf(parents: readonly string[]): number | null {
  return parents.length > 1 ? 1 : null;
}

export function checkoutCommit(oid: string): GitRepositoryAction {
  return { kind: "checkoutCommit", targetOid: oid };
}

export function branchFromCommit(
  name: string,
  oid: string,
  switchAfter: boolean,
): GitRepositoryAction {
  return {
    kind: "createBranch",
    name,
    startPoint: oid,
    switch: switchAfter,
  };
}

export function tagAtCommit(
  name: string,
  oid: string,
  message: string | null,
): GitRepositoryAction {
  return { kind: "createTag", name, targetOid: oid, message };
}

export function cherryPickCommit(
  oid: string,
  mainline: number | null,
  expectedStateToken: string,
): GitRepositoryAction {
  return {
    kind: "startCherryPick",
    targetOid: oid,
    mainline,
    recordOrigin: true,
    expectedStateToken,
  };
}

export function revertCommit(
  oid: string,
  mainline: number | null,
  expectedStateToken: string,
): GitRepositoryAction {
  return { kind: "revert", targetOid: oid, mainline, expectedStateToken };
}

export function resetToCommit(
  mode: "soft" | "mixed" | "hard",
  oid: string,
  expectedStateToken: string,
  discardChanges: boolean,
): GitRepositoryAction {
  return {
    kind: "reset",
    mode,
    targetOid: oid,
    expectedStateToken,
    discardChanges,
  };
}

export function interactiveRebaseFrom(
  onto: string,
  todo: Extract<
    GitRepositoryAction,
    { kind: "startInteractiveRebase" }
  >["todo"],
  expectedStateToken: string,
): GitRepositoryAction {
  return { kind: "startInteractiveRebase", onto, todo, expectedStateToken };
}
