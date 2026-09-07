import type { GitForceWithLease, GitRepositoryAction } from "@armadra/shared";

/**
 * 分支、标签、远端、worktree、stash 节点上的写动作构造
 * （Git 工具窗口设计 §2.2「分支节点」及其余节点的右键菜单）。
 *
 * 和 `actions/commit.ts` 同一个理由：分支树的右键菜单与旧的五个页签造的是
 * 同一批动作。每个删除 / 推送都带上**这一行观察到的对象 ID**——标签删除
 * 确认的是标签对象本身而不是它指向的提交，所以标签被重新指向之后旧请求会
 * 被拒绝，而不是删掉一个别的东西。
 */

/* --------------------------------- 分支 ----------------------------------- */

export function switchBranch(
  name: string,
  expectedOid: string,
): GitRepositoryAction {
  return { kind: "switchBranch", name, expectedOid };
}

export function deleteBranch(
  name: string,
  expectedOid: string,
): GitRepositoryAction {
  return { kind: "deleteBranch", name, expectedOid };
}

/**
 * 改名。带的是**树上画出来的那个** OID：分支在读回来之后动过，就该是一次冲突
 * 而不是把它现在指向的东西改名。上游跟着分支走，因为 Git 自己会搬。
 */
export function renameBranch(
  name: string,
  newName: string,
  expectedOid: string,
): GitRepositoryAction {
  return { kind: "renameBranch", name, newName, expectedOid };
}

export function createBranch(
  name: string,
  startPoint: string | null,
  switchAfter: boolean,
): GitRepositoryAction {
  return { kind: "createBranch", name, startPoint, switch: switchAfter };
}

/** 把当前分支合并到 / rebase 到某个引用；两者都要 state token。 */
export function mergeInto(
  targetOid: string,
  message: string,
  expectedStateToken: string,
): GitRepositoryAction {
  return { kind: "startMerge", targetOid, message, expectedStateToken };
}

export function rebaseOnto(
  onto: string,
  expectedStateToken: string,
): GitRepositoryAction {
  return { kind: "startRebase", onto, expectedStateToken };
}

/* --------------------------------- 远端 ----------------------------------- */

/**
 * 展示用的 URL 脱敏，和 Runtime 的规则一致：http/https/ssh 里的 userinfo
 * 一律换成 `[redacted]`。用户刚输入的 URL 也会经过它，免得凭据留在本次会话的
 * 操作列表里。
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^(https?|ssh):\/\/[^/\s@]+@/i, "$1://[redacted]@");
}

export function fetchRemote(
  remote: string,
  prune: boolean,
): GitRepositoryAction {
  return { kind: "fetch", remote, prune };
}

export function pullBranch(
  remote: string,
  branch: string,
): GitRepositoryAction {
  return { kind: "pull", remote, branch };
}

export function pushBranch(
  remote: string,
  branch: string,
  setUpstream: boolean,
  forceWithLease: GitForceWithLease | null,
): GitRepositoryAction {
  return { kind: "push", remote, branch, setUpstream, forceWithLease };
}

export function syncBranch(
  remote: string,
  branch: string,
  expectedRemoteOid: string | null,
): GitRepositoryAction {
  return { kind: "sync", remote, branch, expectedRemoteOid };
}

export function addRemote(name: string, url: string): GitRepositoryAction {
  return { kind: "addRemote", name, url };
}

export function renameRemote(
  name: string,
  newName: string,
): GitRepositoryAction {
  return { kind: "renameRemote", name, newName };
}

export function setRemoteUrl(name: string, url: string): GitRepositoryAction {
  return { kind: "setRemoteUrl", name, url };
}

export function removeRemote(name: string): GitRepositoryAction {
  return { kind: "removeRemote", name };
}

/* --------------------------------- 标签 ----------------------------------- */

export function createTag(
  name: string,
  targetOid: string,
  message: string | null,
): GitRepositoryAction {
  return { kind: "createTag", name, targetOid, message };
}

export function deleteTag(
  name: string,
  expectedOid: string,
): GitRepositoryAction {
  return { kind: "deleteTag", name, expectedOid };
}

export function pushTag(
  remote: string,
  name: string,
  expectedOid: string,
): GitRepositoryAction {
  return { kind: "pushTag", remote, name, expectedOid };
}

/* -------------------------------- Worktree -------------------------------- */

/**
 * 创建 worktree 的构造已经有一份了，在 `../worktree.ts` 的
 * `createWorktreeAction()`——它连同「新建分支时不能带 expectedOid」的校验
 * 一起，早就被 `Worktrees.tsx` 用着。这里不再造第二份。
 */
export function removeWorktree(
  path: string,
  expectedOid: string,
  allowUnpublished: boolean,
): GitRepositoryAction {
  return { kind: "removeWorktree", path, expectedOid, allowUnpublished };
}
