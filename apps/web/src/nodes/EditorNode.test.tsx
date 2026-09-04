import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { usePreferencesStore } from "../app/preferences-store";

const fileInfo = vi.fn();
const readFile = vi.fn();
vi.mock("@/api/client", () => ({ isConflict: () => false, runtimeApi: {
  fileInfo: (...args: unknown[]) => fileInfo(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  fileDownloadUrl: (_workspace: string, path: string) => `http://localhost/file-download?path=${encodeURIComponent(path)}`,
} }));
vi.mock("@/store/canvas-store", () => ({ useCanvasStore: (selector: (state: unknown) => unknown) => selector({ workspace: { id: "w1" } }) }));
vi.mock("./NodeShell", () => ({ NodeShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
import { EditorNode } from "./EditorNode";

afterEach(cleanup);

describe("file attachments", () => {
  it("shows PDF metadata and a download without decoding binary content", async () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    fileInfo.mockResolvedValue({ path: ".armadra/imports/a/report.pdf", name: "report.pdf", size: 2048, mimeType: "application/pdf", preview: "download" });
    render(<EditorNode id="node" selected={false} collapsed={false} focused={false} node={{ title: "report.pdf", data: { kind: "editor", path: ".armadra/imports/a/report.pdf" } } as never} />);
    const download = await screen.findByRole("link", { name: "下载文件" });
    expect(download.getAttribute("download")).toBe("report.pdf");
    expect(download.getAttribute("href")).toContain("file-download?path=.armadra%2Fimports%2Fa%2Freport.pdf");
    expect(screen.getByText("2 KB · application/pdf")).toBeTruthy();
    expect(readFile).not.toHaveBeenCalled();
  });
});
