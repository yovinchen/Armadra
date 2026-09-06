import { describe, expect, it } from "vitest";
import type { Board, BoardDocument, CanvasNode } from "@armadra/shared";

import {
  frameById,
  frameSignature,
  frameSource,
  frameSummaryText,
  FRAME_SUMMARY_LIMIT,
} from "./frame-reference";
import {
  emptyWhiteboard,
  type Item,
  type WhiteboardDoc,
} from "./whiteboard/model";

/**
 * Frame 当引用来源（React Flow 计划 §2.5 / F29 的收尾项）。
 *
 * 成员按几何算（白板对象从来没有 `parentId`），清单文案全部从外面喂进来，
 * 签名跟着成员的内容与相对位置走。
 */

const STAMP = "2026-09-06T00:00:00.000Z";
const FRAME = "33333333-3333-4333-8333-333333333333";
const OUTSIDE = "44444444-4444-4444-8444-444444444444";

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: STAMP,
  updatedAt: STAMP,
};

let counter = 0;
const uuid = () =>
  `019ff7d1-0000-7000-8000-${String((counter += 1)).padStart(12, "0")}`;

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: uuid(),
    boardId: board.id,
    type: "terminal",
    title: "term",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...patch,
  } as CanvasNode;
}

function item(patch: Partial<Item> = {}): Item {
  return {
    id: uuid(),
    kind: "text",
    x: 0,
    y: 0,
    w: 20,
    h: 20,
    z: 0,
    style: { color: "black", size: "m" },
    text: "",
    ...patch,
  } as Item;
}

const frame = () =>
  node({
    id: FRAME,
    type: "group",
    title: "设计稿",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 400 },
  });

function doc(nodes: CanvasNode[]): BoardDocument {
  return { board, nodes, edges: [] };
}

function whiteboard(items: Item[]): WhiteboardDoc {
  return { ...emptyWhiteboard(), items };
}

const name = (kind: string) => kind;
const labels = {
  empty: "empty",
  header: "header",
  line: (line: { kind: string; text: string }) =>
    line.text ? `- ${line.kind}=${line.text}` : `- ${line.kind}`,
  more: (rest: number) => `- +${rest}`,
};

describe("frameById", () => {
  it("只认 `group` 节点", () => {
    expect(frameById(doc([frame()]), FRAME)?.id).toBe(FRAME);
    expect(frameById(doc([node({ id: FRAME })]), FRAME)).toBeNull();
    expect(frameById(null, FRAME)).toBeNull();
  });
});

describe("frameSource", () => {
  it("中心落在框里的白板对象与节点都算成员", () => {
    const inside = item({ x: 100, y: 100 });
    const outside = item({ x: 900, y: 900 });
    const member = node({ position: { x: 40, y: 40 } });
    const stranger = node({ id: OUTSIDE, position: { x: 900, y: 900 } });
    const source = frameSource(
      doc([frame(), member, stranger]),
      whiteboard([inside, outside]),
      FRAME,
    )!;
    expect(source.items.map((row) => row.id)).toEqual([inside.id]);
    expect(source.nodes.map((row) => row.id)).toEqual([member.id]);
  });

  it("`parentId` 指着这个 Frame 的节点无条件算成员，别的 Frame 的组员不算", () => {
    const child = node({ parentId: FRAME, position: { x: 5000, y: 5000 } });
    const foreign = node({ parentId: OUTSIDE, position: { x: 10, y: 10 } });
    const source = frameSource(
      doc([frame(), node({ id: OUTSIDE, type: "group" }), child, foreign]),
      whiteboard([]),
      FRAME,
    )!;
    expect(source.nodes.map((row) => row.id)).toEqual([child.id]);
  });

  it("Frame 自己与别的 Frame 都不算成员", () => {
    const other = node({
      id: OUTSIDE,
      type: "group",
      position: { x: 10, y: 10 },
      size: { width: 20, height: 20 },
    });
    const source = frameSource(doc([frame(), other]), whiteboard([]), FRAME)!;
    expect(source.nodes).toEqual([]);
  });

  it("白板对象按 `z` 升序（栅格化的绘制顺序）", () => {
    const top = item({ x: 10, y: 10, z: 9 });
    const bottom = item({ x: 10, y: 10, z: 1 });
    const source = frameSource(
      doc([frame()]),
      whiteboard([top, bottom]),
      FRAME,
    )!;
    expect(source.items.map((row) => row.z)).toEqual([1, 9]);
  });

  it("找不到 Frame 时是 null（来源被删掉了）", () => {
    expect(frameSource(doc([]), whiteboard([]), FRAME)).toBeNull();
  });
});

describe("frameSummaryText", () => {
  it("每个成员一行，带文字的成员把文字也列出来", () => {
    const source = frameSource(
      doc([frame(), node({ position: { x: 20, y: 20 }, title: "claude" })]),
      whiteboard([
        item({ x: 10, y: 10, text: "需求确认" }),
        item({ x: 30, y: 30, kind: "ink", points: [[0, 0, 0.5]] }),
      ]),
      FRAME,
    )!;
    expect(frameSummaryText(source, name, labels)).toBe(
      ["header", "- text=需求确认", "- ink", "- terminal=claude"].join("\n"),
    );
  });

  it("一项都没有时给一句「空的」", () => {
    const source = frameSource(doc([frame()]), whiteboard([]), FRAME)!;
    expect(frameSummaryText(source, name, labels)).toBe("empty");
  });

  it("超过上限时折成一行「还有 N 项」", () => {
    const many = Array.from({ length: FRAME_SUMMARY_LIMIT + 3 }, () =>
      item({ x: 10, y: 10 }),
    );
    const source = frameSource(doc([frame()]), whiteboard(many), FRAME)!;
    const lines = frameSummaryText(source, name, labels).split("\n");
    expect(lines).toHaveLength(FRAME_SUMMARY_LIMIT + 2);
    expect(lines.at(-1)).toBe("- +3");
  });
});

describe("frameSignature", () => {
  it("整个 Frame 搬家不改签名（成员的相对位置没变）", () => {
    const inside = item({ x: 10, y: 10 });
    const before = frameSource(doc([frame()]), whiteboard([inside]), FRAME)!;
    const moved = { ...frame(), position: { x: 0, y: 0 } };
    const after = frameSource(doc([moved]), whiteboard([inside]), FRAME)!;
    expect(frameSignature(after)).toBe(frameSignature(before));
  });

  it("挪一个成员、改标题、成员进出都会改签名", () => {
    const inside = item({ x: 10, y: 10 });
    const base = frameSource(doc([frame()]), whiteboard([inside]), FRAME)!;
    const shifted = frameSource(
      doc([frame()]),
      whiteboard([{ ...inside, x: 200 }]),
      FRAME,
    )!;
    expect(frameSignature(shifted)).not.toBe(frameSignature(base));

    const renamed = frameSource(
      doc([{ ...frame(), title: "别的名字" }]),
      whiteboard([inside]),
      FRAME,
    )!;
    expect(frameSignature(renamed)).not.toBe(frameSignature(base));

    const joined = frameSource(
      doc([frame(), node({ position: { x: 20, y: 20 } })]),
      whiteboard([inside]),
      FRAME,
    )!;
    expect(frameSignature(joined)).not.toBe(frameSignature(base));
  });
});
