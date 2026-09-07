import { describe, expect, it } from "vitest";

import { commitGraph } from "../CommitGraph";
import { commitKey, logGraphKeys, repositoryColor } from "./graph";
import type { LogCommit } from "./types";

const oid = (char: string) => char.repeat(40);

const commit = (
  repositoryPath: string,
  id: string,
  parents: string[],
): LogCommit => ({
  repositoryPath,
  oid: id,
  parents,
  subject: `${repositoryPath} ${id.slice(0, 4)}`,
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-09-01T00:00:00Z",
  committerTime: "2026-09-01T00:00:00Z",
  refs: [],
});

describe("多仓库的车道", () => {
  it("两个仓库的 DAG 互不相连，各占一条车道", () => {
    // 时间上交错：根仓库、嵌套仓库、根仓库、嵌套仓库。
    const commits = [
      commit(".", oid("a"), [oid("b")]),
      commit("packages/foo", oid("c"), [oid("d")]),
      commit(".", oid("b"), []),
      commit("packages/foo", oid("d"), []),
    ];
    const graph = commitGraph(commits, logGraphKeys);
    const lane = (entry: LogCommit) => graph.points.get(commitKey(entry))!.lane;
    expect(lane(commits[0]!)).toBe(0);
    expect(lane(commits[2]!)).toBe(0);
    // 第二个仓库拿到自己的车道，而不是挤进第一个仓库的那条。
    expect(lane(commits[1]!)).toBe(1);
    expect(lane(commits[3]!)).toBe(1);
    expect(graph.lanes).toBe(2);
    // 边只在同一个仓库里连。
    for (const edge of graph.edges) {
      expect(edge.child.split(":")[0]).toBe(edge.parent.split(":")[0]);
    }
  });

  it("两个仓库里碰巧同 oid 的提交不会被连成一条线", () => {
    const shared = oid("a");
    const commits = [
      commit(".", shared, [oid("b")]),
      commit("worktrees/x", shared, [oid("b")]),
      commit(".", oid("b"), []),
    ];
    const graph = commitGraph(commits, logGraphKeys);
    // 同一个 oid 出现两次，但它们是两个点。
    expect(graph.points.get(`.:${shared}`)!.row).toBe(0);
    expect(graph.points.get(`worktrees/x:${shared}`)!.row).toBe(1);
    // 第二个仓库那条父边的父提交不在本页，画成残桩。
    const stub = graph.edges.find(
      (edge) => edge.child === `worktrees/x:${shared}`,
    )!;
    expect(stub.to).toBeUndefined();
    const inside = graph.edges.find((edge) => edge.child === `.:${shared}`)!;
    expect(inside.to).toBeDefined();
  });

  it("缺省的 key 仍然是裸 oid，单仓库的图一个字都不用改", () => {
    const graph = commitGraph([
      { oid: oid("a"), parents: [oid("b")] },
      { oid: oid("b"), parents: [] },
    ]);
    expect(graph.points.get(oid("a"))!.lane).toBe(0);
    expect(graph.lanes).toBe(1);
  });
});

describe("仓库颜色", () => {
  it("按序号循环，负数与越界都落回色板里", () => {
    expect(repositoryColor(0)).toBe(repositoryColor(8));
    expect(repositoryColor(-1)).toBe(repositoryColor(7));
  });
});
