import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "w1", rootPath: "/tmp" },
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

const api = vi.hoisted(() => ({ gitDiff: vi.fn() }));

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

import { DiffNode } from "./DiffNode";

const patch = [
  "@@ -1,3 +1,3 @@",
  " context line",
  "-removed line",
  "+added line",
].join("\n");

const node = {
  id: "d1",
  boardId: "b1",
  type: "diff",
  title: "变更",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  size: { width: 420, height: 400 },
  data: { kind: "diff", scope: "worktree", paths: ["src/a.ts"] },
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
} as CanvasNode;

function renderDiff() {
  return render(
    <DiffNode
      id="d1"
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );
}

beforeEach(() => {
  api.gitDiff.mockResolvedValue({
    repository: true,
    clean: false,
    files: [
      {
        path: "src/a.ts",
        status: "M",
        additions: 1,
        deletions: 1,
        patch,
        previewable: true,
        staged: false,
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders the same patch unified or side by side without re-reading it", async () => {
  renderDiff();
  fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }));
  await screen.findByText("-removed line");
  expect(api.gitDiff).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "并排显示" }));
  // The two sides come from the same patch, so no extra request is made and
  // the removed/added text is split into its own columns.
  await screen.findByText("removed line");
  expect(screen.getByText("added line")).toBeTruthy();
  expect(screen.queryByText("-removed line")).toBeNull();
  expect(api.gitDiff).toHaveBeenCalledTimes(1);
});

it("re-reads the diff when whitespace is ignored and reports a whitespace-only file", async () => {
  renderDiff();
  await screen.findByRole("button", { name: /src\/a\.ts/ });
  api.gitDiff.mockResolvedValue({
    repository: true,
    clean: false,
    files: [
      {
        path: "src/a.ts",
        status: "M",
        additions: 0,
        deletions: 0,
        patch: "",
        previewable: true,
        staged: false,
      },
    ],
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "忽略空白" }));
  await waitFor(() => expect(api.gitDiff).toHaveBeenCalledTimes(2));
  expect(api.gitDiff.mock.calls[1]?.[1]).toMatchObject({
    ignoreWhitespace: true,
  });
  // The row survives — the file really did change — and says why it is empty.
  fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
  await screen.findByText("仅空白差异");
});

it("counts search matches inside the open diff", async () => {
  renderDiff();
  fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }));
  fireEvent.change(screen.getByLabelText("在差异中搜索"), {
    target: { value: "removed" },
  });
  await screen.findByText("命中 1 行");
  expect(api.gitDiff).toHaveBeenCalledTimes(1);
});
