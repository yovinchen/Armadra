import { describe, expect, it, vi } from "vitest";

/** 只为了拿默认尺寸；节点体（xterm / CodeMirror）不该被拉进纯函数单测。 */
const nodeMetaStub = {
  labelKey: "node.sticky",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import type { CanvasEdge, CanvasNode } from "@armadra/shared";
import type { TLFrameShape } from "tldraw";

import type { ArmadraShape } from "../shapes/armadra-shape";
import type { LinkShape } from "../shapes/link-shape";
import { edgeIdOfShape, linkToEdge, shapeToNode } from "./derive";
import {
  edgeArrowheads,
  edgeLabelKey,
  edgeToLink,
  nodeToShape,
} from "./project";

const BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed00";
const A = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const GROUP = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";
const EDGE = "019ff7d1-0d12-7421-833d-2c5e8d64ed04";
const STAMP = "2026-09-04T10:00:00.000Z";

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: A,
    boardId: BOARD,
    type: "terminal",
    title: "终端",
    color: "#0a84ff",
    position: { x: 120, y: 80 },
    size: { width: 640, height: 440 },
    labels: ["build"],
    note: "记一笔",
    data: { kind: "terminal", cwd: "/tmp" },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...patch,
  } as CanvasNode;
}

const edge: CanvasEdge = {
  id: EDGE,
  boardId: BOARD,
  source: A,
  target: B,
  kind: "link",
  createdAt: STAMP,
  updatedAt: STAMP,
};

describe("nodeToShape / shapeToNode", () => {
  it("普通节点往返恒等", () => {
    const before = node();
    const shape = nodeToShape(before) as ArmadraShape;
    expect(shape.id).toBe(`shape:${A}`);
    expect(shape.type).toBe("armadra");
    expect(shape.x).toBe(120);
    expect(shape.props.w).toBe(640);
    expect(shapeToNode(shape, BOARD, STAMP)).toEqual(before);
  });

  it("组员的父级是 frame 的 shape id，坐标保持相对", () => {
    const before = node({ parentId: GROUP, position: { x: 10, y: 20 } });
    const shape = nodeToShape(before) as ArmadraShape;
    expect(shape.parentId).toBe(`shape:${GROUP}`);
    expect(shape.x).toBe(10);
    expect(shapeToNode(shape, BOARD, STAMP)).toEqual(before);
  });

  it("折叠与展开高度往返恒等", () => {
    const before = node({
      collapsed: true,
      expandedHeight: 440,
      size: { width: 640, height: 40 },
    });
    const shape = nodeToShape(before) as ArmadraShape;
    expect(shape.props.collapsed).toBe(true);
    expect(shapeToNode(shape, BOARD, STAMP)).toEqual(before);
  });

  it("分组变成 frame，标签 / 批注 / 颜色进 meta 后原样取回", () => {
    const before = node({
      id: GROUP,
      type: "group",
      title: "构建",
      color: "#ffd60a",
      data: { kind: "group" },
      labels: ["a", "b"],
      note: "组说明",
      size: { width: 520, height: 360 },
    });
    const frame = nodeToShape(before) as TLFrameShape;
    expect(frame.type).toBe("frame");
    expect(frame.props.name).toBe("构建");
    // 十六进制映射到 tldraw 的颜色名，原值同时留在 meta 里。
    expect(frame.props.color).toBe("yellow");
    expect(shapeToNode(frame, BOARD, STAMP)).toEqual(before);
  });
});

describe("edgeToLink / linkToEdge", () => {
  const nodes = [node(), node({ id: B, position: { x: 900, y: 80 } })];

  it("往返恒等，两端各一条 binding", () => {
    const projection = edgeToLink(edge, nodes);
    expect(projection).not.toBeNull();
    // id 故意不是 `shape:<uuid>`：那种形状会被当成一个节点 shape。
    expect(projection!.shape.id).toBe(`shape:link-${EDGE}`);
    expect(projection!.shape.type).toBe("link");
    // 路径是页面坐标，所以 shape 自己永远在原点。
    expect(projection!.shape.x).toBe(0);
    expect(projection!.shape.y).toBe(0);
    expect(projection!.bindings.map((item) => item.props.terminal)).toEqual([
      "start",
      "end",
    ]);
    expect(projection!.bindings.map((item) => item.toId)).toEqual([
      `shape:${A}`,
      `shape:${B}`,
    ]);
    expect(linkToEdge(projection!.shape, BOARD)).toEqual(edge);
  });

  it("两端节点缺一个就投影不出连线", () => {
    expect(edgeToLink(edge, [node()])).toBeNull();
  });

  it("两端不是节点 uuid 时不是一条边（那是白板 shape）", () => {
    const projection = edgeToLink(edge, nodes)!;
    const stray = {
      ...projection.shape,
      props: { ...projection.shape.props, to: "shape:x1y2z3" },
    } as LinkShape;
    expect(linkToEdge(stray, BOARD)).toBeNull();
  });

  it("「什么算边」只认 link shape 的 edgeId", () => {
    const projection = edgeToLink(edge, nodes)!;
    expect(edgeIdOfShape(projection.shape)).toBe(EDGE);
    // 白板箭头不是边。
    expect(
      edgeIdOfShape({ id: "shape:kJ8dQ1", type: "arrow", meta: {} }),
    ).toBeNull();
    // 便签节点也不是边。
    expect(edgeIdOfShape({ id: `shape:${A}`, type: "armadra" })).toBeNull();
  });

  it("标签按内容那一端的类型走 i18n 键（§21）", () => {
    expect(edgeLabelKey("terminal", "terminal")).toBe("edge.context");
    expect(edgeLabelKey("sticky", "terminal")).toBe("edge.sticky");
    expect(edgeLabelKey("terminal", "editor")).toBe("edge.file");
    expect(edgeLabelKey("terminal", "files")).toBe("edge.dir");
    expect(edgeLabelKey("browser", "terminal")).toBe("edge.web");
    expect(edgeLabelKey("terminal", "diff")).toBe("edge.diff");
  });

  it("箭头方向表达「谁读谁」（§21）", () => {
    expect(edgeArrowheads("terminal", "terminal")).toEqual({
      start: "arrow",
      end: "arrow",
    });
    expect(edgeArrowheads("sticky", "terminal")).toEqual({
      start: "none",
      end: "arrow",
    });
    expect(edgeArrowheads("terminal", "sticky")).toEqual({
      start: "arrow",
      end: "none",
    });
    expect(edgeArrowheads("sticky", "files")).toEqual({
      start: "none",
      end: "none",
    });
  });
});
