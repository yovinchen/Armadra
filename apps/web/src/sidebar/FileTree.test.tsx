import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FileEntry, Workspace } from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../store/canvas-store";
import { PreferencesProvider } from "../preferences/Preferences";
import { currentDragPayload, clearDragPayload } from "../canvas/dnd/payload";
import { FileTree } from "./FileTree";

const listFiles = vi.fn();
const gitDiff = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    listFiles: (...args: unknown[]) => listFiles(...args),
    gitDiff: (...args: unknown[]) => gitDiff(...args),
  },
}));

const timestamp = "2026-09-02T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  gatewayEnabled: false,
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
    <QueryClientProvider client={client}>
      <PreferencesProvider>{children}</PreferencesProvider>
    </QueryClientProvider>
  );
  return render(<FileTree />, { wrapper });
}

afterEach(() => cleanup());

beforeEach(() => {
  clearDragPayload();
  listFiles.mockReset();
  gitDiff.mockReset();
  useCanvasStore.setState({ workspace, document: null });
  gitDiff.mockResolvedValue({
    repository: true,
    clean: false,
    files: [
      {
        path: "src/login.ts",
        status: "M",
        additions: 3,
        deletions: 1,
        patch: "",
      },
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
    // The truncation notice belongs to the expanded directory.
    await screen.findByRole("status");
  });

  it("carries an image payload for image files", async () => {
    renderTree();
    const image = await screen.findByText("logo.png");
    const row = image.closest("[role='treeitem']")!;
    const dataTransfer = {
      setData: vi.fn(),
      getData: () => "",
      types: [],
      effectAllowed: "none",
    };
    row.dispatchEvent(
      Object.assign(new Event("dragstart", { bubbles: true }), {
        dataTransfer,
      }),
    );
    await waitFor(() =>
      expect(currentDragPayload()).toEqual({
        kind: "image",
        path: "logo.png",
        name: "logo.png",
        mimeType: "image/png",
      }),
    );
  });
});
