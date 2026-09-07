/**
 * Stash 的四个动作（保存 / 应用 / 应用并移除 / 移除），从 `Stashes.tsx` 抽出来
 * 的纯判断部分。提交页工具栏的 `Stash…` 与 `Unstash…` 用的是同一套规则：
 * 冲突未解决时不许应用、同一个对象出现多条记录时不许动、每个动作都绑着读到的
 * 那一版 `stateToken` 与 HEAD。
 */
import type {
  GitRepositoryAction,
  GitStashRecord,
  GitStashSnapshot,
} from "@armadra/shared";
import type { RepositoryRequest } from "./integration";

export type StashEntryAction = "applyStash" | "popStash" | "dropStash";

/** Stash 的动作和别的仓库写没有区别：动作 + 被比对的 HEAD。 */
export type StashRequest = RepositoryRequest;

/**
 * 分支树上那个 stash 节点的动作。
 *
 * 和上面那组不同，它手上只有**这一行读回来的那个对象**加仓库的 state token，
 * 没有整份 `GitStashSnapshot`——分支树一次读回所有仓库的 stash 列表，为了给一
 * 个右键菜单再去读一遍单仓库快照，只会让菜单和树各自看到一个时刻。绑定在
 * `oid` 上是这里成立的原因：`stash@{n}` 这个选择器会在别人 push 或 drop 之后
 * 整体挪位，而对象不会。
 */
export function stashActionAt(
  oid: string,
  expectedStateToken: string,
  kind: StashEntryAction,
  options: { reinstateIndex: boolean } = { reinstateIndex: false },
): GitRepositoryAction {
  const common = { oid, expectedStateToken };
  return kind === "dropStash"
    ? { kind, ...common }
    : { kind, ...common, reinstateIndex: options.reinstateIndex };
}

/** 有东西可存、没有待解决的冲突、HEAD 存在，才谈得上保存一个 stash。 */
export function canCreateStash(
  state: GitStashSnapshot | null | undefined,
): boolean {
  return Boolean(state?.dirty && !state.hasConflicts && state.head.headOid);
}

/** 保存一个 stash；条件不满足时是 `null`，不是一次会被服务端拒掉的请求。 */
export function createStashAction(
  state: GitStashSnapshot | null | undefined,
  options: { message: string; includeUntracked: boolean },
): StashRequest | null {
  if (!state || !canCreateStash(state)) return null;
  return {
    action: {
      kind: "createStash",
      message: options.message,
      includeUntracked: options.includeUntracked,
      expectedStateToken: state.stateToken,
    },
    expected: { ...state.head },
  };
}

/**
 * 同一个对象在列表里只出现一次时才能对它动手。两条记录指向同一个 commit 时，
 * `stash apply <oid>` 到底作用于哪一条是 Git 自己的事——那就不该由这里替用户
 * 猜（`gitStash.duplicate`）。
 */
export function isUniqueStash(
  state: GitStashSnapshot | null | undefined,
  entry: GitStashRecord | null | undefined,
): boolean {
  if (!state || !entry) return false;
  return state.stashes.filter((item) => item.oid === entry.oid).length === 1;
}

/**
 * 应用 / 弹出 / 删除一条 stash。已有冲突时只允许删除：往一个还没解决的索引上
 * 再应用一次，只会把两次冲突混在一起。
 */
export function stashEntryAction(
  state: GitStashSnapshot | null | undefined,
  entry: GitStashRecord | null | undefined,
  kind: StashEntryAction,
  options: { reinstateIndex: boolean },
): StashRequest | null {
  if (!state || !entry || !isUniqueStash(state, entry)) return null;
  if (kind !== "dropStash" && state.hasConflicts) return null;
  const common = { oid: entry.oid, expectedStateToken: state.stateToken };
  return {
    action:
      kind === "dropStash"
        ? { kind, ...common }
        : { kind, ...common, reinstateIndex: options.reinstateIndex },
    expected: { ...state.head },
  };
}
