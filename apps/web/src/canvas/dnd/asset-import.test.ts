import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 桌面端 OS 拖放的分流（§8 Phase 3 / asset-import）。
 *
 * 只有路径没有字节的那条路：图片交给 Runtime 的 `assets/import`，其余仍旧开
 * 节点。`external-content.test.ts` 覆盖的是纯函数，这里覆盖的是副作用。
 */

vi.mock("tldraw", async (original) => {
  const actual = await original<typeof import("tldraw")>();
  return { ...actual, getAssetInfo: (editor: { getAssetForExternalContent: (content: unknown) => unknown }, file: File) => editor.getAssetForExternalContent({ type: "file", file }) };
});

const importAsset = vi.fn();
const listFiles = vi.fn();
const fileInfo = vi.fn();
const importLocalFiles = vi.fn();
const importFiles = vi.fn();
const error = vi.fn();

vi.mock("../../api/client", () => ({
  runtimeApi: {
    importAsset: (...args: unknown[]) => importAsset(...args),
    uploadAsset: vi.fn(async () => ({ id: "0011223344556677.png", path: ".armadra/assets/0011223344556677.png" })),
    fileInfo: (...args: unknown[]) => fileInfo(...args),
    importLocalFiles: (...args: unknown[]) => importLocalFiles(...args),
    importFiles: (...args: unknown[]) => importFiles(...args),
    listFiles: (...args: unknown[]) => listFiles(...args),
    assetUrl: (workspaceId: string, assetId: string) =>
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/${assetId}`,
  },
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: (...args: unknown[]) => error(...args) },
}));

const addNode = vi.fn();
const state = {
  document: { board: { id: "board" } },
  workspace: { id: "w1" },
  addNode: (...args: unknown[]) => addNode(...args),
};

vi.mock("../../store/canvas-store", () => ({
  useCanvasStore: { getState: () => state },
}));

const { addNodeForPath, addBrowserFiles, addWorkspaceEntriesToCanvas } =
  await import("./external-content");
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
    fileInfo.mockReset().mockRejectedValue(new Error("outside workspace"));
    importLocalFiles.mockReset().mockResolvedValue({ files: [{ path: ".armadra/imports/b/notes.md", name: "notes.md", size: 4, mimeType: "text/plain", preview: "text" }] });
    importFiles.mockReset();
    state.document = { board: { id: "board" } };
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
      path: ".armadra/assets/0011223344556677.png",
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

  it("非图片导入副本，工作区内目录保留原路径", async () => {
    setEditor(fakeEditor() as never);

    listFiles.mockRejectedValue(new Error("not a directory"));
    await addNodeForPath("/Users/me/notes.md", at);
    expect(addNode).toHaveBeenLastCalledWith("editor", {
      position: at,
      title: "notes.md",
      data: { kind: "editor", path: ".armadra/imports/b/notes.md" },
    });

    listFiles.mockResolvedValue({ entries: [], path: "src" });
    await addNodeForPath("/Users/me/src", at);
    expect(addNode).toHaveBeenLastCalledWith("files", {
      position: at,
      title: "src",
      data: { kind: "files", path: "src" },
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


describe("browser file imports", () => {
  it("uploads PDF bytes as an attachment instead of decoding text", async () => {
    state.document = { board: { id: "board" } };
    addNode.mockClear();
    const editor = fakeEditor();
    setEditor(editor as never);
    const file = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });
    const readText = vi.fn();
    Object.defineProperty(file, "text", { value: readText });
    importFiles.mockResolvedValue({ files: [{ name: file.name, path: ".armadra/imports/b/report.pdf", size: file.size, mimeType: file.type, preview: "download" }] });
    await addBrowserFiles(editor as never, [file], at);
    expect(readText).not.toHaveBeenCalled();
    expect(importFiles).toHaveBeenLastCalledWith("w1", [{ file, path: "report.pdf" }]);
    expect(addNode).toHaveBeenLastCalledWith("editor", expect.objectContaining({ data: { kind: "editor", path: ".armadra/imports/b/report.pdf" } }));
  });

  it("does not create nodes on a board switched during upload", async () => {
    state.document = { board: { id: "board" } };
    addNode.mockClear();
    const editor = fakeEditor();
    setEditor(editor as never);
    let finish: (value: unknown) => void = () => {};
    importFiles.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    const pending = addBrowserFiles(editor as never, [file], at);
    state.document = { board: { id: "other-board" } };
    finish({ files: [{ name: file.name, path: ".armadra/imports/b/a.txt", size: 5, mimeType: file.type, preview: "text" }] });
    await pending;
    expect(addNode).not.toHaveBeenCalled();
  });
});

describe("workspace file references", () => {
  beforeEach(() => {
    state.document = { board: { id: "board" } };
    addNode.mockClear();
    importLocalFiles.mockClear();
    importFiles.mockClear();
    fileInfo.mockReset();
    listFiles.mockReset();
    setEditor(fakeEditor() as never);
  });

  it("previews an existing file without uploading or copying it", async () => {
    fileInfo.mockResolvedValue({
      path: "src/a.ts",
      name: "a.ts",
      size: 2,
      mimeType: "text/plain",
      preview: "text",
    });
    await addWorkspaceEntriesToCanvas(
      [{ path: "src/a.ts", name: "a.ts", kind: "file" }],
      at,
    );
    expect(addNode).toHaveBeenCalledWith(
      "editor",
      expect.objectContaining({ data: { kind: "editor", path: "src/a.ts" } }),
    );
    expect(importLocalFiles).not.toHaveBeenCalled();
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("treats a directory named .png as a directory", async () => {
    listFiles.mockResolvedValue({ path: "images.png", entries: [] });
    await addWorkspaceEntriesToCanvas(
      [{ path: "images.png", name: "images.png", kind: "directory" }],
      at,
    );
    expect(addNode).toHaveBeenCalledWith(
      "files",
      expect.objectContaining({ data: { kind: "files", path: "images.png" } }),
    );
  });

  it("does not fall back to external importing on a read failure", async () => {
    fileInfo.mockRejectedValue(new Error("permission denied"));
    await expect(
      addWorkspaceEntriesToCanvas(
        [{ path: "secret.txt", name: "secret.txt", kind: "file" }],
        at,
      ),
    ).rejects.toThrow();
    expect(importLocalFiles).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
  });

  it("does not add a preview after switching boards or locking the canvas", async () => {
    fileInfo.mockImplementation(async () => {
      state.document = { board: { id: "changed" } };
      return { path: "a.ts", name: "a.ts" };
    });
    await addWorkspaceEntriesToCanvas(
      [{ path: "a.ts", name: "a.ts", kind: "file" }],
      at,
    );
    expect(addNode).not.toHaveBeenCalled();
    setEditor({ ...fakeEditor(), getIsReadonly: () => true } as never);
    await expect(
      addWorkspaceEntriesToCanvas(
        [{ path: "a.ts", name: "a.ts", kind: "file" }],
        at,
      ),
    ).rejects.toThrow();
  });
});
