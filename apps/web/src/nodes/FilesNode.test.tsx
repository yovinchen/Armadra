import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderFlow } from "@/canvas/test-support";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "w1", name: "Armadra", rootPath: "/tmp" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(),
}));

const api = vi.hoisted(() => ({ listFiles: vi.fn(), gitStatus: vi.fn() }));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: api,
  terminalWebSocketUrl: (id: string) => `ws://x/${id}`,
}));

import { usePreferencesStore } from "@/app/preferences-store";
import { FilesNode } from "./FilesNode";
import { WORKSPACE_FILES_MIME } from "../files/workspace-drag";

const node = {
  id: "f1",
  boardId: "b1",
  type: "files",
  title: "文件",
  color: "#0a84ff",
  position: { x: 100, y: 40 },
  size: { width: 340, height: 460 },
  data: { kind: "files", path: "src" },
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
} as CanvasNode;

function renderFiles() {
  return renderFlow(
    <FilesNode
      id="f1"
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
    { nodeId: "f1" },
  );
}

beforeEach(() => {
  api.gitStatus.mockResolvedValue({
    repository: true,
    branch: "main",
    changedCount: 0,
    files: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FilesNode", () => {
  /**
   * 「按比例展示」（契约 §3.4，2026-09-19）：列表拿走面包屑与过滤框之外的
   * 全部高度并自己滚，所以节点越高看见的条目越多，不靠固定行数。
   */
  it("gives the list the remaining height and its own scroller", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [],
    });
    const view = renderFiles();
    await screen.findByLabelText("过滤");

    const scroller = view.container.querySelector(
      '[data-slot="scroll-area"]',
    ) as HTMLElement;
    expect(scroller.className).toContain("flex-1");
    expect(scroller.className).toContain("min-h-0");
  });

  it("starts an internal file drag without opening an editor", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        {
          name: "a.ts",
          path: "src/a.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
      ],
    });
    renderFiles();
    const file = await screen.findByRole("button", { name: "a.ts" });
    const transfer = { effectAllowed: "none", setData: vi.fn() };
    fireEvent.dragStart(file, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith(
      WORKSPACE_FILES_MIME,
      expect.stringContaining('"workspaceId":"w1"'),
    );
    expect(store.addNode).not.toHaveBeenCalled();
  });
  it("lists directories before files and navigates on click", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        {
          name: "b.ts",
          path: "src/b.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
        {
          name: "nodes",
          path: "src/nodes",
          kind: "directory",
          size: 0,
          readonly: false,
        },
      ],
    });
    renderFiles();

    await waitFor(() =>
      expect(api.listFiles).toHaveBeenCalledWith("w1", "src"),
    );
    const rows = await screen.findAllByRole("button");
    const labels = rows.map((row) => row.textContent);
    expect(labels.indexOf("nodes")).toBeLessThan(labels.indexOf("b.ts"));

    fireEvent.click(await screen.findByText("nodes"));
    expect(store.updateNodeData).toHaveBeenCalledWith("f1", {
      path: "src/nodes",
    });
  });

  /**
   * F4：`.DS_Store` 这类文件不是用户写的，也不是用户要打开的；在一个 340px
   * 宽的节点里它们只会把真正的文件挤下去。默认藏起来，偏好一开就回来。
   */
  it("hides operating system metadata files unless the preference is on", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        { name: ".DS_Store", path: "src/.DS_Store", kind: "file", size: 1 },
        { name: "Thumbs.db", path: "src/Thumbs.db", kind: "file", size: 1 },
        { name: "desktop.ini", path: "src/desktop.ini", kind: "file", size: 1 },
        // 点开头但是用户自己的文件：一条「隐藏点文件」的规则会把它也藏掉。
        { name: ".gitignore", path: "src/.gitignore", kind: "file", size: 1 },
        { name: "a.ts", path: "src/a.ts", kind: "file", size: 1 },
      ],
    });
    const view = renderFiles();
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(screen.getByText(".gitignore")).toBeTruthy();
    expect(screen.queryByText(".DS_Store")).toBeNull();
    expect(screen.queryByText("Thumbs.db")).toBeNull();
    expect(screen.queryByText("desktop.ini")).toBeNull();

    usePreferencesStore.setState({ showSystemFiles: true });
    view.rerenderNode(
      <FilesNode
        id="f1"
        node={node}
        selected={false}
        collapsed={false}
        focused={false}
      />,
    );
    expect(await screen.findByText(".DS_Store")).toBeTruthy();
    usePreferencesStore.setState({ showSystemFiles: false });
  });

  it("opens a file as an editor node to the right", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        {
          name: "a.ts",
          path: "src/a.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
      ],
    });
    renderFiles();

    fireEvent.doubleClick(await screen.findByText("a.ts"));
    expect(store.addNode).toHaveBeenCalledWith("editor", {
      title: "a.ts",
      data: { path: "src/a.ts" },
      position: { x: 100 + 340 + 24, y: 40 },
    });
  });

  // 头一格显示工作空间名，不是「根目录」：一整条绝对路径逐级列出来会把
  // 节点撑爆（见 files/breadcrumb.ts）。
  it("navigates back through the breadcrumb", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [],
    });
    renderFiles();
    fireEvent.click(await screen.findByText("Armadra"));
    expect(store.updateNodeData).toHaveBeenCalledWith("f1", { path: "." });
  });

  it("filters the listing by name", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        {
          name: "alpha.ts",
          path: "src/alpha.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
        {
          name: "beta.ts",
          path: "src/beta.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
      ],
    });
    renderFiles();
    await screen.findByText("alpha.ts");

    fireEvent.change(screen.getByLabelText("过滤"), {
      target: { value: "bet" },
    });
    expect(screen.queryByText("alpha.ts")).toBeNull();
    expect(screen.getByText("beta.ts")).toBeTruthy();
  });

  it("badges entries from git status without asking for a diff", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        {
          name: "a.ts",
          path: "src/a.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
        {
          name: "b.ts",
          path: "src/b.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
      ],
    });
    api.gitStatus.mockResolvedValue({
      repository: true,
      branch: "main",
      changedCount: 1,
      files: [{ path: "src/a.ts", status: "M", staged: false, unstaged: true }],
    });
    renderFiles();

    const badge = await screen.findByTitle("已修改");
    expect(badge.textContent).toBe("M");
    // 只有 a.ts 有变更，b.ts 不该拿到徽标。
    expect(screen.queryByTitle("未跟踪")).toBeNull();
    expect(api).not.toHaveProperty("gitDiff");
  });

  it("keeps listing files when the workspace is not a repository", async () => {
    api.listFiles.mockResolvedValue({
      path: "src",
      truncated: false,
      entries: [
        {
          name: "a.ts",
          path: "src/a.ts",
          kind: "file",
          size: 1,
          readonly: false,
        },
      ],
    });
    api.gitStatus.mockRejectedValue(new Error("not a repository"));
    renderFiles();

    await screen.findByText("a.ts");
    expect(screen.queryByTitle("已修改")).toBeNull();
  });
});
