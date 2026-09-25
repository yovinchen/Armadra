import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
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
import { rememberRecentFile } from "../files/recent-files";
import { QuickOpen } from "./QuickOpen";
import { openQuickOpen } from "./quick-open-seed";

installDomPolyfills();

const fileIndex = vi.fn();
const openFileInEditor = vi.fn();
const documentSymbols = vi.fn();
const workspaceSymbols = vi.fn();

vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: { fileIndex: (...args: unknown[]) => fileIndex(...args) },
}));
vi.mock("@/files/open-editor", () => ({
  openFileInEditor: (...args: unknown[]) => openFileInEditor(...args),
}));
vi.mock("@/editor/language/symbols", async () => {
  const actual = await vi.importActual<
    typeof import("@/editor/language/symbols")
  >("@/editor/language/symbols");
  return {
    ...actual,
    documentSymbols: (...args: unknown[]) => documentSymbols(...args),
    workspaceSymbols: (...args: unknown[]) => workspaceSymbols(...args),
  };
});

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useRealTimers();
  fileIndex.mockReset().mockResolvedValue({
    entries: [{ path: "src/api/client.ts", name: "client.ts", size: 100 }],
    truncated: false,
    scanned: 20,
  });
  openFileInEditor.mockReset();
  documentSymbols.mockReset().mockResolvedValue([]);
  workspaceSymbols.mockReset().mockResolvedValue([]);
  useCanvasStore.setState({ workspace });
  useCanvasStore.getState().setPanel("quickOpen", true);
});

/** 一个已经打开的编辑器节点，`@` 问的就是它。 */
function openEditorNode(path: string) {
  useCanvasStore.setState({
    document: {
      nodes: [
        {
          id: "n1",
          type: "editor",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          title: path,
          data: { kind: "editor", path },
        },
      ],
      edges: [],
    } as never,
    selectedNodeIds: ["n1"],
  });
}

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

  // `@` 与 `#` 是两种问法，问的也是两个不同的东西：一个文档的符号表，和
  // 整个工作区的符号索引。走错一条就是列出了别的文件里的东西。
  it("asks the current document for `@` and jumps to the symbol's line", async () => {
    openEditorNode("src/api/client.ts");
    documentSymbols.mockResolvedValue([
      { name: "openSession", kind: 12, path: "src/api/client.ts", line: 41 },
    ]);
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "@open" },
    });
    await waitFor(() =>
      expect(documentSymbols).toHaveBeenCalledWith(
        workspace.id,
        "src/api/client.ts",
      ),
    );
    // 前缀不是文件名的一部分：`@open` 不该同时变成一次文件索引查询。
    expect(fileIndex.mock.calls.some(([, term]) => term === "@open")).toBe(
      false,
    );

    fireEvent.click(await screen.findByText("openSession"));
    // LSP 的行号从 0 起，编辑器的定位接口从 1 起。
    expect(openFileInEditor).toHaveBeenCalledWith("src/api/client.ts", {
      line: 42,
    });
  });

  it("asks the workspace for `#` and shows which file each symbol is in", async () => {
    workspaceSymbols.mockResolvedValue([
      { name: "Manager", kind: 5, path: "src/language/mod.rs", line: 9 },
    ]);
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "#Manager" },
    });
    await waitFor(() =>
      expect(workspaceSymbols).toHaveBeenCalledWith("Manager"),
    );
    expect(await screen.findByText("src/language/mod.rs")).toBeTruthy();
  });

  // 没有语言会话时符号列表是空的。说清楚这一点，而不是转一个永远转不完的圈。
  it("says there are no symbols rather than pretending to still be loading", async () => {
    openEditorNode("src/api/client.ts");
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "@" },
    });
    expect(
      await screen.findByText("没有符号；语言服务没在跑时这里是空的"),
    ).toBeTruthy();
  });

  it("lists the recently opened files of this workspace before anything is typed", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    rememberRecentFile(workspace.id, "docs/old.md");
    rememberRecentFile(workspace.id, "src/new.ts");
    rememberRecentFile("another-workspace", "elsewhere.txt");
    renderQuickOpen();

    const group = await screen.findByText("最近打开");
    const rows = group.parentElement?.textContent ?? "";
    // 最近的在前，别的工作空间的不混进来。
    expect(rows.indexOf("src/new.ts")).toBeLessThan(
      rows.indexOf("docs/old.md"),
    );
    expect(rows).not.toContain("elsewhere.txt");

    fireEvent.click(screen.getByText("new.ts"));
    expect(openFileInEditor).toHaveBeenCalledWith("src/new.ts");
  });

  it("opens a file at `path:line:column`", async () => {
    renderQuickOpen();
    fireEvent.change(screen.getByPlaceholderText("按文件名查找"), {
      target: { value: "client:12:4" },
    });
    // 位置后缀不进文件名查询。
    await waitFor(() =>
      expect(fileIndex).toHaveBeenCalledWith(workspace.id, "client"),
    );
    fireEvent.click(await screen.findByText("client.ts"));
    expect(openFileInEditor).toHaveBeenCalledWith("src/api/client.ts", {
      line: 12,
      column: 4,
    });
  });

  it("jumps within the editor the go-to-line command came from", async () => {
    cleanup();
    useCanvasStore.getState().setPanel("quickOpen", false);
    openEditorNode("src/other.ts");
    renderQuickOpen();
    act(() => openQuickOpen({ query: ":", path: "src/seeded.ts" }));

    const input = await screen.findByPlaceholderText("按文件名查找");
    expect((input as HTMLInputElement).value).toBe(":");
    expect(await screen.findByText(/输入行号/)).toBeTruthy();

    fireEvent.change(input, { target: { value: ":30" } });
    fireEvent.click(await screen.findByText("第 30 行"));
    expect(openFileInEditor).toHaveBeenCalledWith("src/seeded.ts", {
      line: 30,
      column: undefined,
    });
    // 只跳行的输入不去扫文件索引。
    expect(fileIndex).not.toHaveBeenCalledWith(workspace.id, ":30");
  });
});
