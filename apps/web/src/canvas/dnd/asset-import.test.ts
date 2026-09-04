import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 桌面端 OS 拖放的分流（§8 Phase 3 / asset-import）。
 *
 * 只有路径没有字节的那条路：图片交给 Runtime 的 `assets/import`，其余仍旧开
 * 节点。`external-content.test.ts` 覆盖的是纯函数，这里覆盖的是副作用。
 */

const importAsset = vi.fn();
const listFiles = vi.fn();
const error = vi.fn();

vi.mock("../../api/client", () => ({
  runtimeApi: {
    importAsset: (...args: unknown[]) => importAsset(...args),
    listFiles: (...args: unknown[]) => listFiles(...args),
    assetUrl: (workspaceId: string, assetId: string) =>
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/${assetId}`,
  },
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => error(...args) },
}));

const addNode = vi.fn();
const state = {
  document: { id: "board" } as unknown,
  workspace: { id: "w1" } as unknown,
  addNode: (...args: unknown[]) => addNode(...args),
};

vi.mock("../../store/canvas-store", () => ({
  useCanvasStore: { getState: () => state },
}));

const { addNodeForPath } = await import("./external-content");
const { setEditor } = await import("../editor-context");

/** `createImageShapes` 只用到这几个方法，够它跑完一整趟。 */
function fakeEditor() {
  const asset = {
    id: "asset:1",
    typeName: "asset",
    type: "image",
    props: { src: "http://runtime/asset.png", w: 100, h: 50 },
    meta: {},
  };
  return {
    getAssetForExternalContent: vi.fn(
      async (_content: { file: File }) => asset,
    ),
    run: (fn: () => void) => fn(),
    getAsset: () => undefined,
    createAssets: vi.fn(),
    createShapes: vi.fn(),
    getShape: () => ({ id: "shape:1" }),
    select: vi.fn(),
  };
}

const at = { x: 0, y: 0 };

describe("addNodeForPath", () => {
  beforeEach(() => {
    importAsset.mockReset();
    listFiles.mockReset();
    addNode.mockReset();
    error.mockReset();
    setEditor(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      })),
    );
  });

  it("图片路径走 importAsset，建 image shape 而不是节点", async () => {
    const editor = fakeEditor();
    setEditor(editor as never);
    importAsset.mockResolvedValue({
      id: "0011223344556677.png",
      path: ".aicc/assets/0011223344556677.png",
      url: "/api/workspaces/w1/assets/0011223344556677.png",
      mimeType: "image/png",
      bytes: 3,
    });

    await addNodeForPath("/Users/me/Downloads/shot.PNG", at);

    expect(importAsset).toHaveBeenCalledWith(
      "w1",
      "/Users/me/Downloads/shot.PNG",
    );
    expect(editor.createShapes).toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    // 取回的字节包成 `File` 后交给资产仓库，文件名沿用原文件名。
    const content = editor.getAssetForExternalContent.mock.calls[0]?.[0];
    expect(content?.file.name).toBe("shot.PNG");
    expect(content?.file.type).toBe("image/png");
  });

  it("导入失败只提示，不退回去开 editor 节点", async () => {
    setEditor(fakeEditor() as never);
    importAsset.mockRejectedValue(new Error("too large"));

    await addNodeForPath("/Users/me/Downloads/huge.png", at);

    expect(addNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("非图片仍旧开节点：目录 → files，文件 → editor", async () => {
    setEditor(fakeEditor() as never);

    listFiles.mockRejectedValue(new Error("not a directory"));
    await addNodeForPath("/Users/me/notes.md", at);
    expect(addNode).toHaveBeenLastCalledWith("editor", {
      position: at,
      title: "notes.md",
      data: { kind: "editor", path: "/Users/me/notes.md" },
    });

    listFiles.mockResolvedValue({ entries: [] });
    await addNodeForPath("/Users/me/src", at);
    expect(addNode).toHaveBeenLastCalledWith("files", {
      position: at,
      title: "src",
      data: { kind: "files", path: "/Users/me/src" },
    });
    expect(importAsset).not.toHaveBeenCalled();
  });

  it("画布还没挂载时图片也只能开节点（没有 editor 就建不了 shape）", async () => {
    listFiles.mockRejectedValue(new Error("not a directory"));

    await addNodeForPath("/Users/me/Downloads/shot.png", at);

    expect(importAsset).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledWith("editor", expect.anything());
  });
});
