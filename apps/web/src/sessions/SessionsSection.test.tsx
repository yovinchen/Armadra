import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  BoardDocument,
  SessionSummary,
  Workspace,
} from "@armadra/shared";

import { useAgentStatusStore } from "../agent/status-store";
import { useCanvasStore } from "../store/canvas-store";
import { CENTER_NODE_EVENT } from "./SessionRow";
import { SessionsSection } from "./SessionsSection";

const sessions = vi.fn();
const gitStatus = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    sessions: (...args: unknown[]) => sessions(...args),
    gitStatus: (...args: unknown[]) => gitStatus(...args),
    terminateTerminal: vi.fn(),
    recycleTerminal: vi.fn(),
  },
}));

const timestamp = "2026-09-04T10:00:00.000Z";
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

const BOARD_ID = "019ff7d1-0d12-7421-833d-2c5e8d64ed30";

/** selectNodes 只接受当前看板里存在的节点，所以测试要给一份最小文档。 */
function document(nodeIds: string[]): BoardDocument {
  return {
    board: {
      id: BOARD_ID,
      workspaceId: workspace.id,
      name: "Default",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      kanban: { columns: [], cards: {} },
      whiteboard: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    nodes: nodeIds.map((id) => ({
      id,
      boardId: BOARD_ID,
      type: "terminal" as const,
      title: id,
      color: "#0a84ff",
      position: { x: 0, y: 0 },
      labels: [],
      note: "",
      data: { kind: "terminal" as const },
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    edges: [],
  };
}

function session(
  partial: Partial<SessionSummary> & { nodeId: string; title: string },
): SessionSummary {
  return {
    boardId: BOARD_ID,
    sessionId: `s-${partial.nodeId}`,
    kind: "terminal",
    cwd: "/repo/apps/web",
    unread: false,
    updatedAt: timestamp,
    alive: true,
    ...partial,
  };
}

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<SessionsSection boardId={BOARD_ID} />, { wrapper });
}

afterEach(() => cleanup());

beforeEach(() => {
  sessions.mockReset();
  gitStatus.mockReset();
  useAgentStatusStore.getState().reset();
  useCanvasStore.setState({
    workspace,
    boardId: BOARD_ID,
    document: document([
      "019ff7d1-0d12-7421-833d-2c5e8d64ed40",
      "019ff7d1-0d12-7421-833d-2c5e8d64ed41",
      "019ff7d1-0d12-7421-833d-2c5e8d64ed42",
    ]),
    selectedNodeIds: [],
  });
  gitStatus.mockResolvedValue({
    repository: true,
    branch: "main",
    changedCount: 2,
    ahead: 0,
    behind: 0,
  });
  sessions.mockResolvedValue([
    session({
      nodeId: "019ff7d1-0d12-7421-833d-2c5e8d64ed40",
      title: "接口重构",
      agentId: "claude",
      state: "working",
    }),
    session({
      nodeId: "019ff7d1-0d12-7421-833d-2c5e8d64ed41",
      title: "登录修复",
      agentId: "codex",
      state: "blocked",
      pendingId: "p1",
      cwd: "/repo/apps/runtime",
    }),
    session({
      nodeId: "019ff7d1-0d12-7421-833d-2c5e8d64ed42",
      title: "旧终端",
      alive: false,
    }),
  ]);
});

describe("SessionsSection", () => {
  it("lists the live sessions grouped by status, newest buckets first", async () => {
    renderSection();

    await screen.findByText("接口重构");
    expect(screen.getByText("登录修复")).toBeTruthy();
    // 已关闭的会话只出现在「历史」折叠里，默认不展开。
    expect(screen.queryByText("旧终端")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // 分组头按「需要你 → 运行中」排；工作空间维度已经交给上面的树。
    const buckets = screen
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent ?? "");
    expect(buckets[0]).toContain("需要你");
    expect(buckets[1]).toContain("运行中");
    expect(screen.queryByRole("tab", { name: "状态" })).toBeNull();
  });

  it("会话少的时候不放过滤框", async () => {
    renderSection();
    await screen.findByText("接口重构");
    expect(screen.queryByLabelText("过滤")).toBeNull();
  });

  it("会话多了才出现过滤框，Escape 清空", async () => {
    // 阈值是 6 条活着的会话（`FILTER_THRESHOLD`）。
    sessions.mockResolvedValue([
      session({ nodeId: "n1", title: "接口重构", state: "working" }),
      session({ nodeId: "n2", title: "登录修复", state: "working" }),
      session({ nodeId: "n3", title: "三", state: "working" }),
      session({ nodeId: "n4", title: "四", state: "working" }),
      session({ nodeId: "n5", title: "五", state: "working" }),
      session({ nodeId: "n6", title: "六", state: "working" }),
    ]);
    renderSection();
    await screen.findByText("接口重构");

    const filter = screen.getByLabelText("过滤");
    fireEvent.change(filter, { target: { value: "登录" } });
    expect(screen.queryByText("接口重构")).toBeNull();

    fireEvent.keyDown(filter, { key: "Escape" });
    expect(await screen.findByText("接口重构")).toBeTruthy();
  });

  it("只列当前看板上的会话", async () => {
    sessions.mockResolvedValue([
      session({ nodeId: "n1", title: "本板的" }),
      session({ nodeId: "n2", title: "别的板的", boardId: "other-board" }),
    ]);
    renderSection();

    expect(await screen.findByText("本板的")).toBeTruthy();
    expect(screen.queryByText("别的板的")).toBeNull();
  });

  it("selects the node and asks the canvas to centre it", async () => {
    const centred: string[] = [];
    const listener = (event: Event) =>
      centred.push((event as CustomEvent<{ nodeId: string }>).detail.nodeId);
    window.addEventListener(CENTER_NODE_EVENT, listener);

    renderSection();
    const row = await screen.findByText("接口重构");
    fireEvent.click(row);

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([
      "019ff7d1-0d12-7421-833d-2c5e8d64ed40",
    ]);
    expect(centred).toEqual(["019ff7d1-0d12-7421-833d-2c5e8d64ed40"]);
    window.removeEventListener(CENTER_NODE_EVENT, listener);
  });

  it("shows closed sessions under the history section", async () => {
    renderSection();
    await screen.findByText("接口重构");

    fireEvent.click(screen.getByText("历史"));
    expect(await screen.findByText("旧终端")).toBeTruthy();
    expect(screen.getByText("重开")).toBeTruthy();
    expect(screen.getByText("移除")).toBeTruthy();
  });
});
