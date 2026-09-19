import { describe, expect, it } from "vitest";

import { makeItem, makeNode, resetTestUuids } from "../test-support";
import {
  buildClipboard,
  CLIPBOARD_SIGNATURE,
  clipboardBounds,
  isCanvasClipboard,
  parseClipboard,
  relocateClipboard,
  routePaste,
  serializeClipboard,
  UNCOPYABLE_NODE_TYPES,
} from "./clipboard";

/**
 * 画布剪贴板（React Flow 计划 T08）。
 *
 * 三条：签名要认得准（认错就把别人复制的一段 JSON 当成画布内容粘进来）、
 * 粘贴要落在指定的点上、外部内容的分流顺序不能乱。
 */

let seed = 0;
const newId = () => `pasted-${++seed}`;

function reset(): void {
  seed = 0;
  resetTestUuids();
}

describe("签名识别", () => {
  it("自己写出去的一定认得回来", () => {
    reset();
    const payload = buildClipboard([makeItem("shape")], []);
    const text = serializeClipboard(payload);
    expect(text.includes(CLIPBOARD_SIGNATURE)).toBe(true);
    expect(parseClipboard(text)).toEqual(payload);
    expect(isCanvasClipboard(text)).toBe(true);
  });

  it("不是我们的东西一律 null：普通文本、别人的 JSON、坏 JSON、空", () => {
    for (const text of [
      "",
      null,
      undefined,
      "hello world",
      "https://example.com",
      "{oops",
      JSON.stringify({ armadra: "canvas@2", items: [], nodes: [] }),
      JSON.stringify({ items: [], nodes: [] }),
    ]) {
      expect(
        parseClipboard(text),
        `${String(text)} 不该被认成画布内容`,
      ).toBeNull();
    }
  });

  it("对象字段不合法时整段拒绝，不做部分恢复", () => {
    const text = JSON.stringify({
      armadra: CLIPBOARD_SIGNATURE,
      items: [{ id: "x", kind: "text" }],
      nodes: [],
      references: [],
    });
    expect(parseClipboard(text)).toBeNull();
  });
});

describe("复制的取舍", () => {
  it("终端不进剪贴板：会话是活的，复制一份只会两个节点抢一个进程", () => {
    reset();
    const payload = buildClipboard(
      [],
      [makeNode("terminal"), makeNode("sticky")],
    );
    expect(UNCOPYABLE_NODE_TYPES.has("terminal")).toBe(true);
    expect(payload.nodes.map((node) => node.type)).toEqual(["sticky"]);
  });

  it("只留两端都在这次复制里的引用", () => {
    reset();
    const item = makeItem("text");
    const node = makeNode("sticky");
    const payload = buildClipboard(
      [item],
      [node],
      [
        { id: "r1", itemId: item.id, nodeId: node.id },
        { id: "r2", itemId: item.id, nodeId: "someone-else" },
        { id: "r3", itemId: "another-item", nodeId: node.id },
      ],
    );
    expect(payload.references.map((reference) => reference.id)).toEqual(["r1"]);
  });
});

describe("粘贴落点", () => {
  it("内容的中心落在指定的点上", () => {
    reset();
    const payload = buildClipboard(
      [makeItem("shape", { x: 0, y: 0, w: 100, h: 100 })],
      [],
    );
    const moved = relocateClipboard(payload, { at: { x: 500, y: 300 }, newId });
    expect(moved.items[0]).toMatchObject({ x: 450, y: 250 });
  });

  it("多条对象的相对位置不变", () => {
    reset();
    const payload = buildClipboard(
      [
        makeItem("shape", { x: 0, y: 0, w: 100, h: 100 }),
        makeItem("shape", { x: 200, y: 0, w: 100, h: 100 }),
      ],
      [],
    );
    const moved = relocateClipboard(payload, { at: { x: 0, y: 0 }, newId });
    expect(moved.items[1]!.x - moved.items[0]!.x).toBe(200);
  });

  it("每一条都换新 id，引用也跟着换（PNG 文件名靠它稳定）", () => {
    reset();
    const item = makeItem("text");
    const node = makeNode("sticky");
    const payload = buildClipboard(
      [item],
      [node],
      [{ id: "r1", itemId: item.id, nodeId: node.id }],
    );
    const moved = relocateClipboard(payload, { at: { x: 0, y: 0 }, newId });
    expect(moved.items[0]!.id).not.toBe(item.id);
    expect(moved.references[0]!.id).not.toBe("r1");
    expect(moved.references[0]!.itemId).toBe(moved.items[0]!.id);
  });

  it("粘出来的对象一律落在页面级：组员的相对坐标不能带着走", () => {
    reset();
    const payload = buildClipboard(
      [makeItem("shape", { parentId: "some-frame" })],
      [],
    );
    const moved = relocateClipboard(payload, { at: { x: 10, y: 10 }, newId });
    expect(moved.items[0]!.parentId).toBeNull();
  });

  it("节点跟着一起搬，尺寸参与包围盒", () => {
    reset();
    const payload = buildClipboard(
      [],
      [
        makeNode("sticky", {
          position: { x: 0, y: 0 },
          size: { width: 200, height: 100 },
        }),
      ],
    );
    expect(clipboardBounds(payload)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    const moved = relocateClipboard(payload, { at: { x: 100, y: 50 }, newId });
    expect(moved.nodes[0]!.position).toEqual({ x: 0, y: 0 });
  });

  it("空剪贴板没有包围盒", () => {
    expect(clipboardBounds(buildClipboard([], []))).toBeNull();
  });
});

describe("外部内容分流", () => {
  it("签名最优先，其次图片，最后文本", () => {
    reset();
    const canvasText = serializeClipboard(
      buildClipboard([makeItem("shape")], []),
    );
    expect(routePaste({ text: canvasText, hasImage: true })).toBe("canvas");
    expect(routePaste({ text: "", hasImage: true })).toBe("image");
    expect(routePaste({ text: "hello", hasImage: true })).toBe("image");
    expect(routePaste({ text: "hello" })).toBe("text");
    expect(routePaste({ text: "   " })).toBe("none");
    expect(routePaste({})).toBe("none");
  });

  it("看起来像 Mermaid 的文本单独一支（落地前会弹确认框）", () => {
    expect(routePaste({ text: "flowchart LR\n A --> B" })).toBe("mermaid");
    expect(routePaste({ text: "sequenceDiagram\n A->>B: hi" })).toBe("mermaid");
    // 普通文本不受影响。
    expect(routePaste({ text: "graphql is not mermaid" })).toBe("text");
  });

  it("签名与图片都排在 Mermaid 前面", () => {
    reset();
    const canvasText = serializeClipboard(
      buildClipboard([makeItem("shape")], []),
    );
    // 我们自己复制的内容永远优先，哪怕它碰巧以图种关键字开头。
    expect(routePaste({ text: canvasText })).toBe("canvas");
    // 截图粘贴时 `text/plain` 里可能混着别的东西，图片仍然优先。
    expect(routePaste({ text: "flowchart LR\n A-->B", hasImage: true })).toBe(
      "image",
    );
  });
});
