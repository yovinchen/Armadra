import { describe, expect, it, vi } from "vitest";
import type { TLResizeInfo } from "tldraw";

/**
 * `tldraw` 在模块加载时就探测环境（`environment.ts` 读 `matchMedia`），
 * jsdom 没有这一项。`vi.hoisted` 会被提到所有 import 之前，正好赶得上。
 */
vi.hoisted(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

import { COLLAPSED_HEIGHT, NODE_META } from "@/nodes/registry";
import { ArmadraShapeUtil, shapeToCanvasNode } from "./ArmadraShapeUtil";
import {
  toNodeId,
  toShapeId,
  type ArmadraProps,
  type ArmadraShape,
} from "./armadra-shape";

/**
 * `ShapeUtil` 的这几个方法都是纯函数（不碰 editor），所以直接在原型上调，
 * 不用把整个 `<Tldraw>` 挂起来。
 */
const util = ArmadraShapeUtil.prototype;

const NODE_ID = "11111111-2222-4333-8444-555555555555";

function makeShape(props: Partial<ArmadraProps> = {}): ArmadraShape {
  const defaults = ArmadraShapeUtil.prototype.getDefaultProps.call(
    {},
  ) as ArmadraProps;
  return {
    id: toShapeId(NODE_ID),
    type: "armadra",
    typeName: "shape",
    x: 100,
    y: 200,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { ...defaults, ...props },
  } as unknown as ArmadraShape;
}

/** `resizeBox` 只用到 `scaleX/scaleY` 与初始尺寸，其余字段不参与。 */
function resizeInfo(
  shape: ArmadraShape,
  scaleX: number,
  scaleY: number,
): TLResizeInfo<ArmadraShape> {
  return {
    newPoint: { x: shape.x, y: shape.y },
    handle: "bottom_right",
    mode: "resize_bounds",
    scaleX,
    scaleY,
    initialBounds: {
      x: shape.x,
      y: shape.y,
      w: shape.props.w,
      h: shape.props.h,
    },
    initialShape: shape,
  } as unknown as TLResizeInfo<ArmadraShape>;
}

describe("ArmadraShapeUtil", () => {
  it("registers the shape type and default props", () => {
    expect(ArmadraShapeUtil.type).toBe("armadra");
    const defaults = util.getDefaultProps.call({}) as ArmadraProps;
    expect(defaults.nodeType).toBe("terminal");
    expect(defaults.w).toBe(NODE_META.terminal.defaultSize.width);
    expect(defaults.collapsed).toBe(false);
  });

  it("never culls: a hidden shape would make the terminal fit to 0×0", () => {
    expect(util.canCull.call(util)).toBe(false);
  });

  /** 选中框自己画，把手用 tldraw 的；旋转把手藏掉（终端文字要保持水平）。 */
  it("keeps tldraw resize handles and hides the rotate handle", () => {
    expect(util.canResize.call(util)).toBe(true);
    expect(util.hideResizeHandles.call(util)).toBe(false);
    expect(util.hideRotateHandle.call(util)).toBe(true);
    expect(util.hideSelectionBoundsFg.call(util)).toBe(true);
    expect(util.canEdit.call(util)).toBe(false);
  });

  it("clamps a resize to NODE_META.minSize", () => {
    const shape = makeShape({ nodeType: "files", w: 340, h: 460 });
    const next = util.onResize.call(util, shape, resizeInfo(shape, 0.1, 0.1));
    expect(next?.props?.w).toBe(NODE_META.files.minSize.width);
    expect(next?.props?.h).toBe(NODE_META.files.minSize.height);
  });

  it("grows freely above the minimum", () => {
    const shape = makeShape({ nodeType: "sticky", w: 240, h: 200 });
    const next = util.onResize.call(util, shape, resizeInfo(shape, 2, 2));
    expect(next?.props?.w).toBe(480);
    expect(next?.props?.h).toBe(400);
    expect(next?.props?.expandedHeight).toBe(400);
  });

  /** 折叠时高度钉死、上下边不动：纵向 resize 被禁掉（§4.1）。 */
  it("pins the height and the top edge while collapsed", () => {
    const shape = makeShape({
      nodeType: "terminal",
      collapsed: true,
      w: 640,
      h: COLLAPSED_HEIGHT,
    });
    const next = util.onResize.call(util, shape, resizeInfo(shape, 1.5, 4));
    expect(next?.props?.h).toBe(COLLAPSED_HEIGHT);
    expect(next?.props?.w).toBe(960);
    expect(next?.y).toBe(shape.y);
  });

  it("draws a rounded indicator the size of the shape", () => {
    const shape = makeShape({ w: 300, h: 180 });
    const calls: unknown[][] = [];
    class FakePath {
      roundRect(...args: unknown[]) {
        calls.push(args);
      }
    }
    const original = globalThis.Path2D;
    // @ts-expect-error jsdom 没有 Path2D，测的是参数不是绘制结果
    globalThis.Path2D = FakePath;
    try {
      util.getIndicatorPath.call(util, shape);
    } finally {
      globalThis.Path2D = original;
    }
    expect(calls).toEqual([[0, 0, 300, 180, 10]]);
  });
});

describe("shapeToCanvasNode", () => {
  it("takes every mirrored field from the shape, not from the store", () => {
    const shape = makeShape({
      nodeType: "sticky",
      title: "便签",
      color: "#ffd60a",
      w: 240,
      h: 200,
      labels: ["紧急"],
      note: "记一笔",
      data: { kind: "sticky", content: "hi" },
    });
    const node = shapeToCanvasNode(shape);
    expect(node.id).toBe(toNodeId(shape.id));
    expect(node.type).toBe("sticky");
    expect(node.title).toBe("便签");
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.size).toEqual({ width: 240, height: 200 });
    expect(node.labels).toEqual(["紧急"]);
    expect(node.note).toBe("记一笔");
  });

  it("borrows only boardId / parentId / updatedAt from the stored node", () => {
    const shape = makeShape({ title: "shape 赢", w: 800 });
    const node = shapeToCanvasNode(shape, {
      id: NODE_ID,
      boardId: "b1",
      parentId: "p1",
      type: "terminal",
      title: "store 输",
      color: "#000",
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      labels: [],
      note: "",
      data: { kind: "terminal" },
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
    } as never);
    expect(node.title).toBe("shape 赢");
    expect(node.size).toEqual({ width: 800, height: 440 });
    expect(node.boardId).toBe("b1");
    expect(node.parentId).toBe("p1");
    expect(node.updatedAt).toBe("2026-09-04T09:00:00.000Z");
  });

  it("omits expandedHeight until one has been recorded", () => {
    expect(shapeToCanvasNode(makeShape()).expandedHeight).toBeUndefined();
    expect(
      shapeToCanvasNode(makeShape({ expandedHeight: 440 })).expandedHeight,
    ).toBe(440);
  });
});
