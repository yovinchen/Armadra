import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Position, type ConnectionLineComponentProps } from "@xyflow/react";

import { linkCurve } from "./link-path";
import { ConnectionLine } from "./ConnectionLine";

/**
 * 拖线时的预览（React Flow 计划 §2.5 第三条）。
 *
 * 替代旧引擎的 `shapes/NodeArrowShapeUtil.test.tsx`（那一项测的是箭头工具
 * 的预览覆写）。这里只有一条断言值得写：预览与落成后的 `LinkEdge`
 * **必须是同一条曲线**，否则松手那一刻线会突然弹到别处。
 */

afterEach(cleanup);

function internalNode(x: number, y: number) {
  return {
    id: `n-${x}`,
    measured: { width: 100, height: 100 },
    width: 100,
    height: 100,
    internals: { positionAbsolute: { x, y } },
  };
}

function renderLine(
  toNode: ReturnType<typeof internalNode> | null,
  status: "valid" | "invalid" | null = null,
) {
  const props = {
    fromNode: internalNode(0, 0),
    toNode,
    toX: 300,
    toY: 50,
    fromX: 100,
    fromY: 50,
    fromPosition: Position.Right,
    toPosition: Position.Left,
    connectionStatus: status,
  } as unknown as ConnectionLineComponentProps;
  return render(
    <svg>
      <ConnectionLine {...props} />
    </svg>,
  );
}

function path(container: HTMLElement): SVGPathElement {
  return container.querySelector(
    '[data-slot="connection-line"] path',
  ) as SVGPathElement;
}

describe("ConnectionLine", () => {
  it("落在目标上时画的就是 `LinkEdge` 那条曲线", () => {
    const { container } = renderLine(internalNode(300, 0));
    const expected = linkCurve(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 300, y: 0, width: 100, height: 100 },
    );
    expect(path(container).getAttribute("d")).toBe(expected.d);
  });

  it("还没落到目标上时把指针当成零尺寸矩形，仍然贴边起笔", () => {
    const { container } = renderLine(null);
    const d = path(container).getAttribute("d") ?? "";
    // 起点是起笔节点右侧边的中点，不是节点中心也不是把手坐标。
    expect(d).toMatch(/^M 100,50 C /u);
    expect(d).toMatch(/ 300,50$/u);
  });

  it("悬空时画虚线，落到目标上变实线", () => {
    const loose = renderLine(null);
    expect(path(loose.container).getAttribute("stroke-dasharray")).toBe("6 4");
    cleanup();

    const landed = renderLine(internalNode(300, 0));
    expect(path(landed.container).getAttribute("stroke-dasharray")).toBeNull();
  });

  it("合法目标是品牌色，非法目标是危险色，悬空是中性灰", () => {
    const cases: [
      "valid" | "invalid" | null,
      ReturnType<typeof internalNode> | null,
      string,
    ][] = [
      ["valid", internalNode(300, 0), "var(--brand)"],
      ["invalid", internalNode(300, 0), "var(--danger)"],
      [null, null, "var(--muted-foreground)"],
    ];
    for (const [status, toNode, colour] of cases) {
      const { container } = renderLine(toNode, status);
      expect(path(container).getAttribute("stroke")).toBe(colour);
      cleanup();
    }
  });
});
