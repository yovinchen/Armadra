import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 图片导入的副作用（React Flow 计划 F26 / F27）。
 *
 * 分流的纯函数在 `external-content.test.ts`；这里盯的是**图片走的是资产
 * 接口、白板文档里只留 `assetPath`**——那是 §3.1 的硬约束，字节一旦进了
 * `whiteboard_json` 就会立刻撞上 8 MiB 上限。
 */

const importAsset = vi.fn();
const uploadAsset = vi.fn();
const listFiles = vi.fn();
const fileInfo = vi.fn();
const importLocalFiles = vi.fn();
const importFiles = vi.fn();
const error = vi.fn();

vi.mock("../../api/client", () => ({
  RUNTIME_URL: "http://127.0.0.1:43120",
  runtimeApi: {
    importAsset: (...args: unknown[]) => importAsset(...args),
    uploadAsset: (...args: unknown[]) => uploadAsset(...args),
    fileInfo: (...args: unknown[]) => fileInfo(...args),
    importLocalFiles: (...args: unknown[]) => importLocalFiles(...args),
    importFiles: (...args: unknown[]) => importFiles(...args),
    listFiles: (...args: unknown[]) => listFiles(...args),
    assetUrl: (workspaceId: string, assetId: string) =>
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/${assetId}`,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    error: (...args: unknown[]) => error(...args),
    success: vi.fn(),
  },
}));

const addNode = vi.fn();
const items: Record<string, unknown>[] = [];
const state = {
  document: { board: { id: "board" }, nodes: [], edges: [] },
  workspace: { id: "w1" },
  whiteboard: { engine: "armadra-flow", version: 2, items, references: [] },
  selectedItemIds: [] as string[],
  addNode: (...args: unknown[]) => addNode(...args),
  setWhiteboard: (doc: { items: Record<string, unknown>[] }) => {
    items.splice(0, items.length, ...doc.items);
    state.whiteboard = { ...state.whiteboard, items } as never;
  },
  setSelection: vi.fn(),
};

vi.mock("../../store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => state,
    setState: vi.fn(),
  },
  beginCoalesce: vi.fn(),
  endCoalesce: vi.fn(),
}));

const { addNodeForPath, addBrowserFiles, createImageShapes } = await import(
  "./external-content"
);

const at = { x: 0, y: 0 };

function png(name = "shot.png"): File {
  return new File(["png-bytes"], name, { type: "image/png" });
}

beforeEach(() => {
  items.length = 0;
  importAsset.mockReset();
  uploadAsset.mockReset().mockResolvedValue({
    id: "0011223344556677.png",
    path: ".armadra/assets/0011223344556677.png",
    url: "/api/workspaces/w1/assets/0011223344556677.png",
    mimeType: "image/png",
    bytes: 9,
  });
  listFiles.mockReset();
  fileInfo.mockReset().mockRejectedValue(new Error("outside workspace"));
  importLocalFiles.mockReset().mockResolvedValue({ files: [] });
  importFiles.mockReset().mockResolvedValue({ files: [] });
  addNode.mockReset();
  error.mockReset();
  state.setSelection.mockReset();
});

describe("createImageShapes", () => {
  it("字节走资产接口，白板对象里只留相对路径", async () => {
    const ids = await createImageShapes([png()], at, {
      workspaceId: "w1",
      boardId: "board",
    });
    expect(uploadAsset).toHaveBeenCalledWith("w1", expect.any(File));
    expect(ids).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "image",
      assetPath: ".armadra/assets/0011223344556677.png",
      alt: "shot.png",
    });
    // 字节绝不能进白板文档：8 MiB 上限会立刻被撑破。
    expect(JSON.stringify(items[0])).not.toContain("png-bytes");
    expect(addNode).not.toHaveBeenCalled();
  });

  it("多张图横排落下，每张一条对象", async () => {
    await createImageShapes([png("a.png"), png("b.png")], at, {
      workspaceId: "w1",
      boardId: "board",
    });
    expect(items).toHaveLength(2);
    expect(items[0]!.x).not.toEqual(items[1]!.x);
  });

  it("一张上传失败只提示那一张，其余照建", async () => {
    uploadAsset.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      id: "0011223344556677.png",
      path: ".armadra/assets/0011223344556677.png",
      url: "/x",
      mimeType: "image/png",
      bytes: 9,
    });
    await createImageShapes([png("bad.png"), png("good.png")], at, {
      workspaceId: "w1",
      boardId: "board",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
  });

  it("没有目标画布时什么都不做", async () => {
    expect(await createImageShapes([png()], at, null)).toEqual([]);
    expect(uploadAsset).not.toHaveBeenCalled();
  });
});

describe("addNodeForPath", () => {
  it("图片路径走 importAsset，建白板对象而不是节点", async () => {
    importAsset.mockResolvedValue({
      id: "aabbccddeeff0011.png",
      path: ".armadra/assets/aabbccddeeff0011.png",
      url: "/api/workspaces/w1/assets/aabbccddeeff0011.png",
      mimeType: "image/png",
      bytes: 10,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      })),
    );
    await addNodeForPath("/tmp/photo.png", at);
    expect(importAsset).toHaveBeenCalledWith("w1", "/tmp/photo.png");
    expect(items[0]).toMatchObject({
      kind: "image",
      assetPath: ".armadra/assets/aabbccddeeff0011.png",
    });
    expect(addNode).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("导入失败时提示，画布上不留半张图", async () => {
    importAsset.mockRejectedValue(new Error("no such file"));
    await addNodeForPath("/tmp/photo.png", at);
    expect(items).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("目录仍旧开 files 节点，不碰资产接口", async () => {
    listFiles.mockResolvedValue({ path: "src", entries: [] });
    await addNodeForPath("/tmp/repo/src", at);
    expect(importAsset).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledWith("files", expect.anything());
  });
});

describe("addBrowserFiles", () => {
  it("图片与普通文件分两条路：前者建对象，后者导入成节点", async () => {
    importFiles.mockResolvedValue({
      files: [
        {
          path: ".armadra/imports/b/notes.md",
          name: "notes.md",
          size: 4,
          mimeType: "text/plain",
          preview: "text",
        },
      ],
    });
    await addBrowserFiles(
      [png(), new File(["# hi"], "notes.md", { type: "text/markdown" })],
      at,
      { workspaceId: "w1", boardId: "board" },
    );
    expect(items).toHaveLength(1);
    expect(importFiles).toHaveBeenCalledOnce();
    expect(addNode).toHaveBeenCalledWith("editor", expect.anything());
  });
});
