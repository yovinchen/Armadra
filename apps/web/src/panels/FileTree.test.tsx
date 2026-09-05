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
import type { FileEntry, Workspace } from "@armadra/shared";

import { useCanvasStore } from "../store/canvas-store";
import { FileTree } from "./FileTree";

const listFiles = vi.fn();
const gitStatus = vi.fn();
const createFileEntry = vi.fn();
const renameFileEntry = vi.fn();
const trashFileEntry = vi.fn();
const restoreTrash = vi.fn();

vi.mock("../api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: {
    listFiles: (...args: unknown[]) => listFiles(...args),
    gitStatus: (...args: unknown[]) => gitStatus(...args),
    createFileEntry: (...args: unknown[]) => createFileEntry(...args),
    renameFileEntry: (...args: unknown[]) => renameFileEntry(...args),
    trashFileEntry: (...args: unknown[]) => trashFileEntry(...args),
    restoreTrash: (...args: unknown[]) => restoreTrash(...args),
  },
}));
import { WORKSPACE_FILES_MIME } from "../files/workspace-drag";

const timestamp = "2026-09-04T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function entry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    path: partial.path ?? partial.name,
    kind: partial.kind ?? "file",
    size: partial.size ?? 10,
    readonly: partial.readonly ?? false,
    name: partial.name,
  };
}

function renderTree() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<FileTree />, { wrapper });
}

afterEach(() => cleanup());

beforeEach(() => {
  listFiles.mockReset();
  gitStatus.mockReset();
  createFileEntry.mockReset().mockResolvedValue({
    path: "src/new.ts",
    kind: "file",
  });
  renameFileEntry.mockReset().mockResolvedValue({
    path: "src/renamed.ts",
    kind: "file",
  });
  trashFileEntry.mockReset().mockResolvedValue({
    id: "0198f000-0000-7000-8000-000000000000",
    originalPath: "logo.png",
    name: "logo.png",
    kind: "file",
    deletedAt: timestamp,
  });
  restoreTrash.mockReset();
  useCanvasStore.setState({ workspace });
  gitStatus.mockResolvedValue({
    repository: true,
    branch: "main",
    changedCount: 1,
    files: [
      { path: "src/login.ts", status: "M", staged: false, unstaged: true },
    ],
  });
  listFiles.mockImplementation((_id: string, path: string) =>
    Promise.resolve(
      path === "."
        ? {
            path: ".",
            truncated: false,
            entries: [
              entry({ name: "src", path: "src", kind: "directory" }),
              entry({
                name: "node_modules",
                path: "node_modules",
                kind: "directory",
              }),
              entry({ name: "logo.png", path: "logo.png", size: 900 }),
            ],
          }
        : {
            path,
            truncated: true,
            entries: [entry({ name: "login.ts", path: "src/login.ts" })],
          },
    ),
  );
});

describe("FileTree", () => {
  it("starts scoped file dragging without opening a preview", async () => {
    renderTree();
    const file = await screen.findByRole("treeitem", { name: /logo.png/ });
    const transfer = { effectAllowed: "none", setData: vi.fn() };
    fireEvent.dragStart(file, { dataTransfer: transfer });
    expect(file.draggable).toBe(true);
    expect(transfer.setData).toHaveBeenCalledWith(
      WORKSPACE_FILES_MIME,
      expect.stringContaining(workspace.id),
    );
    expect(JSON.parse(transfer.setData.mock.calls[0]![1]).entries[0].path).toBe(
      "logo.png",
    );
  });
  it("hides ignored folders and puts directories first", async () => {
    renderTree();
    await screen.findByText("src");
    expect(screen.queryByText("node_modules")).toBeNull();
    const names = screen.getAllByRole("treeitem").map((row) => row.textContent);
    expect(names[0]).toContain("src");
    expect(names[1]).toContain("logo.png");
  });

  it("expands a folder lazily and shows the Git badge", async () => {
    renderTree();
    const folder = await screen.findByText("src");
    expect(listFiles).toHaveBeenCalledTimes(1);

    folder.click();
    await screen.findByText("login.ts");
    expect(listFiles).toHaveBeenCalledWith(workspace.id, "src");

    const badge = await screen.findByTitle("已修改");
    expect(badge.textContent).toBe("M");
    // 徽标只来自 status，绝不为此再去算 diff。
    expect(gitStatus).toHaveBeenCalledWith(workspace.id);
    // 截断提示属于展开的那一层目录。
    await screen.findByRole("status");
  });

  it("renders no badge when the workspace is not a repository", async () => {
    gitStatus.mockResolvedValue({
      repository: false,
      branch: null,
      changedCount: 0,
      files: [],
    });
    renderTree();

    const folder = await screen.findByText("src");
    folder.click();
    await screen.findByText("login.ts");
    expect(screen.queryByTitle("已修改")).toBeNull();
  });

  it("creates a file in the folder that was right-clicked", async () => {
    renderTree();
    const folder = await screen.findByRole("treeitem", { name: /src/ });
    fireEvent.contextMenu(folder);
    fireEvent.click(await screen.findByText("新建文件"));

    const field = await screen.findByLabelText("名称");
    fireEvent.change(field, { target: { value: "new.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(createFileEntry).toHaveBeenCalledWith(
        workspace.id,
        "src/new.ts",
        "file",
      ),
    );
  });

  it("renames through a full path, so the same box also moves the file", async () => {
    renderTree();
    const file = await screen.findByRole("treeitem", { name: /logo.png/ });
    fireEvent.contextMenu(file);
    fireEvent.click(await screen.findByText("重命名"));

    const field = await screen.findByLabelText("工作区内路径");
    expect((field as HTMLInputElement).value).toBe("logo.png");
    fireEvent.change(field, { target: { value: "assets/logo.png" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(renameFileEntry).toHaveBeenCalledWith(
        workspace.id,
        "logo.png",
        "assets/logo.png",
      ),
    );
  });

  it("deletes only to the trash, and only after confirmation", async () => {
    renderTree();
    const file = await screen.findByRole("treeitem", { name: /logo.png/ });
    fireEvent.contextMenu(file);
    fireEvent.click(await screen.findByText("删除到回收站"));
    // The confirmation is a real gate: nothing has been asked of the runtime.
    expect(trashFileEntry).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("button", {
      name: "删除到回收站",
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(trashFileEntry).toHaveBeenCalledWith(workspace.id, "logo.png"),
    );
  });

  it("dropping a file on a folder moves it there", async () => {
    renderTree();
    const folder = await screen.findByRole("treeitem", { name: /src/ });
    const payload = JSON.stringify({
      version: 1,
      runtimeUrl: "http://runtime",
      workspaceId: workspace.id,
      entries: [{ path: "logo.png", name: "logo.png", kind: "file" }],
    });
    const dataTransfer = {
      types: [WORKSPACE_FILES_MIME],
      getData: () => payload,
      dropEffect: "none",
    };
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    await waitFor(() =>
      expect(renameFileEntry).toHaveBeenCalledWith(
        workspace.id,
        "logo.png",
        "src/logo.png",
      ),
    );
  });

  it("offers no file operations in a read-only workspace", async () => {
    useCanvasStore.setState({
      workspace: {
        ...workspace,
        permissions: { read: true, write: false, execute: false },
      },
    });
    renderTree();
    const file = await screen.findByRole("treeitem", { name: /logo.png/ });
    fireEvent.contextMenu(file);
    expect(screen.queryByText("重命名")).toBeNull();
    expect(screen.queryByText("删除到回收站")).toBeNull();
    expect(screen.queryByLabelText("新建文件")).toBeNull();
  });
});
