import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FileEntry, Workspace } from "@armadra/shared";

import { useCanvasStore } from "../store/canvas-store";
import { FileTree } from "./FileTree";

const listFiles = vi.fn();
const gitStatus = vi.fn();

vi.mock("../api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: {
    listFiles: (...args: unknown[]) => listFiles(...args),
    gitStatus: (...args: unknown[]) => gitStatus(...args),
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
});
