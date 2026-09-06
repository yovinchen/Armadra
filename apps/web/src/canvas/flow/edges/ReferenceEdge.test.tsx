import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeHandle,
  type NodeTypes,
} from "@xyflow/react";

import { installDomPolyfills } from "@/app/test-harness";
import { makeItem, makeNode } from "@/canvas/test-support";

const removeContentReference = vi.fn();
vi.mock("@/canvas/create-content-reference", () => ({
  removeContentReference: (...args: unknown[]) =>
    (removeContentReference as (...a: unknown[]) => void)(...args),
}));

const { edgeTypes } = await import("./edge-types");

/**
 * 内容引用边的渲染（React Flow 计划 §2.3 / F29）。
 *
 * 三件事：画的是直线不是贝塞尔、只有一个指向**节点**那一端的箭头、
 * 选中时浮出删除按钮且点它只删引用不删对象。
 */

beforeAll(installDomPolyfills);
afterEach(() => {
  cleanup();
  removeContentReference.mockClear();
});

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const item = makeItem("shape");
const ITEM = `wb:${item.id}`;

const nodeTypes: NodeTypes = {
  armadra: () => null,
  "wb.shape": () => null,
};

const HANDLES: NodeHandle[] = [
  { id: "left", type: "source", position: Position.Left, x: 0, y: 50 },
  { id: "body", type: "target", position: Position.Left, x: 0, y: 0 },
];

function flowNode(id: string, type: string, x: number, data: object): Node {
  return {
    id,
    type,
    position: { x, y: 0 },
    width: 100,
    height: 100,
    handles: HANDLES,
    data: data as Record<string, unknown>,
  };
}

function renderEdge(selected = false) {
  const edge: Edge = {
    id: "r1",
    type: "reference",
    source: ITEM,
    target: NODE,
    selected,
  };
  return render(
    <ReactFlowProvider>
      <ReactFlow
        width={800}
        height={600}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodes={[
          flowNode(ITEM, "wb.shape", 0, item),
          flowNode(NODE, "armadra", 300, makeNode("terminal", { id: NODE })),
        ]}
        edges={[edge]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onViewportChange={() => undefined}
        onError={() => undefined}
      />
    </ReactFlowProvider>,
  );
}

function edgeGroup(container: HTMLElement): SVGGElement {
  const group = container.querySelector('[data-slot="reference-edge"]');
  expect(group).not.toBeNull();
  return group as SVGGElement;
}

describe("ReferenceEdge", () => {
  it("画的是两个矩形相对边中点之间的直线", () => {
    const { container } = renderEdge();
    const path = edgeGroup(container).querySelector(
      ".react-flow__edge-path",
    ) as SVGPathElement;
    expect(path.getAttribute("d")).toBe("M 100,50 L 300,50");
  });

  it("虚线 + 静音配色，与实线的上下文连线分得开", () => {
    const { container } = renderEdge();
    const path = edgeGroup(container).querySelector(
      ".react-flow__edge-path",
    ) as SVGPathElement;
    expect(path.style.strokeDasharray).toBe("6 5");
    expect(edgeGroup(container).style.color).toBe("var(--muted-foreground)");
  });

  it("只有一个箭头，指向节点那一端", () => {
    const { container } = renderEdge();
    // 主路径 + 命中路径 + 一个箭头。
    const paths = edgeGroup(container).querySelectorAll("path");
    expect(paths).toHaveLength(3);
    const arrow = paths[2] as SVGPathElement;
    // 箭头的顶点落在节点那一侧（x = 300），不是白板对象那一侧。
    expect(arrow.getAttribute("d")).toMatch(/^M \d/u);
    expect(arrow.getAttribute("d")).toContain("300");
  });

  it("选中时换成品牌色", () => {
    const { container } = renderEdge(true);
    expect(edgeGroup(container).style.color).toBe("var(--brand)");
  });

  it("没选中时没有删除按钮", () => {
    const { queryByRole } = renderEdge();
    expect(queryByRole("button")).toBeNull();
  });

  it("选中时浮出删除按钮，点它只删引用行", () => {
    const { container } = renderEdge(true);
    const button = container.querySelector(
      '[data-slot="reference-remove"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    fireEvent.click(button);
    expect(removeContentReference).toHaveBeenCalledWith("r1");
  });

  it("两端有一个还没量到尺寸时整条边不画", () => {
    const edge: Edge = {
      id: "r1",
      type: "reference",
      source: ITEM,
      target: NODE,
    };
    const { container } = render(
      <ReactFlowProvider>
        <ReactFlow
          width={800}
          height={600}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodes={[
            { ...flowNode(ITEM, "wb.shape", 0, item), width: 0, height: 0 },
            flowNode(NODE, "armadra", 300, makeNode("terminal", { id: NODE })),
          ]}
          edges={[edge]}
          onError={() => undefined}
        />
      </ReactFlowProvider>,
    );
    expect(container.querySelector('[data-slot="reference-edge"]')).toBeNull();
  });
});
