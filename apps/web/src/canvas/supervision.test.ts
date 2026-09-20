import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "@armadra/shared";

import { makeNode } from "./test-support";
import { displayNameOf, supervisionBadge, supervisionFor } from "./supervision";

/**
 * 主从关系的读法。
 *
 * 三条值得守：缺省是对等（老画布上每条线都没有这个字段）；主被删掉之后从节点
 * 说的是「主已离开」而不是「没有主」；一条链的中间一环画的是它的上级。
 */

const lead = makeNode("terminal", { title: "planner" }) as CanvasNode;
const report = makeNode("terminal", { title: "codex-1" }) as CanvasNode;
const other = makeNode("terminal", { title: "codex-2" }) as CanvasNode;

const edge = (
  source: string,
  target: string,
  role?: CanvasEdge["role"],
): CanvasEdge =>
  ({
    id: `${source}->${target}`,
    boardId: "board",
    source,
    target,
    kind: "link",
    ...(role === undefined ? {} : { role }),
    createdAt: "",
    updatedAt: "",
  }) as CanvasEdge;

describe("supervisionFor", () => {
  it("没有 role 的边一律是对等，谁都没有上级", () => {
    const edges = [edge(lead.id, report.id)];
    expect(supervisionFor(report.id, edges, [lead, report])).toEqual({
      subordinates: [],
    });
    expect(
      supervisionBadge(supervisionFor(report.id, edges, [lead, report])),
    ).toBeUndefined();
  });

  it("source 是主，target 是从", () => {
    const edges = [
      edge(lead.id, report.id, "supervises"),
      edge(lead.id, other.id, "supervises"),
    ];
    const nodes = [lead, report, other];
    expect(supervisionFor(lead.id, edges, nodes).subordinates).toEqual([
      report.id,
      other.id,
    ]);
    expect(supervisionBadge(supervisionFor(lead.id, edges, nodes))).toEqual({
      kind: "supervisor",
      count: 2,
    });
    expect(supervisionBadge(supervisionFor(report.id, edges, nodes))).toEqual({
      kind: "subordinate",
      name: "planner",
    });
  });

  it("主被删掉之后是「主已离开」，不是「没有主」", () => {
    const edges = [edge(lead.id, report.id, "supervises")];
    const badge = supervisionBadge(supervisionFor(report.id, edges, [report]));
    expect(badge).toEqual({ kind: "orphan" });
  });

  it("一条链的中间一环画的是它的上级", () => {
    const edges = [
      edge(lead.id, report.id, "supervises"),
      edge(report.id, other.id, "supervises"),
    ];
    const nodes = [lead, report, other];
    const middle = supervisionFor(report.id, edges, nodes);
    expect(middle.subordinates).toEqual([other.id]);
    expect(supervisionBadge(middle)).toEqual({
      kind: "subordinate",
      name: "planner",
    });
  });
});

describe("displayNameOf", () => {
  it("名字优先，其次标题，最后退回给的那个 id", () => {
    const named = {
      ...report,
      data: { ...report.data, handle: "codex-1" },
    } as CanvasNode;
    expect(displayNameOf(named, "x")).toBe("codex-1");
    expect(displayNameOf(report, "x")).toBe("codex-1");
    expect(displayNameOf(undefined, "x")).toBe("x");
  });
});
