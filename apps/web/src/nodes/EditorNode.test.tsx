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

  function renderMedia(path: string, mimeType: string, preview: string) {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:${path}`),
      revokeObjectURL: vi.fn(),
    });
    const fetchMedia = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
    });
    vi.stubGlobal("fetch", fetchMedia);
    readFile.mockClear();
    fileInfo.mockResolvedValue({
      path,
      name: path,
      size: 3,
      mimeType,
      preview,
    });
    render(
      <EditorNode
        id="media"
        selected={false}
        collapsed={false}
        focused={false}
        node={{ title: path, data: { kind: "editor", path } } as never}
      />,
    );
    return fetchMedia;
  }

  it("plays video and audio with the engine's own controls", async () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    const fetchMedia = renderMedia("clip.mp4", "video/mp4", "video");
    await vi.waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe(
        "blob:clip.mp4",
      ),
    );
    expect(document.querySelector("video")?.hasAttribute("controls")).toBe(
      true,
    );
    expect(fetchMedia.mock.calls[0]?.[0]).toContain(
      "file-download?path=clip.mp4",
    );
    cleanup();

    renderMedia("take.mp3", "audio/mpeg", "audio");
    await vi.waitFor(() =>
      expect(document.querySelector("audio")?.getAttribute("src")).toBe(
        "blob:take.mp3",
      ),
    );
    // 播放不了就退回下载卡片。
    fireEvent.error(document.querySelector("audio")!);
    expect(await screen.findByRole("link", { name: "下载文件" })).toBeTruthy();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("shows a PDF in a frame built from its bytes", async () => {
    renderMedia("spec.pdf", "application/pdf", "pdf");
    await vi.waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
        "blob:spec.pdf",
      ),
    );
  });

  it("zooms an image: fit, 1:1 and the wheel", async () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    renderMedia("photo.png", "image/png", "image");
    const image = (await screen.findByRole("img")) as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { value: 200 });
    Object.defineProperty(image, "naturalHeight", { value: 100 });
    fireEvent.load(image);

    // 默认适应：不写死尺寸。
    expect(image.style.width).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: "1:1" }));
    expect(image.style.width).toBe("200px");
    expect(screen.getByText("100%")).toBeTruthy();

    fireEvent.wheel(screen.getByTestId("image-viewport"), { deltaY: -100 });
    expect(image.style.width).toBe("220px");
    expect(screen.getByText("110%")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "适应" }));
    expect(image.style.width).toBe("");
    // 透明区域铺棋盘格。
    expect(image.style.backgroundImage).toContain("repeating-conic-gradient");
  });
});
