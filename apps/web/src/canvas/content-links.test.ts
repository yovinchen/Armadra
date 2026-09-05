import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, TLShapeId } from "tldraw";

/** tldraw 在模块加载时就读 `matchMedia`（见 `ArmadraShapeUtil.test.ts`）。 */
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

const nodeMetaStub = {
  labelKey: "node.sticky",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { setEditor } from "./editor-context";
import {
  clampText,
  collectContentLinks,
  contentArrowEnds,
  contentIdOf,
  contentTitle,
  ensureContentId,
  isContentShape,
  isNodeShapeRecord,
  resolveContent,
  shapeSignature,
  shapeText,
  useContentLinks,
} from "./content-links";
import { toShapeId } from "./shapes/armadra-shape";
import {
  createContentReference,
  referenceCountForNode,
} from "./create-content-reference";

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const NODE2 = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const GROUP = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";

type Rec = Record<string, unknown>;

/** i18n 在单测里就是恒等函数：断言的是键，不是文案。 */
const label = (key: string): string => key;

function rich(text: string): Rec {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/**
 * `content-links.ts` 只用到 editor 的十来个方法（与 `LinkArrow.test.ts` 同一套
 * 手法）：真 `<Tldraw>` 挂不进 jsdom。
 */
class FakeEditor {
  shapes = new Map<string, Rec>();
  bindings: Rec[] = [];
  assets = new Map<string, Rec>();
  exported: { ids: string[]; opts: Rec }[] = [];

  listeners = new Set<() => void>();

  store = {
    listen: (fn: () => void): (() => void) => {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };

  emitChange(): void {
    for (const fn of this.listeners) fn();
  }

  getTextOptions(): Rec {
    return {};
  }

  getShape(id: string): Rec | undefined {
    return this.shapes.get(id);
  }

  getCurrentPageShapes(): Rec[] {
    return [...this.shapes.values()];
  }

  getBindingsFromShape(id: string): Rec[] {
    return this.bindings.filter((binding) => binding.fromId === id);
  }

  getShapeAndDescendantIds(ids: string[]): Set<string> {
    const out = new Set<string>(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const shape of this.shapes.values()) {
        const id = shape.id as string;
        if (out.has(id)) continue;
        if (out.has(shape.parentId as string)) {
          out.add(id);
          grew = true;
        }
      }
    }
    return out;
  }

  getAsset(id: string): Rec | undefined {
    return this.assets.get(id);
  }

  async toImageDataUrl(
    ids: string[],
    opts: Rec,
  ): Promise<{ url: string; width: number; height: number }> {
    this.exported.push({ ids, opts });
    return { url: "data:image/png;base64,AAA", width: 10, height: 10 };
  }

  run(fn: () => void): void {
    fn();
  }

  updateShape(patch: Rec): void {
    const shape = this.shapes.get(patch.id as string);
    if (!shape) return;
    this.shapes.set(patch.id as string, { ...shape, ...patch });
  }

  /* --------------------------- 测试用的动作 --------------------------- */

  addNode(id: string): void {
    this.shapes.set(toShapeId(id), {
      id: toShapeId(id),
      type: "armadra",
      typeName: "shape",
      parentId: "page:page",
      meta: {},
      props: { nodeType: "terminal", title: "Claude" },
    });
  }

  addGroup(id: string): void {
    this.shapes.set(toShapeId(id), {
      id: toShapeId(id),
      type: "frame",
      typeName: "shape",
      parentId: "page:page",
      meta: { armadra: {} },
      props: { name: "分组", w: 400, h: 300 },
    });
  }

  addShape(
    id: string,
    type: string,
    props: Rec = {},
    parentId = "page:page",
  ): void {
    this.shapes.set(id, {
      id,
      type,
      typeName: "shape",
      parentId,
      x: 0,
      y: 0,
      rotation: 0,
      meta: {},
      props,
    });
  }

  addArrow(id: string): void {
    this.addShape(id, "arrow", {
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
    });
  }

  bind(arrowId: string, terminal: "start" | "end", toId: string): void {
    this.bindings.push({
      id: `binding:${arrowId}-${terminal}`,
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId,
      props: { terminal },
    });
  }

  get(id: string): Rec {
    return this.shapes.get(id) as Rec;
  }
}

let editor: FakeEditor;

beforeEach(() => {
  editor = new FakeEditor();
  editor.addNode(NODE);
  editor.addNode(NODE2);
});

/* ------------------------------- 判定 ------------------------------------- */

describe("内容链接的判定", () => {
  it("节点 shape：`armadra` 与 uuid id 的 `frame`", () => {
    editor.addGroup(GROUP);
    editor.addShape("shape:plainframe", "frame", { name: "白板画框" });
    expect(isNodeShapeRecord(editor.get(toShapeId(NODE)) as never)).toBe(true);
    expect(isNodeShapeRecord(editor.get(toShapeId(GROUP)) as never)).toBe(true);
    // 用户用画框工具建的 frame 不是分组：id 不是 uuid。
    expect(isNodeShapeRecord(editor.get("shape:plainframe") as never)).toBe(
      false,
    );
    expect(isContentShape(editor.get("shape:plainframe") as never)).toBe(true);
    expect(isContentShape(editor.get(toShapeId(GROUP)) as never)).toBe(false);
  });

  it.each([
    ["text", true],
    ["geo", true],
    ["draw", true],
    ["image", true],
    ["line", true],
    ["highlight", true],
    ["frame", true],
    ["bookmark", false],
    ["video", false],
    ["arrow", false],
  ])("%s 能不能当内容读 → %s", (type, expected) => {
    editor.addShape(`shape:${type}1`, type);
    expect(isContentShape(editor.get(`shape:${type}1`) as never)).toBe(
      expected,
    );
  });

  it("一端节点、一端白板 shape ⇒ 内容链接", () => {
    editor.addShape("shape:txt", "text", { richText: rich("hello") });
    editor.addArrow("shape:a1");
    editor.bind("shape:a1", "start", "shape:txt");
    editor.bind("shape:a1", "end", toShapeId(NODE));

    const ends = contentArrowEnds(
      "shape:a1",
      editor.getBindingsFromShape("shape:a1") as never,
      (id) => editor.getShape(id) as never,
    );
    expect(ends).toEqual({
      nodeId: NODE,
      shapeId: "shape:txt",
      nodeEnd: "end",
    });
  });

  it("两端都是节点 / 两端都是白板 / 只绑一端 ⇒ 不是内容链接", () => {
    editor.addShape("shape:txt", "text", { richText: rich("hello") });
    editor.addShape("shape:txt2", "text", { richText: rich("world") });

    editor.addArrow("shape:edge");
    editor.bind("shape:edge", "start", toShapeId(NODE));
    editor.bind("shape:edge", "end", toShapeId(NODE2));

    editor.addArrow("shape:board");
    editor.bind("shape:board", "start", "shape:txt");
    editor.bind("shape:board", "end", "shape:txt2");

    editor.addArrow("shape:half");
    editor.bind("shape:half", "start", toShapeId(NODE));

    const ends = (id: string) =>
      contentArrowEnds(
        id,
        editor.getBindingsFromShape(id) as never,
        (shapeId) => editor.getShape(shapeId) as never,
      );
    expect(ends("shape:edge")).toBeNull();
    expect(ends("shape:board")).toBeNull();
    expect(ends("shape:half")).toBeNull();
  });

  it("绑到不可读类型（bookmark）的箭头不算内容链接", () => {
    editor.addShape("shape:bm", "bookmark", { url: "https://example.com" });
    editor.addArrow("shape:a2");
    editor.bind("shape:a2", "start", toShapeId(NODE));
    editor.bind("shape:a2", "end", "shape:bm");
    expect(
      contentArrowEnds(
        "shape:a2",
        editor.getBindingsFromShape("shape:a2") as never,
        (id) => editor.getShape(id) as never,
      ),
    ).toBeNull();
  });
});

/* ------------------------------ 稳定 uuid --------------------------------- */

describe("稳定 uuid（`meta.armadra.contentId`）", () => {
  it("第一次生成、之后不再变，写在箭头的 meta 里", () => {
    editor.addArrow("shape:a1");
    expect(contentIdOf(editor.get("shape:a1") as never)).toBeNull();

    const first = ensureContentId(
      editor as unknown as Editor,
      editor.get("shape:a1") as never,
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(contentIdOf(editor.get("shape:a1") as never)).toBe(first);

    const second = ensureContentId(
      editor as unknown as Editor,
      editor.get("shape:a1") as never,
    );
    expect(second).toBe(first);
  });

  it("`collectContentLinks` 给还没有 id 的箭头补一个", () => {
    editor.addShape("shape:txt", "text", { richText: rich("hi") });
    editor.addArrow("shape:a1");
    editor.bind("shape:a1", "start", toShapeId(NODE));
    editor.bind("shape:a1", "end", "shape:txt");
    // 无关的白板箭头不该混进来。
    editor.addArrow("shape:free");

    const found = collectContentLinks(editor as unknown as Editor);
    expect(found).toHaveLength(1);
    expect(found[0]!.nodeId).toBe(NODE);
    expect(found[0]!.shapeId).toBe("shape:txt");
    expect(found[0]!.contentId).toBe(
      contentIdOf(editor.get("shape:a1") as never),
    );
  });
});

/* -------------------------------- 标题 ------------------------------------ */

describe("contentTitle", () => {
  it("文字取正文前 40 字，超了带省略号", () => {
    editor.addShape("shape:txt", "text", {});
    const short = contentTitle(
      editor.get("shape:txt") as never,
      "两行\n结论",
      label,
    );
    expect(short).toBe("两行 结论");
    const long = contentTitle(
      editor.get("shape:txt") as never,
      "字".repeat(60),
      label,
    );
    expect(long).toBe(`${"字".repeat(40)}…`);
  });

  it("画框取框名，没名字时退回类型名", () => {
    editor.addShape("shape:f1", "frame", { name: "架构图" });
    editor.addShape("shape:f2", "frame", { name: "  " });
    expect(contentTitle(editor.get("shape:f1") as never, "", label)).toBe(
      "架构图",
    );
    expect(contentTitle(editor.get("shape:f2") as never, "", label)).toBe(
      "content.frame",
    );
  });

  it("其余类型取 i18n 的类型名", () => {
    editor.addShape("shape:d1", "draw", {});
    editor.addShape("shape:i1", "image", {});
    expect(contentTitle(editor.get("shape:d1") as never, "", label)).toBe(
      "content.draw",
    );
    expect(contentTitle(editor.get("shape:i1") as never, "", label)).toBe(
      "content.image",
    );
  });
});

describe("clampText", () => {
  it("按字节截断（一个汉字 3 字节）", () => {
    expect(clampText("字".repeat(10), 3000)).toHaveLength(10);
    const clamped = clampText("字".repeat(10), 12);
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(12);
    expect(clamped.length).toBeGreaterThan(0);
  });
});

/* ------------------------------ 文字与签名 -------------------------------- */

describe("shapeText / shapeSignature", () => {
  it("画框把框内所有文字拼起来", () => {
    editor.addShape("shape:f1", "frame", { name: "架构图" });
    editor.addShape("shape:t1", "text", { richText: rich("上") }, "shape:f1");
    editor.addShape("shape:g1", "geo", { richText: rich("下") }, "shape:f1");
    expect(
      shapeText(editor as unknown as Editor, editor.get("shape:f1") as never),
    ).toBe("上\n\n下");
  });

  it("挪一下位置签名不变，改内容才变", () => {
    editor.addShape("shape:d1", "draw", { color: "red" });
    const before = shapeSignature(
      editor as unknown as Editor,
      "shape:d1" as TLShapeId,
    );
    editor.updateShape({ id: "shape:d1", x: 500, y: 900 });
    expect(
      shapeSignature(editor as unknown as Editor, "shape:d1" as TLShapeId),
    ).toBe(before);
    editor.updateShape({ id: "shape:d1", props: { color: "blue" } });
    expect(
      shapeSignature(editor as unknown as Editor, "shape:d1" as TLShapeId),
    ).not.toBe(before);
  });

  it("画框的签名跟着框内的东西走", () => {
    editor.addShape("shape:f1", "frame", { name: "架构图" });
    editor.addShape("shape:t1", "text", { richText: rich("上") }, "shape:f1");
    const before = shapeSignature(
      editor as unknown as Editor,
      "shape:f1" as TLShapeId,
    );
    editor.updateShape({ id: "shape:t1", props: { richText: rich("改了") } });
    expect(
      shapeSignature(editor as unknown as Editor, "shape:f1" as TLShapeId),
    ).not.toBe(before);
  });
});

/* ------------------------------ 内容解析 ---------------------------------- */

describe("resolveContent", () => {
  const contentId = "019ff7d1-0d12-7421-833d-2c5e8d64edaa";
  const deps = () => {
    const exportPng = vi.fn(async (id: string) => `.armadra/exports/${id}.png`);
    return { exportPng, label };
  };

  it("文字：只有 `text`，不导出 PNG", async () => {
    editor.addShape("shape:txt", "text", { richText: rich("结论：可以合并") });
    const d = deps();
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:txt" as TLShapeId,
      contentId,
      d,
    );
    expect(resolved?.content).toEqual({ text: "结论：可以合并" });
    expect(resolved?.title).toBe("结论：可以合并");
    expect(d.exportPng).not.toHaveBeenCalled();
    expect(editor.exported).toHaveLength(0);
  });

  it("图片：`pngPath` 取资产的 `meta.armadra.path`，不导出", async () => {
    editor.assets.set("asset:1", {
      id: "asset:1",
      meta: { armadra: { path: ".armadra/assets/0a1b2c3d4e5f6071.png" } },
      props: { src: "http://127.0.0.1:43120/x" },
    });
    editor.addShape("shape:img", "image", { assetId: "asset:1", w: 10, h: 10 });
    const d = deps();
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:img" as TLShapeId,
      contentId,
      d,
    );
    expect(resolved?.content).toEqual({
      pngPath: ".armadra/assets/0a1b2c3d4e5f6071.png",
    });
    expect(d.exportPng).not.toHaveBeenCalled();
  });

  it("手绘：栅格化后上传，`pngPath` 用返回的 `relativePath`", async () => {
    editor.addShape("shape:d1", "draw", { color: "red" });
    const d = deps();
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:d1" as TLShapeId,
      contentId,
      d,
    );
    expect(resolved?.content).toEqual({
      pngPath: `.armadra/exports/${contentId}.png`,
    });
    expect(d.exportPng).toHaveBeenCalledWith(
      contentId,
      "data:image/png;base64,AAA",
    );
    expect(editor.exported[0]).toEqual({
      ids: ["shape:d1"],
      opts: { background: true, padding: 16, scale: 2, format: "png" },
    });
  });

  it("画框：PNG + 框内文字都有", async () => {
    editor.addShape("shape:f1", "frame", { name: "架构图" });
    editor.addShape(
      "shape:t1",
      "text",
      { richText: rich("入口在 main.rs") },
      "shape:f1",
    );
    const d = deps();
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:f1" as TLShapeId,
      contentId,
      d,
    );
    expect(resolved?.title).toBe("架构图");
    expect(resolved?.content).toEqual({
      text: "入口在 main.rs",
      pngPath: `.armadra/exports/${contentId}.png`,
    });
  });

  it("带文字的 geo：`text` + PNG", async () => {
    editor.addShape("shape:g1", "geo", {
      richText: rich("缓存层"),
      geo: "rectangle",
    });
    const d = deps();
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:g1" as TLShapeId,
      contentId,
      d,
    );
    expect(resolved?.content.text).toBe("缓存层");
    expect(resolved?.content.pngPath).toBe(`.armadra/exports/${contentId}.png`);
  });

  it("不可读的类型返回 null", async () => {
    editor.addShape("shape:bm", "bookmark", {});
    expect(
      await resolveContent(
        editor as unknown as Editor,
        "shape:bm" as TLShapeId,
        contentId,
        deps(),
      ),
    ).toBeNull();
  });
});

/* -------------------------------- 防抖 ------------------------------------ */

describe("useContentLinks 的导出防抖", () => {
  it("持续文档变化也会在两秒内导出，签名没变不重复导出", async () => {
    vi.useFakeTimers();
    const exportPng = vi.spyOn(runtimeApi, "exportPng").mockResolvedValue({
      path: "/abs/.armadra/exports/x.png",
      relativePath: ".armadra/exports/x.png",
      bytes: 3,
    } as never);
    useCanvasStore.setState({ workspace: { id: "ws-1" } as never });

    editor.addShape("shape:d1", "draw", { color: "red" });
    editor.addArrow("shape:a1");
    editor.bind("shape:a1", "start", toShapeId(NODE));
    editor.bind("shape:a1", "end", "shape:d1");
    setEditor(editor as unknown as Editor);

    const { result, unmount } = renderHook(() => useContentLinks());

    // 还没到 2 秒：一次都没导出。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(exportPng).not.toHaveBeenCalled();

    // 中途改动不延后首个截止时间，避免繁忙画板永远不导出。
    act(() => editor.emitChange());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(exportPng).toHaveBeenCalledTimes(1);
    expect(result.current[NODE]).toEqual([
      {
        id: contentIdOf(editor.get("shape:a1") as never),
        // 标题走 i18n，语言由用户偏好决定，这里只关心它不是空的。
        title: expect.stringMatching(/.+/u) as unknown as string,
        kind: "shape",
        content: {
          pngPath: ".armadra/exports/x.png",
          sourceShapeId: "shape:d1",
          shapeType: "draw",
          status: "ready",
        },
      },
    ]);

    // 只是挪了个位置：签名没变，不重新导出。
    act(() => {
      editor.updateShape({ id: "shape:d1", x: 400 });
      editor.emitChange();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(exportPng).toHaveBeenCalledTimes(1);

    // 改了内容才重新导出。
    act(() => {
      editor.updateShape({ id: "shape:d1", props: { color: "blue" } });
      editor.emitChange();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(exportPng).toHaveBeenCalledTimes(2);

    unmount();
    setEditor(null);
    exportPng.mockRestore();
    vi.useRealTimers();
  });
});

function referenceDeps() {
  return {
    exportPng: vi.fn(async (id: string) => `.armadra/exports/${id}.png`),
    label,
  };
}

describe("native reference payload recovery", () => {
  it("preserves native note text and rasterizes its visual appearance", async () => {
    editor.addShape("shape:note", "note", {
      richText: rich("Do not delete this note"),
    });
    expect(isContentShape(editor.get("shape:note") as never)).toBe(true);
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:note" as TLShapeId,
      "note-export",
      referenceDeps(),
    );
    expect(resolved?.content.text).toBe("Do not delete this note");
    expect(resolved?.content.pngPath).toBeTruthy();
  });

  it("exports legacy data URL images instead of caching an empty payload", async () => {
    editor.assets.set("asset:legacy", {
      meta: {},
      props: { src: "data:image/png;base64,AAA" },
    });
    editor.addShape("shape:legacy", "image", { assetId: "asset:legacy" });
    const d = referenceDeps();
    const resolved = await resolveContent(
      editor as unknown as Editor,
      "shape:legacy" as TLShapeId,
      "legacy-export",
      d,
    );
    expect(resolved?.content.pngPath).toBeTruthy();
    expect(d.exportPng).toHaveBeenCalledOnce();
  });

  it("notices changes in asset data even when the shape record is unchanged", () => {
    editor.assets.set("asset:image", { props: { src: "one" } });
    editor.addShape("shape:image", "image", { assetId: "asset:image" });
    const first = shapeSignature(
      editor as unknown as Editor,
      "shape:image" as TLShapeId,
    );
    editor.assets.set("asset:image", { props: { src: "two" } });
    expect(
      shapeSignature(editor as unknown as Editor, "shape:image" as TLShapeId),
    ).not.toBe(first);
  });

  it("retains text and reports an export failure, then retries without another edit", async () => {
    vi.useFakeTimers();
    const upload = vi
      .spyOn(runtimeApi, "exportPng")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        relativePath: ".armadra/exports/recovered.png",
      } as never);
    useCanvasStore.setState({ workspace: { id: "ws-retry" } as never });
    editor.addShape("shape:geo", "geo", {
      richText: rich("Readable while PNG is pending"),
    });
    editor.addArrow("shape:ref");
    editor.bind("shape:ref", "start", toShapeId(NODE));
    editor.bind("shape:ref", "end", "shape:geo");
    setEditor(editor as unknown as Editor);
    const { result, unmount } = renderHook(() => useContentLinks());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current[NODE]?.[0]?.content).toMatchObject({
      status: "pending",
      text: "Readable while PNG is pending",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current[NODE]?.[0]?.content?.status).toBe("error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(result.current[NODE]?.[0]?.content).toMatchObject({
      status: "ready",
      pngPath: ".armadra/exports/recovered.png",
    });
    expect(upload).toHaveBeenCalledTimes(2);
    unmount();
    setEditor(null);
    upload.mockRestore();
    vi.useRealTimers();
  });
});

it("the reference menu action creates persisted bindings readable by the content protocol", async () => {
  editor.addShape("shape:native-note", "note", {
    richText: rich("A real reference"),
  });
  editor.updateShape({
    id: toShapeId(NODE),
    props: {
      nodeType: "terminal",
      title: "Agent",
      data: { agent: { id: "pi" } },
    },
  });
  Object.assign(editor, {
    getShapePageBounds: () => ({
      minX: 0,
      maxX: 200,
      center: { x: 100, y: 100 },
    }),
    getCurrentPageId: () => "page:page",
    markHistoryStoppingPoint: vi.fn(),
    select: vi.fn(),
    createShape: (shape: Rec) =>
      editor.shapes.set(shape.id as string, { ...shape, typeName: "shape" }),
    createBinding: (binding: Rec) =>
      editor.bindings.push({ ...binding, typeName: "binding" }),
  });
  const id = createContentReference(
    editor as unknown as Editor,
    "shape:native-note" as TLShapeId,
    toShapeId(NODE),
  );
  expect(id).toBeTruthy();
  expect(
    createContentReference(
      editor as unknown as Editor,
      "shape:native-note" as TLShapeId,
      toShapeId(NODE),
    ),
  ).toBe(id);
  expect(editor.bindings).toHaveLength(2);
  const descriptor = collectContentLinks(editor as unknown as Editor)[0]!;
  expect(descriptor.nodeId).toBe(NODE);
  const content = await resolveContent(
    editor as unknown as Editor,
    descriptor.shapeId,
    descriptor.contentId,
    referenceDeps(),
  );
  expect(content?.content.text).toBe("A real reference");
  expect(content?.content.pngPath).toBeTruthy();
});

it("reference limit counts unique node peers and prevents a visible but unreadable 65th link", () => {
  editor.addShape("shape:capacity-source", "note", {
    richText: rich("capacity"),
  });
  editor.updateShape({
    id: toShapeId(NODE),
    props: { nodeType: "terminal", data: { agent: { id: "pi" } } },
  });
  for (let i = 0; i < 64; i++)
    editor.addShape(`shape:peer-link-${i}`, "link", {
      from: toShapeId(NODE),
      to: `shape:peer-${i}`,
    });
  // A duplicate edge doesn't consume another readable-object slot.
  editor.addShape("shape:duplicate-peer", "link", {
    from: toShapeId(NODE),
    to: "shape:peer-0",
  });
  expect(
    referenceCountForNode(editor as unknown as Editor, toShapeId(NODE)),
  ).toBe(64);
  expect(
    createContentReference(
      editor as unknown as Editor,
      "shape:capacity-source" as TLShapeId,
      toShapeId(NODE),
    ),
  ).toBeNull();
  expect(editor.bindings).toHaveLength(0);
});

it("unrelated document edits do not discard a successful pending export", async () => {
  vi.useFakeTimers();
  let complete!: (result: never) => void;
  const upload = vi.spyOn(runtimeApi, "exportPng").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  useCanvasStore.setState({ workspace: { id: "ws-unrelated" } as never });
  editor.addShape("shape:stable", "draw", {});
  editor.addArrow("shape:stable-ref");
  editor.bind("shape:stable-ref", "start", toShapeId(NODE));
  editor.bind("shape:stable-ref", "end", "shape:stable");
  setEditor(editor as unknown as Editor);
  const { result, unmount } = renderHook(() => useContentLinks());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2050);
  });
  act(() => editor.emitChange());
  await act(async () => {
    complete({ relativePath: ".armadra/exports/stable.png" } as never);
  });
  expect(result.current[NODE]?.[0]?.content?.status).toBe("ready");
  expect(upload).toHaveBeenCalledOnce();
  unmount();
  setEditor(null);
  upload.mockRestore();
  vi.useRealTimers();
});
