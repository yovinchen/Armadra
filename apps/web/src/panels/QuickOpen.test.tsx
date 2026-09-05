import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Workspace } from "@armadra/shared";

import { installDomPolyfills } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { QuickOpen } from "./QuickOpen";

installDomPolyfills();

const fileIndex = vi.fn();
const openFileInEditor = vi.fn();

vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: { fileIndex: (...args: unknown[]) => fileIndex(...args) },
}));
vi.mock("@/files/open-editor", () => ({
  openFileInEditor: (...args: unknown[]) => openFileInEditor(...args),
}));

const timestamp = "2026-09-05T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function renderQuickOpen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<QuickOpen />, { wrapper });
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.useRealTimers();
  fileIndex.mockReset().mockResolvedValue({
    entries: [{ path: "src/api/client.ts", name: "client.ts", size: 100 }],
    truncated: false,
    scanned: 20,
  });
  openFileInEditor.mockReset();
  useCanvasStore.setState({ workspace });
  useCanvasStore.getState().setPanel("quickOpen", true);
});

describe("QuickOpen", () => {
  it("asks the runtime for the match and opens the chosen file", async () => {
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "client" },
    });
    await waitFor(() =>
      expect(fileIndex).toHaveBeenCalledWith(workspace.id, "client"),
    );

    fireEvent.click(await screen.findByText("client.ts"));
    expect(openFileInEditor).toHaveBeenCalledWith("src/api/client.ts");
    expect(useCanvasStore.getState().panels.quickOpen).toBe(false);
  });

  // 匹配是 Runtime 做的，而且已经截断过；本地再筛一遍会把真正的匹配藏掉。
  it("does not filter the runtime's already-truncated list locally", async () => {
    fileIndex.mockResolvedValue({
      entries: [{ path: "docs/readme.md", name: "readme.md", size: 10 }],
      truncated: true,
      scanned: 40000,
    });
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText("readme.md")).toBeTruthy();
    expect(await screen.findByText("结果已截断")).toBeTruthy();
  });

  it("says the index could not be read instead of showing an empty list", async () => {
    fileIndex.mockRejectedValue(new Error("nope"));
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "x" },
    });
    expect(await screen.findByText("读取索引失败")).toBeTruthy();
  });
});
