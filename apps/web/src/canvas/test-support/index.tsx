import * as React from "react";
import { ReactFlow, ReactFlowProvider, type NodeTypes } from "@xyflow/react";
import { act, render, type RenderResult } from "@testing-library/react";
import type { CanvasEdge, CanvasNode, CanvasNodeType } from "@armadra/shared";

import {
  emptyWhiteboard,
  type Item,
  type ItemStyle,
  type WhiteboardDoc,
} from "../whiteboard/model";

/**
 * 画布单测的共享夹具（React Flow 计划 §5.3 最后一条）。
 *
 * 三样东西：造节点、造白板对象、把组件挂进一个真的 `<ReactFlow>` 里。
 *
 * 第三样不是可有可无的：`<Handle>` 与 `<NodeResizer>` 要的不只是
 * `<ReactFlowProvider>`，还有 React Flow 在**节点包装层**里给的
 * `NodeIdContext` 与 `HandleConfigContext`。所以 `renderFlow` 老老实实
 * 渲一个只有一个节点的画布，把被测组件当成那个节点的内容。
 */

const STAMP = "2026-09-06T00:00:00.000Z";

let counter = 0;

/** 稳定的假 uuid：同一个测试里按调用顺序递增，断言读起来不费劲。 */
export function testUuid(seed = ++counter): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export function makeNode(
  type: CanvasNodeType,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id: testUuid(),
    boardId: testUuid(1),
    type,
    title: type,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 240, height: 200 },
    labels: [],
    note: "",
    data: { kind: type },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  } as CanvasNode;
}

export function makeEdge(source: string, target: string): CanvasEdge {
  return {
    id: testUuid(),
    boardId: testUuid(1),
    source,
    target,
    kind: "link",
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

const DEFAULT_STYLE: ItemStyle = { color: "black", size: "m" };

/** 造一条白板对象。`kind` 决定它自己那几个字段的默认值。 */
export function makeItem(
  kind: Item["kind"] = "shape",
  overrides: Partial<Item> = {},
): Item {
  const base = {
    id: testUuid(),
    x: 0,
    y: 0,
    w: 120,
    h: 80,
    z: 0,
    style: DEFAULT_STYLE,
  };
  const specific: Record<Item["kind"], Record<string, unknown>> = {
    ink: { points: [[0, 0, 0.5]] },
    text: { text: "" },
    shape: { geo: "rectangle" },
    image: { assetPath: ".armadra/assets/0000000000000000.png" },
    line: {
      points: [
        [0, 0],
        [120, 80],
      ],
    },
  };
  return { ...base, kind, ...specific[kind], ...overrides } as Item;
}

export function makeWhiteboard(items: Item[] = []): WhiteboardDoc {
  return { ...emptyWhiteboard(), items };
}

export interface RenderFlowOptions {
  /** 被测组件所在节点的 id；`useNodeId()` 会读到它。 */
  nodeId?: string;
  /** 节点尺寸，`NodeResizer` 与折叠断言要用。 */
  width?: number;
  height?: number;
  selected?: boolean;
}

export interface FlowRenderResult extends RenderResult {
  /**
   * 换掉节点内容而**不重挂画布**。
   *
   * 不能用 RTL 的 `rerender`：那会造一个新的 `nodeTypes.test` 组件，React
   * Flow 会把节点整个卸载重建，「折叠时节点体不卸载」这类断言就失去意义。
   * 所以内容走一个外部小 store，节点组件本身始终是同一个。
   */
  rerenderNode: (next: React.ReactNode) => void;
}

/**
 * 把 `children` 当成一个自定义节点的内容渲进真实画布。
 *
 * jsdom 量不出容器尺寸，所以显式给 `width` / `height`；React Flow 的
 * `onError` 接成空操作，免得它为「容器没有宽高」在每个测试里刷一行警告。
 */
export function renderFlow(
  children: React.ReactNode,
  options: RenderFlowOptions = {},
): FlowRenderResult {
  const nodeId = options.nodeId ?? "test-node";
  let current = children;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const Slot = () => (
    <>
      {React.useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
      )}
    </>
  );
  const nodeTypes: NodeTypes = { test: Slot };
  const result = render(
    <ReactFlowProvider>
      <ReactFlow
        width={800}
        height={600}
        nodeTypes={nodeTypes}
        nodes={[
          {
            id: nodeId,
            type: "test",
            position: { x: 0, y: 0 },
            width: options.width ?? 240,
            height: options.height ?? 200,
            selected: options.selected ?? false,
            data: {},
          },
        ]}
        edges={[]}
        onError={() => undefined}
      />
    </ReactFlowProvider>,
  );
  return {
    ...result,
    rerenderNode(next) {
      current = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** 仅测试用：把 `testUuid` 的计数器归零。 */
export function resetTestUuids(): void {
  counter = 0;
}
