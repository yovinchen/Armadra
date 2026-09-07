import { describe, expect, it } from "vitest";

import type { BranchTreeNode } from "../build-tree";
import {
  refMenuItems,
  remoteForReference,
  type RefMenuItem,
} from "./ref-items";

/**
 * 右键菜单最容易错的是「这一项带的是哪个对象」——界面上看不出来，出错时删掉
 * 的却是另一个东西。所以钉住的是动作载荷，不是文案。
 */

const OID = "a".repeat(40);
const TOKEN = "b".repeat(64);

function node(overrides: Partial<BranchTreeNode>): BranchTreeNode {
  return {
    id: "node",
    kind: "branch",
    label: "main",
    repositoryPath: ".",
    reference: "main",
    children: [],
    ...overrides,
  };
}

function items(
  overrides: Partial<BranchTreeNode>,
  input: Partial<Parameters<typeof refMenuItems>[0]> = {},
): RefMenuItem[] {
  return refMenuItems({
    node: node(overrides),
    remotes: ["origin"],
    currentBranch: "main",
    stateToken: TOKEN,
    idle: true,
    busy: false,
    ...input,
  });
}

function pick(list: readonly RefMenuItem[], id: string): RefMenuItem {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`missing menu item ${id}`);
  return found;
}

describe("标签节点", () => {
  const tag = {
    kind: "tag" as const,
    label: "v1.0.0",
    reference: "v1.0.0",
    oid: OID,
  };

  it("删除带的是标签这一次读到的 OID", () => {
    expect(pick(items(tag), "deleteTag").action).toEqual({
      kind: "deleteTag",
      name: "v1.0.0",
      expectedOid: OID,
    });
  });

  it("检出的是标签指向的那个提交", () => {
    expect(pick(items(tag), "checkout").action).toEqual({
      kind: "checkoutCommit",
      targetOid: OID,
    });
  });

  it("只有一个远端时推送直接就是那一项", () => {
    expect(pick(items(tag), "pushTag").action).toEqual({
      kind: "pushTag",
      remote: "origin",
      name: "v1.0.0",
      expectedOid: OID,
    });
  });

  it("多个远端折成子菜单，每一项各带自己的远端", () => {
    const push = pick(items(tag, { remotes: ["origin", "fork"] }), "pushTag");
    expect(push.action).toBeUndefined();
    expect(push.children?.map((child) => child.label)).toEqual([
      "origin",
      "fork",
    ]);
    expect(push.children?.[1]?.action).toMatchObject({
      kind: "pushTag",
      remote: "fork",
    });
  });

  it("一个远端都没有时推送是禁用的，也不造动作", () => {
    const push = pick(items(tag, { remotes: [] }), "pushTag");
    expect(push.disabled).toBe(true);
    expect(push.action).toBeUndefined();
    expect(push.children).toBeUndefined();
  });
});

describe("stash 节点", () => {
  const stash = {
    kind: "stash" as const,
    label: "WIP",
    reference: null,
    oid: OID,
    index: 2,
  };

  it("三个写动作认的是对象 ID 而不是 stash@{n}", () => {
    const list = items(stash);
    for (const id of ["applyStash", "popStash", "dropStash"]) {
      expect(pick(list, id).action).toMatchObject({
        oid: OID,
        expectedStateToken: TOKEN,
      });
      expect(JSON.stringify(pick(list, id).action)).not.toContain("stash@");
    }
  });

  it("应用与弹出会说清索引不恢复；删除是 destructive", () => {
    const list = items(stash);
    expect(pick(list, "applyStash").action).toMatchObject({
      kind: "applyStash",
      reinstateIndex: false,
    });
    expect(pick(list, "dropStash").destructive).toBe(true);
  });

  it("没有 state token 时三个写动作都不造", () => {
    const list = items(stash, { stateToken: null });
    for (const id of ["applyStash", "popStash", "dropStash"]) {
      expect(pick(list, id).disabled).toBe(true);
      expect(pick(list, id).action).toBeUndefined();
    }
    // 只读地看差异不需要 token。
    expect(pick(list, "stashDiff").disabled).toBe(false);
  });
});

describe("worktree 节点", () => {
  const worktree = {
    kind: "worktree" as const,
    label: "/w/feature",
    reference: "feature",
    path: "/w/feature",
    oid: OID,
  };

  it("移除带的是路径与这一行的 HEAD", () => {
    expect(pick(items(worktree), "removeWorktree").action).toEqual({
      kind: "removeWorktree",
      path: "/w/feature",
      expectedOid: OID,
      allowUnpublished: false,
    });
  });

  it("锁住的 worktree 不能移除", () => {
    const list = items({ ...worktree, locked: true });
    expect(pick(list, "removeWorktree").disabled).toBe(true);
    expect(pick(list, "removeWorktree").action).toBeUndefined();
  });

  it("游离的检出没有分支名，开 Frame 这一项是灰的", () => {
    const list = items({ ...worktree, reference: null });
    expect(pick(list, "frame").disabled).toBe(true);
    expect(pick(list, "frame").intent).toBeUndefined();
  });
});

describe("远端与分组", () => {
  it("远端节点的 fetch 有清理与不清理两项", () => {
    const list = items({ kind: "remote", label: "origin", reference: null });
    expect(pick(list, "fetch").action).toEqual({
      kind: "fetch",
      remote: "origin",
      prune: false,
    });
    expect(pick(list, "fetchPrune").action).toEqual({
      kind: "fetch",
      remote: "origin",
      prune: true,
    });
    expect(pick(list, "removeRemote").destructive).toBe(true);
  });

  it("改地址与改名走对话框，不直接发动作", () => {
    const list = items({ kind: "remote", label: "origin", reference: null });
    expect(pick(list, "remoteUrl").action).toBeUndefined();
    expect(pick(list, "remoteUrl").intent).toEqual({
      kind: "prompt",
      prompt: {
        kind: "remoteUrl",
        repositoryPath: ".",
        reference: "origin",
      },
    });
    expect(pick(list, "renameRemote").intent).toMatchObject({
      prompt: { kind: "renameRemote", reference: "origin" },
    });
  });

  it("只有远端分组有「新增远端」，别的分组没有菜单", () => {
    expect(
      items({ kind: "group", group: "remotes", reference: null }),
    ).toHaveLength(1);
    expect(items({ kind: "group", group: "tags", reference: null })).toEqual(
      [],
    );
  });
});

describe("仓库根与 HEAD", () => {
  it("仓库根的引用日志问的是它自己，HEAD 问的是工作区", () => {
    expect(
      pick(items({ kind: "repository", reference: null }), "reflog").intent,
    ).toEqual({ kind: "reflog", repositoryPath: "." });
    expect(
      pick(
        refMenuItems({
          node: node({
            kind: "head",
            repositoryPath: null,
            reference: "HEAD",
          }),
          remotes: [],
          currentBranch: null,
          stateToken: null,
          idle: false,
          busy: false,
        }),
        "reflog",
      ).intent,
    ).toEqual({ kind: "reflog", repositoryPath: "." });
  });

  it("仓库根上的新建分支没有起点，从 HEAD 起", () => {
    expect(
      pick(items({ kind: "repository", reference: null }), "newBranch").intent,
    ).toEqual({
      kind: "prompt",
      prompt: { kind: "branch", repositoryPath: "." },
    });
  });
});

describe("分支节点", () => {
  it("重命名带的是树上画出来的那个 OID", () => {
    expect(pick(items({ oid: OID }), "rename").intent).toEqual({
      kind: "prompt",
      prompt: {
        kind: "renameBranch",
        repositoryPath: ".",
        oid: OID,
        reference: "main",
      },
    });
  });

  it("当前分支不能切换也不能删除", () => {
    const list = items({ oid: OID, current: true });
    expect(pick(list, "switch").disabled).toBe(true);
    expect(pick(list, "deleteBranch").disabled).toBe(true);
    expect(pick(list, "deleteBranch").action).toBeUndefined();
  });

  it("没有远端时推 / 拉 / fetch 都是禁用的", () => {
    const list = items({ oid: OID }, { remotes: [] });
    for (const id of ["push", "setUpstream", "pull", "fetch"]) {
      expect(pick(list, id).disabled).toBe(true);
      expect(pick(list, id).action).toBeUndefined();
    }
  });

  it("仓库不空闲时合并与 rebase 都不造动作", () => {
    const list = items({ oid: OID }, { idle: false });
    expect(pick(list, "merge").action).toBeUndefined();
    expect(pick(list, "rebaseOnto").action).toBeUndefined();
  });
});

describe("远端归属", () => {
  it("带远端前缀的引用推回它自己的远端", () => {
    expect(remoteForReference("fork/main", ["origin", "fork"])).toBe("fork");
  });

  it("本地分支用第一个配置的远端，没有远端时是 null", () => {
    expect(remoteForReference("main", ["origin", "fork"])).toBe("origin");
    expect(remoteForReference("main", [])).toBeNull();
  });
});
