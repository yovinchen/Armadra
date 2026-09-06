import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeHandle,
  type NodeTypes,
} from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { makeNode } from "@/canvas/test-support";
import { edgeTypes } from "./edge-types";

/**
 * 上下文连线的渲染（React Flow 计划 F06）。
 *
 * 断言的是「画出来的是不是那条贝塞尔」：路径的起点终点落在两个矩形相对的
 * 边中点上、箭头按类型出、标签在缩放够大时才画。几何本身在
 * `link-path.test.ts` 与 `link-visual.test.ts`。
 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

const A = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";

/** 节点体不参与这个测试：连线只读矩形与 `data.type`。 */
const nodeTypes: NodeTypes = { armadra: () => null, group: () => null };

/**
 * jsdom 量不出 DOM，所以把手要显式声明——React Flow 找不到两端的把手就
 * 整条边都不画（`getEdgePosition` 的 `error008`）。真实浏览器里这些是
 * `ConnectionHandles` 渲染出来、由 `ResizeObserver` 量出来的。
 */
const HANDLES: NodeHandle[] = [
  { id: "left", type: "source", position: Position.Left, x: 0, y: 50 },
  { id: "right", type: "source", position: Position.Right, x: 100, y: 50 },
  { id: "body", type: "target", position: Position.Left, x: 0, y: 0 },
];

function flowNode(id: string, type: CanvasNode["type"], x: number): Node {
  return {
    id,
    type: "armadra",
    position: { x, y: 0 },
    width: 100,
    height: 100,
    handles: HANDLES,
    data: makeNode(type, { id }) as unknown as Record<string, unknown>,
  };
}

function renderEdge(
  sourceType: CanvasNode["type"],
  targetType: CanvasNode["type"],
  options: { selected?: boolean; zoom?: number } = {},
) {
  const edge: Edge = {
    id: "e1",
    type: "link",
    source: A,
    target: B,
    selected: options.selected ?? false,
  };
  return render(
    <ReactFlowProvider>
      <ReactFlow
        width={800}
        height={600}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodes={[flowNode(A, sourceType, 0), flowNode(B, targetType, 300)]}
        edges={[edge]}
        viewport={{ x: 0, y: 0, zoom: options.zoom ?? 1 }}
        onViewportChange={() => undefined}
        onError={() => undefined}
      />
    </ReactFlowProvider>,
  );
}

function edgeGroup(container: HTMLElement): SVGGElement {
  const group = container.querySelector('[data-slot="link-edge"]');
  expect(group).not.toBeNull();
  return group as SVGGElement;
}

describe("LinkEdge", () => {
  it("画的是两个矩形相对边中点之间的贝塞尔，不是把手之间的直线", () => {
    const { container } = renderEdge("terminal", "terminal");
    const path = edgeGroup(container).querySelector(
      ".react-flow__edge-path",
    ) as SVGPathElement;
    expect(path.getAttribute("d")).toMatch(/^M 100,50 C /u);
    expect(path.getAttribute("d")).toMatch(/ 300,50$/u);
  });

  it("终端 ↔ 终端画两个箭头，内容 → 终端只画一个", () => {
    const both = renderEdge("terminal", "terminal");
    // 主路径 + 命中路径 + 两个箭头。
    expect(edgeGroup(both.container).querySelectorAll("path")).toHaveLength(4);
    cleanup();

    const one = renderEdge("sticky", "terminal");
    expect(edgeGroup(one.container).querySelectorAll("path")).toHaveLength(3);
  });

  it("内容 ↔ 内容一个箭头都不画", () => {
    const { container } = renderEdge("sticky", "editor");
    expect(edgeGroup(container).querySelectorAll("path")).toHaveLength(2);
  });

  it("中点标签按被读取的那一端的类型翻译", () => {
    const { container } = renderEdge("sticky", "terminal");
    expect(edgeGroup(container).querySelector("text")?.textContent).toBe(
      "🗒 便签",
    );
  });

  it("缩放小于 0.5 时不画标签（那时它只剩一团墨点）", () => {
    const { container } = renderEdge("sticky", "terminal", { zoom: 0.4 });
    expect(edgeGroup(container).querySelector("text")).toBeNull();
  });

  it("选中时线变粗并换成品牌色", () => {
    const plain = renderEdge("terminal", "terminal");
    const plainPath = edgeGroup(plain.container).querySelector(
      ".react-flow__edge-path",
    ) as SVGPathElement;
    expect(plainPath.style.strokeWidth).toBe("2");
    expect(edgeGroup(plain.container).style.color).toBe(
      "var(--muted-foreground)",
    );
    cleanup();

    const picked = renderEdge("terminal", "terminal", { selected: true });
    const pickedPath = edgeGroup(picked.container).querySelector(
      ".react-flow__edge-path",
    ) as SVGPathElement;
    expect(pickedPath.style.strokeWidth).toBe("3.5");
    expect(edgeGroup(picked.container).style.color).toBe("var(--brand)");
  });
});
