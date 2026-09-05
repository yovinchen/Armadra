import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BoardDocument, Conversation, Workspace } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { CommandPalette } from "./CommandPalette";

const conversations = vi.fn();

vi.mock("../api/client", () => ({
  RUNTIME_URL: "http://127.0.0.1:43120",
  runtimeApi: {
    agents: vi.fn().mockResolvedValue([]),
    settings: vi.fn().mockResolvedValue({ ssh: { hosts: [] } }),
    conversations: (...args: unknown[]) => conversations(...args),
  },
}));

const timestamp = "2026-09-04T10:00:00.000Z";

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

const BOARD_ID = "019ff7d1-0d12-7421-833d-2c5e8d64ed30";

const document: BoardDocument = {
  board: {
    id: BOARD_ID,
    workspaceId: workspace.id,
    name: "Default",
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [],
  edges: [],
};

const row: Conversation = {
  provider: "claude",
  sessionId: "8f0f4e2c-1111-4b6f-9d21-2c5e8d64ed99",
  title: "重构保存队列",
  cwd: "/repo/apps/web",
  updatedAt: timestamp,
  bytes: 4096,
};

beforeAll(installDomPolyfills);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  conversations.mockResolvedValue([row]);
  useCanvasStore.setState({
    workspace,
    boardId: BOARD_ID,
    document,
    selectedNodeIds: [],
    panels: { ...useCanvasStore.getState().panels, palette: true },
  });
});

function renderPalette() {
  return render(<CommandPalette />, { wrapper: TestProviders });
}

describe("命令面板的历史对话分组", () => {
  it("列出 Runtime 索引里的对话（标题 + 目录名）", async () => {
    renderPalette();
    expect(await screen.findByText("重构保存队列")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
  });

  it("选中一条会开出带 resume 启动行的终端节点", async () => {
    const { container } = renderPalette();
    const item = await screen.findByText("重构保存队列");
    const option = item.closest("[cmdk-item]") as HTMLElement;
    option.click();

    await waitFor(() => {
      const nodes = useCanvasStore.getState().document?.nodes ?? [];
      expect(nodes).toHaveLength(1);
    });
    const node = useCanvasStore.getState().document!.nodes[0]!;
    expect(node.type).toBe("terminal");
    expect(node.title).toBe("重构保存队列");
    if (node.data.kind !== "terminal") throw new Error("not a terminal node");
    expect(node.data.cwd).toBe("/repo/apps/web");
    expect(node.data.agent?.id).toBe("claude");
    // 启动行带 `--resume <sessionId>`，并交给 pendingLaunch 敲进 shell
    expect(node.data.agent?.initialCommand).toContain("--resume");
    expect(node.data.agent?.initialCommand).toContain(row.sessionId);
    expect(node.data.agent?.pendingLaunch?.after).toEqual([]);
    expect(useCanvasStore.getState().panels.palette).toBe(false);
    expect(container).toBeTruthy();
  });

  it("索引为空时不渲染这一组", async () => {
    conversations.mockResolvedValue([]);
    renderPalette();
    await waitFor(() => expect(conversations).toHaveBeenCalled());
    expect(screen.queryByText("重构保存队列")).toBeNull();
  });
});
