import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { usePreferencesStore } from "../app/preferences-store";

const fileInfo = vi.fn();
const readFile = vi.fn();
vi.mock("@/api/client", () => ({
  isConflict: () => false,
  runtimeApi: {
    // 编辑器挂载时读一次 `language.formatOnSave`（语言服务设计 §2.3）。
    settings: () => Promise.resolve({}),
    fileInfo: (...args: unknown[]) => fileInfo(...args),
    readFile: (...args: unknown[]) => readFile(...args),
    fileDownloadUrl: (_workspace: string, path: string) =>
      `http://localhost/file-download?path=${encodeURIComponent(path)}`,
  },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ workspace: { id: "w1" } }),
}));
vi.mock("./NodeShell", () => ({
  NodeShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { EditorNode } from "./EditorNode";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("file attachments", () => {
  it("shows PDF metadata and a download without decoding binary content", async () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    fileInfo.mockResolvedValue({
      path: ".armadra/imports/a/report.pdf",
      name: "report.pdf",
      size: 2048,
      mimeType: "application/pdf",
      preview: "download",
    });
    render(
      <EditorNode
        id="node"
        selected={false}
        collapsed={false}
        focused={false}
        node={
          {
            title: "report.pdf",
            data: { kind: "editor", path: ".armadra/imports/a/report.pdf" },
          } as never
        }
      />,
    );
    const download = await screen.findByRole("link", { name: "下载文件" });
    expect(download.getAttribute("download")).toBe("report.pdf");
    expect(download.getAttribute("href")).toContain(
      "file-download?path=.armadra%2Fimports%2Fa%2Freport.pdf",
    );
    expect(screen.getByText("2 KB · application/pdf")).toBeTruthy();
    expect(readFile).not.toHaveBeenCalled();
  });
  it("previews an image as bytes and releases its object URL on unmount", async () => {
    const createObjectURL = vi.fn(() => "blob:image-preview");
    const revokeObjectURL = vi.fn();
    const fetchImage = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])]),
    });
    vi.stubGlobal("fetch", fetchImage);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    readFile.mockClear();
    fileInfo.mockResolvedValue({
      path: "photo.png",
      name: "photo.png",
      size: 4,
      mimeType: "image/png",
      preview: "image",
    });
    const view = render(
      <EditorNode
        id="image"
        selected={false}
        collapsed={false}
        focused={false}
        node={
          {
            title: "photo.png",
            data: { kind: "editor", path: "photo.png" },
          } as never
        }
      />,
    );
    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("blob:image-preview");
    expect(fetchImage.mock.calls[0]?.[0]).toContain(
      "file-download?path=photo.png",
    );
    expect(readFile).not.toHaveBeenCalled();
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-preview");
  });
  it("falls back to an attachment download when the browser cannot decode the image", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:unsupported-image"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob(["unsupported-image-bytes"]),
      }),
    );
    fileInfo.mockResolvedValue({
      path: "photo.heic",
      name: "photo.heic",
      size: 24,
      mimeType: "image/heic",
      preview: "image",
    });
    render(
      <EditorNode
        id="image"
        selected={false}
        collapsed={false}
        focused={false}
        node={
          {
            title: "photo.heic",
            data: { kind: "editor", path: "photo.heic" },
          } as never
        }
      />,
    );
    fireEvent.error(await screen.findByRole("img"));
    const download = await screen.findByRole("link", { name: "下载文件" });
    expect(download.getAttribute("download")).toBe("photo.heic");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
