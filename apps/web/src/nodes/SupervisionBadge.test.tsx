import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CanvasEdge, CanvasNode } from "@armadra/shared";

import { makeNode } from "@/canvas/test-support";
import { useCanvasStore } from "@/store/canvas-store";
import { SupervisionBadge } from "./SupervisionBadge";
import { HeaderChips } from "./HeaderChips";
import { Badge } from "@/ui/badge";

/**
 * 节点头上的主从徽标与那一排徽标的折叠。
 *
 * 对等不画任何东西；主被删掉之后是「主已离开」。折叠数的是**渲染出来的**
 * 徽标，不是传进来的子元素——一个 `return null` 的组件仍然是一个子元素。
 */

const lead = makeNode("terminal", { title: "planner" }) as CanvasNode;
const report = makeNode("terminal", { title: "codex-1" }) as CanvasNode;

const edge = (role?: CanvasEdge["role"]): CanvasEdge =>
  ({
    id: "e1",
    boardId: "board",
    source: lead.id,
    target: report.id,
    kind: "link",
    ...(role === undefined ? {} : { role }),
    createdAt: "",
    updatedAt: "",
  }) as CanvasEdge;

function seed(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  useCanvasStore.setState({
    document: { board: { id: "board" }, nodes, edges },
  } as never);
}

afterEach(cleanup);

describe("SupervisionBadge", () => {
  it("对等什么都不画", () => {
    seed([lead, report], [edge()]);
    render(<SupervisionBadge node={report} />);
    expect(
      document.querySelector('[data-slot="supervision-badge"]'),
    ).toBeNull();
  });

  it("主画「主 · N 从」，从画「从 @主」", () => {
    seed([lead, report], [edge("supervises")]);
    render(<SupervisionBadge node={lead} />);
    expect(screen.getByText("主 · 1 从")).toBeTruthy();
    cleanup();
    render(<SupervisionBadge node={report} />);
    expect(screen.getByText("从 @planner")).toBeTruthy();
  });

  it("主被删掉之后是「主已离开」", () => {
    seed([report], [edge("supervises")]);
    render(<SupervisionBadge node={report} />);
    expect(screen.getByText("主已离开")).toBeTruthy();
    expect(
      document
        .querySelector('[data-slot="supervision-badge"]')
        ?.getAttribute("data-role"),
    ).toBe("orphan");
  });
});

describe("HeaderChips", () => {
  const chip = (key: string) => <Badge key={key}>{key}</Badge>;

  it("三枚以内平铺，不折", () => {
    render(<HeaderChips>{[chip("a"), chip("b"), chip("c")]}</HeaderChips>);
    expect(
      document.querySelector('[data-slot="header-chips-overflow"]'),
    ).toBeNull();
  });

  it("超过三枚折成一枚计数，多出来的只是藏起来，没有被卸载", () => {
    render(
      <HeaderChips>
        {[chip("a"), chip("b"), chip("c"), chip("d"), chip("e")]}
      </HeaderChips>,
    );
    expect(screen.getByText("···2")).toBeTruthy();
    // 藏起来的那两枚仍然在 DOM 里：它们各自还在订阅事件。
    expect(
      document.querySelector('[data-slot="header-chips"]')?.childElementCount,
    ).toBe(5);
  });

  it("一个什么都不渲染的孩子不算一枚", () => {
    render(
      <HeaderChips>
        {[chip("a"), chip("b"), chip("c"), null, false]}
      </HeaderChips>,
    );
    expect(
      document.querySelector('[data-slot="header-chips-overflow"]'),
    ).toBeNull();
  });
});
