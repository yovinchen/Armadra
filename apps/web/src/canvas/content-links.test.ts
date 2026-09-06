import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument, Workspace } from "@armadra/shared";

/**
 * 内容引用（React Flow 计划 §2.5 / F29）。
 *
 * 旧引擎那版测的是「箭头 + 两个 binding 算不算一条引用」；引用现在是
 * `whiteboard.references` 里的一行，那半边判定整个消失了。留下来的是真正
 * 跨端的部分——`ContextLink.content` 的每个字段怎么填、什么时候导出 PNG、
 * 导出失败之后怎么办——加上新的一半：订阅 store 而不是编辑器。
 *
 * `store/defaults.ts` 会把整棵节点渲染树拉进来，所以按 `whiteboard/store.test`
 * 的做法给 `nodes/registry` 一份最小替身。栅格化换成假函数：真的开画布要
 * 一个能画图的 node 环境，而这里要断言的是**调没调、传了什么**。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.sticky",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#ffd60a",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const rasterize = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])]));
vi.mock("./whiteboard/raster", () => ({
  rasterizeItems: (...args: unknown[]) =>
    (rasterize as unknown as (...a: unknown[]) => Promise<Blob>)(...args),
}));
vi.mock("./whiteboard/scheme", () => ({ canvasScheme: () => "light" }));

const { runtimeApi } = await import("@/api/client");
const { useCanvasStore } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("./whiteboard/model");
const { itemSchema } = await import("./whiteboard/model");
const {
  blobToDataUrl,
  clampText,
  collectContentLinks,
  contentTitle,
  CONTENT_TYPE_KEYS,
  itemSignature,
  itemText,
  MAX_CONTENT_TEXT_BYTES,
  MAX_LINKS,
  refreshContentReferences,
  resolveContent,
  SHAPE_KIND,
  useContentLinks,
} = await import("./content-links");

type Item = import("zod").infer<typeof itemSchema>;

const stamp = "2026-09-06T00:00:00.000Z";
const label = (key: string) => key;

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};

let counter = 0;
const nextId = () => `item-${++counter}`;

function shape(overrides: Record<string, unknown> = {}): Item {
  return {
    id: nextId(),
    kind: "shape" as const,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 0,
    parentId: null,
    style: { color: "black" as const, size: "m" as const },
    geo: "rectangle" as const,
    ...overrides,
  } as never as Item;
}

function text(body: string) {
  return shape({ kind: "text", text: body, geo: undefined }) as Item;
}

function ink() {
  return shape({ kind: "ink", points: [[0, 0, 0.5]], geo: undefined }) as Item;
}

function image(assetPath: string) {
  return shape({ kind: "image", assetPath, geo: undefined }) as Item;
}

function board_(): BoardDocument {
  return { board, nodes: [], edges: [] };
}

function load(
  items: Item[] = [],
  references: { id: string; itemId: string; nodeId: string }[] = [],
) {
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(board_());
  useCanvasStore
    .getState()
    .setWhiteboard({ ...emptyWhiteboard(), items, references } as never, {
      history: "ignore",
    });
}

function setWhiteboard(
  items: Item[],
  references: { id: string; itemId: string; nodeId: string }[],
) {
  useCanvasStore
    .getState()
    .setWhiteboard({ ...emptyWhiteboard(), items, references } as never, {
      history: "ignore",
    });
}

beforeEach(() => {
  counter = 0;
  rasterize.mockClear();
  rasterize.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])]));
});

afterEach(() => {
  // `globals` 没开，RTL 的自动清理不生效：不手动卸载的话上一个测试的 hook
  // 还挂着，它那份 store 订阅会跟着这个测试再导出一次。
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* -------------------------------- 纯函数 ---------------------------------- */

describe("clampText", () => {
  it("按字节截断（一个汉字 3 字节）", () => {
    expect(clampText("汉字汉字", 6)).toBe("汉字");
  });

  it("不切出半个码点", () => {
    expect(clampText("汉字", 4)).toBe("汉");
  });

  it("没超限时原样返回", () => {
    expect(clampText("abc")).toBe("abc");
  });
});

describe("contentTitle", () => {
  it("文字取正文前 40 字，超了带省略号", () => {
    const long = "a".repeat(60);
    const title = contentTitle("text", long, label);
    expect(title).toBe(`${"a".repeat(40)}…`);
  });

  it("文字里的换行与连续空白压成一个空格", () => {
    expect(contentTitle("text", "  one\n\ntwo  ", label)).toBe("one two");
  });

  it("空正文的文字退回类型名", () => {
    expect(contentTitle("text", "   ", label)).toBe(CONTENT_TYPE_KEYS.text);
  });

  it("其余类型取 i18n 的类型名", () => {
    expect(contentTitle("ink", "", label)).toBe("content.draw");
    expect(contentTitle("shape", "", label)).toBe("content.geo");
    expect(contentTitle("image", "", label)).toBe("content.image");
    expect(contentTitle("line", "", label)).toBe("content.line");
  });

  it("认不出的类型退回通用名", () => {
    expect(contentTitle("mystery", "", label)).toBe("content.shape");
  });
});

describe("itemText", () => {
  it("文字取正文，几何形取标签，其余没有文字", () => {
    expect(itemText(text(" hello "))).toBe("hello");
    expect(itemText(shape({ label: " box " }))).toBe("box");
    expect(itemText(ink())).toBe("");
    expect(itemText(image(".armadra/assets/0123456789abcdef.png"))).toBe("");
  });
});

describe("itemSignature", () => {
  it("挪一下位置签名不变", () => {
    const item = ink();
    expect(itemSignature({ ...item, x: 900, y: -40 })).toBe(
      itemSignature(item),
    );
  });

  it("改尺寸、改样式、改内容签名都变", () => {
    const item = shape({ label: "one" });
    expect(itemSignature({ ...item, w: 300 })).not.toBe(itemSignature(item));
    expect(itemSignature({ ...item, label: "two" } as Item)).not.toBe(
      itemSignature(item),
    );
    expect(
      itemSignature({ ...item, style: { color: "red", size: "m" } } as never),
    ).not.toBe(itemSignature(item));
  });

  it("换一张图签名就变（`assetPath` 在里面）", () => {
    const one = image(".armadra/assets/0123456789abcdef.png");
    const two = { ...one, assetPath: ".armadra/assets/fedcba9876543210.png" };
    expect(itemSignature(two as never)).not.toBe(itemSignature(one));
  });

  it("对象不在了时是空串", () => {
    expect(itemSignature(null)).toBe("");
  });
});

describe("collectContentLinks", () => {
  it("按引用行收集，`contentId` 就是引用行的 id", () => {
    const one = ink();
    const found = collectContentLinks({
      ...emptyWhiteboard(),
      items: [one],
      references: [{ id: "r1", itemId: one.id, nodeId: "agent" }],
    } as never);
    expect(found).toEqual([{ contentId: "r1", nodeId: "agent", item: one }]);
  });

  it("指向已经删掉的对象的引用行被跳过", () => {
    const found = collectContentLinks({
      ...emptyWhiteboard(),
      items: [],
      references: [{ id: "r1", itemId: "gone", nodeId: "agent" }],
    } as never);
    expect(found).toEqual([]);
  });
});

describe("blobToDataUrl", () => {
  it("吐出 `exportPng` 只收的那种 base64 PNG data URL", async () => {
    const url = await blobToDataUrl(new Blob([new Uint8Array([1, 2, 3])]));
    expect(url).toBe("data:image/png;base64,AQID");
  });
});

/* ------------------------------ resolveContent ---------------------------- */

describe("resolveContent", () => {
  const exportPng = vi.fn(async () => ".armadra/exports/r1.png");

  beforeEach(() => exportPng.mockClear());

  it("文字：只有 `text`，不导出 PNG", async () => {
    const resolved = await resolveContent(text("hello"), "r1", {
      exportPng,
      label,
    });
    expect(resolved.content).toEqual({ text: "hello" });
    expect(exportPng).not.toHaveBeenCalled();
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("手绘：栅格化后上传，`pngPath` 用返回的 `relativePath`", async () => {
    const resolved = await resolveContent(ink(), "r1", { exportPng, label });
    expect(resolved.content).toEqual({ pngPath: ".armadra/exports/r1.png" });
    expect(exportPng).toHaveBeenCalledWith("r1", "data:image/png;base64,AQID");
  });

  it("带标签的几何形：`text` 与 PNG 都有", async () => {
    const resolved = await resolveContent(shape({ label: "box" }), "r1", {
      exportPng,
      label,
    });
    expect(resolved.content).toEqual({
      text: "box",
      pngPath: ".armadra/exports/r1.png",
    });
    expect(resolved.title).toBe("content.geo");
  });

  it("受管图片：`pngPath` 直接给资产路径，不重复导出", async () => {
    const path = ".armadra/assets/0123456789abcdef.png";
    const resolved = await resolveContent(image(path), "r1", {
      exportPng,
      label,
    });
    expect(resolved.content).toEqual({ pngPath: path });
    expect(exportPng).not.toHaveBeenCalled();
  });

  it("不是受管资产的图片仍然栅格化", async () => {
    const resolved = await resolveContent(image("elsewhere/cat.png"), "r1", {
      exportPng,
      label,
    });
    expect(resolved.content.pngPath).toBe(".armadra/exports/r1.png");
    expect(rasterize).toHaveBeenCalledOnce();
  });

  it("栅格化带上底色与色系，图片解析函数一起传下去", async () => {
    const resolveImage = () => "http://runtime/asset";
    await resolveContent(ink(), "r1", {
      exportPng,
      label,
      scheme: "dark",
      resolveImage,
    });
    expect((rasterize.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
      scale: 2,
      padding: 16,
      background: "#1a1a1a",
      scheme: "dark",
      resolveImage,
    });
  });

  it("超长文字截断并保留 Unicode", async () => {
    const long = "汉".repeat(MAX_CONTENT_TEXT_BYTES);
    const resolved = await resolveContent(text(long), "r1", {
      exportPng,
      label,
    });
    const bytes = new TextEncoder().encode(resolved.content.text ?? "");
    expect(bytes.length).toBeLessThanOrEqual(MAX_CONTENT_TEXT_BYTES);
    expect(resolved.content.text).not.toContain("�");
  });
});

/* ----------------------------- useContentLinks ---------------------------- */

describe("useContentLinks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    load();
  });

  async function settle(ms = 2100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("没有引用时是空表", async () => {
    const { result } = renderHook(() => useContentLinks());
    await settle();
    expect(result.current).toEqual({});
  });

  it("文字引用立刻就是 ready，不排导出", async () => {
    const one = text("hello");
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    await settle();
    expect(result.current.agent).toEqual([
      {
        id: "r1",
        title: "hello",
        kind: SHAPE_KIND,
        content: {
          sourceShapeId: `wb:${one.id}`,
          shapeType: "text",
          text: "hello",
          textTruncated: false,
          status: "ready",
        },
      },
    ]);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("需要导出的引用先 pending 再 ready", async () => {
    const put = vi.spyOn(runtimeApi, "exportPng").mockResolvedValue({
      path: "/w/a.png",
      relativePath: ".armadra/exports/r1.png",
    } as never);
    const one = ink();
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.agent?.[0]?.content?.status).toBe("pending");
    await settle();
    expect(result.current.agent?.[0]?.content).toMatchObject({
      status: "ready",
      pngPath: ".armadra/exports/r1.png",
      sourceShapeId: `wb:${one.id}`,
      shapeType: "ink",
    });
    expect(put).toHaveBeenCalledOnce();
  });

  it("挪一下位置不重新导出，改内容才重导", async () => {
    vi.spyOn(runtimeApi, "exportPng").mockResolvedValue({
      path: "/w/a.png",
      relativePath: ".armadra/exports/r1.png",
    } as never);
    const one = shape({ label: "one" });
    const reference = [{ id: "r1", itemId: one.id, nodeId: "agent" }];
    renderHook(() => useContentLinks());
    act(() => setWhiteboard([one], reference));
    await settle();
    expect(rasterize).toHaveBeenCalledOnce();

    act(() => setWhiteboard([{ ...one, x: 400 } as Item], reference));
    await settle();
    expect(rasterize).toHaveBeenCalledOnce();

    act(() => setWhiteboard([{ ...one, label: "two" } as Item], reference));
    await settle();
    expect(rasterize).toHaveBeenCalledTimes(2);
  });

  it("删掉对象后那条引用不再出现在文档里", async () => {
    vi.spyOn(runtimeApi, "exportPng").mockResolvedValue({
      path: "/w/a.png",
      relativePath: ".armadra/exports/r1.png",
    } as never);
    const one = ink();
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    await settle();
    expect(result.current.agent).toHaveLength(1);

    act(() => setWhiteboard([], []));
    await settle();
    expect(result.current).toEqual({});
  });

  it("导出失败保留文字并报 error，显式重试后转 ready", async () => {
    const put = vi
      .spyOn(runtimeApi, "exportPng")
      .mockRejectedValue(new Error("offline"));
    const one = shape({ label: "box" });
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    // 三次尝试各隔一个截止时间。
    await settle(2100 * 4);
    expect(put).toHaveBeenCalledTimes(3);
    expect(result.current.agent?.[0]?.content).toMatchObject({
      status: "error",
      text: "box",
    });

    put.mockResolvedValue({
      path: "/w/a.png",
      relativePath: ".armadra/exports/r1.png",
    } as never);
    act(() => refreshContentReferences());
    await settle();
    expect(result.current.agent?.[0]?.content).toMatchObject({
      status: "ready",
      pngPath: ".armadra/exports/r1.png",
    });
  });

  it("同一个对象引用给两个 Agent 各得一条", async () => {
    const one = text("shared");
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard(
        [one],
        [
          { id: "r1", itemId: one.id, nodeId: "a" },
          { id: "r2", itemId: one.id, nodeId: "b" },
        ],
      ),
    );
    await settle();
    expect(result.current.a?.[0]?.id).toBe("r1");
    expect(result.current.b?.[0]?.id).toBe("r2");
  });

  it("超长文字标 `textTruncated`", async () => {
    const one = text("汉".repeat(MAX_CONTENT_TEXT_BYTES));
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    await settle();
    expect(result.current.agent?.[0]?.content?.textTruncated).toBe(true);
  });

  it("卸载后不再导出", async () => {
    const put = vi.spyOn(runtimeApi, "exportPng").mockResolvedValue({
      path: "/w/a.png",
      relativePath: ".armadra/exports/r1.png",
    } as never);
    const one = ink();
    const { unmount } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    unmount();
    await settle();
    expect(put).not.toHaveBeenCalled();
  });

  it("没有工作区时什么也不做", async () => {
    useCanvasStore.setState({ workspace: null } as never);
    const put = vi.spyOn(runtimeApi, "exportPng");
    const one = ink();
    const { result } = renderHook(() => useContentLinks());
    act(() =>
      setWhiteboard([one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]),
    );
    await settle();
    expect(result.current).toEqual({});
    expect(put).not.toHaveBeenCalled();
  });
});

describe("常量", () => {
  it("上限与 Runtime 校验同一个数", () => {
    expect(MAX_LINKS).toBe(64);
    expect(MAX_CONTENT_TEXT_BYTES).toBe(20_000);
    expect(SHAPE_KIND).toBe("shape");
  });
});
