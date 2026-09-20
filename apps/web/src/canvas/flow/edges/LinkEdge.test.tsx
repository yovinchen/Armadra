import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeHandle,
  type NodeTypes,
} from "@xyflow/react";
import type { CanvasNode, WorkspaceEvent } from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { makeNode } from "@/canvas/test-support";
import { dispatchWorkspaceEvent } from "@/api/events";
import { DELIVERY_FLASH_MS, useDeliveryStore } from "@/agent/delivery-store";
import { edgeTypes } from "./edge-types";
import { deliveryTooltip } from "./LinkEdge";

/**
 * 上下文连线的渲染（React Flow 计划 F06）。
 *
 * 断言的是「画出来的是不是那条贝塞尔」：路径的起点终点落在两个矩形相对的
 * 边中点上、箭头按类型出、标签在缩放够大时才画。几何本身在
 * `link-path.test.ts` 与 `link-visual.test.ts`。
 */

beforeAll(installDomPolyfills);

beforeEach(() => {
  // 闪动有一个明确的终点，所以时间在这一组里是一个值。
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useDeliveryStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

function flowNode(
  id: string,
  type: CanvasNode["type"],
  x: number,
  title?: string,
): Node {
  return {
    id,
    type: "armadra",
    position: { x, y: 0 },
    width: 100,
    height: 100,
    handles: HANDLES,
    data: makeNode(type, {
      id,
      ...(title === undefined ? {} : { title }),
    }) as unknown as Record<string, unknown>,
  };
}

function renderEdge(
  sourceType: CanvasNode["type"],
  targetType: CanvasNode["type"],
  options: { selected?: boolean; zoom?: number; role?: string } = {},
) {
  const edge: Edge = {
    id: "e1",
    type: "link",
    source: A,
    target: B,
    selected: options.selected ?? false,
    data: options.role === undefined ? {} : { role: options.role },
  };
  return render(
    <ReactFlowProvider>
      <ReactFlow
        width={800}
        height={600}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodes={[
          flowNode(A, sourceType, 0, "planner"),
          flowNode(B, targetType, 300, "codex-1"),
        ]}
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

  /**
   * 投递（设计 §10）。闪动是**一次事件**：两秒之内这条边高亮并有一段流动的
   * 虚线，之后自己回到常态；悬停提示留着，因为「最近一次」比「刚刚」长命。
   */
  it("一次投递让这条边闪一下，两秒后自己停", () => {
    act(() => {
      dispatchWorkspaceEvent({
        type: "agent.delivery",
        traceId: "t-1",
        sourceNodeId: A,
        targetNodeId: B,
        outcome: "delivered",
      } as WorkspaceEvent);
    });
    const { container } = renderEdge("terminal", "terminal");
    expect(edgeGroup(container).dataset.delivery).toBe("true");
    expect(
      edgeGroup(container).querySelector(".anim-delivery-flow"),
    ).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(DELIVERY_FLASH_MS + 10);
    });
    expect(edgeGroup(container).dataset.delivery).toBeUndefined();
    expect(
      edgeGroup(container).querySelector(".anim-delivery-flow"),
    ).toBeNull();
  });

  /**
   * 主从边（连线角色）。它是画布上唯一一条有方向的关系，所以方向不能只写在
   * 悬停提示里：一个箭头指向从，颜色用品牌色。
   */
  it("主从边只画一个指向从的箭头并用品牌色", () => {
    const peer = renderEdge("terminal", "terminal");
    // 对等的终端 ↔ 终端是两个箭头，颜色中性。
    expect(edgeGroup(peer.container).querySelectorAll("path")).toHaveLength(4);
    expect(edgeGroup(peer.container).dataset.role).toBeUndefined();
    cleanup();

    const lead = renderEdge("terminal", "terminal", { role: "supervises" });
    const group = edgeGroup(lead.container);
    expect(group.dataset.role).toBe("supervises");
    expect(group.style.color).toBe("var(--brand)");
    // 主路径 + 命中路径 + 一个箭头。
    expect(group.querySelectorAll("path")).toHaveLength(3);
    expect(group.querySelector("title")?.textContent).toContain(
      "主 @planner → 从 @codex-1",
    );
  });

  it("悬停提示说最近一次的结果与时刻，被拒的多说一句为什么", () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      `${key}${vars === undefined ? "" : JSON.stringify(vars)}`;
    expect(deliveryTooltip(undefined, t)).toBeNull();
    const refused = deliveryTooltip(
      {
        sourceNodeId: A,
        targetNodeId: B,
        outcome: "refused",
        code: "LOOP_DETECTED",
        at: Date.now(),
      },
      t,
    );
    expect(refused).toContain("delivery.edge.last");
    expect(refused).toContain("error.delivery.LOOP_DETECTED");
  });
});
