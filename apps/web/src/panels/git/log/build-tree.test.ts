import { describe, expect, it } from "vitest";

import {
  buildBranchTree,
  defaultExpanded,
  flattenTree,
  refKey,
  type BranchTreeNode,
} from "./build-tree";
import type { GitRefsBranch, GitRefsRepository } from "./types";

const branch = (
  name: string,
  overrides: Partial<GitRefsBranch> = {},
): GitRefsBranch => ({
  name,
  oid: "a".repeat(40),
  upstream: null,
  ahead: null,
  behind: null,
  current: false,
  ...overrides,
});

const repository = (
  overrides: Partial<GitRefsRepository> = {},
): GitRefsRepository => ({
  repositoryPath: ".",
  name: "armadra",
  head: "main",
  branches: [branch("main", { current: true })],
  remotes: [],
  tags: [],
  worktrees: [],
  stashCount: 0,
  ...overrides,
});

/** 找一个节点，不管它埋在第几层。 */
function find(
  nodes: readonly BranchTreeNode[],
  id: string,
): BranchTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = find(node.children, id);
    if (inner) return inner;
  }
  return null;
}

function labels(nodes: readonly BranchTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.label, ...labels(node.children)]);
}

describe("分支树的构造", () => {
  it("顶上永远是跨仓库的 HEAD 节点", () => {
    const tree = buildBranchTree([repository()]);
    expect(tree[0]!.kind).toBe("head");
    expect(tree[0]!.repositoryPath).toBeNull();
  });

  it("每个仓库一个根，根下固定四组", () => {
    const tree = buildBranchTree([repository()]);
    const root = tree[1]!;
    expect(root.kind).toBe("repository");
    expect(root.children.map((child) => child.group)).toEqual([
      "local",
      "remotes",
      "tags",
      "worktrees",
    ]);
  });

  it("Stash 只在有条目时出现，并带上条数", () => {
    const tree = buildBranchTree([repository({ stashCount: 3 })]);
    const stashes = tree[1]!.children.find(
      (child) => child.group === "stashes",
    );
    expect(stashes?.count).toBe(3);
  });

  it("同一段下的多条分支折进一个段，单独一条不折", () => {
    const tree = buildBranchTree([
      repository({
        branches: [
          branch("main"),
          branch("feat/foo"),
          branch("feat/bar"),
          branch("release/1.0"),
        ],
      }),
    ]);
    const local = find(tree, ".::local")!;
    const names = local.children.map((child) => child.label);
    // `feat` 是一层，`release/1.0` 独自一条所以留在原地。
    expect(names).toContain("feat");
    expect(names).toContain("release/1.0");
    const segment = local.children.find((child) => child.label === "feat")!;
    expect(segment.kind).toBe("segment");
    expect(segment.children.map((child) => child.reference).sort()).toEqual([
      "feat/bar",
      "feat/foo",
    ]);
  });

  it("折进段里的叶子仍然带完整分支名与它观察到的 oid", () => {
    const tree = buildBranchTree([
      repository({
        branches: [
          branch("feat/foo", { oid: "b".repeat(40) }),
          branch("feat/bar"),
        ],
      }),
    ]);
    const leaf = find(tree, ".::local/feat/foo")!;
    expect(leaf.reference).toBe("feat/foo");
    expect(leaf.oid).toBe("b".repeat(40));
  });

  it("当前分支带上 current 标记", () => {
    const tree = buildBranchTree([repository()]);
    expect(find(tree, ".::local/main")!.current).toBe(true);
  });

  it("收藏的分支排在同层最前", () => {
    const tree = buildBranchTree(
      [
        repository({
          branches: [branch("aaa"), branch("main"), branch("zzz")],
        }),
      ],
      { favorites: [refKey(".", "zzz")] },
    );
    const local = find(tree, ".::local")!;
    expect(local.children.map((child) => child.label)).toEqual([
      "zzz",
      "aaa",
      "main",
    ]);
    expect(local.children[0]!.favorite).toBe(true);
  });

  it("远端按远端名再分一层，引用名仍然是完整的", () => {
    const tree = buildBranchTree([
      repository({
        remotes: [
          {
            name: "origin",
            branches: [branch("origin/main"), branch("origin/dev")],
          },
        ],
      }),
    ]);
    const remote = find(tree, ".::remote::origin")!;
    expect(remote.kind).toBe("remote");
    expect(remote.children.map((child) => child.label).sort()).toEqual([
      "dev",
      "main",
    ]);
    expect(remote.children.map((child) => child.reference).sort()).toEqual([
      "origin/dev",
      "origin/main",
    ]);
  });

  it("两个仓库的同名分支是两个节点", () => {
    const tree = buildBranchTree([
      repository(),
      repository({ repositoryPath: "packages/foo", name: "foo" }),
    ]);
    expect(find(tree, ".::local/main")).not.toBeNull();
    expect(find(tree, "packages/foo::local/main")).not.toBeNull();
  });

  it("过滤保留命中叶子的每一层祖先，并丢掉整棵没命中的仓库", () => {
    const tree = buildBranchTree(
      [
        repository({ branches: [branch("main"), branch("feat/login")] }),
        repository({
          repositoryPath: "packages/foo",
          name: "foo",
          branches: [branch("main")],
        }),
      ],
      { filter: "login" },
    );
    // HEAD 永远在；命中的那个仓库连同 `本地` 组一起留下。
    expect(tree[0]!.kind).toBe("head");
    expect(tree).toHaveLength(2);
    expect(labels(tree)).toContain("feat/login");
    expect(labels(tree)).not.toContain("foo");
  });

  it("仓库颜色序号来自日志响应，跟着根节点走", () => {
    const tree = buildBranchTree([repository()], {
      colors: new Map([[".", 2]]),
    });
    expect(tree[1]!.color).toBe(2);
  });
});

describe("铺平与默认展开", () => {
  it("只铺平展开着的那几层", () => {
    const tree = buildBranchTree([repository()]);
    expect(flattenTree(tree, new Set()).map((row) => row.node.kind)).toEqual([
      "head",
      "repository",
    ]);
    const rows = flattenTree(tree, new Set([".::root", ".::local"]));
    expect(rows.map((row) => row.node.id)).toContain(".::local/main");
    expect(rows.find((row) => row.node.id === ".::root")!.expanded).toBe(true);
  });

  it("默认展开每个仓库根与它的本地组", () => {
    expect(defaultExpanded([repository()])).toEqual([".::root", ".::local"]);
  });
});
